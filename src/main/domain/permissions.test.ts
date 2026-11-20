/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Individual seller permissions (V1.1), exercised through the real IPC dispatcher:
 * every channel is checked with a seller who lacks the permission (refused by the main process,
 * whatever the UI shows) and with one who has it; payment methods, specific-receipt repayment,
 * price/cost changes and discounts are checked inside the services; responses hide costs and
 * stock quantities; privilege escalation and owner lockout are refused; PINs never leak;
 * the migration of draft permission IDs keeps RC3 sellers' rights exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

process.env.STORE_DB_PATH = ':memory:';
process.env.STORE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-permissions-'));

const { handleIpcMessage, routeTable, filterResponse } = await import('../ipc/handlers.ts');
const { getDb } = await import('../db/database.ts');
const { AuthService } = await import('./authService.ts');
const { migrations, runMigrations } = await import('../db/migrations.ts');
const { ALL_PERMISSION_IDS, DEFAULT_SELLER_PERMISSIONS, OWNER_ONLY_OPERATIONS, userCan } = await import('../../shared/permissions.ts');

const ipc = (channel: string, payload?: any, token?: string) => handleIpcMessage({ channel, payload, token });
async function must(channel: string, payload?: any, token?: string) {
  const r = await ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
}
const ROUTE_DENIED = 'თქვენ არ გაქვთ ამ მოქმედების შესრულების უფლება';
const OWNER_DENIED = 'მხოლოდ მფლობელს';

const OWNER_PIN = '730591';
const SELLER_PIN = '284716';
const owner = await must('auth:setupOwner', { name: 'მფლობელი', pin: OWNER_PIN });
const OT: string = owner.token;
const auth = new AuthService(getDb());
const ownerUser = auth.getUserById(owner.user.id)!;

const seller = await must('auth:addUser', { name: 'გამყიდველი', pin: SELLER_PIN, role: 'seller' }, OT);
const ST: string = (await must('auth:login', { userId: seller.id, pin: SELLER_PIN })).token;
const grant = (perms: string[]) => auth.setUserPermissions(ownerUser, seller.id, perms);

const piece = await must('products:create', {
  name: 'მაისური', base_price_tetri: 1000, base_cost_tetri: 600,
  variants: [{ variant_name: 'M', initial_stock: 50, codes: [{ code_type: 'manual_5digit', code_value: '41111' }] }],
}, OT);
const pv = piece.variants[0].id;
const customer = await must('customers:create', { first_name: 'ნინო' }, OT);

function keysMatching(value: any, re: RegExp, found: string[] = [], at = '$'): string[] {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (re.test(k)) found.push(`${at}.${k}`);
      keysMatching(v, re, found, `${at}.${k}`);
    }
  }
  return found;
}
const COST_KEYS = /cost|profit|cogs|margin|valuation|inventory_value|operating_result|damaged_goods_writeoff/i;
const STOCK_KEYS = /^(stock_quantity|resulting_stock|remaining_quantity|quantity_change|available_stock)$/;

test('defaults: a new seller gets exactly what an RC3 seller could do', () => {
  assert.deepEqual([...seller.permissions].sort(), [...DEFAULT_SELLER_PERMISSIONS].sort());
  for (const p of ['pos.access', 'sales.cash', 'sales.debt', 'sales.mixed', 'debts.collect', 'returns.process', 'returns.exchange']) {
    assert.equal(auth.hasPermission(seller, p), true, p);
  }
  for (const p of ['sales.discount', 'reports.profit', 'reports.financial', 'products.create', 'inventory.receive', 'categories.manage', 'backups.create']) {
    assert.equal(auth.hasPermission(seller, p), false, p);
  }
  assert.equal(userCan(ownerUser, 'anything.at.all'), true, 'owner always passes');
  for (const p of DEFAULT_SELLER_PERMISSIONS) assert.ok(ALL_PERMISSION_IDS.includes(p), p);
});

test('every IPC channel: refused without the permission, allowed with it (no unlisted open channel)', async () => {
  const OPEN_TO_ANY_USER = new Set(['auth:logout', 'auth:me', 'auth:changeOwnPin', 'products:getCategories', 'ocr:isModelReady', 'ocr:recognize', 'ocr:saveSample']);
  const SKIP_CALL = new Set(['auth:logout']); // would end the test session
  const strong = await must('auth:addUser', { name: 'ყველა უფლებით', pin: '551203', role: 'seller', permissions: ALL_PERMISSION_IDS }, OT);
  const strongToken = (await must('auth:login', { userId: strong.id, pin: '551203' })).token;
  assert.deepEqual([...strong.permissions].sort(), [...ALL_PERMISSION_IDS].sort());

  const routes = routeTable();
  assert.ok(routes.length > 60);
  for (const r of routes) {
    if (r.access === 'public') continue;
    if (r.access === 'owner') {
      assert.ok(OWNER_ONLY_OPERATIONS.includes(r.channel) || r.channel.startsWith('backup:') || r.channel.startsWith('system:'), `${r.channel} owner-only but not listed`);
      const res = await ipc(r.channel, {}, strongToken);
      assert.equal(res.success, false, `${r.channel}: a seller with every grantable permission must still be refused`);
      assert.match(res.error!, new RegExp(OWNER_DENIED), r.channel);
      continue;
    }
    if (!r.permission) {
      assert.ok(OPEN_TO_ANY_USER.has(r.channel), `${r.channel} is open to every user without a permission`);
      continue;
    }
    const required = typeof r.permission === 'string' ? [r.permission] : [...r.permission];
    for (const p of required) assert.ok(ALL_PERMISSION_IDS.includes(p), `${r.channel}: unknown permission ${p}`);
    if (SKIP_CALL.has(r.channel)) continue;

    grant([]);
    const denied = await ipc(r.channel, {}, ST);
    assert.equal(denied.success, false, `${r.channel} must be refused without ${required.join('/')}`);
    assert.ok(denied.error!.includes(ROUTE_DENIED), `${r.channel}: ${denied.error}`);

    grant([required[0]]);
    const passed = await ipc(r.channel, {}, ST);
    assert.ok(!(passed.error || '').includes(ROUTE_DENIED), `${r.channel} must pass the gate with ${required[0]}: ${passed.error}`);
  }
  grant([...DEFAULT_SELLER_PERMISSIONS]);
});

test('payment methods are separate permissions, checked in the main process', async () => {
  const sale = (payment_method: string, extra: any = {}) =>
    ipc('pos:checkout', { items: [{ variant_id: pv, quantity: 1 }], payment_method, ...extra }, ST);
  grant(['pos.access']);
  assert.match((await sale('cash', { cash_received_tetri: 1000 })).error!, /ნაღდი გაყიდვა/);
  grant(['pos.access', 'sales.cash']);
  assert.equal((await sale('cash', { cash_received_tetri: 1000 })).success, true);
  assert.match((await sale('debt', { customer_id: customer.id })).error!, /ნისიით გაყიდვა/);
  assert.match((await sale('mixed', { customer_id: customer.id, cash_received_tetri: 400 })).error!, /შერეული გადახდა/);
  grant(['pos.access', 'sales.debt']);
  assert.equal((await sale('debt', { customer_id: customer.id })).success, true);
  grant(['pos.access', 'sales.mixed']);
  assert.equal((await sale('mixed', { customer_id: customer.id, cash_received_tetri: 400 })).success, true);
  grant(['sales.cash', 'sales.debt', 'sales.mixed']);
  assert.ok((await sale('cash', { cash_received_tetri: 1000 })).error!.includes(ROUTE_DENIED), 'no POS access, no sale');
});

test('discounts need sales.discount', async () => {
  grant(['pos.access', 'sales.cash']);
  const lower = await ipc('pos:checkout', { items: [{ variant_id: pv, quantity: 1, unit_price_tetri: 900 }], payment_method: 'cash', cash_received_tetri: 1000 }, ST);
  assert.equal(lower.success, false);
  const cartDiscount = await ipc('pos:checkout', { items: [{ variant_id: pv, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 1000, cart_discount_tetri: 100 }, ST);
  assert.equal(cartDiscount.success, false);
  grant(['pos.access', 'sales.cash', 'sales.discount']);
  const ok = await ipc('pos:checkout', { items: [{ variant_id: pv, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 1000, cart_discount_tetri: 100 }, ST);
  assert.equal(ok.success, true, ok.error);
  assert.equal(ok.data.total_tetri, 900);
});

test('repayment: automatic (oldest first) with debts.collect; a chosen receipt needs debts.select_receipt', async () => {
  const debtSale = await must('pos:checkout', { items: [{ variant_id: pv, quantity: 2 }], payment_method: 'debt', customer_id: customer.id }, OT);
  grant(['debts.collect']);
  const chosen = await ipc('customers:repay', { customer_id: customer.id, amount_tetri: 100, sale_id: debtSale.id }, ST);
  assert.equal(chosen.success, false);
  assert.match(chosen.error!, /კონკრეტული ჩეკის დაფარვა/);
  assert.equal((await ipc('customers:repay', { customer_id: customer.id, amount_tetri: 100 }, ST)).success, true);
  grant(['debts.collect', 'debts.select_receipt']);
  assert.equal((await ipc('customers:repay', { customer_id: customer.id, amount_tetri: 100, sale_id: debtSale.id }, ST)).success, true);
  grant(['debts.view']);
  assert.ok((await ipc('customers:repay', { customer_id: customer.id, amount_tetri: 100 }, ST)).error!.includes(ROUTE_DENIED));
});

test('product edits: price needs products.prices, cost needs reports.profit, only when they change', async () => {
  const full = await must('products:getById', { productId: piece.id }, OT);
  grant(['products.view', 'products.edit']);
  const rename = await ipc('products:update', { productId: piece.id, name: 'მაისური ბამბის', base_price_tetri: full.base_price_tetri, category_id: null }, ST);
  assert.equal(rename.success, true, rename.error);
  assert.match((await ipc('products:update', { productId: piece.id, base_price_tetri: 1200 }, ST)).error!, /ფასის შეცვლის უფლება/);
  assert.match((await ipc('products:update', { productId: piece.id, base_cost_tetri: 1 }, ST)).error!, /თვითღირებულების შეცვლის უფლება/);
  assert.match((await ipc('products:update', { productId: piece.id, base_cost_tetri: null }, ST)).error!, /თვითღირებულების შეცვლის უფლება/, 'a cost the seller cannot see is not wiped');
  const after = await must('products:getById', { productId: piece.id }, OT);
  assert.equal(after.base_price_tetri, 1000);
  assert.equal(after.base_cost_tetri, 600);
  grant(['products.view', 'products.edit', 'products.prices']);
  assert.equal((await ipc('products:update', { productId: piece.id, base_price_tetri: 1000 }, ST)).success, true);
  // Variants
  grant(['products.view', 'products.variants']);
  assert.match((await ipc('products:updateVariant', { variantId: pv, price_override_tetri: 1500 }, ST)).error!, /ფასის შეცვლის უფლება/);
  assert.match((await ipc('products:updateVariant', { variantId: pv, cost_override_tetri: 1 }, ST)).error!, /თვითღირებულების შეცვლის უფლება/);
  assert.equal((await ipc('products:updateVariant', { variantId: pv, size: 'M', price_override_tetri: null }, ST)).success, true);
  grant(['products.view', 'products.edit']);
  assert.ok((await ipc('products:updateVariant', { variantId: pv, size: 'L' }, ST)).error!.includes(ROUTE_DENIED), 'variants are their own permission');
});

test('exchange paid on debt needs sales.debt too', async () => {
  // A sale on a customer, so that the only reason to refuse is the missing permission.
  const sale = await must('pos:checkout', { items: [{ variant_id: pv, quantity: 1 }], payment_method: 'debt', customer_id: customer.id }, OT);
  const dearer = await must('products:create', {
    name: 'ქურთუკი', base_price_tetri: 5000,
    variants: [{ variant_name: 'L', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '43333' }] }],
  }, OT);
  const exchange = () => ipc('returns:exchange', {
    original_sale_id: sale.id,
    return_items: [{ sale_item_id: sale.items[0].id, variant_id: pv, quantity: 1 }],
    new_items: [{ variant_id: dearer.variants[0].id, quantity: 1 }],
    payment_method: 'debt',
    idempotency_key: `perm-exchange-${Date.now()}-${Math.random()}`,
  }, ST);
  grant(['returns.exchange']);
  const refused = await exchange();
  assert.equal(refused.success, false);
  assert.match(refused.error!, /ნისიით გაყიდვა/);
  const stock = (await must('products:getById', { productId: dearer.id }, OT)).variants[0].stock_quantity;
  assert.equal(stock, 5, 'refused exchange changed nothing');
  grant(['returns.exchange', 'sales.debt']);
  const ok = await exchange();
  assert.equal(ok.success, true, ok.error);
  assert.ok(ok.data.amount_due_tetri > 0);
});

test('responses: costs only with reports.profit, stock numbers only with inventory.quantities', async () => {
  grant(['products.view']);
  const list = await must('products:list', {}, ST);
  assert.deepEqual(keysMatching(list, COST_KEYS), []);
  assert.deepEqual(keysMatching(list, STOCK_KEYS), [], 'no stock numbers without inventory.quantities');
  grant(['products.view', 'inventory.quantities']);
  const withStock = await must('products:list', {}, ST);
  assert.ok(keysMatching(withStock, STOCK_KEYS).length > 0);
  assert.deepEqual(keysMatching(withStock, COST_KEYS), []);
  grant(['products.view', 'reports.profit']);
  const withCost = await must('products:getById', { productId: piece.id }, ST);
  assert.equal(withCost.base_cost_tetri, 600);

  grant(['inventory.view']);
  const moves = await must('inventory:getMovements', { limit: 20 }, ST);
  assert.ok(moves.length > 0);
  assert.deepEqual(keysMatching(moves, COST_KEYS), []);
  assert.deepEqual(keysMatching(moves, STOCK_KEYS), []);

  grant(['reports.financial']);
  const fin = await must('finance:summary', { preset: 'today' }, ST);
  assert.deepEqual(keysMatching(fin, COST_KEYS), [], 'financial report without profit/COGS');
  assert.ok(typeof fin.net_sales_tetri === 'number' && typeof fin.net_cash_flow_tetri === 'number', 'turnover and cash flow are there');
  // Service level too (not only the IPC filter): no figure derived from purchase costs.
  const { FinanceService, PROFIT_FIELDS } = await import('./financeService.ts');
  const direct = new FinanceService(getDb()).getFinancialSummary(auth.getUserById(seller.id)!, { preset: 'today' }) as any;
  for (const k of PROFIT_FIELDS) assert.equal(k in direct, false, k);
  const ownerFin = await must('finance:summary', { preset: 'today' }, OT);
  assert.ok(keysMatching(ownerFin, COST_KEYS).length > 0, 'owner sees COGS/profit');

  grant(['sales.history']);
  const sales = await must('pos:searchSales', {}, ST);
  assert.deepEqual(keysMatching(sales, COST_KEYS), []);
  grant([...DEFAULT_SELLER_PERMISSIONS]);
});

test('the response filter uses the request user and never queries the database per object', () => {
  // A user that does not exist in SQLite: if the filter looked permissions up, it would deny.
  const ghost = { id: 999999, name: 'x', role: 'seller', permissions: ['reports.profit'], is_active: 1, created_at: '' } as any;
  const big = Array.from({ length: 20000 }, (_, i) => ({ id: i, unit_cost_tetri: 5, stock_quantity: 3, pin_hash: 'h' }));
  const t0 = performance.now();
  const out = filterResponse(big, ghost);
  const ms = performance.now() - t0;
  assert.equal(out[0].unit_cost_tetri, 5, 'decided from the request user');
  assert.equal(out[0].stock_quantity, undefined, 'no inventory.quantities');
  assert.equal(out[0].pin_hash, undefined);
  assert.ok(ms < 1500, `20 000 objects filtered in ${ms.toFixed(0)} ms`);
});

test('privilege escalation is refused', async () => {
  const self = await ipc('auth:setUserPermissions', { userId: seller.id, permissions: ALL_PERMISSION_IDS }, ST);
  assert.match(self.error!, new RegExp(OWNER_DENIED));
  assert.match((await ipc('auth:addUser', { name: 'x', pin: '901234', role: 'owner' }, ST)).error!, new RegExp(OWNER_DENIED));
  assert.throws(() => grant(['owner.staff']), /უცნობი ან გადაუცემადი უფლება/);
  assert.throws(() => grant(['reports.profit', 'admin.everything']), /უცნობი ან გადაუცემადი/);
  assert.deepEqual(auth.getUserPermissions(seller.id).sort(), [...DEFAULT_SELLER_PERMISSIONS].sort(), 'nothing stored after a refused update');
  assert.throws(() => auth.setUserPermissions(ownerUser, ownerUser.id, []), /მფლობელის უფლებების შეზღუდვა შეუძლებელია/);
  assert.throws(() => auth.setUserPermissions(auth.getUserById(seller.id)!, seller.id, ALL_PERMISSION_IDS), new RegExp(OWNER_DENIED));
  assert.throws(() => auth.addUser(ownerUser, 'x', '901234', 'admin' as any), /როლი/);
  // Archived products stay hidden unless the seller may archive/restore.
  const archived = await must('products:create', { name: 'ძველი', base_price_tetri: 100, variants: [{ variant_name: 's', codes: [{ code_type: 'manual_5digit', code_value: '44444' }] }] }, OT);
  await must('products:setActive', { productId: archived.id, isActive: false }, OT);
  const hidden = await must('products:list', { archivedOnly: true }, ST);
  assert.ok(!hidden.some((p: any) => p.id === archived.id));
  grant(['products.view', 'products.archive']);
  const visible = await must('products:list', { archivedOnly: true }, ST);
  assert.ok(visible.some((p: any) => p.id === archived.id));
  grant([...DEFAULT_SELLER_PERMISSIONS]);
});

test('owner lockout is prevented', async () => {
  assert.match((await ipc('auth:setUserActive', { userId: ownerUser.id, isActive: false }, OT)).error!, /საკუთარი თავის დაბლოკვა/);
  assert.match((await ipc('auth:resetPin', { userId: ownerUser.id, newPin: '111222' }, OT)).error!, /მიმდინარე PIN/);
  const second = await must('auth:addUser', { name: 'მეორე მფლობელი', pin: '660913', role: 'owner' }, OT);
  const secondToken = (await must('auth:login', { userId: second.id, pin: '660913' })).token;
  await must('auth:setUserActive', { userId: second.id, isActive: false }, OT);
  assert.equal((await ipc('auth:me', {}, secondToken)).success, false, 'deactivated owner session ends');
  const sole = new AuthService(getDb());
  assert.throws(() => sole.setUserActive(auth.getUserById(second.id)!, ownerUser.id, false));
  assert.equal(auth.getUserById(ownerUser.id)!.is_active, 1);
});

test('permission changes apply to the next request without logging in again; deactivation ends the session', async () => {
  grant(['pos.access', 'sales.cash']);
  assert.equal((await ipc('customers:list', {}, ST)).success, false);
  grant(['pos.access', 'sales.cash', 'debts.view']);
  assert.equal((await ipc('customers:list', {}, ST)).success, true);
  const me = await must('auth:me', {}, ST);
  assert.deepEqual([...me.permissions].sort(), ['debts.view', 'pos.access', 'sales.cash']);
  grant([...DEFAULT_SELLER_PERMISSIONS]);
  const temp = await must('auth:addUser', { name: 'დროებითი', pin: '480157', role: 'seller' }, OT);
  const tempToken = (await must('auth:login', { userId: temp.id, pin: '480157' })).token;
  await must('auth:setUserActive', { userId: temp.id, isActive: false }, OT);
  assert.equal((await ipc('pos:searchSales', {}, tempToken)).success, false);
});

test('permission changes are audited with what was added and removed', () => {
  grant(['pos.access', 'reports.export']);
  const row = getDb().prepare("SELECT user_id, details FROM audit_logs WHERE action = 'PERMISSIONS_UPDATE' ORDER BY id DESC LIMIT 1").get() as any;
  assert.equal(row.user_id, ownerUser.id);
  const d = JSON.parse(row.details);
  assert.deepEqual(d.after, ['pos.access', 'reports.export']);
  assert.ok(d.added.includes('reports.export'));
  assert.ok(d.removed.includes('sales.cash'));
  grant([...DEFAULT_SELLER_PERMISSIONS]);
});

test('PINs are never returned, logged or stored in plain text', async () => {
  const wrong = await ipc('auth:changeOwnPin', { currentPin: '999111', newPin: '123987' }, ST);
  assert.equal(wrong.success, false);
  await must('auth:resetPin', { userId: seller.id, newPin: '552019' }, OT);
  const responses = [
    await must('auth:getAllUsers', {}, OT),
    await must('auth:getActiveUsers', {}),
    (await ipc('auth:login', { userId: seller.id, pin: '552019' })).data,
    await must('auth:me', {}, OT),
    await must('auth:getUserPermissions', { userId: seller.id }, OT),
    await must('backup:getLogs', { limit: 500 }, OT),
    await must('system:getErrorLogs', { limit: 500 }, OT),
  ];
  const text = JSON.stringify(responses);
  for (const pin of [OWNER_PIN, SELLER_PIN, '552019', '999111', '123987']) {
    assert.ok(!text.includes(pin), `PIN ${pin} appeared in a response or log`);
  }
  assert.deepEqual(keysMatching(responses, /pin_hash|pin_salt|^pin$/), []);
  const rows = getDb().prepare('SELECT pin_hash, pin_salt FROM users').all() as any[];
  for (const r of rows) {
    assert.match(r.pin_hash, /^pbkdf2-sha256\$\d+\$[0-9a-f]{64}$/, 'salted PBKDF2 hash');
    for (const pin of [OWNER_PIN, SELLER_PIN, '552019']) assert.ok(!String(r.pin_hash).includes(pin));
  }
  const dbText = JSON.stringify(getDb().prepare('SELECT details FROM audit_logs').all()) + JSON.stringify(getDb().prepare('SELECT * FROM system_error_logs').all());
  for (const pin of [OWNER_PIN, SELLER_PIN, '552019', '999111', '123987']) assert.ok(!dbText.includes(pin), `PIN ${pin} in a log table`);
});

test('a new store has no users and no default PIN', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const fresh = new AuthService(db);
  assert.equal(fresh.hasOwner(), false);
  assert.deepEqual(fresh.getActiveUsers(), []);
  for (const pin of ['0000', '1234', '1111', '123456']) {
    assert.throws(() => fresh.login(1, pin), /ვერ მოიძებნა/);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM users').get() as any).n, 0);
  db.close();
});

test('migration 9: draft permission IDs become the V1.1 list; RC3 sellers keep exactly their rights', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  const now = new Date().toISOString();
  const addUser = (name: string, role: string) => Number(db.prepare(
    "INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES (?, ?, 'x', 'y', 1, ?)"
  ).run(name, role, now).lastInsertRowid);
  const rc3Seller = addUser('RC3 გამყიდველი', 'seller');
  const custom = addUser('Gemini-ს მორგებული', 'seller');
  const ownerId = addUser('მფლობელი', 'owner');
  // Migration 7's defaults (what an RC3 seller received on upgrade)
  const v7Defaults = ['sales.create', 'sales.view_history', 'sales.return', 'sales.exchange', 'customers.view', 'customers.create', 'customers.edit', 'debts.create', 'debts.view', 'debts.repayment', 'products.view', 'inventory.view', 'inventory.view_movements', 'categories.view'];
  const ins = db.prepare('INSERT INTO user_permissions (user_id, permission, created_at) VALUES (?, ?, ?)');
  for (const p of v7Defaults) ins.run(rc3Seller, p, now);
  for (const p of ['reports.financial', 'products.change_cost', 'categories.delete', 'made.up']) ins.run(custom, p, now);
  ins.run(ownerId, 'sales.create', now);

  migrations.find((m) => m.version === 9)!.up(db);
  const permsOf = (id: number) => (db.prepare('SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission').all(id) as any[]).map((r) => r.permission);
  assert.deepEqual(permsOf(rc3Seller), [...DEFAULT_SELLER_PERMISSIONS].sort());
  assert.deepEqual(permsOf(custom), ['categories.manage', 'reports.financial', 'reports.profit'], 'draft financial report included profit; cost editing and unknown IDs are dropped');
  assert.deepEqual(permsOf(ownerId), [], 'owners need no rows');
  for (const id of [rc3Seller, custom]) for (const p of permsOf(id)) assert.ok(ALL_PERMISSION_IDS.includes(p), p);
  db.close();
});
