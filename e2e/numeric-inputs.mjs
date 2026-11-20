/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Numeric fields in the real StorePOS.exe, typed with keyboard events through the Chrome
 * DevTools Protocol (isolated profile, never the real store data):
 * focus selects the old value, one key replaces it, Backspace empties the field without a 0
 * coming back, an empty quantity blocks "add to cart", comma works as the decimal point for
 * weight, Tab moves on, cash typed at checkout, an emptied stock count is refused (not saved as
 * 0 kg), a real 0 kg count is accepted, and a partial weight return is limited to what is left.
 *
 *   node e2e/numeric-inputs.mjs --exe "C:\...\StorePOS.exe" --data <empty dir> --out <report dir>
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
const dataDir = path.resolve(arg('data', 'e2e-numeric-profile'));
const outDir = path.resolve(arg('out', 'e2e-numeric-report'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/numeric-inputs.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>');
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
const OWNER_PIN = '5937';
const PORT = 9300 + Math.floor(Math.random() * 400);

const KEYS = {
  ',': { code: 'Comma', vk: 188, text: ',' },
  '.': { code: 'Period', vk: 190, text: '.' },
};
const keyOf = (ch) => KEYS[ch] || { code: `Digit${ch}`, vk: 48 + Number(ch), text: ch };
/** Like a USB scanner: keys back to back, then Enter. */
async function scan(cdp, code) {
  for (const ch of code) await cdp.key(ch, keyOf(ch));
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await sleep(300);
}
/** Like a person: about 7 keys per second (slower than the scanner detector's limit). */
async function typeHuman(cdp, text) {
  for (const ch of text) {
    await cdp.key(ch, keyOf(ch));
    await sleep(140);
  }
}
const backspace = async (cdp, n = 1) => {
  for (let i = 0; i < n; i++) {
    await cdp.key('Backspace', { code: 'Backspace', vk: 8 });
    await sleep(80);
  }
};
const tab = (cdp) => cdp.key('Tab', { code: 'Tab', vk: 9 });
const sel = (label) => `document.querySelector('input[aria-label=${JSON.stringify(label)}]')`;
const fieldValue = (cdp, label) => cdp.evaluate(`${sel(label)}?.value ?? null`);
const focusField = (cdp, label) => cdp.evaluate(`(() => { const i = ${sel(label)}; i.focus(); return { all: i.selectionStart === 0 && i.selectionEnd === i.value.length, value: i.value }; })()`);
const text = (cdp) => cdp.evaluate('document.body.innerText');
async function clickButton(cdp, label) {
  const ok = await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === ${JSON.stringify(label)});
    if (!b) return false;
    b.click(); return true;
  })()`);
  if (!ok) throw new Error(`button not found: ${label}`);
}
const buttonDisabled = (cdp, label) => cdp.evaluate(`[...document.querySelectorAll('button')].find((el) => (el.innerText || '').trim() === ${JSON.stringify(label)})?.disabled ?? null`);
const confirmBoxText = (cdp) => cdp.evaluate(`(() => {
  const h = [...document.querySelectorAll('h3')].find((x) => x.innerText.trim() === 'პროდუქტის დადასტურება');
  return h ? h.closest('.max-w-md').innerText : null;
})()`);

async function setInput(cdp, index, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelectorAll('form input')[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function main() {
  const app = await launchApp(exe, dataDir, PORT);
  const { cdp } = app;
  const dialogs = [];
  cdp.on('Page.javascriptDialogOpening', (p) => {
    dialogs.push(p.message);
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  await cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'first-run owner form');
  await setInput(cdp, 0, 'ტესტ მფლობელი');
  await setInput(cdp, 1, OWNER_PIN);
  await setInput(cdp, 2, OWNER_PIN);
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS screen after owner setup');
  const OT = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);

  const piece = await must(cdp, 'products:create', {
    name: 'ტესტ ცალობითი', base_price_tetri: 2500, base_cost_tetri: 1000,
    variants: [{ variant_name: 'სტანდარტული', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '31111' }] }],
  }, OT);
  const cheese = await must(cdp, 'products:create', {
    name: 'ტესტ ყველი', unit_type: 'kg', base_price_tetri: 1250, base_cost_tetri: 800,
    variants: [{ variant_name: 'სტანდარტული', initial_stock: 5000, codes: [{ code_type: 'manual_5digit', code_value: '32222' }] }],
  }, OT);
  check('kg product created with 5.000 kg initial stock (5000 g)', cheese.variants[0].stock_quantity === 5000, `${cheese.variants[0].stock_quantity} g`);

  // ---- POS: whole-number quantity ----
  await scan(cdp, '31111');
  await cdp.waitFor(`document.querySelector('input[aria-label="რაოდენობა"]')`, 8000, 'quantity field');
  check('confirmation opens with quantity 1', (await fieldValue(cdp, 'რაოდენობა')) === '1');
  const f1 = await focusField(cdp, 'რაოდენობა');
  check('focus selects the whole value', f1.all, JSON.stringify(f1));
  await typeHuman(cdp, '3');
  check('one key replaces the old value (1 -> 3)', (await fieldValue(cdp, 'რაოდენობა')) === '3');
  await backspace(cdp);
  await sleep(150);
  check('Backspace empties the field; no 0 or 1 comes back', (await fieldValue(cdp, 'რაოდენობა')) === '');
  check('empty quantity: "add to cart" is disabled', (await buttonDisabled(cdp, 'კალათაში დამატება')) === true);
  await typeHuman(cdp, '2');
  await tab(cdp);
  await sleep(200);
  const afterTab = await cdp.evaluate(`({ moved: document.activeElement !== ${sel('რაოდენობა')}, value: ${sel('რაოდენობა')}.value })`);
  check('Tab moves to the next control and keeps the typed value', afterTab.moved && afterTab.value === '2', JSON.stringify(afterTab));
  await clickButton(cdp, 'კალათაში დამატება');
  await sleep(400);

  // ---- POS: weight with a decimal comma ----
  await scan(cdp, '32222');
  await cdp.waitFor(`document.querySelector('input[aria-label="წონა კილოგრამებში"]')`, 8000, 'weight field');
  check('weight confirmation opens with 1 kg', (await fieldValue(cdp, 'წონა კილოგრამებში')) === '1');
  await focusField(cdp, 'წონა კილოგრამებში');
  await typeHuman(cdp, '0,375');
  await sleep(150);
  check('comma typed as the decimal separator is shown as a point (0,375 -> 0.375)', (await fieldValue(cdp, 'წონა კილოგრამებში')) === '0.375');
  check('line total 12.50 ₾/kg × 0.375 kg = 4.69 ₾ (nearest tetri)', ((await confirmBoxText(cdp)) || '').includes('4.69'));
  await backspace(cdp, 5);
  await sleep(150);
  const emptyWeight = { value: await fieldValue(cdp, 'წონა კილოგრამებში'), disabled: await buttonDisabled(cdp, 'კალათაში დამატება'), hint: ((await confirmBoxText(cdp)) || '').includes('მიუთითეთ წონა') };
  check('weight emptied with Backspace: field empty, add disabled, asks for a weight', emptyWeight.value === '' && emptyWeight.disabled === true && emptyWeight.hint, JSON.stringify(emptyWeight));
  await typeHuman(cdp, '0.375');
  await sleep(150);
  await clickButton(cdp, 'კალათაში დამატება');
  await sleep(400);
  const cartText = await text(cdp);
  check('cart: 2 pieces + 0.375 kg, total 54.69 ₾', cartText.includes('54.69'), cartText.includes('54.69') ? '' : 'total not shown');

  // ---- Checkout: cash typed into the money field ----
  await cdp.evaluate('document.activeElement && document.activeElement.blur(), true');
  await cdp.key(' ', { code: 'Space', vk: 32, text: ' ' });
  await cdp.waitFor(`document.querySelector('input[aria-label="მიღებული ნაღდი თანხა"]')`, 8000, 'cash field');
  check('cash field starts with the amount due', (await fieldValue(cdp, 'მიღებული ნაღდი თანხა')) === '54.69');
  await focusField(cdp, 'მიღებული ნაღდი თანხა');
  await typeHuman(cdp, '100');
  await sleep(150);
  check('typing 100 replaces the amount', (await fieldValue(cdp, 'მიღებული ნაღდი თანხა')) === '100');
  check('change 45.31 ₾ is shown', (await text(cdp)).includes('45.31'));
  await clickButton(cdp, 'გაყიდვის დასრულება');
  await sleep(1200);
  const sales = await must(cdp, 'pos:searchSales', { limit: 5 }, OT);
  const sale = sales[0];
  const qtys = (sale?.items || []).map((i) => `${i.quantity}${i.unit_type === 'kg' ? 'g' : 'pc'}`).sort().join(',');
  check('sale saved: 2 pieces + 375 g, total 54.69, change 45.31', sale && sale.total_tetri === 5469 && sale.change_given_tetri === 4531 && qtys === '2pc,375g', `${sale?.total_tetri} / ${sale?.change_given_tetri} / ${qtys}`);
  await cdp.key('Escape', { code: 'Escape', vk: 27 });
  await sleep(300);

  // ---- Inventory: an emptied stock count is not 0 kg ----
  await cdp.key('F3', { code: 'F3', vk: 114 });
  await cdp.waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'კორექცია')`, 8000, 'inventory screen');
  await clickButton(cdp, 'კორექცია');
  await cdp.waitFor(`document.querySelector('#correction-form select')`, 5000, 'correction form');
  const cheeseVariant = cheese.variants[0].id;
  await cdp.evaluate(`(() => {
    const s = document.querySelector('#correction-form select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(s, ${JSON.stringify(String(cheeseVariant))});
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await cdp.waitFor(`document.querySelector('input[aria-label="დათვლილი წონა (კგ)"]')`, 5000, 'counted weight field');
  check('count field shows the current stock in kg (4.625)', (await fieldValue(cdp, 'დათვლილი წონა (კგ)')) === '4.625');
  await focusField(cdp, 'დათვლილი წონა (კგ)');
  await backspace(cdp);
  await cdp.evaluate(`(() => {
    const t = document.querySelector('#correction-form textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(t, 'E2E: ცარიელი ველის შემოწმება');
    t.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#correction-form').requestSubmit();
    return true;
  })()`);
  await sleep(600);
  const afterEmpty = await must(cdp, 'products:getById', { productId: cheese.id }, OT);
  check('emptied count is refused with a message; stock stays 4.625 kg',
    (await text(cdp)).includes('მიუთითეთ დათვლილი წონა') && afterEmpty.variants[0].stock_quantity === 4625,
    `stock ${afterEmpty.variants[0].stock_quantity} g`);
  await focusField(cdp, 'დათვლილი წონა (კგ)');
  await typeHuman(cdp, '0');
  await cdp.evaluate(`document.querySelector('#correction-form').requestSubmit(), true`);
  await sleep(800);
  const afterZero = await must(cdp, 'products:getById', { productId: cheese.id }, OT);
  check('a real 0 kg count is accepted (stock 0 g)', afterZero.variants[0].stock_quantity === 0, `stock ${afterZero.variants[0].stock_quantity} g`);

  // ---- History: partial weight return limited to what is left ----
  await cdp.key('F5', { code: 'F5', vk: 116 });
  await cdp.waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'დაბრუნება')`, 8000, 'history screen');
  await clickButton(cdp, 'დაბრუნება');
  await cdp.waitFor(`document.querySelector('input[aria-label="დასაბრუნებელი წონა (კგ)"]')`, 5000, 'weight return field');
  const returnText = await text(cdp);
  check('return dialog shows what is left in kg (0.375 კგ)', returnText.includes('0.375 კგ'));
  await focusField(cdp, 'დასაბრუნებელი წონა (კგ)');
  await typeHuman(cdp, '1');
  await sleep(150);
  check('more than was sold is capped at the remaining 0.375 kg', (await fieldValue(cdp, 'დასაბრუნებელი წონა (კგ)')) === '0.375');
  await cdp.evaluate(`${sel('დასაბრუნებელი წონა (კგ)')}.select(), true`);
  await typeHuman(cdp, '0,2');
  await sleep(150);
  check('partial weight typed with a comma: 0.2', (await fieldValue(cdp, 'დასაბრუნებელი წონა (კგ)')) === '0.2');
  await clickButton(cdp, 'დაბრუნების დადასტურება');
  await sleep(1200);
  const after = (await must(cdp, 'pos:searchSales', { limit: 5 }, OT)).find((s) => s.id === sale.id);
  const kgLine = after.items.find((i) => i.unit_type === 'kg');
  check('return saved: 200 g of 375 g returned, refund 2.50 ₾ (4.69 × 200/375, rounded down)',
    kgLine.returned_quantity === 200 && dialogs.some((d) => d.includes('2.50')),
    `returned ${kgLine.returned_quantity} g; dialog: ${dialogs.at(-1)?.split('\n').join(' | ')}`);
  await clickButton(cdp, 'დაბრუნება');
  await cdp.waitFor(`document.querySelector('input[aria-label="დასაბრუნებელი წონა (კგ)"]')`, 5000, 'weight return field again');
  check('second return: only 0.175 kg left', (await text(cdp)).includes('0.175 კგ'));
  await cdp.screenshot(path.join(outDir, 'return-remaining.png'));

  const closed = await closeApp(app);
  check('app closes cleanly', closed.clean, `exit code ${closed.exitCode}`);
  const db = new DatabaseSync(path.join(dataDir, 'data', 'store.db'), { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const fk = db.prepare('PRAGMA foreign_key_check').all().length;
  db.close();
  check('database integrity ok, no foreign-key violations', integrity === 'ok' && fk === 0, `${integrity}, fk ${fk}`);
}

main()
  .catch((err) => {
    check('test run completed without an exception', false, err.stack || String(err));
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(outDir, 'numeric-inputs.json'), JSON.stringify({ when: new Date().toISOString(), exe, results }, null, 2));
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
