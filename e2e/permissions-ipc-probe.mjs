/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Black-box permission probe of the real StorePOS.exe (isolated test profile, never the
 * store's). The list of IPC channels is read from the program itself (the route table inside
 * resources/app.asar -> dist-electron/main.cjs), not from the source code, and every channel is
 * called from inside the app's page - exactly what a manipulated screen could do - as:
 * no session, a forged session, a seller with no permission, a seller with every permission a
 * seller can be given. Then realistic privilege-escalation attempts with real payloads, live
 * revocation, PIN brute force, owner lock-out, and a scan of every response, the audit/error
 * logs and the program's own output for PINs and PIN hashes.
 *
 *   node e2e/permissions-ipc-probe.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'probe-profile'));
const outDir = path.resolve(arg('out', 'probe-report'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/permissions-ipc-probe.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>');
  process.exit(2);
}
if (fs.existsSync(path.join(dataDir, 'data', 'store.db'))) {
  console.error(`refusing to run: ${dataDir} already contains a store database`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const dbFile = path.join(dataDir, 'data', 'store.db');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- the program's own route table ----
const asarFile = path.join(path.dirname(exe), 'resources', 'app.asar');
const mainJs = asar.extractFile(asarFile, path.join('dist-electron', 'main.cjs')).toString();
const routes = [...mainJs.matchAll(/"([a-z]+:[A-Za-z]+)":\{access:"(public|user|owner)"/g)].map((m) => ({ channel: m[1], access: m[2] }));
const byChannel = new Map(routes.map((r) => [r.channel, r]));

// Channels any signed-in user may call (own session, own PIN, category names, handwriting OCR).
const OPEN_TO_ANY_USER = new Set(['auth:logout', 'auth:me', 'auth:changeOwnPin', 'products:getCategories', 'ocr:isModelReady', 'ocr:recognize', 'ocr:saveSample']);
const GRANTABLE = ['pos.access', 'sales.cash', 'sales.debt', 'sales.mixed', 'customers.create', 'sales.discount', 'debts.view', 'debts.history', 'debts.collect', 'debts.select_receipt', 'debts.correct',
  'sales.history', 'returns.process', 'returns.exchange', 'inventory.view', 'inventory.quantities', 'inventory.receive', 'inventory.adjust',
  'products.view', 'products.create', 'products.edit', 'products.prices', 'products.variants', 'products.archive',
  'reports.financial', 'reports.profit', 'reports.export', 'expenses.manage', 'categories.manage', 'backups.create'];
const ROUTE_DENIED = 'თქვენ არ გაქვთ ამ მოქმედების შესრულების უფლება';
const OWNER_DENIED = 'მხოლოდ მფლობელს';
const PINS = { owner: '738291', none: '561937', all: '846203', def: '492750', editor: '615384' };
const responses = []; // every response, for the PIN scan

async function main() {
  check('route table read from the shipped program', routes.length >= 70 && routes.filter((r) => r.access === 'owner').length >= 15,
    `${routes.length} channels: ${routes.filter((r) => r.access === 'owner').length} owner-only, ${routes.filter((r) => r.access === 'public').length} public`);

  const app = await launchApp(exe, dataDir, 9780 + Math.floor(Math.random() * 60));
  const cdp = app.cdp;
  const call = async (channel, payload, token) => {
    const r = await cdp.ipc(channel, payload, token);
    responses.push({ channel, r });
    return r;
  };
  const must = async (channel, payload, token) => {
    const r = await call(channel, payload, token);
    if (!r.success) throw new Error(`${channel}: ${r.error}`);
    return r.data;
  };

  // ---- a small shop ----
  const owner = await must('auth:setupOwner', { name: 'მფლობელი', pin: PINS.owner });
  const OT = owner.token;
  const mk = async (name, pin, permissions) => {
    const u = await must('auth:addUser', { name, pin, role: 'seller', permissions }, OT);
    return { ...u, token: (await must('auth:login', { userId: u.id, pin })).token };
  };
  const none = await mk('უფლებების გარეშე', PINS.none, []);
  const all = await mk('ყველა უფლებით', PINS.all, GRANTABLE);
  const def = await mk('ჩვეულებრივი გამყიდველი', PINS.def, undefined);
  const editor = await mk('რედაქტორი', PINS.editor, ['products.view', 'products.edit']);
  check('a seller can be given at most the 30 grantable permissions', JSON.stringify([...all.permissions].sort()) === JSON.stringify([...GRANTABLE].sort()), `${all.permissions.length}`);
  const ownerCaps = await call('auth:addUser', { name: 'X', pin: '902817', role: 'seller', permissions: ['owner.staff', 'owner.backup_restore', 'owner.settings'] }, OT);
  const capsGranted = ownerCaps.success ? (await must('auth:getUserPermissions', { userId: ownerCaps.data.id }, OT)) : [];
  check('owner-only capabilities (staff, restore, settings) cannot be given to a seller, not even by the owner', !ownerCaps.success || capsGranted.every((p) => !p.startsWith('owner.')), ownerCaps.success ? `granted: ${capsGranted.join(',') || 'none'}` : ownerCaps.error);

  const product = await must('products:create', { name: 'ზონდი', base_price_tetri: 1000, base_cost_tetri: 600,
    variants: [{ variant_name: 'სტ', initial_stock: 100, codes: [{ code_type: 'manual_5digit', code_value: '47111' }] }] }, OT);
  const customer = await must('customers:create', { first_name: 'ლია' }, OT);
  await must('pos:checkout', { items: [{ variant_id: product.variants[0].id, quantity: 2 }], payment_method: 'debt', customer_id: customer.id }, OT);
  await must('finance:createExpense', { category: 'იჯარა', description: 'ტესტი', amount_tetri: 1000 }, OT);
  const backup = await must('backup:create', {}, OT);

  const snapshot = () => {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const q = (sql) => JSON.stringify(db.prepare(sql).all());
    const s = {
      users: q('SELECT id, name, role, is_active, pin_hash, pin_salt FROM users ORDER BY id'),
      permissions: q('SELECT * FROM user_permissions ORDER BY 1, 2'),
      settings: q("SELECT key, value FROM app_settings WHERE key NOT IN ('last_backup_date', 'last_auto_backup_date') ORDER BY key"),
      products: q('SELECT id, name, base_price_tetri, base_cost_tetri, is_active FROM products ORDER BY id'),
      sales: q('SELECT id, total_tetri FROM sales ORDER BY id'),
    };
    db.close();
    return s;
  };
  // (the daily automatic backup may run meanwhile; it is not part of this test)
  const backupFiles = () => fs.readdirSync(path.join(dataDir, 'data', 'backups')).filter((f) => !f.startsWith('storepos_auto_')).sort().join(',');
  const before = snapshot();
  const backupsBefore = backupFiles();

  // ---- every channel, every caller ----
  const problems = [];
  const skip = new Set(['auth:logout', 'auth:login', 'auth:setupOwner']);
  for (const r of routes) {
    if (r.access === 'public' || skip.has(r.channel)) continue;
    for (const [who, token] of [['no session', undefined], ['forged session', crypto.randomBytes(32).toString('hex')]]) {
      const res = await call(r.channel, {}, token);
      if (res.success) problems.push(`${r.channel} answered with ${who}`);
    }
    const resNone = await call(r.channel, {}, none.token);
    if (r.access === 'owner' && (resNone.success || !String(resNone.error).includes(OWNER_DENIED))) problems.push(`${r.channel} (owner-only) not refused for a seller without permissions: ${resNone.error}`);
    if (r.access === 'user' && !OPEN_TO_ANY_USER.has(r.channel) && (resNone.success || !String(resNone.error).includes(ROUTE_DENIED))) problems.push(`${r.channel} not refused for a seller without permissions: ${resNone.success ? 'success' : resNone.error}`);
    if (r.access === 'owner') {
      const resAll = await call(r.channel, {}, all.token);
      if (resAll.success || !String(resAll.error).includes(OWNER_DENIED)) problems.push(`${r.channel} (owner-only) not refused for a seller with every permission: ${resAll.error}`);
    }
  }
  check('every channel refuses a missing or forged session; owner-only channels refuse every seller; other channels refuse a seller without the permission',
    problems.length === 0, problems.length ? problems.slice(0, 6).join(' | ') : `${routes.length} channels × 4 callers`);

  // ---- escalation attempts with real payloads, by the seller with every permission ----
  const attempts = [
    ['auth:setUserPermissions', { userId: all.id, permissions: [...GRANTABLE, 'owner.staff', 'owner.backup_restore', 'owner.settings'] }],
    ['auth:addUser', { name: 'ახალი მფლობელი', pin: '119922', role: 'owner' }],
    ['auth:resetPin', { userId: owner.user.id, newPin: '111222' }],
    ['auth:setUserActive', { userId: owner.user.id, isActive: false }],
    ['auth:unlockUser', { userId: def.id }],
    ['auth:getAllUsers', {}],
    ['auth:getUserPermissions', { userId: owner.user.id }],
    ['backup:updateSettings', { settings: { auto_backup_enabled: '0', backup_retention_count: '3' } }],
    ['backup:restoreFromList', { filename: backup.backup_filename }],
    ['backup:restore', { base64Data: Buffer.from('{}').toString('base64') }],
    ['backup:runDaily', {}],
    ['auth:resetStoreDatabase', { pin: PINS.owner }],
    ['system:clearErrorLogs', {}],
  ];
  const escalated = [];
  for (const [channel, payload] of attempts) {
    const res = await call(channel, payload, all.token);
    if (res.success) escalated.push(channel);
  }
  // own-PIN change aimed at the owner's account
  const ownPin = await call('auth:changeOwnPin', { userId: owner.user.id, currentPin: PINS.all, newPin: '204816' }, all.token);
  const ownerStillLogsIn = await call('auth:login', { userId: owner.user.id, pin: PINS.owner });
  const sellerNewPin = await call('auth:login', { userId: all.id, pin: '204816' });
  check('escalation attempts by a seller with every permission are all refused (staff, owner role, owner PIN, restore, settings, wipe with the owner\'s PIN)',
    escalated.length === 0, escalated.length ? `went through: ${escalated.join(', ')}` : `${attempts.length} attempts refused`);
  check('"change own PIN" aimed at the owner changes only the caller\'s own PIN', ownPin.success && ownerStillLogsIn.success && sellerNewPin.success, ownPin.error || '');
  all.token = sellerNewPin.data?.token || all.token;

  // field-level checks inside the services
  const priceByEditor = await call('products:update', { productId: product.id, base_price_tetri: 1 }, editor.token);
  const costByEditor = await call('products:update', { productId: product.id, base_cost_tetri: 1 }, editor.token);
  const discountByDefault = await call('pos:checkout', { items: [{ variant_id: product.variants[0].id, quantity: 1, unit_price_tetri: 1 }], payment_method: 'cash', cash_received_tetri: 1000 }, def.token);
  const financeByDefault = await call('finance:summary', { preset: 'all' }, def.token);
  check('a seller who may edit products cannot change price or cost; a default seller cannot discount or open finance',
    !priceByEditor.success && !costByEditor.success && !discountByDefault.success && !financeByDefault.success,
    [priceByEditor.error, costByEditor.error, discountByDefault.error, financeByDefault.error].join(' | '));

  const after = snapshot();
  const changedTables = Object.keys(before).filter((k) => k !== 'users' && before[k] !== after[k]);
  const usersBefore = JSON.parse(before.users).filter((u) => u.id !== all.id);
  const usersAfter = JSON.parse(after.users).filter((u) => u.id !== all.id);
  check('nothing changed in users (except the caller\'s own PIN), permissions, settings, products or sales; no backup was restored',
    changedTables.length === 0 && JSON.stringify(usersBefore) === JSON.stringify(usersAfter) && backupFiles() === backupsBefore, changedTables.join(', '));

  // ---- live revocation, deactivation ----
  const fin1 = await call('finance:summary', { preset: 'all' }, all.token);
  await must('auth:setUserPermissions', { userId: all.id, permissions: GRANTABLE.filter((p) => p !== 'reports.financial') }, OT);
  const fin2 = await call('finance:summary', { preset: 'all' }, all.token);
  await must('auth:setUserActive', { userId: def.id, isActive: false }, OT);
  const afterDeactivate = await call('products:lookupCode', { code: '47111' }, def.token);
  const loginDeactivated = await call('auth:login', { userId: def.id, pin: PINS.def });
  check('a removed permission stops working on the next request (same session); a deactivated seller\'s session and sign-in are refused',
    fin1.success && !fin2.success && !afterDeactivate.success && !loginDeactivated.success, [fin2.error, afterDeactivate.error, loginDeactivated.error].join(' | '));

  // ---- PIN brute force against the owner, owner lock-out ----
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push(await call('auth:login', { userId: owner.user.id, pin: String(100000 + i) }));
  const lockedEvenWithRightPin = await call('auth:login', { userId: owner.user.id, pin: PINS.owner });
  check('guessing the owner\'s PIN locks the account after 5 wrong PINs (even the right PIN waits)', tries.every((t) => !t.success) && !lockedEvenWithRightPin.success && /დაბლოკ/.test(lockedEvenWithRightPin.error || ''), lockedEvenWithRightPin.error);
  const selfBlock = await call('auth:setUserActive', { userId: owner.user.id, isActive: false }, OT);
  const selfLimit = await call('auth:setUserPermissions', { userId: owner.user.id, permissions: [] }, OT);
  const ownerStillWorks = await call('finance:summary', { preset: 'all' }, OT);
  check('the owner cannot lock themselves out (deactivate self, limit own rights); the owner\'s session keeps working', !selfBlock.success && !selfLimit.success && ownerStillWorks.success, [selfBlock.error, selfLimit.error].join(' | '));

  // owner-side reads, for the scan
  for (const ch of ['auth:getAllUsers', 'auth:me', 'backup:getSettings', 'backup:getLogs', 'system:getErrorLogs', 'backup:list']) await call(ch, { limit: 500 }, OT);
  for (const u of [none, all, def, editor]) await call('auth:getUserPermissions', { userId: u.id }, OT);
  await call('auth:getActiveUsers', {});
  await call('auth:me', {}, none.token);

  // ---- PIN / hash scan ----
  const pinValues = Object.values(PINS).concat(['204816', '111222', '119922']);
  const leaks = [];
  for (const { channel, r } of responses) {
    const text = JSON.stringify(r);
    for (const pin of pinValues) if (text.includes(pin)) leaks.push(`${channel}: PIN ${pin}`);
    const keys = [];
    (function walk(v, at) {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/pin_hash|pin_salt|^pin$|password/i.test(k)) keys.push(`${at}.${k}`); walk(x, `${at}.${k}`); }
    })(r, '$');
    if (keys.length) leaks.push(`${channel}: ${keys.join(',')}`);
  }
  await closeApp(app);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const logText = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()) + JSON.stringify(db.prepare('SELECT * FROM system_error_logs').all());
  const hashes = db.prepare('SELECT pin_hash FROM users').all().map((u) => u.pin_hash);
  db.close();
  const appOut = app.log.join('');
  for (const pin of pinValues) {
    if (logText.includes(`"${pin}"`) || new RegExp(`\\b${pin}\\b`).test(logText)) leaks.push(`audit/error log: PIN ${pin}`);
    if (new RegExp(`\\b${pin}\\b`).test(appOut)) leaks.push(`program output: PIN ${pin}`);
  }
  for (const h of hashes) if (logText.includes(h) || appOut.includes(h) || responses.some(({ r }) => JSON.stringify(r).includes(h))) leaks.push('a PIN hash appears in a response or log');
  check('no PIN or PIN hash in any of the responses, the audit and error logs, or the program\'s output', leaks.length === 0, leaks.length ? leaks.slice(0, 6).join(' | ') : `${responses.length} responses scanned`);

  fs.writeFileSync(path.join(outDir, 'probe-report.json'), JSON.stringify({ exe, date: new Date().toISOString(), routes, results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} permission probe checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('probe aborted:', err);
  fs.writeFileSync(path.join(outDir, 'probe-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
