/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * RC3 -> V1.1 upgrade on a COPIED RC3 store database with real history, with installers built
 * under the separate test identity "StorePOS-Test" (own app id, install folder, uninstall entry)
 * and only isolated profiles - the shop's real StorePOS installation and data are never used.
 *
 *  1. the RC3 program builds a shop with history: 3 users, categories, ~150 variants with photos
 *     and several purchase batches at different costs, ~160 sales (cash/debt/mixed, by the owner
 *     and two sellers, some discounted), general and receipt-specific repayments, partial returns
 *     (resellable/damaged), exchanges, stock counts, write-offs, expenses, RC3 backups;
 *  2. its data folder is COPIED to a second profile; the RC3 program opens the copy (same data);
 *  3. the V1.1 installer runs over RC3: it must not change a single byte of the data folder;
 *  4. V1.1 opens the copy: a pre-migration safety copy holding exactly the RC3 data; every
 *     record and every RC3 finance figure unchanged; PINs work; RC3 sellers keep RC3 rights;
 *     bookkeeping and FIFO cost-layer identities hold;
 *  5. work continues after the upgrade (return of an RC3 sale, new sales, repayment, exchange)
 *     and the identities still hold;
 *  6. an RC3 backup restores in V1.1 to exactly the RC3 data;
 *  7. uninstalling V1.1 keeps the data folder byte for byte.
 *
 *   node e2e/upgrade-copied-rc3-test.mjs --old <StorePOS-Test-Setup-1.0.0-rc.3.exe> --new <StorePOS-Test-Setup-1.1.0-rc.2.exe>
 *        --dir <test install dir containing "StorePOS-Test"> --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';
import { must, rnd, PINS, fingerprint, sameAsRc3, buildRc3Shop } from './rc3-shop.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const oldSetup = arg('old');
const newSetup = arg('new');
const newVersion = (path.basename(newSetup || '').match(/Setup-(.+)\.exe$/i) || [])[1] || '';
const installDir = path.resolve(arg('dir', ''));
const root = path.resolve(arg('data', 'copied-rc3'));
const outDir = path.resolve(arg('out', 'copied-rc3-report'));
const EXE = 'StorePOS-Test.exe';
// The shop's real installation: per user or for all users (Program Files).
const realInstalls = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'StorePOS'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'StorePOS')];
const rc3Exe = arg('rc3-exe'); // an unpacked RC3 program, for the 'old program opens new data' experiment
const expectSchema = Number(arg('schema', '11')); // schema written by the new program (RC1: 10, RC2: 11)
if (!oldSetup || !newSetup || !fs.existsSync(oldSetup) || !fs.existsSync(newSetup) || !/StorePOS-Test-Setup/.test(oldSetup) || !/StorePOS-Test-Setup/.test(newSetup)) {
  console.error('usage: --old <StorePOS-Test-Setup-1.0.0-rc.3.exe> --new <StorePOS-Test-Setup-1.1.0-rc.2.exe> --dir <dir> --data <empty dir> --out <dir>');
  process.exit(2);
}
if (!/StorePOS-Test/i.test(installDir) || realInstalls.some((r) => installDir.toLowerCase().startsWith(r.toLowerCase() + path.sep) || installDir.toLowerCase() === r.toLowerCase())) {
  console.error(`refusing: the install folder must be a separate test folder, not ${realInstalls.join(' or ')}`);
  process.exit(2);
}
const P0 = path.join(root, 'rc3-original');
const P1 = path.join(root, 'rc3-copy');
for (const p of [P0, P1]) if (fs.existsSync(path.join(p, 'data', 'store.db'))) { console.error(`refusing to run: ${p} already contains a store database`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60000 }).trim();
const run = (file, args) => new Promise((resolve) => { const p = spawn(file, args, { stdio: 'ignore', windowsVerbatimArguments: true }); p.on('exit', (c) => resolve(c)); });
const uninstallEntries = () => {
  const out = ps(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'StorePOS-Test*' } | Select-Object DisplayName, DisplayVersion | ConvertTo-Json -Compress`);
  return out ? [].concat(JSON.parse(out)) : [];
};
const productVersion = (file) => ps(`(Get-Item '${file.replace(/'/g, "''")}').VersionInfo.FileVersion`);
const exePath = path.join(installDir, EXE);
let port = 9860 + Math.floor(Math.random() * 60);
/** Every file under a folder with its SHA-256. */
function tree(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) tree(p, base, out); else out[path.relative(base, p)] = sha(fs.readFileSync(p));
  }
  return out;
}
const treeDiff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
/** Content of every table (sorted rows), read from a copy so the original files are not touched. */
function logicalDump(dbPath) {
  const tmp = fs.mkdtempSync(path.join(root, 'dump-'));
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, path.join(tmp, 'x.db' + suffix));
  const db = new DatabaseSync(path.join(tmp, 'x.db'));
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[name] = sha(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort()));
  }
  db.close();
  return out;
}

async function main() {
  const realStat = () => realInstalls.map((r) => path.join(r, 'StorePOS.exe')).filter((f) => fs.existsSync(f)).map((f) => { const st = fs.statSync(f); return { f, size: st.size, mtime: st.mtimeMs }; });
  const realBefore = realStat();

  // ===== 1. RC3 builds a shop with history =====
  check('RC3 test installer finishes silently', (await run(oldSetup, ['/S', `/D=${installDir}`])) === 0);
  check('RC3 installed in the test folder', fs.existsSync(exePath), productVersion(exePath));
  log('RC3 builds the shop');
  let app = await launchApp(exePath, P0, port++);
  const shop = await buildRc3Shop(app.cdp);
  const fpRc3 = await fingerprint(app.cdp, shop.OT);
  await closeApp(app);
  const c = shop.counts;
  check('RC3 shop with history', c.sales >= 150 && c.returns >= 15 && c.exchanges >= 5 && c.repayments >= 15 && c.restocks >= 70,
    `${c.variants} variants, ${c.restocks} purchase batches, ${c.sales} sales, ${c.repayments} repayments, ${c.returns} returns, ${c.exchanges} exchanges, ${c.writeOffs} write-offs`);
  {
    const db = new DatabaseSync(path.join(P0, 'data', 'store.db'), { readOnly: true });
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    const multi = db.prepare('SELECT COUNT(*) AS n FROM (SELECT variant_id FROM inventory_lots GROUP BY variant_id HAVING COUNT(*) > 1)').get().n;
    const partial = db.prepare('SELECT COUNT(*) AS n FROM inventory_lots WHERE remaining_quantity > 0 AND remaining_quantity < initial_quantity').get().n;
    db.close();
    check('the RC3 database: RC3 schema, variants with several purchase batches, partly sold batches', v < 9 && multi >= 20 && partial >= 10, `schema v${v}, ${multi} variants with 2+ batches, ${partial} partly sold batches`);
  }

  // ===== 2. copy the data folder; RC3 opens the copy =====
  fs.mkdirSync(P1, { recursive: true });
  fs.cpSync(path.join(P0, 'data'), path.join(P1, 'data'), { recursive: true });
  check('the data folder is copied byte for byte (database, photos, backups)', treeDiff(tree(path.join(P0, 'data')), tree(path.join(P1, 'data'))).length === 0, `${Object.keys(tree(path.join(P1, 'data'))).length} files`);
  app = await launchApp(exePath, P1, port++);
  const T1 = (await must(app.cdp, 'auth:login', { userId: (await must(app.cdp, 'auth:getActiveUsers', {})).find((u) => u.role === 'owner').id, pin: PINS.owner })).token;
  const fpCopyRc3 = await fingerprint(app.cdp, T1);
  await closeApp(app);
  check('RC3 opens the copied database: identical data', JSON.stringify(fpCopyRc3) === JSON.stringify(fpRc3));
  const dumpBefore = logicalDump(path.join(P1, 'data', 'store.db'));
  const h1 = tree(path.join(P1, 'data'));

  // ===== 3. the V1.1 installer over RC3 =====
  log('V1.1 installer');
  const code = await run(newSetup, ['/S', `/D=${installDir}`]);
  await sleep(2000);
  check('V1.1 test installer finishes silently over RC3', code === 0);
  const v2 = fs.existsSync(exePath) ? productVersion(exePath) : 'missing';
  const entries = uninstallEntries();
  check('the program is now V1.1; exactly one uninstall entry', v2 === newVersion && entries.length === 1 && entries[0].DisplayVersion === newVersion, `${v2}; ${JSON.stringify(entries)}`);
  const h2 = tree(path.join(P1, 'data'));
  check('the installer did not change a single byte of the data folder', treeDiff(h1, h2).length === 0, `${Object.keys(h2).length} files compared`);

  // ===== 4. V1.1 opens the copied RC3 database =====
  app = await launchApp(exePath, P1, port++);
  const users = await must(app.cdp, 'auth:getActiveUsers', {});
  const T2 = (await must(app.cdp, 'auth:login', { userId: users.find((u) => u.role === 'owner').id, pin: PINS.owner })).token;
  const fpV11 = await fingerprint(app.cdp, T2);
  const same = sameAsRc3(fpRc3, fpV11);
  check('V1.1: every user, product, variant, stock, code, photo count, debt and sale identical; every RC3 finance figure unchanged', same.ok, same.detail);
  const safety = fs.readdirSync(path.join(P1, 'data')).filter((f) => /^store\.db\.before_migration_v\d+_\d+\.bak$/.test(f));
  const safetyDump = safety.length ? logicalDump(path.join(P1, 'data', safety[0])) : {};
  check('a pre-migration safety copy exists and holds exactly the RC3 data (every table, every row)', safety.length === 1 && JSON.stringify(safetyDump) === JSON.stringify(dumpBefore), safety.join(', '));
  const sellerRights = [];
  for (const [name, pin] of [['RC3 გამყიდველი ანა', PINS.s1], ['RC3 გამყიდველი გიორგი', PINS.s2]]) {
    const u = users.find((x) => x.name === name);
    const login = await app.cdp.ipc('auth:login', { userId: u.id, pin });
    const perms = await must(app.cdp, 'auth:getUserPermissions', { userId: u.id }, T2);
    const fin = await app.cdp.ipc('finance:summary', { preset: 'all' }, login.data?.token);
    sellerRights.push({ ok: login.success && !fin.success, perms: [...perms].sort().join(',') });
  }
  const expected = ['customers.create', 'debts.collect', 'debts.history', 'debts.select_receipt', 'debts.view', 'inventory.quantities', 'inventory.view', 'pos.access', 'products.view', 'returns.exchange', 'returns.process', 'sales.cash', 'sales.debt', 'sales.history', 'sales.mixed'].join(',');
  check('both RC3 sellers sign in with their PINs, keep exactly RC3 rights, still no finance', sellerRights.every((s) => s.ok && s.perms === expected), sellerRights.map((s) => s.perms).join(' | '));
  await closeApp(app);
  const db1 = path.join(P1, 'data', 'store.db');
  const rec1 = reconcileDatabase(db1);
  check('bookkeeping identities hold after the upgrade (incl. FIFO cost layers and stock value)', rec1.checks.every((x) => x.ok), JSON.stringify(rec1.checks.filter((x) => !x.ok)));
  {
    const db = new DatabaseSync(db1, { readOnly: true });
    const v = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
    const lots = db.prepare(`SELECT COUNT(*) AS n,
      SUM(remaining_cost_tetri = unit_cost_tetri * remaining_quantity) AS rem_ok,
      SUM(initial_cost_tetri = unit_cost_tetri * initial_quantity) AS init_ok
      FROM inventory_lots WHERE unit_cost_tetri IS NOT NULL`).get();
    const units = db.prepare("SELECT COUNT(*) AS n FROM products WHERE unit_type <> 'piece'").get().n;
    db.close();
    check(`schema v${expectSchema}; RC3 products stay pieces; every batch: initial and remaining cost = unit cost × quantity`, v === expectSchema && units === 0 && lots.n > 0 && lots.rem_ok === lots.n && lots.init_ok === lots.n,
      `v${v}, ${lots.n} batches, remaining ok ${lots.rem_ok}, initial ok ${lots.init_ok}, ${units} non-piece`);
  }

  // ===== 4b. experiment: the OLD program opens the upgraded data (e.g. a second, older copy
  //       left installed). Reported as INFO; it does not count as an installer check. =====
  if (rc3Exe && fs.existsSync(rc3Exe)) {
    const P2 = path.join(root, 'rc3-on-upgraded');
    fs.mkdirSync(P2, { recursive: true });
    fs.cpSync(path.join(P1, 'data'), path.join(P2, 'data'), { recursive: true });
    const info = { started: false };
    try {
      const old = await launchApp(rc3Exe, P2, port++);
      info.started = true;
      const ownerOld = (await must(old.cdp, 'auth:getActiveUsers', {})).find((u) => u.role === 'owner');
      const TO = (await must(old.cdp, 'auth:login', { userId: ownerOld.id, pin: PINS.owner })).token;
      const db = new DatabaseSync(path.join(P2, 'data', 'store.db'), { readOnly: true });
      const multi = db.prepare('SELECT variant_id FROM inventory_lots WHERE remaining_quantity > 0 GROUP BY variant_id HAVING COUNT(*) > 1 LIMIT 1').get();
      db.close();
      const sale = await old.cdp.ipc('pos:checkout', { items: [{ variant_id: multi.variant_id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 100000 }, TO);
      info.sale = sale.success ? 'accepted' : sale.error;
      const rst = await old.cdp.ipc('inventory:restock', { variant_id: multi.variant_id, added_quantity: 5, unit_cost_tetri: 777 }, TO);
      info.restock = rst.success ? 'accepted' : rst.error;
      await closeApp(old);
      const recOld = reconcileDatabase(path.join(P2, 'data', 'store.db'));
      info.identities_failing = recOld.checks.filter((x) => !x.ok).map((x) => x.name);
    } catch (err) {
      info.error = String(err?.message || err).slice(0, 300);
    }
    const line = `old RC3 program on the upgraded database: started=${info.started}, sale=${info.sale}, restock=${info.restock}, failing identities afterwards: ${JSON.stringify(info.identities_failing || [])}${info.error ? `, error: ${info.error}` : ''}`;
    console.log(`INFO  ${line}`);
    results.push({ name: 'INFO (not a check): old program opens upgraded data', ok: true, info: true, detail: line });
  }

  // ===== 5. work continues after the upgrade =====
  app = await launchApp(exePath, P1, port++);
  const T3 = (await must(app.cdp, 'auth:login', { userId: users.find((u) => u.role === 'owner').id, pin: PINS.owner })).token;
  const old = shop.sales.find((s) => s.sale.items.some((it) => it.quantity >= 3));
  const oldItem = old.sale.items.find((it) => it.quantity >= 3);
  const ret = await app.cdp.ipc('returns:process', { sale_id: old.sale.id, items: [{ sale_item_id: oldItem.id, quantity: 1, condition: 'resellable' }], reason: 'V1.1 დაბრუნება' }, T3);
  let newSales = 0;
  for (let i = 0; i < 10; i++) {
    const v = shop.variants[rnd(shop.variants.length)];
    const r = await app.cdp.ipc('pos:checkout', { items: [{ variant_id: v.id, quantity: 1 }], payment_method: i % 2 ? 'cash' : 'debt', customer_id: shop.customers[i % 15].id, cash_received_tetri: i % 2 ? v.price : undefined }, T3);
    if (r.success) newSales++;
  }
  const repay = await app.cdp.ipc('customers:repay', { customer_id: shop.customers[0].id, amount_tetri: 100 }, T3);
  const exch = await app.cdp.ipc('returns:exchange', { original_sale_id: shop.sales.find((s) => s.method === 'cash').sale.id, return_items: [{ sale_item_id: shop.sales.find((s) => s.method === 'cash').sale.items[0].id, quantity: 1 }], new_items: [{ variant_id: shop.variants[5].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: shop.variants[5].price + 1000 }, T3);
  check('after the upgrade: a return of an RC3 sale, new sales, a repayment and an exchange work', ret.success && newSales >= 8 && repay.success && (exch.success || /უკვე|დაბრუნებ/.test(exch.error || '')),
    [ret.error, `${newSales}/10 sales`, repay.error, exch.success ? 'exchange ok' : exch.error].filter(Boolean).join(' | '));
  await closeApp(app);
  const rec2 = reconcileDatabase(db1);
  check('bookkeeping and FIFO identities still hold after working in V1.1', rec2.checks.every((x) => x.ok), JSON.stringify(rec2.checks.filter((x) => !x.ok)));

  // ===== 6. an RC3 backup restores in V1.1 =====
  app = await launchApp(exePath, P1, port++);
  const T4 = (await must(app.cdp, 'auth:login', { userId: users.find((u) => u.role === 'owner').id, pin: PINS.owner })).token;
  const listed = await must(app.cdp, 'backup:list', {}, T4);
  const rc3Backups = listed.filter((b) => b.filename === shop.backup1.backup_filename || b.filename === shop.backup2.backup_filename);
  check('both RC3 backups are listed in V1.1 and verify', rc3Backups.length === 2 && rc3Backups.every((b) => b.is_valid), rc3Backups.map((b) => `${b.filename}:${b.is_valid}`).join(', '));
  const restored = await must(app.cdp, 'backup:restoreFromList', { filename: shop.backup2.backup_filename }, T4);
  const T5 = (await must(app.cdp, 'auth:login', { userId: (await must(app.cdp, 'auth:getActiveUsers', {})).find((u) => u.role === 'owner').id, pin: PINS.owner })).token;
  const fpRestored = await fingerprint(app.cdp, T5);
  const same2 = sameAsRc3(fpRc3, fpRestored);
  check('the last RC3 backup restores in V1.1 to exactly the RC3 data', restored.success && same2.ok, same2.detail || restored.message);
  await closeApp(app);
  const rec3 = reconcileDatabase(db1);
  check('bookkeeping and FIFO identities hold in the restored RC3 backup', rec3.checks.every((x) => x.ok), JSON.stringify(rec3.checks.filter((x) => !x.ok)));

  // ===== 7. uninstall keeps the data =====
  const h3 = tree(path.join(P1, 'data'));
  await run(path.join(installDir, 'Uninstall StorePOS-Test.exe'), ['/S']);
  for (let i = 0; i < 60 && fs.existsSync(exePath); i++) await sleep(1000);
  await sleep(2000);
  const h4 = tree(path.join(P1, 'data'));
  check('uninstall removes the program and its uninstall entry', !fs.existsSync(exePath) && uninstallEntries().length === 0);
  check('uninstall keeps the data folder byte for byte', treeDiff(h3, h4).length === 0, `${Object.keys(h4).length} files`);
  const realAfter = realStat();
  check('the real StorePOS installation on this computer was not touched (program file size and time unchanged)',
    JSON.stringify(realBefore) === JSON.stringify(realAfter),
    realBefore.length ? realBefore.map((r) => `${r.f}: ${r.size} bytes, ${new Date(r.mtime).toISOString()}`).join('; ') : 'no real installation found');

  fs.writeFileSync(path.join(outDir, 'copied-rc3-report.json'), JSON.stringify({ oldSetup, newSetup, date: new Date().toISOString(), counts: shop.counts, results }, null, 2));
  const counted = results.filter((r) => !r.info);
  const failed = counted.filter((r) => !r.ok).length;
  console.log(`\n${counted.length - failed}/${counted.length} copied-RC3 upgrade checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('copied-RC3 upgrade test aborted:', err);
  fs.writeFileSync(path.join(outDir, 'copied-rc3-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
