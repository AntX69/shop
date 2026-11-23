/**
 * V1.2 ↔ V1.1 RC2 (the version installed in the shop today), both real programs, one isolated
 * profile:
 *   A. V1.2 creates a Georgian lari shop (owner, products, sales, a debt) with its new user
 *      language column.
 *   B. RC2 opens the V1.2 database (going back after an upgrade): it starts, signs in, reads and
 *      sells; it refuses a V1.2 backup (newer schema).
 *   C. V1.2 opens it again: schema 12, every record (RC2's sale included), the user's language,
 *      the currency and the bookkeeping identities intact; it sells.
 *
 *   node e2e/rc2-compat-test.mjs --new-exe <V1.2 StorePOS.exe> --rc2-exe <RC2 StorePOS.exe> --data <empty dir> --out <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const newExe = arg('new-exe');
const rc2Exe = arg('rc2-exe');
const dataDir = path.resolve(arg('data', 'rc2-compat'));
const outDir = path.resolve(arg('out', 'rc2-compat-report'));
for (const exe of [newExe, rc2Exe]) {
  if (!exe || !fs.existsSync(exe)) throw new Error('--new-exe and --rc2-exe are required');
  if (/Program Files/i.test(exe)) throw new Error('refusing to use a real installation');
}
if (/AppData[\\/]Roaming[\\/]StorePOS/i.test(dataDir) || (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length)) throw new Error('need an empty test profile');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
let port = 9950 + Math.floor(Math.random() * 40);
const dbFile = path.join(dataDir, 'data', 'store.db');
const readDb = () => {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return {
      schema: db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,
      sales: db.prepare('SELECT COUNT(*) AS n FROM sales').get().n,
      langs: db.prepare('SELECT name, ui_language FROM users ORDER BY id').all().map((u) => `${u.name}:${u.ui_language}`).join(','),
      currency: db.prepare("SELECT value FROM app_settings WHERE key = 'currency'").get()?.value,
      guards: db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'v11_guard_%'").get().n,
    };
  } finally {
    db.close();
  }
};
const identities = () => {
  const { checks } = reconcileDatabase(dbFile);
  const bad = checks.filter((c) => !c.ok);
  return { ok: bad.length === 0, failed: bad.map((c) => `${c.name}: ${c.detail}`) };
};

async function main() {
  // A. V1.2
  let app = await launchApp(newExe, dataDir, port++);
  let { cdp } = app;
  const owner = await must(cdp, 'auth:setupOwner', { name: 'მფლობელი', pin: '3842', language: 'ru' });
  let OT = owner.token;
  const prod = await must(cdp, 'products:create', {
    name: 'ჩაი', base_price_tetri: 450, base_cost_tetri: 300,
    variants: [{ variant_name: 'სტ', initial_stock: 40, codes: [{ code_type: 'manual_5digit', code_value: '61001' }] }],
  }, OT);
  const v = prod.variants[0].id;
  const cust = await must(cdp, 'customers:create', { first_name: 'ნინო' }, OT);
  await must(cdp, 'pos:checkout', { items: [{ variant_id: v, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 1000 }, OT);
  await must(cdp, 'pos:checkout', { items: [{ variant_id: v, quantity: 3 }], payment_method: 'debt', customer_id: cust.id }, OT);
  const v12Backup = await must(cdp, 'backup:create', {}, OT);
  await closeApp(app);
  const a = { ...readDb(), identities: identities() };
  check('A. V1.2 shop: schema 12, lari, owner language stored, guard in place', a.schema === 12 && a.currency === 'GEL' && a.langs === 'მფლობელი:ru' && a.guards > 0 && a.identities.ok, `${a.schema} ${a.currency} ${a.langs}`);

  // B. RC2 on the V1.2 database
  app = await launchApp(rc2Exe, dataDir, port++);
  ({ cdp } = app);
  const users = await must(cdp, 'auth:getActiveUsers', {});
  const login = await cdp.ipc('auth:login', { userId: users[0].id, pin: '3842' });
  check('B. RC2 starts on the V1.2 database and the owner signs in', login.success, login.error);
  const T2 = login.data?.token;
  const list = await cdp.ipc('products:list', {}, T2);
  const sale = await cdp.ipc('pos:checkout', { items: [{ variant_id: v, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 500 }, T2);
  check('B. RC2 reads the catalogue and sells', list.success && list.data.length === 1 && sale.success, sale.error || list.error);
  const verify = await cdp.ipc('backup:verify', { filename: v12Backup.backup_filename }, T2);
  check('B. RC2 refuses the V1.2 backup (newer schema)', verify.success && verify.data.is_valid === false, verify.data?.integrity_status || verify.error);
  await closeApp(app);
  const b = { ...readDb(), identities: identities() };
  check('B. after RC2: schema still 12, the language column and the identities intact', b.schema === 12 && b.langs === 'მფლობელი:ru' && b.sales === 3 && b.identities.ok, `${b.sales} sales ${b.identities.ok ? '' : JSON.stringify(b.identities)}`);

  // C. V1.2 again
  app = await launchApp(newExe, dataDir, port++);
  ({ cdp } = app);
  const back = await must(cdp, 'auth:login', { userId: users[0].id, pin: '3842' });
  OT = back.token;
  check("C. V1.2 again: the owner keeps their language (Russian)", back.user.language === 'ru');
  const s4 = await cdp.ipc('pos:checkout', { items: [{ variant_id: v, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 500 }, OT);
  const pub = await must(cdp, 'settings:getPublic');
  check('C. V1.2 sells again; still lari', s4.success && pub.currency === 'GEL', s4.error);
  await closeApp(app);
  const c = { ...readDb(), identities: identities() };
  check('C. all 4 sales (one made by RC2), identities hold', c.sales === 4 && c.identities.ok, JSON.stringify(c.identities).slice(0, 200));

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} V1.2 / RC2 compatibility checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL  run aborted:', err?.stack || err);
  process.exit(1);
});
