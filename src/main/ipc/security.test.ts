/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Security regression suite, exercised through the real IPC dispatcher:
 * server-side role checks, seller data filtering, PIN lockout, session revocation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.STORE_DB_PATH = ':memory:';
process.env.STORE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-security-'));

const { handleIpcMessage } = await import('./handlers.ts');
const { getDb } = await import('../db/database.ts');
const { getActiveSession, SESSION_IDLE_MS, createSession } = await import('../domain/authService.ts');

const ipc = (channel: string, payload?: any, token?: string) => handleIpcMessage({ channel, payload, token });
async function must(channel: string, payload?: any, token?: string) {
  const r = await ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
}

const owner = await must('auth:setupOwner', { name: 'მფლობელი', pin: '1111' });
const OT: string = owner.token;
const sellerUser = await must('auth:addUser', { name: 'გამყიდველი', pin: '2222', role: 'seller' }, OT);
const loginSeller = async () => (await must('auth:login', { userId: sellerUser.id, pin: '2222' })).token as string;
let ST = await loginSeller();

const product = await must('products:create', {
  name: 'სათამაშო', base_price_tetri: 5000, base_cost_tetri: 2000,
  variants: [{ variant_name: 'სტანდარტული', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '54321' }] }],
}, OT);
const variantId = product.variants[0].id;
const customer = await must('customers:create', { first_name: 'კლიენტი' }, ST);

function findSensitiveKeys(value: any, found: string[] = [], at = '$'): string[] {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/cost|profit|cogs|pin_hash|pin_salt/i.test(k)) found.push(`${at}.${k}`);
      findSensitiveKeys(v, found, `${at}.${k}`);
    }
  }
  return found;
}

test('F1: no purchase cost, COGS or profit reaches a seller session', async () => {
  const sale = await must('pos:checkout', { items: [{ variant_id: variantId, quantity: 1 }], payment_method: 'debt', customer_id: customer.id }, ST);
  await must('returns:process', { sale_id: sale.id, items: [{ sale_item_id: sale.items[0].id, variant_id: variantId, quantity: 1 }] }, ST);
  const sale2 = await must('pos:checkout', { items: [{ variant_id: variantId, quantity: 1 }], payment_method: 'debt', customer_id: customer.id }, ST);

  const responses: Record<string, any> = {
    checkout: sale2,
    list: await must('products:list', {}, ST),
    lookup: await must('products:lookupCode', { code: '54321' }, ST),
    byId: await must('products:getById', { productId: product.id }, ST),
    search: await must('pos:searchSales', {}, ST),
    getSale: await must('pos:getSale', { saleId: sale.id }, ST),
    returns: await must('returns:list', {}, ST),
    movements: await must('inventory:getMovements', { limit: 50 }, ST),
    activeSales: await must('customers:getActiveSales', { customerId: customer.id }, ST),
  };
  for (const [name, data] of Object.entries(responses)) {
    assert.deepEqual(findSensitiveKeys(data), [], `${name} leaked sensitive fields`);
  }
  // The owner still sees costs.
  const ownerList = await must('products:list', {}, OT);
  assert.equal(ownerList[0].base_cost_tetri, 2000);
});

test('owner-only channels are refused to sellers on the server', async () => {
  const ownerOnly: Array<[string, any]> = [
    ['finance:summary', { preset: 'today' }],
    ['finance:listExpenses', {}],
    ['finance:exportSalesCSV', {}],
    ['backup:getLogs', {}],
    ['backup:getSettings', {}],
    ['backup:create', {}],
    ['system:getErrorLogs', {}],
    ['auth:getAllUsers', {}],
    ['auth:addUser', { name: 'x', pin: '3333', role: 'owner' }],
    ['auth:resetPin', { userId: owner.user.id, newPin: '9999' }],
    ['inventory:correct', { variant_id: variantId, counted_quantity: 1, reason: 'x' }],
    ['inventory:restock', { variant_id: variantId, added_quantity: 1 }],
    ['products:create', { name: 'x', base_price_tetri: 1, variants: [] }],
    ['debts:writeOff', { sale_id: 1, amount_tetri: 1, reason: 'x' }],
    ['auth:resetStoreDatabase', { pin: '2222' }],
  ];
  for (const [channel, payload] of ownerOnly) {
    const r = await ipc(channel, payload, ST);
    assert.equal(r.success, false, `${channel} must be refused`);
    assert.match(r.error!, /მხოლოდ მფლობელს/);
  }
  const noToken = await ipc('customers:list', {});
  assert.equal(noToken.success, false);
  const unknown = await ipc('fs:readFile', { path: 'C:\\Windows' }, OT);
  assert.match(unknown.error!, /უცნობი IPC არხი/);
  const proto = await ipc('__proto__', {}, OT);
  assert.equal(proto.success, false);
  const badPayload = await handleIpcMessage({ channel: 'customers:list', payload: 'x' as any, token: ST });
  assert.equal(badPayload.success, false);
});

test('PIN hashes never leave the main process; public settings are whitelisted', async () => {
  const users = await must('auth:getAllUsers', {}, OT);
  assert.deepEqual(findSensitiveKeys(users).filter((k) => /pin_/.test(k)), []);
  const active = await must('auth:getActiveUsers', {});
  assert.deepEqual(findSensitiveKeys(active), []);
  const pub = await must('settings:getPublic', {});
  assert.deepEqual(Object.keys(pub).sort(), ['currency', 'inactivity_lock_minutes', 'store_name', 'timezone']);
});

test('F10: wrong PINs lock the account temporarily, persisted in SQLite', async () => {
  for (let i = 1; i <= 4; i++) {
    const r = await ipc('auth:login', { userId: sellerUser.id, pin: '9999' });
    assert.match(r.error!, /დარჩენილი მცდელობა/);
  }
  const fifth = await ipc('auth:login', { userId: sellerUser.id, pin: '9999' });
  assert.match(fifth.error!, /დაიბლოკა/);
  const correctWhileLocked = await ipc('auth:login', { userId: sellerUser.id, pin: '2222' });
  assert.equal(correctWhileLocked.success, false, 'the correct PIN is refused while locked');
  assert.match(correctWhileLocked.error!, /დაბლოკილია/);

  const row = getDb().prepare('SELECT failed_pin_attempts, locked_until FROM users WHERE id = ?').get(sellerUser.id) as any;
  assert.equal(row.failed_pin_attempts, 5);
  assert.ok(Date.parse(row.locked_until) > Date.now());

  await must('auth:unlockUser', { userId: sellerUser.id }, OT);
  ST = await loginSeller();
  const after = getDb().prepare('SELECT failed_pin_attempts FROM users WHERE id = ?').get(sellerUser.id) as any;
  assert.equal(after.failed_pin_attempts, 0);
});

test('F11: deactivation, PIN reset and logout end sessions immediately', async () => {
  await must('auth:setUserActive', { userId: sellerUser.id, isActive: false }, OT);
  const r1 = await ipc('customers:list', {}, ST);
  assert.equal(r1.success, false);
  assert.match(r1.error!, /სესია/);
  const login = await ipc('auth:login', { userId: sellerUser.id, pin: '2222' });
  assert.match(login.error!, /დაბლოკილია/);

  await must('auth:setUserActive', { userId: sellerUser.id, isActive: true }, OT);
  ST = await loginSeller();
  await must('auth:resetPin', { userId: sellerUser.id, newPin: '4444' }, OT);
  assert.equal((await ipc('customers:list', {}, ST)).success, false, 'PIN reset revokes the old session');

  const t = (await must('auth:login', { userId: sellerUser.id, pin: '4444' })).token;
  await must('auth:logout', {}, t);
  assert.equal((await ipc('customers:list', {}, t)).success, false, 'logout (lock) revokes the session');

  const own = await ipc('auth:resetPin', { userId: owner.user.id, newPin: '1212' }, OT);
  assert.match(own.error!, /მიმდინარე PIN/);
  const wrongCurrent = await ipc('auth:changeOwnPin', { currentPin: '0000', newPin: '1212' }, OT);
  assert.equal(wrongCurrent.success, false);
  await must('auth:changeOwnPin', { currentPin: '1111', newPin: '1212' }, OT);
  assert.equal((await ipc('auth:me', {}, OT)).success, true, 'the session that changed the PIN stays valid');
});

test('sessions expire after inactivity', () => {
  const s = createSession({ id: 999, name: 'x', role: 'seller', is_active: 1, created_at: '' });
  assert.ok(getActiveSession(s.token));
  assert.equal(getActiveSession(s.token, Date.now() + SESSION_IDLE_MS + 1000), null);
  assert.equal(getActiveSession(s.token), null, 'an expired session is removed');
});
