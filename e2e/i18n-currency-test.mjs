/**
 * V1.2 languages and shop currency in the real StorePOS.exe (fresh, isolated profile).
 *
 *   node e2e/i18n-currency-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>
 *
 * A shop set up on the first screen in Spanish with euros in Madrid; every screen in Spanish,
 * Russian and English without Georgian text and without the lari sign; the language changed from
 * the header and from the sign-in screen; each user's own language; a main-process error shown in
 * the user's language; the currency locked after the first money record; everything kept after a
 * restart; the language chosen in the installer (install-language.txt next to the exe).
 * Screenshots of every screen at 1280×720 in every language go to the report folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { launchApp, closeApp } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'i18n-profile'));
const outDir = path.resolve(arg('out', 'i18n-report'));
if (!exe || !fs.existsSync(exe)) throw new Error('--exe <StorePOS.exe> is required');
if (/Program Files/i.test(exe) || /AppData[\\/]Roaming[\\/]StorePOS/i.test(dataDir)) throw new Error('refusing to use a real installation or profile');
if (fs.existsSync(path.join(dataDir, 'data', 'store.db'))) throw new Error('profile not empty');
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9700 + Math.floor(Math.random() * 200);
const OWNER_PIN = '5821';
const SELLER_PIN = '6390';
const fkey = (n) => ({ key: `F${n}`, code: `F${n}`, vk: 111 + n });
const TABS = { 1: 'pos', 2: 'products', 3: 'inventory', 4: 'debts', 5: 'history', 6: 'finance', 7: 'staff', 8: 'settings' };

async function setInput(cdp, selector, index, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function selectValue(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

/** Georgian characters on the screen (texts, titles, placeholders, labels), apart from the language list. */
async function georgianOnScreen(cdp) {
  return cdp.evaluate(`(() => {
    const GEO = /[\\u10A0-\\u10FF]/;
    const found = [];
    // The language list names every language in itself (ქართული, English...), on purpose.
    const skip = (el) => el.closest('[data-testid^=language-switcher]');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (GEO.test(n.nodeValue) && !skip(n.parentElement)) found.push(n.nodeValue.trim().slice(0, 80));
    }
    for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
      if (skip(el)) continue;
      for (const a of ['title', 'placeholder', 'aria-label']) {
        const v = el.getAttribute(a);
        if (v && GEO.test(v)) found.push(a + ': ' + v.slice(0, 80));
      }
    }
    return [...new Set(found)];
  })()`);
}
const bodyText = (cdp) => cdp.evaluate('document.body.innerText');
/** Screen text without the contents of drop-down lists (the currency list names the lari). */
const textOutsideLists = (cdp) => cdp.evaluate(`(() => {
  let t = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest('select')) t += n.nodeValue + ' ';
  return t;
})()`);

async function visitAllTabs(cdp, lang, expectEuro) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const problems = [];
  let euroSeen = 0;
  let lariSeen = 0;
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    await cdp.key(`F${n}`, fkey(n));
    await sleep(900);
    const geo = await georgianOnScreen(cdp);
    if (geo.length) problems.push(`${TABS[n]}: ${geo.slice(0, 4).join(' | ')}`);
    const text = await textOutsideLists(cdp);
    if (text.includes('€')) euroSeen++;
    if (text.includes('₾')) lariSeen++;
    await cdp.screenshot(path.join(outDir, `${lang}-${n}-${TABS[n]}.png`));
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await cdp.key('F1', fkey(1));
  check(`${lang}: all 8 screens without Georgian text (texts, titles, placeholders)`, problems.length === 0, problems.join(' || ').slice(0, 600));
  if (expectEuro) check(`${lang}: amounts in euros, no lari sign anywhere`, euroSeen >= 4 && lariSeen === 0, `€ on ${euroSeen} screens, ₾ on ${lariSeen}`);
}

async function signIn(cdp, name, pin) {
  await cdp.waitFor(`[...document.querySelectorAll('button')].some(b => b.innerText.includes(${JSON.stringify(name)}))`, 15000, `user ${name} on the sign-in screen`);
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes(${JSON.stringify(name)})).click(), true`);
  await sleep(300);
  await cdp.typeDigits(pin);
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
}

async function main() {
  // ---------------- Launch 1: first start in Spanish ----------------
  let app = await launchApp(exe, dataDir, PORT);
  let { cdp } = app;
  await cdp.waitFor(`document.querySelector('[data-testid=setup-currency]')`, 20000, 'first-run form');
  check('first start: the language choice is on the first screen', await cdp.evaluate(`!!document.querySelector('[data-testid=language-switcher]')`));
  check('first start: Georgian by default (no installer choice, nothing chosen yet)', (await bodyText(cdp)).includes('მფლობელის რეგისტრაცია'));
  await selectValue(cdp, '[data-testid=language-switcher] select, select[data-testid=language-switcher]', 'es');
  await cdp.waitFor(`document.body.innerText.includes('Primer inicio: registro del propietario')`, 10000, 'Spanish first-run screen');
  const geoSetup = await georgianOnScreen(cdp);
  check('first start in Spanish: no Georgian text', geoSetup.length === 0, geoSetup.join(' | '));
  await selectValue(cdp, '[data-testid=setup-currency]', 'EUR');
  await selectValue(cdp, '[data-testid=setup-timezone]', 'Europe/Madrid');
  await cdp.screenshot(path.join(outDir, 'es-0-first-start.png'));
  await setInput(cdp, 'form input', 0, 'Ana García');
  await setInput(cdp, 'form input', 1, OWNER_PIN);
  await setInput(cdp, 'form input', 2, OWNER_PIN);
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('Confirmar la venta')`, 15000, 'Spanish checkout after setup');
  const OT = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  const me = await must(cdp, 'auth:me', {}, OT);
  const pub = await must(cdp, 'settings:getPublic');
  check('owner created in Spanish, shop in euros, Madrid time', me.language === 'es' && pub.currency === 'EUR' && pub.timezone === 'Europe/Madrid', `${me.language} ${pub.currency} ${pub.timezone}`);
  check('header shows the store name in Spanish (default name)', (await bodyText(cdp)).includes('Mi tienda'));

  // Settings before any money record: the currency can still change.
  await cdp.key('F8', fkey(8));
  await cdp.waitFor(`document.querySelector('[data-testid=settings-currency]')`, 10000, 'settings');
  await sleep(600);
  check('settings: currency can still change (no money records)', await cdp.evaluate(`!document.querySelector('[data-testid=settings-currency]').disabled`));

  // Shop data (Spanish names) and a sale, a credit sale, a return, an expense.
  const prod = await must(cdp, 'products:create', {
    name: 'Camiseta', base_price_tetri: 1250, base_cost_tetri: 700,
    variants: [{ variant_name: 'M', initial_stock: 20, codes: [{ code_type: 'manual_5digit', code_value: '51001' }] }],
  }, OT);
  const kilo = await must(cdp, 'products:create', {
    name: 'Manzanas', unit_type: 'kg', base_price_tetri: 299, base_cost_tetri: 150,
    variants: [{ variant_name: 'Golden', initial_stock: 5000, codes: [{ code_type: 'manual_5digit', code_value: '51002' }] }],
  }, OT);
  const cust = await must(cdp, 'customers:create', { first_name: 'Lucía', phone: '612345678' }, OT);
  const s1 = await must(cdp, 'pos:checkout', { items: [{ variant_id: prod.variants[0].id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 3000 }, OT);
  await must(cdp, 'pos:checkout', { items: [{ variant_id: kilo.variants[0].id, quantity: 1500 }], payment_method: 'debt', customer_id: cust.id }, OT);
  await must(cdp, 'returns:process', { sale_id: s1.id, items: [{ sale_item_id: s1.items[0].id, quantity: 1, condition: 'resellable' }] }, OT);
  await must(cdp, 'finance:addExpense', { category: 'ქირა', description: 'Alquiler', amount_tetri: 50000 }, OT).catch(async () => must(cdp, 'finance:createExpense', { category: 'ქირა', description: 'Alquiler', amount_tetri: 50000 }, OT));
  check('a Spanish shop records sales, credit, a return and an expense in euros', s1.change_given_tetri === 500);

  // A main-process error in the user's language: the currency cannot change any more.
  const refused = await cdp.ipc('backup:updateSettings', { settings: { currency: 'USD' } }, OT);
  check('currency locked after the first money record (main process refuses)', !refused.success && /ფულადი ჩანაწერები/.test(refused.error), refused.error);
  await cdp.key('F7', fkey(7));
  await sleep(300);
  await cdp.key('F8', fkey(8));
  await cdp.waitFor(`document.querySelector('[data-testid=settings-currency]')`, 10000, 'settings');
  await sleep(800);
  check('settings: currency select disabled with an explanation in Spanish',
    await cdp.evaluate(`document.querySelector('[data-testid=settings-currency]').disabled && document.querySelector('[data-testid=currency-note]').innerText.includes('ya tiene registros de dinero')`));

  await visitAllTabs(cdp, 'es', true);

  // Header switch to Russian, then English: every screen follows; the account keeps the choice.
  await selectValue(cdp, 'select[data-testid=language-switcher]', 'ru');
  await cdp.waitFor(`document.body.innerText.includes('Касса')`, 10000, 'Russian header');
  check('header switch to Russian: account and computer keep it', (await must(cdp, 'auth:me', {}, OT)).language === 'ru' && (await must(cdp, 'app:getDeviceLanguage')).language === 'ru');
  await visitAllTabs(cdp, 'ru', true);
  await selectValue(cdp, 'select[data-testid=language-switcher]', 'en');
  await cdp.waitFor(`document.body.innerText.includes('Checkout')`, 10000, 'English header');
  await visitAllTabs(cdp, 'en', true);

  // A seller with no language of their own follows the computer; their own choice stays theirs.
  const seller = await must(cdp, 'auth:addUser', { name: 'Pablo', pin: SELLER_PIN, role: 'seller' }, OT);
  await cdp.key('F12', { key: 'F12', code: 'F12', vk: 123 });
  await cdp.waitFor(`document.body.innerText.includes('Choose a user')`, 10000, 'sign-in screen in English');
  check('locked: sign-in screen in the computer language (English)', true);
  await signIn(cdp, 'Pablo', SELLER_PIN);
  await cdp.waitFor(`document.body.innerText.includes('Checkout')`, 15000, 'seller signed in, English');
  await selectValue(cdp, 'select[data-testid=language-switcher]', 'es');
  await cdp.waitFor(`document.body.innerText.includes('Caja')`, 10000, 'seller in Spanish');
  const ST = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  check('the seller chose Spanish for himself', (await must(cdp, 'auth:me', {}, ST)).language === 'es');
  await cdp.key('F12', { key: 'F12', code: 'F12', vk: 123 });
  await cdp.waitFor(`document.body.innerText.includes('Elija un usuario')`, 10000, 'sign-in screen in Spanish');
  // Choosing the owner switches the PIN screen to the owner's language (English).
  await cdp.evaluate(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('Ana García')).click(), true`);
  await cdp.waitFor(`document.body.innerText.includes('Sign in (Enter)')`, 10000, "owner's language on the PIN screen");
  check("choosing a user on the sign-in screen shows the PIN screen in that user's language", true);
  // A wrong PIN: the main process answers in Georgian, the screen shows it in English.
  await cdp.typeDigits('0000');
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`document.body.innerText.includes('Wrong PIN')`, 10000, 'wrong PIN message');
  const wrong = await cdp.evaluate(`[...document.querySelectorAll('span')].map(s => s.innerText).find(t => t.includes('Wrong PIN')) || ''`);
  check("a main-process error is shown in the user's language", /Wrong PIN \(attempts left before lock: \d+\)/.test(wrong) && !/[Ⴀ-ჿ]/.test(wrong), wrong);
  await cdp.typeDigits(OWNER_PIN);
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`document.body.innerText.includes('Checkout')`, 15000, 'owner back in English');
  const OT2 = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);

  // ---------------- Launch 2: restart keeps everything ----------------
  await closeApp(app);
  app = await launchApp(exe, dataDir, PORT + 1);
  ({ cdp } = app);
  await cdp.waitFor(`document.body.innerText.includes('Elija un usuario') || document.body.innerText.includes('Introduzca')`, 20000, 'sign-in screen after restart');
  check('restart: the sign-in screen keeps the last language chosen on this computer (Spanish)', true);
  await signIn(cdp, 'Ana García', OWNER_PIN);
  await cdp.waitFor(`document.body.innerText.includes('Checkout')`, 15000, "owner's own language after restart");
  const OT3 = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  const pub2 = await must(cdp, 'settings:getPublic');
  check('restart: owner in English, shop still in euros and Madrid time', pub2.currency === 'EUR' && pub2.timezone === 'Europe/Madrid' && (await must(cdp, 'auth:me', {}, OT3)).language === 'en');
  const csv = await must(cdp, 'finance:exportSalesCSV', { lang: 'en' }, OT3);
  check('CSV export in English with euro columns', /Receipt #/.test(csv.split('\n')[0]) && /Total \(€\)/.test(csv.split('\n')[0]));
  await closeApp(app);

  // ---------------- Launch 3: the installer's language ----------------
  const installFile = path.join(path.dirname(exe), 'install-language.txt');
  fs.writeFileSync(installFile, '1049');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(installFile, later, later);
  try {
    app = await launchApp(exe, dataDir, PORT + 2);
    ({ cdp } = app);
    await cdp.waitFor(`document.body.innerText.includes('Выберите пользователя')`, 20000, 'Russian sign-in screen from the installer choice');
    check('a newer installer language choice (Russian) sets the sign-in screen', true);
    await closeApp(app);
  } finally {
    fs.rmSync(installFile, { force: true });
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} language and currency checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL  run aborted:', err?.stack || err);
  process.exit(1);
});
