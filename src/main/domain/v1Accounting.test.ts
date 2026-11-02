/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * StorePOS V1.0 accounting regression suite.
 * Every scenario checks balances directly in SQLite: FIFO layers vs stock counters,
 * COGS reversal on returns, exchange credit vs cash, debt balances, Tbilisi periods.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrations, runMigrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { PosService } from './posService.ts';
import { CustomerService } from './customerService.ts';
import { ReturnsService } from './returnsService.ts';
import { FinanceService } from './financeService.ts';
import { InventoryService } from './inventoryService.ts';
import { resolvePeriod, localDate } from '../../shared/time.ts';
import { allocateProportionally, proratedLineAmount } from '../../shared/money.ts';

let codeSeq = 20000;

function env() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const auth = new AuthService(db);
  const products = new ProductsService(db);
  const pos = new PosService(db);
  const customers = new CustomerService(db);
  const returns = new ReturnsService(db);
  const finance = new FinanceService(db);
  const inventory = new InventoryService(db);
  const owner = auth.setupInitialOwner('მფლობელი', '1111').user;
  const seller = auth.addUser(owner, 'გამყიდველი', '2222', 'seller');

  const product = (name: string, price: number, cost: number | null, stock: number) => {
    const p = products.createProduct(owner, {
      name,
      base_price_tetri: price,
      base_cost_tetri: cost,
      variants: [{ variant_name: 'სტანდარტული', initial_stock: stock, codes: [{ code_type: 'manual_5digit', code_value: String(codeSeq++) }] }],
    });
    return p.variants![0];
  };
  const stockOf = (variantId: number) => (db.prepare('SELECT stock_quantity AS q FROM product_variants WHERE id = ?').get(variantId) as any).q;
  const lotsOf = (variantId: number) => (db.prepare('SELECT COALESCE(SUM(remaining_quantity), 0) AS q FROM inventory_lots WHERE variant_id = ?').get(variantId) as any).q;
  const assertStockMatchesLots = () => assert.deepEqual(inventory.findStockLotMismatches(), []);
  const summary = (preset: any = 'all') => finance.getFinancialSummary(owner, { preset });
  const shiftSale = (saleId: number, iso: string) => db.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(iso, saleId);
  const shiftReturn = (returnId: number, iso: string) => db.prepare('UPDATE returns SET created_at = ? WHERE id = ?').run(iso, returnId);
  const customer = (name: string) => customers.createCustomer(owner, { first_name: name });
  const debtOf = (customerId: number) => customers.getCustomerById(customerId)!.total_debt_tetri;

  return { db, auth, products, pos, customers, returns, finance, inventory, owner, seller, product, stockOf, lotsOf, assertStockMatchesLots, summary, shiftSale, shiftReturn, customer, debtOf };
}

const cash = (variant_id: number, quantity: number, cash_received_tetri: number) => ({
  items: [{ variant_id, quantity }],
  payment_method: 'cash' as const,
  cash_received_tetri,
});

test('money helpers: proportional split and prorated partial returns are exact', () => {
  assert.deepEqual(allocateProportionally(100, [1, 1, 1]), [34, 33, 33]);
  assert.equal(allocateProportionally(999, [5000, 3000, 2000]).reduce((a, b) => a + b, 0), 999);
  assert.deepEqual(allocateProportionally(0, [10, 20]), [0, 0]);
  // 3 units for 10.00 GEL returned one by one: 3.33 + 3.33 + 3.34 = 10.00
  const parts = [proratedLineAmount(1000, 3, 0, 1), proratedLineAmount(1000, 3, 1, 1), proratedLineAmount(1000, 3, 2, 1)];
  assert.deepEqual(parts, [333, 333, 334]);
  assert.equal(proratedLineAmount(1000, 3, 0, 3), 1000);
});

test('F5: sale + resellable return nets to zero and restores the original FIFO cost', () => {
  const e = env();
  const v = e.product('სათამაშო მანქანა', 6000, 2500, 5);
  const sale = e.pos.checkout(e.seller, cash(v.id, 1, 6000));
  const lotBefore = e.db.prepare('SELECT id, remaining_quantity, unit_cost_tetri FROM inventory_lots WHERE variant_id = ?').get(v.id) as any;
  assert.equal(lotBefore.remaining_quantity, 4);

  e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, variant_id: v.id, quantity: 1, condition: 'resellable' }] });

  const lots = e.db.prepare('SELECT id, remaining_quantity, unit_cost_tetri FROM inventory_lots WHERE variant_id = ?').all(v.id) as any[];
  assert.equal(lots.length, 1, 'returned unit goes back into its original layer, no NULL-cost layer is created');
  assert.equal(lots[0].remaining_quantity, 5);
  assert.equal(lots[0].unit_cost_tetri, 2500);
  e.assertStockMatchesLots();

  const s = e.summary('all');
  assert.equal(s.total_sales_revenue_tetri, 6000);
  assert.equal(s.total_returns_amount_tetri, 6000);
  assert.equal(s.net_sales_tetri, 0);
  assert.equal(s.cost_of_goods_sold_tetri, 2500);
  assert.equal(s.cogs_reversed_by_returns_tetri, 2500);
  assert.equal(s.net_cogs_tetri, 0);
  assert.equal(s.estimated_gross_profit_tetri, 0);
  assert.equal(s.net_cash_flow_tetri, 0);
  assert.equal(s.has_unknown_costs, false);

  // Re-selling the returned unit uses the original cost again.
  const resale = e.pos.checkout(e.seller, cash(v.id, 1, 6000));
  assert.equal(resale.items![0].unit_cost_tetri, 2500);
});

test('F6 field report: earlier sales + even exchange + two returns today give correct period figures', () => {
  const e = env();
  const A = e.product('A', 4500, 2500, 5);
  const B = e.product('B', 4500, 2500, 5);
  const C = e.product('C', 4500, 2500, 5);
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();

  const saleA = e.pos.checkout(e.seller, cash(A.id, 1, 4500));
  const saleC = e.pos.checkout(e.seller, cash(C.id, 1, 4500));
  e.shiftSale(saleA.id, yesterday);
  e.shiftSale(saleC.id, yesterday);

  // Today: even exchange A -> B, then B and C are returned.
  const ex = e.returns.processExchange(e.seller, {
    original_sale_id: saleA.id,
    return_items: [{ sale_item_id: saleA.items![0].id, variant_id: A.id, quantity: 1 }],
    new_items: [{ variant_id: B.id, quantity: 1, unit_price_tetri: 4500 }],
  });
  assert.equal(ex.credit_applied_tetri, 4500);
  assert.equal(ex.cash_refund_tetri, 0);
  assert.equal(ex.amount_due_tetri, 0);
  const exSale = ex.new_sale;
  e.returns.processReturn(e.seller, { sale_id: exSale.id, items: [{ sale_item_id: exSale.items[0].id, variant_id: B.id, quantity: 1 }] });
  e.returns.processReturn(e.seller, { sale_id: saleC.id, items: [{ sale_item_id: saleC.items![0].id, variant_id: C.id, quantity: 1 }] });

  const today = e.summary('today');
  assert.equal(today.total_sales_revenue_tetri, 4500, 'gross sales today: the exchange sale');
  assert.equal(today.total_returns_amount_tetri, 13500);
  assert.equal(today.net_sales_tetri, -9000);
  assert.equal(today.cost_of_goods_sold_tetri, 2500);
  assert.equal(today.cogs_reversed_by_returns_tetri, 7500);
  assert.equal(today.net_cogs_tetri, -5000);
  assert.equal(today.estimated_gross_profit_tetri, -4000);
  assert.equal(today.cash_refunded_tetri, 9000, 'only B and C were paid back in cash; the exchange credit is not cash');
  assert.equal(today.net_cash_flow_tetri, -9000);

  const all = e.summary('all');
  assert.equal(all.net_sales_tetri, 0);
  assert.equal(all.net_cogs_tetri, 0);
  assert.equal(all.estimated_gross_profit_tetri, 0);
  assert.equal(all.net_cash_flow_tetri, 0);
  e.assertStockMatchesLots();
  for (const v of [A, B, C]) assert.equal(e.stockOf(v.id), 5);
});

test('F4: even exchange of goods bought on debt keeps the debt; nothing is given for free', () => {
  const e = env();
  const A = e.product('A', 4500, 2000, 3);
  const B = e.product('B', 4500, 2000, 3);
  const cust = e.customer('ნინო');
  const sale = e.pos.checkout(e.seller, { items: [{ variant_id: A.id, quantity: 1 }], payment_method: 'debt', customer_id: cust.id });
  assert.equal(e.debtOf(cust.id), 4500);

  const ex = e.returns.processExchange(e.seller, {
    original_sale_id: sale.id,
    return_items: [{ sale_item_id: sale.items![0].id, variant_id: A.id, quantity: 1 }],
    new_items: [{ variant_id: B.id, quantity: 1, unit_price_tetri: 4500 }],
  });
  assert.equal(e.debtOf(cust.id), 4500, 'debt unchanged');
  assert.equal(ex.new_sale.cash_received_tetri, 0);
  assert.equal(ex.new_sale.exchange_credit_tetri, 4500);
  assert.equal(ex.cash_refund_tetri, 0);
  assert.equal(e.summary('all').net_cash_flow_tetri, 0);
});

test('exchanges on debt: cheaper item reduces the debt, dearer item adds explicit payment', () => {
  const e = env();
  const A = e.product('A', 4500, 2000, 3);
  const cheap = e.product('იაფი', 3000, 1000, 3);
  const dear = e.product('ძვირი', 6000, 3000, 3);
  const cust = e.customer('ლევანი');

  const s1 = e.pos.checkout(e.seller, { items: [{ variant_id: A.id, quantity: 1 }], payment_method: 'debt', customer_id: cust.id });
  e.returns.processExchange(e.seller, {
    original_sale_id: s1.id,
    return_items: [{ sale_item_id: s1.items![0].id, variant_id: A.id, quantity: 1 }],
    new_items: [{ variant_id: cheap.id, quantity: 1, unit_price_tetri: 3000 }],
  });
  assert.equal(e.debtOf(cust.id), 3000, 'customer owes the price of the cheaper item');

  const s2 = e.pos.checkout(e.seller, { items: [{ variant_id: A.id, quantity: 1 }], payment_method: 'debt', customer_id: cust.id });
  assert.throws(() => e.returns.processExchange(e.seller, {
    original_sale_id: s2.id,
    return_items: [{ sale_item_id: s2.items![0].id, variant_id: A.id, quantity: 1 }],
    new_items: [{ variant_id: dear.id, quantity: 1, unit_price_tetri: 6000 }],
    payment_method: 'cash',
  }), /მიუთითეთ კლიენტისგან მიღებული ნაღდი თანხა/);
  const ex = e.returns.processExchange(e.seller, {
    original_sale_id: s2.id,
    return_items: [{ sale_item_id: s2.items![0].id, variant_id: A.id, quantity: 1 }],
    new_items: [{ variant_id: dear.id, quantity: 1, unit_price_tetri: 6000 }],
    payment_method: 'debt',
  });
  assert.equal(ex.amount_due_tetri, 1500);
  assert.equal(e.debtOf(cust.id), 3000 + 4500 + 1500);

  // Cash sale downgraded: the excess is paid back in cash.
  const s3 = e.pos.checkout(e.seller, cash(A.id, 1, 5000));
  const ex3 = e.returns.processExchange(e.seller, {
    original_sale_id: s3.id,
    return_items: [{ sale_item_id: s3.items![0].id, variant_id: A.id, quantity: 1 }],
    new_items: [{ variant_id: cheap.id, quantity: 1 }],
  });
  assert.equal(ex3.cash_refund_tetri, 1500);
  assert.equal(ex3.cash_action, 'store_refunds');
  e.assertStockMatchesLots();
});

test('F2: checkout ignores a client-supplied exchange credit and sale_type', () => {
  const e = env();
  const v = e.product('ქუდი', 6000, 2000, 5);
  assert.throws(() => e.pos.checkout(e.seller, {
    items: [{ variant_id: v.id, quantity: 1 }],
    payment_method: 'cash',
    cash_received_tetri: 0,
    exchange_credit_tetri: 6000,
    sale_type: 'exchange',
  } as any), /ნაკლებია ჯამურ თანხაზე/);
  const sale = e.pos.checkout(e.seller, { ...cash(v.id, 1, 6000), exchange_credit_tetri: 6000, sale_type: 'exchange' } as any);
  assert.equal(sale.sale_type, 'standard');
  assert.equal(sale.exchange_credit_tetri, 0);
  assert.equal(sale.cash_received_tetri, 6000);
});

test('F3: fractional or non-numeric quantities are rejected everywhere', () => {
  const e = env();
  const v = e.product('ფეხსაცმელი', 500, 100, 5);
  assert.throws(() => e.pos.checkout(e.seller, cash(v.id, 0.5, 500)), /მთელი რიცხვი/);
  assert.throws(() => e.pos.checkout(e.seller, cash(v.id, '2' as any, 1000)), /მთელი რიცხვი/);
  assert.throws(() => e.inventory.restockVariant(e.owner, { variant_id: v.id, added_quantity: 1.5 }), /მთელი რიცხვი/);
  assert.throws(() => e.inventory.correctStock(e.owner, { variant_id: v.id, counted_quantity: 2.5, reason: 'დათვლა' }), /მთელი/);
  const sale = e.pos.checkout(e.seller, cash(v.id, 2, 1000));
  assert.throws(() => e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, variant_id: v.id, quantity: 0.5 }] }), /მთელი რიცხვი/);
  assert.equal(e.stockOf(v.id), 3);
});

test('F7: listing the same sale line twice cannot return more than was sold', () => {
  const e = env();
  const v = e.product('ქუდი', 6000, 2000, 5);
  const sale = e.pos.checkout(e.seller, cash(v.id, 1, 6000));
  const line = { sale_item_id: sale.items![0].id, variant_id: v.id, quantity: 1 };
  assert.throws(() => e.returns.processReturn(e.seller, { sale_id: sale.id, items: [line, line] }), /აღემატება დარჩენილ დაბრუნებად რაოდენობას/);
  assert.equal(e.stockOf(v.id), 4);
  assert.equal(e.summary('all').total_returns_amount_tetri, 0);
});

test('F8: stock corrections keep FIFO layers in step and are not sales', () => {
  const e = env();
  const v = e.product('ჭიქა', 1000, 400, 5);
  e.inventory.restockVariant(e.owner, { variant_id: v.id, added_quantity: 3, unit_cost_tetri: 500 });
  e.inventory.correctStock(e.owner, { variant_id: v.id, counted_quantity: 6, reason: 'დათვლა' });
  assert.equal(e.lotsOf(v.id), 6);
  // The two missing units left the oldest layer (cost 400).
  const lots = e.db.prepare('SELECT remaining_quantity, unit_cost_tetri FROM inventory_lots WHERE variant_id = ? ORDER BY id').all(v.id) as any[];
  assert.deepEqual(lots.map((l) => [l.remaining_quantity, l.unit_cost_tetri]), [[3, 400], [3, 500]]);
  e.inventory.correctStock(e.owner, { variant_id: v.id, counted_quantity: 8, reason: 'ნაპოვნი' });
  assert.equal(e.lotsOf(v.id), 8);
  e.assertStockMatchesLots();
  const s = e.summary('all');
  assert.equal(s.total_sales_count, 0);
  assert.equal(s.total_sales_revenue_tetri, 0);
  assert.throws(() => e.inventory.correctStock(e.seller, { variant_id: v.id, counted_quantity: 1, reason: 'x' }), /მხოლოდ მფლობელს/);
});

test('migration repairs legacy data: drifted layers are reconciled', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // Apply up to v5 only, create drift as the old correctStock did, then upgrade.
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
  for (const m of migrations.filter((m) => m.version <= 5)) {
    m.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
  }
  const now = new Date().toISOString();
  db.prepare("INSERT INTO products (name, base_price_tetri, base_cost_tetri, created_at, updated_at) VALUES ('ძველი', 1000, 300, ?, ?)").run(now, now);
  db.prepare("INSERT INTO product_variants (product_id, variant_name, stock_quantity) VALUES (1, 'სტ', 2)").run();
  db.prepare("INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, created_at) VALUES (1, 5, 5, 300, ?)").run(now);
  runMigrations(db);
  const lot = (db.prepare('SELECT SUM(remaining_quantity) AS q FROM inventory_lots WHERE variant_id = 1').get() as any).q;
  assert.equal(lot, 2);
  const view = db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'sale_debt_balances'").get();
  assert.ok(view);
});

test('F9 and Asia/Tbilisi periods: local midnight, not UTC midnight, bounds the day', () => {
  // 2026-11-02 01:30 in Tbilisi is 2026-11-01 21:30 UTC.
  const now = new Date('2026-11-01T21:30:00.000Z');
  const today = resolvePeriod({ preset: 'today' }, now);
  assert.equal(today.from, '2026-11-02');
  assert.equal(today.startUtc, '2026-11-01T20:00:00.000Z');
  assert.equal(today.endUtc, '2026-11-02T20:00:00.000Z');
  const week = resolvePeriod({ preset: 'week' }, now);
  assert.equal(week.from, '2026-11-02', '2026-11-02 is a Monday');
  const month = resolvePeriod({ preset: 'month' }, now);
  assert.equal(month.from, '2026-11-01');
  assert.equal(month.startUtc, '2026-10-31T20:00:00.000Z');
  const lastMonth = resolvePeriod({ preset: 'last_month' }, now);
  assert.deepEqual([lastMonth.from, lastMonth.to], ['2026-10-01', '2026-10-31']);
  assert.equal(localDate(new Date('2026-11-01T19:59:59.000Z')), '2026-11-01');
  assert.equal(localDate(new Date('2026-11-01T20:00:00.000Z')), '2026-11-02');

  const e = env();
  e.finance.createExpense(e.owner, { category: 'ქირა', description: 'დღის ხარჯი', amount_tetri: 1000 });
  assert.equal(e.summary('today').total_expenses_tetri, 1000);
  assert.throws(() => e.finance.createExpense(e.owner, { category: 'x', description: 'y', amount_tetri: 12.5 }), /მთელი რიცხვი/);
});

test('sale in one month and return in the next: each month shows its own side', () => {
  const e = env();
  const v = e.product('კაბა', 10000, 6000, 3);
  const sale = e.pos.checkout(e.seller, cash(v.id, 1, 10000));
  e.shiftSale(sale.id, '2026-10-31T19:00:00.000Z'); // 23:00 on 31 Oct in Tbilisi
  const ret = e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, variant_id: v.id, quantity: 1 }] });
  e.shiftReturn(ret.return_id, '2026-10-31T21:00:00.000Z'); // 01:00 on 1 Nov in Tbilisi

  const oct = e.finance.getFinancialSummary(e.owner, { preset: 'custom', from: '2026-10-01', to: '2026-10-31' });
  const nov = e.finance.getFinancialSummary(e.owner, { preset: 'custom', from: '2026-11-01', to: '2026-11-30' });
  assert.equal(oct.net_sales_tetri, 10000);
  assert.equal(oct.estimated_gross_profit_tetri, 4000);
  assert.equal(nov.net_sales_tetri, -10000);
  assert.equal(nov.net_cogs_tetri, -6000);
  assert.equal(nov.estimated_gross_profit_tetri, -4000, 'a legitimately negative month is not clamped to zero');
  assert.equal(oct.net_cash_flow_tetri + nov.net_cash_flow_tetri, 0);
});

test('discounted goods: owner-only, exact cart split, refunds at the price paid', () => {
  const e = env();
  const a = e.product('A', 3000, 1000, 5);
  const b = e.product('B', 7000, 2000, 5);
  assert.throws(() => e.pos.checkout(e.seller, { items: [{ variant_id: a.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 3000, cart_discount_tetri: 100 }), /მხოლოდ მფლობელს/);
  assert.throws(() => e.pos.checkout(e.seller, { items: [{ variant_id: a.id, quantity: 1, line_discount_tetri: 100 }], payment_method: 'cash', cash_received_tetri: 3000 }), /მხოლოდ მფლობელს/);

  const sale = e.pos.checkout(e.owner, {
    items: [{ variant_id: a.id, quantity: 1 }, { variant_id: b.id, quantity: 1, line_discount_tetri: 1000 }],
    payment_method: 'cash',
    cash_received_tetri: 10000,
    cart_discount_tetri: 900,
    discount_reason: 'მუდმივი კლიენტი',
  });
  assert.equal(sale.subtotal_tetri, 10000);
  assert.equal(sale.discount_tetri, 1900);
  assert.equal(sale.total_tetri, 8100);
  assert.equal(sale.change_given_tetri, 1900);
  const [la, lb] = sale.items!;
  assert.equal(la.total_price_tetri + lb.total_price_tetri, 8100);
  assert.equal(la.unit_price_tetri, 3000, 'list price is kept on the line');

  const r1 = e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: la.id, variant_id: a.id, quantity: 1 }] });
  assert.equal(r1.total_refund_tetri, la.total_price_tetri);
  const r2 = e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: lb.id, variant_id: b.id, quantity: 1 }] });
  assert.equal(r1.total_refund_tetri + r2.total_refund_tetri, 8100);
  assert.equal(e.summary('all').net_sales_tetri, 0);
  assert.equal(e.finance.listDiscounts(e.owner).length, 1);
});

test('partial returns of a multi-unit line never refund fractional tetri', () => {
  const e = env();
  const v = e.product('ბურთი', 1000, 300, 10);
  const sale = e.pos.checkout(e.owner, { items: [{ variant_id: v.id, quantity: 3, line_discount_tetri: 2000 }], payment_method: 'cash', cash_received_tetri: 1000 });
  assert.equal(sale.total_tetri, 1000);
  const line = sale.items![0].id;
  const refunds = [1, 1, 1].map(() => e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: line, variant_id: v.id, quantity: 1 }] }).total_refund_tetri);
  assert.deepEqual(refunds, [333, 333, 334]);
  assert.equal(e.pos.getSaleById(sale.id)!.status, 'returned');
});

test('unknown purchase cost is never 0: profit is null, partial figure flagged', () => {
  const e = env();
  const known = e.product('ცნობილი', 2000, 1200, 5);
  const unknown = e.product('უცნობი', 3000, null, 5);
  e.pos.checkout(e.seller, { items: [{ variant_id: known.id, quantity: 1 }, { variant_id: unknown.id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 8000 });
  const s = e.summary('all');
  assert.equal(s.has_unknown_costs, true);
  assert.equal(s.unknown_cost_items_count, 2);
  assert.equal(s.cost_of_goods_sold_tetri, 1200);
  assert.equal(s.estimated_gross_profit_tetri, null);
  assert.equal(s.operating_result_tetri, null);
  assert.equal(s.gross_profit_partial_tetri, 8000 - 1200);
});

test('damaged return: stock not restored, cost reported as a separate write-off', () => {
  const e = env();
  const v = e.product('სათამაშო', 5000, 3000, 2);
  const sale = e.pos.checkout(e.seller, cash(v.id, 1, 5000));
  e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, variant_id: v.id, quantity: 1, condition: 'damaged' }] });
  assert.equal(e.stockOf(v.id), 1);
  e.assertStockMatchesLots();
  const s = e.summary('all');
  assert.equal(s.net_sales_tetri, 0);
  assert.equal(s.net_cogs_tetri, 0);
  assert.equal(s.estimated_gross_profit_tetri, 0);
  assert.equal(s.damaged_goods_writeoff_tetri, 3000);
  assert.equal(s.operating_result_tetri, -3000, 'the real loss is the cost of the damaged item');
});

test('return on a debt sale reduces that sale debt before any cash refund', () => {
  const e = env();
  const v = e.product('პალტო', 10000, 5000, 3);
  const cust = e.customer('თამარი');
  const sale = e.pos.checkout(e.seller, { items: [{ variant_id: v.id, quantity: 2 }], payment_method: 'mixed', customer_id: cust.id, cash_received_tetri: 5000 });
  assert.equal(e.debtOf(cust.id), 15000);
  const r = e.returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, variant_id: v.id, quantity: 2 }] });
  assert.equal(r.debt_deduction_tetri, 15000);
  assert.equal(r.cash_refund_tetri, 5000);
  assert.equal(e.debtOf(cust.id), 0);
});

test('idempotent retries never double-book checkout, repayment, return or exchange', () => {
  const e = env();
  const v = e.product('სათამაშო', 2000, 1000, 10);
  const w = e.product('სხვა', 2000, 1000, 10);
  const cust = e.customer('გიო');
  const p = { items: [{ variant_id: v.id, quantity: 2 }], payment_method: 'debt' as const, customer_id: cust.id, idempotency_key: 'chk-1' };
  const s1 = e.pos.checkout(e.seller, p);
  const s2 = e.pos.checkout(e.seller, p);
  assert.equal(s1.id, s2.id);
  assert.equal(e.stockOf(v.id), 8);

  const rp = { customer_id: cust.id, amount_tetri: 1000, idempotency_key: 'rep-1' };
  e.customers.recordRepayment(e.seller, rp);
  e.customers.recordRepayment(e.seller, rp);
  assert.equal(e.debtOf(cust.id), 3000);

  const rr = { sale_id: s1.id, items: [{ sale_item_id: s1.items![0].id, variant_id: v.id, quantity: 1 }], idempotency_key: 'ret-1' };
  e.returns.processReturn(e.seller, rr);
  e.returns.processReturn(e.seller, rr);
  assert.equal(e.stockOf(v.id), 9);

  const ex = { original_sale_id: s1.id, return_items: [{ sale_item_id: s1.items![0].id, variant_id: v.id, quantity: 1 }], new_items: [{ variant_id: w.id, quantity: 1 }], idempotency_key: 'exc-1' };
  const e1 = e.returns.processExchange(e.seller, ex);
  const e2 = e.returns.processExchange(e.seller, ex);
  assert.equal(e1.new_sale_id, e2.new_sale_id);
  assert.equal(e.stockOf(w.id), 9);
  assert.equal(e.stockOf(v.id), 10);
  e.assertStockMatchesLots();
});

test('insufficient stock is rejected, also when one variant spans several lines', () => {
  const e = env();
  const v = e.product('ჩანთა', 1000, 500, 3);
  assert.throws(() => e.pos.checkout(e.seller, cash(v.id, 4, 4000)), /არასაკმარისი მარაგი/);
  assert.throws(() => e.pos.checkout(e.seller, { items: [{ variant_id: v.id, quantity: 2 }, { variant_id: v.id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 4000 }), /არასაკმარისი მარაგი/);
  assert.equal(e.stockOf(v.id), 3);
  e.assertStockMatchesLots();
});

test('F12 and debt administration: cross-customer repayment rejected; void and write-off audited', () => {
  const e = env();
  const v = e.product('ქურთუკი', 5000, 2000, 10);
  const c1 = e.customer('პირველი');
  const c2 = e.customer('მეორე');
  const s1 = e.pos.checkout(e.seller, { items: [{ variant_id: v.id, quantity: 1 }], payment_method: 'debt', customer_id: c1.id });
  const s2 = e.pos.checkout(e.seller, { items: [{ variant_id: v.id, quantity: 1 }], payment_method: 'debt', customer_id: c2.id });
  assert.throws(() => e.customers.recordRepayment(e.seller, { customer_id: c1.id, sale_id: s2.id, amount_tetri: 1000 }), /არ ეკუთვნის/);

  const rep = e.customers.recordRepayment(e.seller, { customer_id: c1.id, amount_tetri: 2000 });
  assert.equal(e.debtOf(c1.id), 3000);
  assert.throws(() => e.customers.voidRepayment(e.seller, { repayment_id: rep.id, reason: 'შეცდომა' }), /მხოლოდ მფლობელს/);
  assert.throws(() => e.customers.voidRepayment(e.owner, { repayment_id: rep.id, reason: '' }), /სავალდებულოა/);
  const v1 = e.customers.voidRepayment(e.owner, { repayment_id: rep.id, reason: 'ორჯერ შეიყვანეს' });
  assert.deepEqual([v1.customer_balance_before_tetri, v1.customer_balance_after_tetri], [3000, 5000]);
  assert.throws(() => e.customers.voidRepayment(e.owner, { repayment_id: rep.id, reason: 'კიდევ' }), /უკვე გაუქმებულია/);
  assert.equal(e.summary('all').cash_collected_debts_tetri, 0, 'a voided repayment is not cash');

  assert.throws(() => e.customers.writeOffDebt(e.seller, { sale_id: s2.id, amount_tetri: 1000, reason: 'x' }), /მხოლოდ მფლობელს/);
  assert.throws(() => e.customers.writeOffDebt(e.owner, { sale_id: s2.id, amount_tetri: 6000, reason: 'x' }), /აღემატება/);
  const wo = e.customers.writeOffDebt(e.owner, { sale_id: s2.id, amount_tetri: 1500, reason: 'უიმედო ვალი', idempotency_key: 'wo-1' });
  e.customers.writeOffDebt(e.owner, { sale_id: s2.id, amount_tetri: 1500, reason: 'უიმედო ვალი', idempotency_key: 'wo-1' });
  assert.equal(wo.sale_balance_before_tetri, 5000);
  assert.equal(wo.sale_balance_after_tetri, 3500);
  assert.equal(e.debtOf(c2.id), 3500);
  const ledger = e.customers.getCustomerLedger(c1.id);
  assert.deepEqual(ledger.map((x: any) => x.type), ['sale_debt', 'repayment', 'repayment_void']);
  assert.equal(ledger[ledger.length - 1].running_balance_tetri, 5000);
  const s = e.summary('all');
  assert.equal(s.debt_written_off_tetri, 1500);
  assert.equal(s.outstanding_debt_tetri, 5000 + 3500);
  const audit = e.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('DEBT_REPAYMENT_VOID', 'DEBT_WRITE_OFF')").get() as any;
  assert.equal(audit.n, 2);
  void s1;
});
