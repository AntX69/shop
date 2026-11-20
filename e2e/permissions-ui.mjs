/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Seller permissions in the real StorePOS.exe (isolated profile, never the real store data):
 * the owner creates a seller with only "POS + cash"; the seller logs in with the keyboard and sees
 * only the POS; calls made directly through the renderer bridge (bypassing the UI) are refused by
 * the main process; permissions granted or revoked by the owner change the seller's screens without
 * a new login; a deactivated seller is locked out.
 *
 *   node e2e/permissions-ui.mjs --exe "C:\...\StorePOS.exe" --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'e2e-perm-profile'));
const outDir = path.resolve(arg('out', 'e2e-perm-report'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/permissions-ui.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
const OWNER_PIN = '718293';
const SELLER_PIN = '604215';
const PORT = 9300 + Math.floor(Math.random() * 400);
const NAV = ['სალარო', 'პროდუქცია', 'მარაგები', 'ნისიები', 'ისტორია', 'ფინანსები', 'პერსონალი', 'პარამეტრები'];
const keyOf = (ch) => ({ code: `Digit${ch}`, vk: 48 + Number(ch), text: ch });
const fkey = (n) => ({ key: `F${n}`, code: `F${n}`, vk: 111 + n });

async function setInput(cdp, index, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelectorAll('form input')[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
const visibleTabs = (cdp) => cdp.evaluate(`[...document.querySelectorAll('header nav button')].map((b) => (b.getAttribute('aria-label') || '').replace(/ \\(F\\d\\)$/, ''))`);
const pageText = (cdp) => cdp.evaluate('document.body.innerText');
const buttonState = (cdp, label) => cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(label)}); return b ? { disabled: b.disabled } : null; })()`);
async function clickButton(cdp, label) {
  const ok = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
  if (!ok) throw new Error(`button not found: ${label}`);
}
/** Tab change refreshes the seller's permissions from the main process (auth:me). */
async function refreshScreens(cdp) {
  await cdp.evaluate(`window.dispatchEvent(new Event('focus')), true`);
  await sleep(700);
}

async function main() {
  const app = await launchApp(exe, dataDir, PORT);
  const { cdp } = app;
  await cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'first-run owner form');
  await setInput(cdp, 0, 'ტესტ მფლობელი');
  await setInput(cdp, 1, OWNER_PIN);
  await setInput(cdp, 2, OWNER_PIN);
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS after owner setup');
  const OT = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  check('owner sees all 8 screens', (await visibleTabs(cdp)).join(',') === NAV.join(','), (await visibleTabs(cdp)).join(', '));

  const product = await must(cdp, 'products:create', {
    name: 'ტესტ მაისური', base_price_tetri: 2500, base_cost_tetri: 1200,
    variants: [{ variant_name: 'M', initial_stock: 20, codes: [{ code_type: 'manual_5digit', code_value: '51111' }] }],
  }, OT);
  const customer = await must(cdp, 'customers:create', { first_name: 'ნინო' }, OT);
  const seller = await must(cdp, 'auth:addUser', { name: 'შეზღუდული გამყიდველი', pin: SELLER_PIN, role: 'seller', permissions: ['pos.access', 'sales.cash'] }, OT);
  check('seller created with only POS + cash', seller.permissions.sort().join(',') === 'pos.access,sales.cash');

  // Seller logs in with the keyboard
  await cdp.key('F12', fkey(12));
  await cdp.waitFor(`document.body.innerText.includes('შეზღუდული გამყიდველი')`, 10000, 'login screen');
  await cdp.evaluate(`([...document.querySelectorAll('button')].find(b => b.innerText.includes('შეზღუდული გამყიდველი'))?.click(), true)`);
  await sleep(400);
  for (const d of SELLER_PIN) await cdp.key(d, keyOf(d));
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'seller POS');
  const ST = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  check('seller sees only the POS screen', (await visibleTabs(cdp)).join(',') === 'სალარო', (await visibleTabs(cdp)).join(', '));
  await cdp.key('F2', fkey(2));
  await cdp.key('F6', fkey(6));
  await cdp.key('F7', fkey(7));
  await sleep(500);
  const afterKeys = await pageText(cdp);
  check('F2 / F6 / F7 do not open products, finance or staff', afterKeys.includes('გაყიდვის დადასტურება') && !afterKeys.includes('უფლებების მართვა') && !afterKeys.includes('ფინანსები, მოგება და ხარჯები'));

  // Bypass attempts through the same bridge the UI uses
  const attempts = {
    'products:create': { name: 'x', base_price_tetri: 100, variants: [{ variant_name: 's', codes: [{ code_type: 'manual_5digit', code_value: '52222' }] }] },
    'products:update': { productId: product.id, base_price_tetri: 1 },
    'auth:setUserPermissions': { userId: seller.id, permissions: ['reports.profit', 'products.prices'] },
    'auth:addUser': { name: 'x', pin: '909090', role: 'owner' },
    'finance:summary': { preset: 'today' },
    'customers:list': {},
    'pos:searchSales': {},
    'backup:create': {},
    'backup:restoreFromList': { filename: 'x.db' },
    'auth:getAllUsers': {},
    'inventory:correct': { variant_id: product.variants[0].id, counted_quantity: 0, reason: 'x' },
  };
  const leaks = [];
  for (const [channel, payload] of Object.entries(attempts)) {
    const r = await cdp.ipc(channel, payload, ST);
    if (r.success) leaks.push(channel);
  }
  check(`direct IPC calls outside the seller's permissions are refused (${Object.keys(attempts).length} channels)`, leaks.length === 0, leaks.join(', '));
  const debt = await cdp.ipc('pos:checkout', { items: [{ variant_id: product.variants[0].id, quantity: 1 }], payment_method: 'debt', customer_id: customer.id }, ST);
  check('debt sale through IPC refused (no "sales.debt")', !debt.success && /ნისიით გაყიდვა/.test(debt.error), debt.error);
  const lookup = await must(cdp, 'products:lookupCode', { code: '51111' }, ST);
  check('responses to this seller carry no purchase cost and no stock numbers', !/cost|profit/i.test(JSON.stringify(lookup)) && lookup.variant.stock_quantity === undefined);

  // POS UI for this seller
  for (const ch of '51111') await cdp.key(ch, keyOf(ch));
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`[...document.querySelectorAll('h3')].some((h) => h.innerText.trim() === 'პროდუქტის დადასტურება')`, 8000, 'confirm dialog');
  const confirmText = await cdp.evaluate(`[...document.querySelectorAll('h3')].find((h) => h.innerText.trim() === 'პროდუქტის დადასტურება').closest('.max-w-md').innerText`);
  check('stock shown as a dash, not a number', /ნაშთი მარაგში\s*—/.test(confirmText), confirmText.split('\n').slice(0, 8).join(' | '));
  await clickButton(cdp, 'კალათაში დამატება');
  await sleep(400);
  await cdp.evaluate('document.activeElement && document.activeElement.blur(), true');
  await cdp.key(' ', { code: 'Space', vk: 32, text: ' ' });
  await cdp.waitFor(`document.querySelector('input[aria-label="მიღებული ნაღდი თანხა"]')`, 8000, 'checkout');
  const pay = { cash: await buttonState(cdp, '1. ნაღდი'), debt: await buttonState(cdp, '2. ნისია'), mixed: await buttonState(cdp, '3. შერეული') };
  check('checkout: cash enabled, debt and mixed disabled', pay.cash && !pay.cash.disabled && pay.debt?.disabled && pay.mixed?.disabled, JSON.stringify(pay));
  check('no "new customer" button without "customers.create"', !(await pageText(cdp)).includes('+ ახალი კლიენტი'));
  check('no discount field without "sales.discount"', !(await pageText(cdp)).includes('ფასდაკლება'));
  await clickButton(cdp, 'გაყიდვის დასრულება');
  await sleep(1200);
  const OT2 = (await must(cdp, 'auth:login', { userId: 1, pin: OWNER_PIN })).token;
  const sales = await must(cdp, 'pos:searchSales', { limit: 5 }, OT2);
  check('the seller completed a cash sale through the UI', sales.length === 1 && sales[0].payment_method === 'cash' && sales[0].user_name === 'შეზღუდული გამყიდველი');
  await cdp.key('Escape', { code: 'Escape', vk: 27 });
  await sleep(300);

  // Owner grants more while the seller stays logged in
  await must(cdp, 'auth:setUserPermissions', { userId: seller.id, permissions: ['pos.access', 'sales.cash', 'sales.history', 'returns.process', 'inventory.view'] }, OT2);
  await refreshScreens(cdp);
  const tabs2 = await visibleTabs(cdp);
  check('granted permissions show their screens without a new login', tabs2.join(',') === 'სალარო,მარაგები,ისტორია', tabs2.join(', '));
  await cdp.key('F5', fkey(5));
  await cdp.waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'დაბრუნება')`, 8000, 'history with return button');
  check('history: return button shown, exchange hidden', !!(await buttonState(cdp, 'დაბრუნება')) && !(await buttonState(cdp, 'გაცვლა')));
  await cdp.key('F3', fkey(3));
  await sleep(800);
  const inv = await pageText(cdp);
  check('inventory: no restock / correction buttons, stock as a dash', !(await buttonState(cdp, 'შევსება')) && !(await buttonState(cdp, 'კორექცია')) && inv.includes('—'));

  // Owner revokes everything
  await must(cdp, 'auth:setUserPermissions', { userId: seller.id, permissions: [] }, OT2);
  await refreshScreens(cdp);
  check('all permissions revoked: no screens, a message to ask the owner', (await visibleTabs(cdp)).length === 0 && (await pageText(cdp)).includes('ამ ანგარიშს ჯერ არცერთი უფლება არ აქვს'));
  const afterRevoke = await cdp.ipc('pos:checkout', { items: [{ variant_id: product.variants[0].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 2500 }, ST);
  check('revoked: the same session can no longer sell', !afterRevoke.success);

  // Deactivation locks the seller out
  await must(cdp, 'auth:setUserActive', { userId: seller.id, isActive: false }, OT2);
  await refreshScreens(cdp);
  await cdp.waitFor(`!document.querySelector('header nav')`, 8000, 'login screen after deactivation');
  check('deactivated seller is sent back to the login screen', !(await pageText(cdp)).includes('შეზღუდული გამყიდველი'), 'seller no longer listed');
  await cdp.screenshot(path.join(outDir, 'after-deactivation.png'));

  const closed = await closeApp(app);
  check('app closes cleanly', closed.clean, `exit code ${closed.exitCode}`);
  const db = new DatabaseSync(path.join(dataDir, 'data', 'store.db'), { readOnly: true });
  const audit = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PERMISSIONS_UPDATE'").get().n;
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const pins = JSON.stringify(db.prepare('SELECT * FROM audit_logs').all()) + JSON.stringify(db.prepare('SELECT * FROM system_error_logs').all());
  db.close();
  check('permission changes audited (2), database intact, no PIN in logs', audit === 2 && integrity === 'ok' && !pins.includes(SELLER_PIN) && !pins.includes(OWNER_PIN), `audit ${audit}, ${integrity}`);
}

main()
  .catch((err) => check('test run completed without an exception', false, err.stack || String(err)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(outDir, 'permissions-ui.json'), JSON.stringify({ when: new Date().toISOString(), exe, results }, null, 2));
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
