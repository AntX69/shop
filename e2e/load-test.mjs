/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Load and reconciliation test through the real StorePOS.exe (isolated profile).
 *   node e2e/load-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>
 *
 * Creates 500 products x 3 variants in 4 categories, 300 sales (cash/debt/mixed, some with
 * owner discounts), 60 customers' debts, 30 repayments (general FIFO and per sale), 20 returns
 * (resellable/damaged), 10 exchanges and 20 expenses; measures response times and renderer
 * memory; backs up, restores from the backup; then checks every balance in SQLite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'load-profile'));
const outDir = path.resolve(arg('out', 'load-report'));
fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(path.join(dataDir, 'data', 'store.db'))) throw new Error('profile not empty');

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const timings = {};
const time = async (label, fn) => {
  const t0 = performance.now();
  const v = await fn();
  (timings[label] ||= []).push(performance.now() - t0);
  return v;
};
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, p50: Math.round(s[Math.floor(s.length * 0.5)]), p95: Math.round(s[Math.floor(s.length * 0.95)] ?? s[s.length - 1]), max: Math.round(s[s.length - 1]) };
};
let seed = 42;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };

async function main() {
  const app = await launchApp(exe, dataDir, 9900 + Math.floor(Math.random() * 50));
  const { cdp } = app;
  const call = async (label, ch, p, t) => {
    const r = await time(label, () => cdp.ipc(ch, p, t));
    if (!r.success) throw new Error(`${ch}: ${r.error}`);
    return r.data;
  };
  const OT = (await call('setup', 'auth:setupOwner', { name: 'დატვირთვის ტესტი', pin: '2580' })).token;
  await call('user', 'auth:addUser', { name: 'მოლარე', pin: '1470', role: 'seller' }, OT);
  const seller = (await call('user', 'auth:getActiveUsers', {})).find((u) => u.role === 'seller');
  const ST = (await call('login', 'auth:login', { userId: seller.id, pin: '1470' })).token;
  await cdp.evaluate(`location.reload(), true`).catch(() => {});

  const cats = [];
  for (const name of ['სათამაშოები', 'ტანსაცმელი', 'ფეხსაცმელი', 'აქსესუარები']) cats.push(await call('category', 'products:createCategory', { name }, OT));

  const variants = [];
  let code = 10000;
  for (let i = 0; i < 500; i++) {
    const price = 500 + rnd(15000);
    const p = await call('product:create', 'products:create', {
      name: `პროდუქტი ${i}`, category_id: cats[i % 4].id, base_price_tetri: price,
      base_cost_tetri: i % 10 === 0 ? null : Math.round(price * 0.55),
      variants: ['S', 'M', 'L'].map((size) => ({ variant_name: size, size, color: i % 2 ? 'შავი' : 'თეთრი', initial_stock: 20 + rnd(30), codes: [{ code_type: 'manual_5digit', code_value: String(code++) }] })),
    }, OT);
    for (const v of p.variants) variants.push({ id: v.id, price });
  }
  check('500 products x 3 variants created', variants.length === 1500, `create p95 ${stats(timings['product:create']).p95} ms`);

  const customers = [];
  for (let i = 0; i < 60; i++) customers.push(await call('customer', 'customers:create', { first_name: `კლიენტი ${i}`, phone: `5990000${String(i).padStart(2, '0')}` }, ST));

  const sales = [];
  for (let i = 0; i < 300; i++) {
    const lines = Array.from({ length: 1 + rnd(3) }, () => ({ variant_id: variants[rnd(variants.length)].id, quantity: 1 + rnd(2) }));
    const unique = [...new Map(lines.map((l) => [l.variant_id, l])).values()];
    const total = unique.reduce((s, l) => s + l.quantity * variants.find((v) => v.id === l.variant_id).price, 0);
    const kind = i < 60 ? 'debt' : i < 90 ? 'mixed' : 'cash';
    const owner = i % 25 === 0;
    const payload = { items: unique, payment_method: kind, idempotency_key: `load-sale-${i}` };
    if (kind !== 'cash') payload.customer_id = customers[i % 60].id;
    let due = total;
    if (owner) { payload.cart_discount_tetri = Math.floor(total * 0.1); payload.discount_reason = 'ტესტი'; due -= payload.cart_discount_tetri; }
    if (kind === 'cash') payload.cash_received_tetri = due + rnd(500);
    if (kind === 'mixed') payload.cash_received_tetri = Math.max(1, Math.floor(due / 2));
    sales.push(await call('pos:checkout', 'pos:checkout', payload, owner ? OT : ST));
  }
  check('300 sales (60 debt, 30 mixed, 210 cash, 12 discounted)', sales.length === 300, `checkout p50 ${stats(timings['pos:checkout']).p50} ms, p95 ${stats(timings['pos:checkout']).p95} ms`);

  for (let i = 0; i < 30; i++) {
    const c = customers[i];
    const debt = (await call('customer:get', 'customers:get', { customerId: c.id }, ST)).total_debt_tetri;
    if (debt <= 0) continue;
    const amount = Math.max(1, Math.floor(debt / (2 + (i % 3))));
    if (i % 2) {
      const open = await call('activeSales', 'customers:getActiveSales', { customerId: c.id }, ST);
      await call('repay', 'customers:repay', { customer_id: c.id, sale_id: open[0].id, amount_tetri: Math.min(amount, open[0].debt_remaining_tetri), idempotency_key: `load-rep-${i}` }, ST);
    } else {
      await call('repay', 'customers:repay', { customer_id: c.id, amount_tetri: amount, idempotency_key: `load-rep-${i}` }, ST);
    }
  }
  check('30 repayments (FIFO and per sale)', timings.repay?.length >= 25, `${timings.repay?.length} recorded`);

  for (let i = 0; i < 20; i++) {
    const s = sales[100 + i * 7];
    await call('return', 'returns:process', { sale_id: s.id, items: [{ sale_item_id: s.items[0].id, quantity: 1, condition: i % 4 === 0 ? 'damaged' : 'resellable' }], idempotency_key: `load-ret-${i}` }, ST);
  }
  for (let i = 0; i < 10; i++) {
    const s = sales[5 + i * 3]; // debt sales
    await call('exchange', 'returns:exchange', { original_sale_id: s.id, return_items: [{ sale_item_id: s.items[0].id, quantity: 1 }], new_items: [{ variant_id: variants[rnd(variants.length)].id, quantity: 1 }], payment_method: 'debt', idempotency_key: `load-exc-${i}` }, ST);
  }
  for (let i = 0; i < 20; i++) await call('expense', 'finance:createExpense', { category: 'სხვა', description: `ხარჯი ${i}`, amount_tetri: 1000 + rnd(5000) }, OT);
  check('20 returns, 10 exchanges, 20 expenses', true);

  // Read performance on the full catalogue
  for (let i = 0; i < 5; i++) await call('products:list', 'products:list', {}, ST);
  for (let i = 0; i < 20; i++) await call('lookup', 'products:lookupCode', { code: String(10000 + rnd(1500)) }, ST);
  for (const term of ['პროდუქტი 4', 'შავი', 'ფეხსაცმელი', '12345']) await call('search', 'products:list', { searchTerm: term }, ST);
  await call('history', 'pos:searchSales', { limit: 50 }, ST);
  await call('finance', 'finance:summary', { preset: 'all' }, OT);
  const list = stats(timings['products:list']);
  check('catalogue of 1500 variants lists fast enough for the till', list.p95 < 1500, `products:list p50 ${list.p50} ms, p95 ${list.p95} ms; lookup p95 ${stats(timings.lookup).p95} ms; search p95 ${stats(timings.search).p95} ms`);

  await cdp.send('Performance.enable');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  check('renderer memory stays moderate', metrics.JSHeapUsedSize < 200 * 1024 * 1024, `JS heap ${(metrics.JSHeapUsedSize / 1048576).toFixed(1)} MB`);

  const summaryBefore = await call('finance', 'finance:summary', { preset: 'all' }, OT);
  const backup = await call('backup', 'backup:create', {}, OT);
  check('backup of the loaded store', fs.existsSync(backup.filepath), `${(backup.size_bytes / 1048576).toFixed(1)} MB in ${Math.round(timings.backup[0])} ms`);

  // Change data after the backup, then restore it and confirm the change is gone.
  await call('pos:checkout', 'pos:checkout', { items: [{ variant_id: variants[0].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: variants[0].price }, OT);
  const restored = await call('restore', 'backup:restoreFromList', { filename: backup.backup_filename }, OT);
  const oldSession = await cdp.ipc('customers:list', {}, OT);
  const OT2 = (await call('login', 'auth:login', { userId: (await call('users', 'auth:getActiveUsers', {})).find((u) => u.role === 'owner').id, pin: '2580' })).token;
  const summaryAfter = await call('finance', 'finance:summary', { preset: 'all' }, OT2);
  check('restore from the backup brings back exactly the backed-up state', restored.success && JSON.stringify(summaryAfter) === JSON.stringify(summaryBefore) && !oldSession.success,
    `restore ${Math.round(timings.restore[0])} ms, sessions revoked: ${!oldSession.success}`);

  const closed = await closeApp(app);
  check('clean close after load', closed.clean);

  // SQLite-level reconciliation
  const db = new DatabaseSync(path.join(dataDir, 'data', 'store.db'), { readOnly: true });
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  const drift = one(`SELECT COUNT(*) FROM product_variants pv WHERE pv.stock_quantity != COALESCE((SELECT SUM(remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0)`);
  check('stock counters equal FIFO layers for all 1500 variants', drift === 0, `${drift} out of step`);
  const negative = one(`SELECT COUNT(*) FROM product_variants WHERE stock_quantity < 0`) + one(`SELECT COUNT(*) FROM inventory_lots WHERE remaining_quantity < 0 OR remaining_quantity > initial_quantity`);
  check('no negative stock or overdrawn layer', negative === 0);
  const debtView = one(`SELECT COALESCE(SUM(remaining_tetri), 0) FROM sale_debt_balances`);
  const debtBooks = one(`SELECT COALESCE(SUM(debt_amount_tetri), 0) FROM sales`) - one(`SELECT COALESCE(SUM(a.allocated_tetri), 0) FROM debt_repayment_allocations a JOIN debt_repayments r ON r.id = a.repayment_id WHERE r.voided_at IS NULL`) - one(`SELECT COALESCE(SUM(debt_deduction_tetri), 0) FROM returns`) - one(`SELECT COALESCE(SUM(amount_tetri), 0) FROM debt_adjustments`);
  const repaid = one(`SELECT COALESCE(SUM(amount_tetri), 0) FROM debt_repayments WHERE voided_at IS NULL`);
  const allocated = one(`SELECT COALESCE(SUM(a.allocated_tetri), 0) FROM debt_repayment_allocations a JOIN debt_repayments r ON r.id = a.repayment_id WHERE r.voided_at IS NULL`);
  check('debt: per-sale balances = debt − allocations − return deductions; every repayment fully allocated', debtView === debtBooks && repaid === allocated, `open debt ${debtView}, repaid ${repaid}, allocated ${allocated}`);
  const sold = one(`SELECT COALESCE(SUM(quantity), 0) FROM sale_items`);
  const layered = one(`SELECT COALESCE(SUM(quantity), 0) FROM sale_item_lots`);
  const returnedLines = one(`SELECT COALESCE(SUM(returned_quantity), 0) FROM sale_items`);
  const returnedLayers = one(`SELECT COALESCE(SUM(returned_quantity), 0) FROM sale_item_lots`);
  check('every sold and returned unit is attributed to a FIFO layer', sold === layered && returnedLines === returnedLayers, `sold ${sold}, returned ${returnedLines}`);
  const refundSplit = one(`SELECT COUNT(*) FROM returns WHERE total_refund_tetri != debt_deduction_tetri + exchange_credit_tetri + cash_refund_tetri`);
  const saleSplit = one(`SELECT COUNT(*) FROM sales WHERE total_tetri != (cash_received_tetri - change_given_tetri) + debt_amount_tetri + exchange_credit_tetri`);
  check('every sale and return splits exactly into cash, debt and exchange credit', refundSplit === 0 && saleSplit === 0, `${saleSplit} sales, ${refundSplit} returns off`);
  const s = summaryAfter;
  check('finance identities hold', s.net_sales_tetri === s.total_sales_revenue_tetri - s.total_returns_amount_tetri &&
    s.net_cogs_tetri === s.cost_of_goods_sold_tetri - s.cogs_reversed_by_returns_tetri &&
    s.net_cash_flow_tetri === s.cash_collected_direct_tetri + s.cash_collected_debts_tetri - s.cash_refunded_tetri &&
    s.outstanding_debt_tetri === debtView,
    JSON.stringify({ gross: s.total_sales_revenue_tetri, returns: s.total_returns_amount_tetri, netCogs: s.net_cogs_tetri, cash: s.net_cash_flow_tetri, debt: s.outstanding_debt_tetri, unknownCostUnits: s.unknown_cost_items_count }));
  check('integrity_check ok', one('PRAGMA integrity_check') === 'ok');
  db.close();

  const report = { exe, date: new Date().toISOString(), timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stats(v)])), results };
  fs.writeFileSync(path.join(outDir, 'load-report.json'), JSON.stringify(report, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} load checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('load test aborted:', e); process.exit(1); });
