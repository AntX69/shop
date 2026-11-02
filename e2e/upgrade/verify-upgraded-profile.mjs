/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Opens a profile created by an older StorePOS (see make-m12-profile.mts) with the new
 * StorePOS.exe and checks that the upgrade keeps every record and repairs known defects.
 *
 *   node e2e/upgrade/verify-upgraded-profile.mjs --exe <StorePOS.exe> --profile <dir> --out <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from '../cdp.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const exe = arg('exe');
const profile = path.resolve(arg('profile'));
const outDir = path.resolve(arg('out') || 'upgrade-report');
fs.mkdirSync(outDir, { recursive: true });
const expected = JSON.parse(fs.readFileSync(path.join(profile, 'm12-expected.json'), 'utf8'));
const dbFile = path.join(profile, 'data', 'store.db');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const must = async (cdp, ch, p, t) => { const r = await cdp.ipc(ch, p, t); if (!r.success) throw new Error(`${ch}: ${r.error}`); return r.data; };

async function main() {
  const before = new DatabaseSync(dbFile, { readOnly: true });
  const oldHash = before.prepare("SELECT pin_hash FROM users WHERE role = 'owner'").get().pin_hash;
  before.close();

  const app = await launchApp(exe, profile, 9800 + Math.floor(Math.random() * 100));
  const { cdp } = app;
  await cdp.waitFor(`document.body.innerText.includes('M12 მფლობელი')`, 30000, 'login screen of the upgraded store');
  check('upgraded app starts on the existing profile', true, `${(app.startedMs / 1000).toFixed(1)} s`);

  const backups = fs.readdirSync(path.join(profile, 'data')).filter((f) => f.includes('before_migration_v6'));
  check('pre-migration safety copy made before upgrading the schema', backups.length === 1, backups[0] || '');

  await cdp.evaluate(`([...document.querySelectorAll('button')].find(b => b.innerText.includes('M12 მფლობელი'))?.click(), true)`);
  await new Promise((r) => setTimeout(r, 400));
  await cdp.typeDigits(expected.ownerPin);
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS after login');
  check('old owner PIN (10k-iteration hash) still works', true);
  const T = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);

  const products = await must(cdp, 'products:list', {}, T);
  const sales = await must(cdp, 'pos:searchSales', { limit: 100 }, T);
  const customer = await must(cdp, 'customers:get', { customerId: expected.customerId }, T);
  check('all products and sales kept', products.length === expected.products && sales.length === expected.sales, `${products.length} products, ${sales.length} sales`);
  check('customer debt unchanged by the upgrade', customer.total_debt_tetri === expected.customerDebt, `${customer.total_debt_tetri} (before ${expected.customerDebt})`);

  const stock = Object.fromEntries(products.flatMap((p) => p.variants).map((v) => [v.id, v.stock_quantity]));
  check('stock counters unchanged', JSON.stringify(stock) === JSON.stringify(expected.stock), JSON.stringify(stock));

  await cdp.key('F2', { code: 'F2', vk: 113 });
  await cdp.waitFor(`[...document.images].some(i => i.src.startsWith('storepos-img://') && i.complete && i.naturalWidth > 0)`, 10000, 'migrated photo visible');
  check('inline base64 photo moved to a file and still displayed', fs.readdirSync(path.join(profile, 'data', 'images')).length === 1);
  await cdp.screenshot(path.join(outDir, 'upgraded-products.png'));

  const summary = await must(cdp, 'finance:summary', { preset: 'all' }, T);
  check('finance after upgrade: COGS of the old return is reversed', summary.cogs_reversed_by_returns_tetri === 1200 && summary.total_returns_amount_tetri === 3000,
    JSON.stringify({ gross: summary.total_sales_revenue_tetri, returns: summary.total_returns_amount_tetri, cogs: summary.cost_of_goods_sold_tetri, reversed: summary.cogs_reversed_by_returns_tetri, unknown: summary.unknown_cost_items_count }));

  // A new sale on upgraded data works and keeps FIFO consistent.
  const s = await must(cdp, 'pos:checkout', { items: [{ variant_id: products.find((p) => p.name === 'ძველი სათამაშო').variants[0].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 3000 }, T);
  check('new sale on upgraded data', s.total_tetri === 3000 && s.items[0].unit_cost_tetri === 1200, `cost ${s.items[0].unit_cost_tetri}`);

  const closed = await closeApp(app);
  check('clean close', closed.clean);

  const db = new DatabaseSync(dbFile, { readOnly: true });
  const schema = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  const drift = db.prepare(`SELECT COUNT(*) AS n FROM product_variants pv WHERE pv.stock_quantity != COALESCE((SELECT SUM(remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0)`).get().n;
  const nullLots = db.prepare('SELECT COUNT(*) AS n FROM inventory_lots WHERE unit_cost_tetri IS NULL AND remaining_quantity > 0').get().n;
  const inline = db.prepare("SELECT COUNT(*) AS n FROM product_images WHERE file_path LIKE 'data:%'").get().n;
  const newHash = db.prepare("SELECT pin_hash FROM users WHERE role = 'owner'").get().pin_hash;
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  db.close();
  check('schema upgraded to v6, integrity ok', schema === 6 && integrity === 'ok', `v${schema}, ${integrity}`);
  check('stock and FIFO layers reconciled', drift === 0, `variants out of step: before ${expected.lotDrift}, after ${drift}`);
  check('return lot got its original cost back; only truly unknown cost stays unknown', nullLots === 1, `NULL-cost lots: before ${expected.nullCostLots}, after ${nullLots}`);
  check('no inline photos left in SQLite', inline === 0);
  check('owner PIN hash upgraded on login', oldHash !== newHash && newHash.startsWith('pbkdf2-sha256$'));

  fs.writeFileSync(path.join(outDir, 'upgrade-report.json'), JSON.stringify({ exe, profile, date: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} upgrade checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('upgrade check aborted:', e); process.exit(1); });
