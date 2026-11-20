/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Kilogram products and exact FIFO costs: line prices, COGS (the draft counted grams × price per
 * kg = 1000× too much), partial layers without drift, partial and damaged weight returns,
 * unknown costs, stock valuation, corrections, cross-unit exchanges, unit change guard and the
 * migration of existing piece data.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, migrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { InventoryService } from './inventoryService.ts';
import { PosService } from './posService.ts';
import { ReturnsService } from './returnsService.ts';
import { FinanceService } from './financeService.ts';
import { allocateLayerCost, returnedPartCost, layerCost } from './fifo.ts';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const auth = new AuthService(db);
  const owner = auth.setupInitialOwner('მფლობელი', '1234').user;
  return {
    db, owner,
    products: new ProductsService(db),
    inventory: new InventoryService(db),
    pos: new PosService(db),
    returns: new ReturnsService(db),
    finance: new FinanceService(db),
  };
}
type Env = ReturnType<typeof setup>;

let code = 60000;
function kgProduct(env: Env, opts: { price: number; cost?: number | null; grams?: number; name?: string }) {
  return env.products.createProduct(env.owner, {
    name: opts.name || `ყველი ${code}`, unit_type: 'kg', base_price_tetri: opts.price, base_cost_tetri: opts.cost ?? null,
    variants: [{ variant_name: 'სტანდარტული', initial_stock: opts.grams ?? 0, codes: [{ code_type: 'manual_5digit', code_value: String(++code) }] }],
  } as any);
}
function pieceProduct(env: Env, opts: { price: number; cost?: number | null; stock?: number; name?: string }) {
  return env.products.createProduct(env.owner, {
    name: opts.name || `მაისური ${code}`, base_price_tetri: opts.price, base_cost_tetri: opts.cost ?? null,
    variants: [{ variant_name: 'M', initial_stock: opts.stock ?? 0, codes: [{ code_type: 'manual_5digit', code_value: String(++code) }] }],
  } as any);
}
const sell = (env: Env, items: Array<{ variant_id: number; quantity: number }>, extra: any = {}) =>
  env.pos.checkout(env.owner, { items, payment_method: 'cash', cash_received_tetri: 10_000_000, ...extra } as any);
const summary = (env: Env) => env.finance.getFinancialSummary(env.owner, { preset: 'all' } as any) as any;
const lots = (env: Env, variantId: number) =>
  env.db.prepare('SELECT initial_quantity, remaining_quantity, initial_cost_tetri, remaining_cost_tetri FROM inventory_lots WHERE variant_id = ? ORDER BY id').all(variantId) as any[];
const stockOf = (env: Env, variantId: number) => (env.db.prepare('SELECT stock_quantity FROM product_variants WHERE id = ?').get(variantId) as any).stock_quantity;

test('fifo helpers: exact remainder, cumulative returns, layer cost per kg', () => {
  assert.equal(allocateLayerCost(800, 1000, 375), 300);
  assert.equal(allocateLayerCost(799, 1000, 333), 266, '266.067 -> 266');
  assert.equal(allocateLayerCost(533, 667, 333), 266, 'second third');
  assert.equal(allocateLayerCost(267, 334, 334), 267, 'the last part takes exactly what is left');
  assert.equal(allocateLayerCost(null, 10, 3), null, 'unknown stays unknown');
  assert.equal(allocateLayerCost(1000, 10, 3), 300, 'pieces: unit × quantity');
  // returns of a 300-tetri, 375 g part: 100 g, then 100 g, then the rest
  const r1 = returnedPartCost(300, 375, 0, 0, 100)!;
  const r2 = returnedPartCost(300, 375, 100, r1, 100)!;
  const r3 = returnedPartCost(300, 375, 200, r1 + r2, 175)!;
  assert.deepEqual([r1, r2, r3], [80, 80, 140]);
  assert.equal(r1 + r2 + r3, 300);
  assert.equal(layerCost(799, 1000, 'kg'), 799);
  assert.equal(layerCost(799, 333, 'kg'), 266);
  assert.equal(layerCost(null, 333, 'kg'), null);
  assert.equal(layerCost(1500, 4, 'piece'), 6000);
});

test('kg sale: price 12.50/kg × 0.375 kg = 4.69; COGS 8.00/kg × 0.375 kg = 3.00 (not 3 000)', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1250, cost: 800, grams: 5000 });
  const v = p.variants![0].id;
  const sale = sell(env, [{ variant_id: v, quantity: 375 }]);
  assert.equal(sale.total_tetri, 469);
  assert.equal(stockOf(env, v), 4625);
  const s = summary(env);
  assert.equal(s.cost_of_goods_sold_tetri, 300);
  assert.equal(s.net_sales_tetri, 469);
  assert.equal(s.estimated_gross_profit_tetri, 169);
  const item = env.db.prepare('SELECT unit_cost_tetri FROM sale_items WHERE sale_id = ?').get(sale.id) as any;
  assert.equal(item.unit_cost_tetri, 800, 'average cost shown per kg');
  assert.deepEqual(lots(env, v).map((l) => [l.remaining_quantity, l.remaining_cost_tetri]), [[4625, 3700]]);
});

test('partial layers: three sales of one kilogram layer add up to exactly what it cost (no drift)', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1500, cost: null });
  const v = p.variants![0].id;
  env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 1000, unit_cost_tetri: 799 } as any);
  for (const g of [333, 333, 334]) sell(env, [{ variant_id: v, quantity: g }]);
  const parts = env.db.prepare('SELECT cost_tetri FROM sale_item_lots ORDER BY id').all() as any[];
  assert.deepEqual(parts.map((r) => r.cost_tetri), [266, 266, 267]);
  assert.equal(summary(env).cost_of_goods_sold_tetri, 799);
  assert.deepEqual(lots(env, v).map((l) => [l.remaining_quantity, l.remaining_cost_tetri]), [[0, 0]]);
});

test('a sale across several layers takes each layer at its own cost', () => {
  const env = setup();
  const p = kgProduct(env, { price: 2000, cost: null });
  const v = p.variants![0].id;
  env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 500, unit_cost_tetri: 1000 } as any); // 500
  env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 700, unit_cost_tetri: 1200 } as any); // 840
  env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 300, unit_cost_tetri: 1333 } as any); // 400 (399.9)
  assert.deepEqual(lots(env, v).map((l) => l.initial_cost_tetri), [500, 840, 400]);
  const sale = sell(env, [{ variant_id: v, quantity: 1350 }]); // 500 g + 700 g + 150 g
  const parts = env.db.prepare('SELECT quantity, cost_tetri FROM sale_item_lots ORDER BY id').all() as any[];
  assert.deepEqual(parts.map((r) => [r.quantity, r.cost_tetri]), [[500, 500], [700, 840], [150, 200]]);
  assert.equal(summary(env).cost_of_goods_sold_tetri, 1540);
  assert.equal(sale.total_tetri, 2700);
  assert.equal(summary(env).inventory_value_tetri, 200, 'what is left: 150 g of the last layer');
});

test('partial weight returns: limited to what is left; refunds and costs add up exactly', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1250, cost: 800, grams: 2000 });
  const v = p.variants![0].id;
  const sale = sell(env, [{ variant_id: v, quantity: 1000 }]); // 12.50, cost 8.00
  const itemId = sale.items![0].id;
  const r1 = env.returns.processReturn(env.owner, { sale_id: sale.id, items: [{ sale_item_id: itemId, quantity: 200 }] } as any);
  assert.equal(r1.total_refund_tetri, 250);
  assert.throws(() => env.returns.processReturn(env.owner, { sale_id: sale.id, items: [{ sale_item_id: itemId, quantity: 801 }] } as any), /აღემატება/);
  assert.throws(() => env.returns.processReturn(env.owner, { sale_id: sale.id, items: [{ sale_item_id: itemId, quantity: 0 }] } as any));
  const r2 = env.returns.processReturn(env.owner, { sale_id: sale.id, items: [{ sale_item_id: itemId, quantity: 333 }] } as any);
  const r3 = env.returns.processReturn(env.owner, { sale_id: sale.id, items: [{ sale_item_id: itemId, quantity: 467 }] } as any);
  assert.equal(r1.total_refund_tetri + r2.total_refund_tetri + r3.total_refund_tetri, 1250, 'refunds = what was paid');
  const s = summary(env);
  assert.equal(s.cost_of_goods_sold_tetri, 800);
  assert.equal(s.cogs_reversed_by_returns_tetri, 800, 'returned costs = sold cost');
  assert.equal(s.net_cogs_tetri, 0);
  assert.equal(s.net_sales_tetri, 0);
  assert.equal(stockOf(env, v), 2000);
  assert.deepEqual(lots(env, v).map((l) => [l.remaining_quantity, l.remaining_cost_tetri]), [[2000, 1600]], 'original cost basis restored');
  assert.equal((env.db.prepare('SELECT status FROM sales WHERE id = ?').get(sale.id) as any).status, 'returned');
});

test('a returned weight sells again at its original cost', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1000, cost: null });
  const v = p.variants![0].id;
  env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 1000, unit_cost_tetri: 700 } as any);
  env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 1000, unit_cost_tetri: 900 } as any);
  const s1 = sell(env, [{ variant_id: v, quantity: 600 }]); // from layer 1: 420
  env.returns.processReturn(env.owner, { sale_id: s1.id, items: [{ sale_item_id: s1.items![0].id, quantity: 600 }] } as any);
  sell(env, [{ variant_id: v, quantity: 1000 }]); // layer 1 again, whole: 700
  const last = env.db.prepare('SELECT cost_tetri FROM sale_item_lots ORDER BY id DESC LIMIT 1').get() as any;
  assert.equal(last.cost_tetri, 700);
  assert.equal(summary(env).net_cogs_tetri, 700);
});

test('damaged weight return: not back on the shelf, its cost is a write-off', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1250, cost: 800, grams: 1000 });
  const v = p.variants![0].id;
  const sale = sell(env, [{ variant_id: v, quantity: 500 }]);
  env.returns.processReturn(env.owner, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, quantity: 250, condition: 'damaged' }] } as any);
  assert.equal(stockOf(env, v), 500);
  const s = summary(env);
  assert.equal(s.damaged_goods_writeoff_tetri, 200);
  assert.equal(s.damaged_goods_grams, 250);
  assert.equal(s.damaged_goods_units, 0);
  assert.equal(s.inventory_value_tetri, 400);
  const mv = env.db.prepare("SELECT unit_type, quantity_change, reason FROM inventory_movements WHERE movement_type = 'return'").get() as any;
  assert.equal(mv.unit_type, 'kg');
  assert.equal(mv.quantity_change, 0);
  assert.match(mv.reason, /0\.250 კგ/);
});

test('unknown cost stays unknown: counted in grams, profit and stock value not invented', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1000, cost: null, grams: 2000 });
  const v = p.variants![0].id;
  sell(env, [{ variant_id: v, quantity: 750 }]);
  const s = summary(env);
  assert.equal(s.cost_of_goods_sold_tetri, 0);
  assert.equal(s.unknown_cost_grams, 750);
  assert.equal(s.unknown_cost_items_count, 0, 'grams are not counted as pieces');
  assert.equal(s.has_unknown_costs, true);
  assert.equal(s.estimated_gross_profit_tetri, null);
  assert.equal(s.inventory_value_tetri, null);
  assert.equal(s.inventory_unknown_cost_grams, 1250);
});

test('stock correction: a shortfall leaves at exact layer cost, a surplus is added at the card cost per kg', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1000, cost: 600, grams: 1000 }); // 600
  const v = p.variants![0].id;
  env.inventory.correctStock(env.owner, { variant_id: v, counted_quantity: 700, reason: 'შეშრა' } as any);
  assert.deepEqual(lots(env, v).map((l) => [l.remaining_quantity, l.remaining_cost_tetri]), [[700, 420]]);
  const down = env.db.prepare("SELECT cost_total_tetri, unit_cost_tetri FROM inventory_movements WHERE movement_type = 'correction'").get() as any;
  assert.equal(down.cost_total_tetri, -180);
  assert.equal(down.unit_cost_tetri, 600, 'per kg');
  env.inventory.correctStock(env.owner, { variant_id: v, counted_quantity: 950, reason: 'ნაპოვნი' } as any);
  assert.deepEqual(lots(env, v).map((l) => [l.remaining_quantity, l.remaining_cost_tetri]), [[700, 420], [250, 150]]);
  assert.equal(summary(env).inventory_value_tetri, 570);
});

test('stock value reconciles: received − sold + returned to shelf − shortfall = what is left', () => {
  const env = setup();
  const k = kgProduct(env, { price: 1999, cost: null });
  const pc = pieceProduct(env, { price: 2500, cost: 1100, stock: 30 });
  const kv = k.variants![0].id;
  const pv = pc.variants![0].id;
  env.inventory.restockVariant(env.owner, { variant_id: kv, added_quantity: 1234, unit_cost_tetri: 777 } as any);
  env.inventory.restockVariant(env.owner, { variant_id: kv, added_quantity: 987, unit_cost_tetri: 1333 } as any);
  const a = sell(env, [{ variant_id: kv, quantity: 555 }, { variant_id: pv, quantity: 3 }]);
  const b = sell(env, [{ variant_id: kv, quantity: 999 }]);
  env.returns.processReturn(env.owner, { sale_id: b.id, items: [{ sale_item_id: b.items![0].id, quantity: 123 }] } as any);
  env.returns.processReturn(env.owner, { sale_id: a.id, items: [{ sale_item_id: a.items![1].id, quantity: 1, condition: 'damaged' }] } as any);
  env.inventory.correctStock(env.owner, { variant_id: kv, counted_quantity: 700, reason: 'აწონვა' } as any);
  const totals = env.db.prepare('SELECT COALESCE(SUM(cost_total_tetri), 0) AS net, COUNT(*) AS n, SUM(cost_total_tetri IS NULL) AS unknown FROM inventory_movements').get() as any;
  assert.equal(totals.unknown, 0);
  const value = summary(env).inventory_value_tetri;
  assert.equal(totals.net, value, 'sum of every movement\'s cost effect = stock value');
  const shelf = env.db.prepare('SELECT SUM(remaining_quantity) AS q FROM inventory_lots WHERE variant_id = ?').get(kv) as any;
  assert.equal(shelf.q, stockOf(env, kv));
  assert.equal(stockOf(env, kv), 700);
});

test('exchanges across units are settled by value: piece↔piece, kg↔kg, piece→kg, kg→piece', () => {
  const env = setup();
  const shirt = pieceProduct(env, { price: 3000, cost: 1500, stock: 10 });
  const cap = pieceProduct(env, { price: 2000, cost: 900, stock: 10 });
  const cheese = kgProduct(env, { price: 2000, cost: 1200, grams: 5000 });
  const ham = kgProduct(env, { price: 3000, cost: 2000, grams: 5000 });
  const sv = shirt.variants![0].id, cv = cap.variants![0].id, chv = cheese.variants![0].id, hv = ham.variants![0].id;
  const ex = (saleId: number, itemId: number, retQty: number, newVariant: number, newQty: number) =>
    env.returns.processExchange(env.owner, {
      original_sale_id: saleId,
      return_items: [{ sale_item_id: itemId, quantity: retQty }],
      new_items: [{ variant_id: newVariant, quantity: newQty }],
      payment_method: 'cash', cash_received_tetri: 100000,
    } as any);

  const s1 = sell(env, [{ variant_id: sv, quantity: 1 }]);
  const e1 = ex(s1.id, s1.items![0].id, 1, cv, 1); // 30.00 -> 20.00: 10.00 back
  assert.equal(e1.cash_refund_tetri, 1000);

  const s2 = sell(env, [{ variant_id: chv, quantity: 500 }]); // 10.00
  const e2 = ex(s2.id, s2.items![0].id, 500, hv, 250); // 10.00 -> 7.50
  assert.equal(e2.new_items_value_tetri, 750);
  assert.equal(e2.cash_refund_tetri, 250);

  const s3 = sell(env, [{ variant_id: sv, quantity: 1 }]); // 30.00
  const e3 = ex(s3.id, s3.items![0].id, 1, chv, 1750); // -> 35.00: customer adds 5.00
  assert.equal(e3.new_items_value_tetri, 3500);
  assert.equal(e3.amount_due_tetri, 500);

  const s4 = sell(env, [{ variant_id: hv, quantity: 400 }]); // 12.00
  const e4 = ex(s4.id, s4.items![0].id, 400, cv, 1); // -> 20.00: customer adds 8.00
  assert.equal(e4.amount_due_tetri, 800);

  assert.equal(stockOf(env, chv), 5000 - 500 + 500 - 1750);
  assert.equal(stockOf(env, hv), 5000 - 250 - 400 + 400);
  const s = summary(env);
  // COGS of what is finally out: cap 2 × 9.00, ham 250 g × 20.00/kg, cheese 1750 g × 12.00/kg
  assert.equal(s.net_cogs_tetri, 1800 + 500 + 2100);
  const mvs = env.db.prepare("SELECT im.unit_type FROM inventory_movements im JOIN product_variants pv ON pv.id = im.variant_id WHERE pv.id IN (?, ?)").all(chv, hv) as any[];
  assert.ok(mvs.every((m) => m.unit_type === 'kg'), 'weight movements recorded as kg');
});

test('discounted kg line: the line costs what the lower kg price gives', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1250, cost: 800, grams: 1000 });
  const sale = env.pos.checkout(env.owner, { items: [{ variant_id: p.variants![0].id, quantity: 375, unit_price_tetri: 1000 }], payment_method: 'cash', cash_received_tetri: 1000 } as any);
  assert.equal(sale.total_tetri, 375, '10.00/kg × 0.375 kg');
});

test('unit change is refused once a product has stock, history or sales', () => {
  const env = setup();
  const fresh = pieceProduct(env, { price: 100, cost: null, stock: 0 });
  const changed = env.products.updateProduct(env.owner, { productId: fresh.id, unit_type: 'kg' } as any);
  assert.equal(changed.unit_type, 'kg', 'no stock and no history: allowed');
  const stocked = pieceProduct(env, { price: 100, cost: null, stock: 10 });
  assert.throws(() => env.products.updateProduct(env.owner, { productId: stocked.id, unit_type: 'kg' } as any), /ერთეულის \(ცალი\/კგ\) შეცვლა შეუძლებელია/);
  env.inventory.correctStock(env.owner, { variant_id: stocked.variants![0].id, counted_quantity: 0, reason: 'x' } as any);
  assert.throws(() => env.products.updateProduct(env.owner, { productId: stocked.id, unit_type: 'kg' } as any), /შეუძლებელია/, 'history alone is enough');
  assert.equal(stockOf(env, stocked.variants![0].id), 0);
});

test('weights are validated: whole grams, positive, within limits', () => {
  const env = setup();
  const p = kgProduct(env, { price: 1000, cost: 500, grams: 1000 });
  const v = p.variants![0].id;
  for (const bad of [0, -5, 1.5, 10_000_001]) {
    assert.throws(() => sell(env, [{ variant_id: v, quantity: bad }]), String(bad));
  }
  assert.throws(() => sell(env, [{ variant_id: v, quantity: 1001 }]), /მარაგ/);
  assert.throws(() => env.inventory.restockVariant(env.owner, { variant_id: v, added_quantity: 0.5 } as any));
  const big = kgProduct(env, { price: 100, cost: null, grams: 250_000 });
  assert.equal(stockOf(env, big.variants![0].id), 250_000, 'initial stock above 100 kg (250 kg) is accepted for weight products');
});

test('migration 10: existing piece layers get costs equal to unit × quantity; history untouched', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const auth = new AuthService(db);
  const owner = auth.setupInitialOwner('მფლობელი', '1234').user;
  const products = new ProductsService(db);
  const pos = new PosService(db);
  const p = products.createProduct(owner, { name: 'ძველი', base_price_tetri: 2000, base_cost_tetri: 1100, variants: [{ variant_name: 's', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '69999' }] }] } as any);
  const sale = pos.checkout(owner, { items: [{ variant_id: p.variants![0].id, quantity: 3 }], payment_method: 'cash', cash_received_tetri: 6000 } as any);
  // Pretend this data was written by RC3 (no cost columns filled), then run migration 10 again.
  db.exec('UPDATE inventory_lots SET initial_cost_tetri = NULL, remaining_cost_tetri = NULL; UPDATE sale_item_lots SET cost_tetri = NULL, returned_cost_tetri = 0;');
  const beforeSale = JSON.stringify(db.prepare('SELECT * FROM sale_items').all());
  migrations.find((m) => m.version === 10)!.up(db);
  const lot = db.prepare('SELECT initial_cost_tetri, remaining_cost_tetri FROM inventory_lots').get() as any;
  assert.deepEqual([lot.initial_cost_tetri, lot.remaining_cost_tetri], [11000, 7700]);
  const part = db.prepare('SELECT cost_tetri FROM sale_item_lots WHERE sale_item_id = ?').get(sale.items![0].id) as any;
  assert.equal(part.cost_tetri, 3300);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM sale_items').all()), beforeSale, 'sales history not modified');
  db.close();
});
