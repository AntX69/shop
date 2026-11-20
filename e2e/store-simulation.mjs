/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Realistic store simulation with the real StorePOS.exe (isolated profile, never the real data),
 * deterministic (fixed seed), everything through the app's IPC as the owner and a seller:
 * 200+ products (pieces and kilograms, variants, known and unknown costs), several FIFO layers,
 * customers, cash / debt / mixed sales with discounts, repeated requests, repayments (automatic
 * and chosen receipt), a voided repayment, a debt write-off, partial piece and weight returns
 * (resellable and damaged), cross-unit exchanges, stock corrections, expenses; a backup, more
 * work, a restore (must bring back exactly the backup's figures), more work after the restore.
 * Then the database is reconciled independently (e2e/reconcile.mjs) and compared with the
 * finance report.
 *
 *   node e2e/store-simulation.mjs --exe "C:\...\StorePOS.exe" --data <empty dir> --out <report dir>
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
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'e2e-sim-profile'));
const outDir = path.resolve(arg('out', 'e2e-sim-report'));
const SEED = Number(arg('seed', '20261120'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/store-simulation.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--seed N]');
  process.exit(2);
}
if (fs.existsSync(path.join(dataDir, 'data', 'store.db'))) {
  console.error(`refusing to run: ${dataDir} already contains a store database`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const stats = {};
const bump = (k, n = 1) => { stats[k] = (stats[k] || 0) + n; };

// Deterministic PRNG (mulberry32)
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

const OWNER_PIN = '846203';
const SELLER_PIN = '395174';
const PORT = 9300 + Math.floor(Math.random() * 400);
let cdp;
let OT;
let ST;
let sellerId;
const call = (channel, payload, token) => cdp.ipc(channel, payload, token);
async function must(channel, payload, token) {
  const r = await call(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error} :: ${JSON.stringify(payload).slice(0, 300)}`);
  return r.data;
}
let keySeq = 0;
const key = (p) => `sim-${SEED}-${p}-${++keySeq}`;

async function setInput(index, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelectorAll('form input')[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

/** Current sellable variants with stock (owner view: sees stock). */
async function sellable() {
  const list = await must('products:list', {}, OT);
  const out = [];
  for (const p of list) for (const v of p.variants || []) {
    if (v.is_active === 1 && v.stock_quantity > 0) out.push({ product: p, variant: v, kg: (p.unit_type || v.unit_type) === 'kg' });
  }
  return out;
}
const qtyFor = (item) => item.kg ? Math.min(item.variant.stock_quantity, int(50, 1500)) : Math.min(item.variant.stock_quantity, int(1, 3));

let customers = [];
const sales = [];

async function doSale({ by = 'seller', forcePay } = {}) {
  const pool = await sellable();
  if (pool.length === 0) return null;
  const lines = [];
  const used = new Set();
  const kgPool = pool.filter((x) => x.kg);
  for (let i = 0, n = int(1, 4); i < n; i++) {
    // About a third of the lines are weighed products.
    const it = kgPool.length && chance(0.35) ? pick(kgPool) : pick(pool);
    if (used.has(it.variant.id)) continue;
    used.add(it.variant.id);
    lines.push({ variant_id: it.variant.id, quantity: qtyFor(it) });
  }
  const token = by === 'owner' ? OT : ST;
  const roll = rnd();
  const pay = forcePay || (roll < 0.55 ? 'cash' : roll < 0.8 ? 'debt' : 'mixed');
  const payload = { items: lines, payment_method: pay, idempotency_key: key('sale') };
  if (pay !== 'cash') payload.customer_id = pick(customers).id;
  if (by === 'owner' && chance(0.3)) payload.cart_discount_tetri = int(10, 200);
  // Price first (the app recomputes it anyway): a dry run through the same pricing as checkout.
  let sale;
  if (pay === 'cash') {
    payload.cash_received_tetri = 10_000_000;
    sale = await must('pos:checkout', payload, token);
  } else if (pay === 'mixed') {
    // Cash part strictly between 0 and the total: try with a small amount first.
    payload.cash_received_tetri = 100;
    const r = await call('pos:checkout', payload, token);
    if (!r.success) { delete payload.cart_discount_tetri; payload.payment_method = 'debt'; delete payload.cash_received_tetri; sale = await must('pos:checkout', payload, token); }
    else sale = r.data;
  } else {
    sale = await must('pos:checkout', payload, token);
  }
  sales.push(sale);
  bump(`sales_${sale.payment_method}`);
  bump('sale_lines', sale.items.length);
  if (sale.discount_tetri > 0) bump('discounted_sales');
  for (const it of sale.items) bump(it.unit_type === 'kg' ? 'kg_lines' : 'piece_lines');
  // A repeated request (e.g. double click / retry) must not sell twice.
  if (chance(0.06)) {
    const again = await must('pos:checkout', payload, token);
    if (again.id !== sale.id) throw new Error('repeated checkout created a second sale');
    bump('repeated_checkouts');
  }
  return sale;
}

async function doRepayment() {
  const list = await must('customers:list', {}, OT);
  const withDebt = list.filter((c) => (c.total_debt_tetri || 0) > 0);
  if (withDebt.length === 0) return;
  const c = pick(withDebt);
  const specific = chance(0.5);
  const payload = { customer_id: c.id, idempotency_key: key('repay') };
  if (specific) {
    const active = await must('customers:getActiveSales', { customerId: c.id }, ST);
    const open = active.filter((x) => (x.debt_remaining_tetri ?? 0) > 0);
    if (open.length === 0) return;
    const sale = pick(open);
    payload.sale_id = sale.id;
    payload.amount_tetri = Math.max(1, Math.min(sale.debt_remaining_tetri, int(100, sale.debt_remaining_tetri)));
  } else {
    payload.amount_tetri = Math.max(1, Math.min(c.total_debt_tetri, int(100, c.total_debt_tetri)));
  }
  const r = await must('customers:repay', payload, ST);
  bump(specific ? 'repayments_specific' : 'repayments_fifo');
  return r;
}

async function doReturn({ damaged = chance(0.25) } = {}) {
  const candidates = [];
  for (const sale of sales) {
    const fresh = await must('pos:getSale', { saleId: sale.id }, OT);
    for (const it of fresh.items || []) if (it.quantity > it.returned_quantity) candidates.push({ sale: fresh, it });
    if (candidates.length > 40) break;
  }
  if (candidates.length === 0) return;
  const kgCandidates = candidates.filter((c) => c.it.unit_type === 'kg');
  const { sale, it } = kgCandidates.length && chance(0.4) ? pick(kgCandidates) : pick(candidates);
  const left = it.quantity - it.returned_quantity;
  const qty = it.unit_type === 'kg' ? Math.max(1, Math.min(left, int(10, left))) : Math.max(1, Math.min(left, int(1, left)));
  const r = await must('returns:process', {
    sale_id: sale.id,
    items: [{ sale_item_id: it.id, quantity: qty, condition: damaged ? 'damaged' : 'resellable' }],
    idempotency_key: key('ret'),
  }, ST);
  bump(it.unit_type === 'kg' ? 'returns_kg' : 'returns_piece');
  if (damaged) bump('returns_damaged');
  if (r.debt_deduction_tetri > 0) bump('returns_against_debt');
  return r;
}

async function doExchange(fromKg, toKg) {
  const pool = await sellable();
  const targets = pool.filter((x) => x.kg === toKg);
  for (const sale of [...sales].reverse()) {
    const fresh = await must('pos:getSale', { saleId: sale.id }, OT);
    const it = (fresh.items || []).find((x) => (x.unit_type === 'kg') === fromKg && x.quantity > x.returned_quantity);
    if (!it || targets.length === 0) continue;
    const target = pick(targets.filter((t) => t.variant.id !== it.variant_id)) || targets[0];
    const left = it.quantity - it.returned_quantity;
    const retQty = fromKg ? Math.max(1, Math.min(left, int(50, left))) : 1;
    const newQty = toKg ? Math.min(target.variant.stock_quantity, int(100, 1200)) : 1;
    const payload = {
      original_sale_id: fresh.id,
      return_items: [{ sale_item_id: it.id, quantity: retQty }],
      new_items: [{ variant_id: target.variant.id, quantity: newQty }],
      payment_method: fresh.customer_id && chance(0.4) ? 'debt' : 'cash',
      cash_received_tetri: 10_000_000,
      idempotency_key: key('exch'),
    };
    const r = await must('returns:exchange', payload, ST);
    sales.push(r.new_sale);
    bump(`exchange_${fromKg ? 'kg' : 'piece'}_to_${toKg ? 'kg' : 'piece'}`);
    return r;
  }
}

let correctionSeq = 0;
async function doCorrection() {
  const list = await must('products:list', {}, OT);
  const all = list.flatMap((p) => (p.variants || []).map((v) => ({ v, kg: (p.unit_type || v.unit_type) === 'kg' })));
  // Alternate weighed and piece products.
  const wantKg = correctionSeq++ % 2 === 0;
  const { v, kg } = pick(all.filter((x) => x.kg === wantKg));
  const delta = kg ? int(-300, 300) : int(-2, 2);
  const counted = Math.max(0, v.stock_quantity + delta);
  await must('inventory:correct', { variant_id: v.id, counted_quantity: counted, reason: `სიმულაცია: დათვლა (${delta})` }, OT);
  bump(kg ? 'corrections_kg' : 'corrections_piece');
}

async function snapshot(label) {
  const rec = reconcileDatabase(path.join(dataDir, 'data', 'store.db'));
  const fin = await must('finance:summary', { preset: 'all' }, OT);
  return { label, figures: rec.figures, checks: rec.checks, fin };
}

async function main() {
  const app = await launchApp(exe, dataDir, PORT);
  cdp = app.cdp;
  await cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'first-run owner form');
  await setInput(0, 'სიმულაციის მფლობელი');
  await setInput(1, OWNER_PIN);
  await setInput(2, OWNER_PIN);
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS after owner setup');
  OT = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  const seller = await must('auth:addUser', { name: 'სიმულაციის გამყიდველი', pin: SELLER_PIN, role: 'seller' }, OT);
  sellerId = seller.id;
  ST = (await must('auth:login', { userId: sellerId, pin: SELLER_PIN })).token;

  // ---------------- Catalogue ----------------
  const colors = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];
  const catNames = ['სასმელები', 'რძის ნაწარმი', 'ხორცი', 'ტანსაცმელი', 'ფეხსაცმელი', 'სათამაშოები', 'საყოფაცხოვრებო', 'ხილი და ბოსტნეული'];
  const cats = [];
  for (let i = 0; i < catNames.length; i++) cats.push(await must('products:createCategory', { name: catNames[i], color: colors[i] }, OT));
  let codeSeq = 20000;
  let barSeq = 0;
  for (let i = 0; i < 205; i++) {
    const kg = i % 5 === 0;
    const price = kg ? int(300, 6000) : int(300, 15000);
    const unknownCost = i % 10 === 3;
    const cost = unknownCost ? null : Math.round(price * (0.5 + rnd() * 0.2));
    const nVar = kg ? 1 : i % 7 === 0 ? 3 : i % 11 === 0 ? 2 : 1;
    const variants = [];
    for (let k = 0; k < nVar; k++) {
      const codes = [{ code_type: 'manual_5digit', code_value: String(++codeSeq) }];
      if (!kg && chance(0.3)) codes.push({ code_type: 'barcode', code_value: `486${String(++barSeq).padStart(10, '0')}` });
      variants.push({
        variant_name: nVar === 1 ? 'სტანდარტული' : ['S', 'M', 'L'][k],
        size: nVar === 3 ? ['S', 'M', 'L'][k] : undefined,
        color: nVar === 2 ? ['შავი', 'თეთრი'][k] : undefined,
        initial_stock: kg ? (chance(0.15) ? 0 : int(2000, 20000)) : (chance(0.1) ? 0 : int(3, 40)),
        codes,
      });
    }
    await must('products:create', {
      name: `${kg ? 'წონითი' : 'ცალობითი'} პროდუქტი ${i + 1}`, unit_type: kg ? 'kg' : 'piece',
      category_id: pick(cats).id, base_price_tetri: price, base_cost_tetri: cost, variants,
    }, OT);
    bump(kg ? 'products_kg' : 'products_piece');
    bump('variants', nVar);
  }
  // More FIFO layers at other costs (some unknown).
  {
    const list = await must('products:list', {}, OT);
    const all = list.flatMap((p) => (p.variants || []).map((v) => ({ p, v, kg: p.unit_type === 'kg' })));
    for (let i = 0; i < 80; i++) {
      const { p, v, kg } = pick(all);
      const cost = p.base_cost_tetri == null && chance(0.6) ? null : int(200, kg ? 5000 : 9000);
      await must('inventory:restock', { variant_id: v.id, added_quantity: kg ? int(500, 8000) : int(2, 25), unit_cost_tetri: cost }, OT);
      bump('restocks');
      if (cost === null) bump('restocks_unknown_cost');
    }
  }
  for (let i = 0; i < 15; i++) customers.push(await must('customers:create', { first_name: `კლიენტი ${i + 1}`, phone: `5990000${String(i).padStart(2, '0')}` }, ST));

  // ---------------- Phase A ----------------
  for (let i = 0; i < 70; i++) await doSale({ by: i % 3 === 0 ? 'owner' : 'seller' });
  for (let i = 0; i < 12; i++) await doRepayment();
  for (let i = 0; i < 18; i++) await doReturn();
  await doExchange(false, false);
  await doExchange(true, true);
  await doExchange(false, true);
  await doExchange(true, false);
  for (let i = 0; i < 8; i++) await doCorrection();
  for (let i = 0; i < 5; i++) {
    await must('finance:createExpense', { category: pick(['ქირა', 'კომუნალური', 'ტრანსპორტი', 'სხვა']), description: `ხარჯი ${i + 1}`, amount_tetri: int(500, 20000) }, OT);
    bump('expenses');
  }
  // Debt corrections by the owner
  {
    const reps = [];
    for (const c of customers) for (const r of await must('customers:getRepayments', { customerId: c.id }, OT)) if (!r.voided_at) reps.push(r);
    if (reps.length) { await must('debts:voidRepayment', { repayment_id: pick(reps).id, reason: 'სიმულაცია: შეცდომით შეტანილი' }, OT); bump('voided_repayments'); }
    const list = await must('customers:list', {}, OT);
    for (const c of list.filter((x) => x.total_debt_tetri > 0)) {
      const open = (await must('customers:getActiveSales', { customerId: c.id }, OT)).filter((x) => x.debt_remaining_tetri > 0);
      if (open.length) {
        await must('debts:writeOff', { sale_id: open[0].id, amount_tetri: Math.min(open[0].debt_remaining_tetri, 150), reason: 'სიმულაცია: ჩამოწერა', idempotency_key: key('wo') }, OT);
        bump('write_offs');
        break;
      }
    }
  }
  const midA = await snapshot('after phase A');
  check('phase A reconciles', midA.checks.every((c) => c.ok), JSON.stringify(midA.checks.filter((c) => !c.ok)));

  // ---------------- Backup, more work, restore ----------------
  const backup = await must('backup:create', {}, OT);
  const atBackup = await snapshot('at backup');
  for (let i = 0; i < 10; i++) await doSale({ by: 'seller' });
  await doReturn({ damaged: false });
  await doCorrection();
  const beforeRestore = await snapshot('before restore');
  check('work after the backup changed the figures', beforeRestore.figures.sales > atBackup.figures.sales, `${atBackup.figures.sales} -> ${beforeRestore.figures.sales} sales`);
  const restored = await must('backup:restoreFromList', { filename: backup.backup_filename }, OT);
  check('restore from the backup succeeds', restored.success !== false, restored.message);
  const oldToken = await call('auth:me', {}, OT);
  check('sessions end after a restore', !oldToken.success);
  OT = (await must('auth:login', { userId: 1, pin: OWNER_PIN })).token;
  ST = (await must('auth:login', { userId: sellerId, pin: SELLER_PIN })).token;
  const afterRestore = await snapshot('after restore');
  check('restore brings back exactly the backup\'s data (counts, stock, debts, costs, cash)', JSON.stringify(afterRestore.figures) === JSON.stringify(atBackup.figures),
    JSON.stringify({ backup: atBackup.figures, restored: afterRestore.figures }).slice(0, 600));
  check('restore brings back exactly the backup\'s finance report', JSON.stringify(afterRestore.fin) === JSON.stringify(atBackup.fin));
  // The in-memory list of sales must forget the work undone by the restore.
  const alive = new Set((await must('pos:searchSales', { limit: 1000 }, OT)).map((x) => x.id));
  for (let i = sales.length - 1; i >= 0; i--) if (!alive.has(sales[i].id)) sales.splice(i, 1);

  // ---------------- Phase C (after restore) ----------------
  for (let i = 0; i < 12; i++) await doSale({ by: i % 2 ? 'owner' : 'seller' });
  for (let i = 0; i < 4; i++) await doRepayment();
  for (let i = 0; i < 4; i++) await doReturn();
  await doExchange(false, true);
  await doExchange(true, false);
  for (let i = 0; i < 3; i++) await doCorrection();
  await must('finance:createExpense', { category: 'სხვა', description: 'აღდგენის შემდეგ', amount_tetri: 1234 }, OT);

  // Seller never sees costs (spot check on real responses).
  const sellerViews = JSON.stringify([await must('products:list', {}, ST), await must('pos:searchSales', { limit: 50 }, ST), await must('customers:getActiveSales', { customerId: customers[0].id }, ST)]);
  check('seller responses carry no purchase cost / profit', !/cost|profit|cogs/i.test(sellerViews));

  // ---------------- Final reconciliation ----------------
  const final = await snapshot('final');
  for (const c of final.checks) check(`reconcile: ${c.name}`, c.ok, c.detail);
  const f = final.figures;
  const fin = final.fin;
  check('finance net sales = sales − returns (independent SQL)', fin.net_sales_tetri === f.net_sales_tetri, `${fin.net_sales_tetri} vs ${f.net_sales_tetri}`);
  check('finance cash flow = cash in sales + repayments − cash refunds', fin.net_cash_flow_tetri === f.cash_flow_tetri, `${fin.net_cash_flow_tetri} vs ${f.cash_flow_tetri}`);
  check('finance COGS = sum of consumed parts\' exact costs', fin.cost_of_goods_sold_tetri === f.cogs_known_tetri, `${fin.cost_of_goods_sold_tetri} vs ${f.cogs_known_tetri}`);
  check('finance cost reversed by returns = return lines\' costs', fin.cogs_reversed_by_returns_tetri === f.cost_reversed_tetri, `${fin.cogs_reversed_by_returns_tetri} vs ${f.cost_reversed_tetri}`);
  check('finance stock value (known part) = remaining layer costs', fin.inventory_value_known_tetri === f.stock_value_known_tetri, `${fin.inventory_value_known_tetri} vs ${f.stock_value_known_tetri}`);
  check('finance outstanding debt = open debt balances', fin.outstanding_debt_tetri === f.open_debt_tetri, `${fin.outstanding_debt_tetri} vs ${f.open_debt_tetri}`);
  check('finance expenses = expense rows', fin.total_expenses_tetri === f.expenses_tetri, `${fin.total_expenses_tetri} vs ${f.expenses_tetri}`);
  check('unknown costs are reported, not hidden (some layers had no cost)', fin.has_unknown_costs === true && fin.estimated_gross_profit_tetri === null);
  const minimums = { products: 200, sales: 50 };
  check(`scale: ≥${minimums.products} products, ≥${minimums.sales} sales, pieces and kg`, f.products >= 200 && f.sales >= 50 && (stats.kg_lines || 0) > 0 && (stats.piece_lines || 0) > 0,
    `${f.products} products, ${f.variants} variants, ${f.sales} sales, ${f.returns} returns, ${f.repayments} repayments`);
  const coverage = ['sales_cash', 'sales_debt', 'sales_mixed', 'repayments_specific', 'repayments_fifo', 'returns_kg', 'returns_piece', 'returns_damaged',
    'exchange_piece_to_piece', 'exchange_kg_to_kg', 'exchange_piece_to_kg', 'exchange_kg_to_piece', 'corrections_kg', 'corrections_piece', 'restocks_unknown_cost', 'voided_repayments', 'write_offs'];
  const missing = coverage.filter((k) => !stats[k]);
  check('every operation type happened at least once', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : JSON.stringify(stats));

  const closed = await closeApp(app);
  check('app closes cleanly', closed.clean, `exit code ${closed.exitCode}`);
  const db = new DatabaseSync(path.join(dataDir, 'data', 'store.db'), { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const fk = db.prepare('PRAGMA foreign_key_check').all().length;
  const schema = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  db.close();
  check('after close: integrity_check ok, no foreign-key violations, schema v10', integrity === 'ok' && fk === 0 && schema === 10, `${integrity}, fk ${fk}, v${schema}`);
  fs.writeFileSync(path.join(outDir, 'figures.json'), JSON.stringify({ seed: SEED, stats, final: final.figures, finance: fin }, null, 2));
}

main()
  .catch((err) => check('simulation completed without an exception', false, err.stack || String(err)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(outDir, 'store-simulation.json'), JSON.stringify({ when: new Date().toISOString(), exe, seed: SEED, stats, results }, null, 2));
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    console.log(JSON.stringify(stats));
    process.exit(failed ? 1 : 0);
  });
