/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Windows desktop acceptance test: drives the real StorePOS.exe (packaged or installed)
 * through the Chrome DevTools Protocol with an isolated profile, never the real store data.
 *
 *   node e2e/desktop-acceptance.mjs --exe "C:\...\StorePOS.exe" --data <empty dir> --out <report dir>
 *
 * Covers: first start and SQLite creation, first owner registration through the UI, product with
 * photo, sales (cash/debt/mixed), repayment, return, exchange, seller data filtering, OCR model in
 * the package, offline (no network requests), renderer isolation, responsive layout at several
 * resolutions and Windows scaling factors, backup, clean close, restart and keyboard login,
 * persistence of every figure.
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
const dataDir = path.resolve(arg('data', 'e2e-profile'));
const outDir = path.resolve(arg('out', 'e2e-report'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/desktop-acceptance.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>');
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
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OWNER_PIN = '4826';
const SELLER_PIN = '7391';
const PORT = 9300 + Math.floor(Math.random() * 400);

async function setInput(cdp, index, value) {
  await cdp.evaluate(`(() => {
    const el = document.querySelectorAll('form input')[${index}];
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

const fkey = (n) => ({ key: `F${n}`, code: `F${n}`, vk: 111 + n });

async function main() {
  // ---------------- Launch 1: fresh profile ----------------
  let app = await launchApp(exe, dataDir, PORT);
  const { cdp } = app;
  const network = [];
  cdp.on('Network.requestWillBeSent', (p) => network.push(p.request.url));
  await cdp.send('Network.enable');
  check('app starts and shows its own page', /^file:\/\/.*\/dist\/index\.html/.test(app.pageUrl), `${app.pageUrl} in ${(app.startedMs / 1000).toFixed(1)} s`);

  const dbFile = path.join(dataDir, 'data', 'store.db');
  check('SQLite database created in the profile', fs.existsSync(dbFile), dbFile);

  await cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'first-run owner form');
  check('first run asks for the owner account', true);
  await setInput(cdp, 0, 'ტესტ მფლობელი');
  await setInput(cdp, 1, OWNER_PIN);
  await setInput(cdp, 2, OWNER_PIN);
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS screen after owner setup');
  check('owner registered through the UI, POS opens', true);
  await cdp.screenshot(path.join(outDir, '01-pos-after-setup.png'));

  const OT = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  check('session token kept in sessionStorage only', !!OT && !(await cdp.evaluate(`localStorage.getItem('storepos_session_token')`)));

  // Renderer isolation
  const iso = await cdp.evaluate(`({ req: typeof require, proc: typeof process, api: Object.keys(window.electronAPI || {}) })`);
  check('renderer has no Node access, bridge exposes invoke only', iso.req === 'undefined' && iso.proc === 'undefined' && iso.api.join(',') === 'invoke', JSON.stringify(iso));

  // Catalogue: category + product with photo + second product without cost
  const cat = await must(cdp, 'products:createCategory', { name: 'სათამაშოები' }, OT);
  const toy = await must(cdp, 'products:create', {
    name: 'სათამაშო მანქანა', category_id: cat.id, base_price_tetri: 4500, base_cost_tetri: 2000,
    variants: [{ variant_name: 'წითელი', color: 'წითელი', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '12345' }, { code_type: 'barcode', code_value: '0004006381333' }] }],
    image_paths: [PNG],
  }, OT);
  const shoe = await must(cdp, 'products:create', {
    name: 'ბავშვის ფეხსაცმელი', base_price_tetri: 6000,
    variants: [{ variant_name: '30', size: '30', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '23456' }] }],
  }, OT);
  const tv = toy.variants[0].id;
  const sv = shoe.variants[0].id;
  check('products created with 5-digit codes and barcode', !!tv && !!sv);
  check('photo stored as a file in the profile', fs.readdirSync(path.join(dataDir, 'data', 'images')).length === 1);

  // Photo renders in the Products screen through storepos-img://
  await cdp.key('F2', fkey(2));
  await cdp.waitFor(`[...document.images].some(i => i.src.startsWith('storepos-img://'))`, 10000, 'product photo element');
  await cdp.waitFor(`[...document.images].some(i => i.src.startsWith('storepos-img://') && i.complete && i.naturalWidth > 0)`, 10000, 'product photo loaded');
  check('product photo loads from storepos-img:// (CSP allows it)', true);
  await cdp.screenshot(path.join(outDir, '02-products.png'));

  // Sales
  const cust = await must(cdp, 'customers:create', { first_name: 'ნინო', phone: '555123456' }, OT);
  const s1 = await must(cdp, 'pos:checkout', { items: [{ variant_id: tv, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 10000, idempotency_key: 'e2e-s1' }, OT);
  const s1again = await must(cdp, 'pos:checkout', { items: [{ variant_id: tv, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 10000, idempotency_key: 'e2e-s1' }, OT);
  check('cash sale with change; retried request does not sell twice', s1.change_given_tetri === 1000 && s1again.id === s1.id);
  const s2 = await must(cdp, 'pos:checkout', { items: [{ variant_id: sv, quantity: 1 }], payment_method: 'debt', customer_id: cust.id }, OT);
  const s3 = await must(cdp, 'pos:checkout', { items: [{ variant_id: tv, quantity: 1 }], payment_method: 'mixed', customer_id: cust.id, cash_received_tetri: 2000 }, OT);
  check('debt and mixed sales', s2.debt_amount_tetri === 6000 && s3.debt_amount_tetri === 2500);
  await must(cdp, 'customers:repay', { customer_id: cust.id, amount_tetri: 3000 }, OT);
  const c1 = await must(cdp, 'customers:get', { customerId: cust.id }, OT);
  check('partial repayment reduces debt (not a sale)', c1.total_debt_tetri === 5500, `debt ${c1.total_debt_tetri}`);

  const r1 = await must(cdp, 'returns:process', { sale_id: s1.id, items: [{ sale_item_id: s1.items[0].id, quantity: 1, condition: 'resellable' }] }, OT);
  check('return from history refunds cash', r1.cash_refund_tetri === 4500);
  const ex = await must(cdp, 'returns:exchange', {
    original_sale_id: s3.id,
    return_items: [{ sale_item_id: s3.items[0].id, quantity: 1 }],
    new_items: [{ variant_id: sv, quantity: 1 }],
    payment_method: 'debt',
  }, OT);
  check('exchange on a mixed sale: difference put on debt', ex.amount_due_tetri === 1500);

  // Seller cannot see costs, cannot open finance
  await must(cdp, 'auth:addUser', { name: 'ტესტ გამყიდველი', pin: SELLER_PIN, role: 'seller' }, OT);
  const users = await must(cdp, 'auth:getActiveUsers', {});
  const seller = users.find((u) => u.role === 'seller');
  const ST = (await must(cdp, 'auth:login', { userId: seller.id, pin: SELLER_PIN })).token;
  const sellerView = JSON.stringify([
    await must(cdp, 'products:list', {}, ST),
    await must(cdp, 'pos:searchSales', {}, ST),
    await must(cdp, 'inventory:getMovements', { limit: 100 }, ST),
  ]);
  check('seller responses contain no cost/profit fields', !/cost|profit|cogs/i.test(sellerView));
  const fin = await cdp.ipc('finance:summary', { preset: 'today' }, ST);
  check('seller is refused finance on the server', !fin.success);

  // OCR inside the package (ONNX model + WASM from app.asar)
  const ready = await must(cdp, 'ocr:isModelReady', {}, OT);
  const w = 200, h = 60;
  const pixels = await cdp.evaluate(`(() => {
    const w = ${w}, h = ${h}; const px = new Array(w * h * 4).fill(255);
    for (let slot = 0; slot < 5; slot++) { const cx = slot * 40 + 20;
      for (let y = 12; y < 48; y++) for (let x = cx - 2; x <= cx + 2; x++) { const i = (y * w + x) * 4; px[i] = px[i + 1] = px[i + 2] = 0; } }
    return px; })()`);
  const ocr = await must(cdp, 'ocr:recognize', { pixels, width: w, height: h }, OT);
  check('offline OCR model loads in the packaged app and reads 11111', ready.ready === true && ocr.code === '11111', `code ${ocr.code}, confidence ${ocr.confidence}%`);

  // Finance figures (owner)
  const sum = await must(cdp, 'finance:summary', { preset: 'today' }, OT);
  check('finance: net sales, COGS reversal and cash flow are consistent',
    sum.total_sales_revenue_tetri === 9000 + 6000 + 4500 + 6000 &&
    sum.total_returns_amount_tetri === 4500 + 4500 &&
    sum.net_cogs_tetri === (2000 * 3) - (2000 * 2) &&
    sum.net_cash_flow_tetri === 9000 + 2000 + 3000 - 4500,
    JSON.stringify({ gross: sum.total_sales_revenue_tetri, returns: sum.total_returns_amount_tetri, netCogs: sum.net_cogs_tetri, cash: sum.net_cash_flow_tetri, profit: sum.estimated_gross_profit_tetri }));

  // Security: navigation away from the app is blocked
  await cdp.evaluate(`(location.href = 'https://example.com', true)`).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  check('navigation to the internet is blocked', /\/dist\/index\.html/.test(await cdp.evaluate('location.href')));

  // Backup
  const bk = await must(cdp, 'backup:create', {}, OT);
  check('backup file written in the profile', fs.existsSync(bk.filepath), `${(bk.size_bytes / 1024).toFixed(0)} KB`);

  // Responsive layout: physical resolution / Windows scaling -> CSS viewport
  const viewports = [
    ['1280x720 @100%', 1280, 720, 1], ['1366x768 @100%', 1366, 768, 1], ['1920x1080 @100%', 1920, 1080, 1],
    ['2560x1440 @100%', 2560, 1440, 1], ['1366x768 @125%', 1093, 614, 1.25], ['1920x1080 @125%', 1536, 864, 1.25],
    ['1920x1080 @150%', 1280, 720, 1.5], ['1920x1080 @175%', 1097, 617, 1.75], ['2560x1440 @150%', 1707, 960, 1.5],
    ['2560x1440 @175%', 1463, 823, 1.75],
  ];
  const tabs = [[1, 'pos'], [2, 'products'], [3, 'inventory'], [4, 'debts'], [5, 'history'], [6, 'finance'], [7, 'staff'], [8, 'settings']];
  const layoutProblems = [];
  for (const [label, width, height, dpr] of viewports) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
    await new Promise((r) => setTimeout(r, 300));
    const hiddenTabs = await cdp.evaluate(`[...document.querySelectorAll('header nav button')].filter((b) => {
      const r = b.getBoundingClientRect(); const n = b.closest('nav').getBoundingClientRect();
      return r.left < n.left - 1 || r.right > n.right + 1;
    }).map((b) => b.getAttribute('aria-label') || b.textContent)`);
    if (hiddenTabs.length) layoutProblems.push(`${label} header: tabs not visible: ${hiddenTabs.join(', ')}`);
    for (const [n, name] of tabs) {
      await cdp.key(`F${n}`, fkey(n));
      await new Promise((r) => setTimeout(r, 350));
      const m = await cdp.evaluate(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight })`);
      if (m.sw > m.cw + 1 || m.sh > m.ch + 1) layoutProblems.push(`${label} ${name}: page ${m.sw}x${m.sh} > viewport ${m.cw}x${m.ch}`);
      if ((label === '1920x1080 @175%' || label === '1280x720 @100%' || label === '2560x1440 @100%') && ['pos', 'products', 'finance', 'history'].includes(name)) {
        await cdp.screenshot(path.join(outDir, `vp-${label.replace(/[^0-9a-z]+/gi, '_')}-${name}.png`));
      }
    }
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  check('no page-level overflow on 8 screens at 10 resolution/scaling combinations', layoutProblems.length === 0, layoutProblems.slice(0, 6).join('; '));

  const external = network.filter((u) => /^(https?|wss?):/i.test(u));
  check('offline: no network requests were made', external.length === 0, external.slice(0, 3).join(', '));

  const before = {
    products: (await must(cdp, 'products:list', {}, OT)).length,
    sales: (await must(cdp, 'pos:searchSales', { limit: 100 }, OT)).length,
    debt: (await must(cdp, 'customers:get', { customerId: cust.id }, OT)).total_debt_tetri,
    summary: await must(cdp, 'finance:summary', { preset: 'all' }, OT),
  };

  const closed = await closeApp(app);
  check('window close shuts the app down cleanly', closed.clean, `exit code ${closed.exitCode} after ${closed.seconds.toFixed(1)} s`);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const schema = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  db.close();
  check('database file intact after close', integrity === 'ok', `integrity_check ${integrity}, schema v${schema}`);

  // ---------------- Launch 2: same profile ----------------
  app = await launchApp(exe, dataDir, PORT + 1);
  const cdp2 = app.cdp;
  await cdp2.waitFor(`document.body.innerText.includes('ტესტ მფლობელი')`, 20000, 'login screen with users');
  await cdp2.evaluate(`([...document.querySelectorAll('button')].find(b => b.innerText.includes('ტესტ მფლობელი'))?.click(), true)`);
  await new Promise((r) => setTimeout(r, 400));
  await cdp2.typeDigits(OWNER_PIN);
  await cdp2.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp2.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS after keyboard login');
  check('restart: login with the physical keyboard (PIN + Enter)', true);
  const OT2 = await cdp2.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  const after = {
    products: (await must(cdp2, 'products:list', {}, OT2)).length,
    sales: (await must(cdp2, 'pos:searchSales', { limit: 100 }, OT2)).length,
    debt: (await must(cdp2, 'customers:get', { customerId: cust.id }, OT2)).total_debt_tetri,
    summary: await must(cdp2, 'finance:summary', { preset: 'all' }, OT2),
  };
  check('restart: products, sales, debt and finance figures unchanged',
    JSON.stringify(before) === JSON.stringify(after), `products ${after.products}, sales ${after.sales}, debt ${after.debt}`);
  const oldToken = await cdp2.ipc('customers:list', {}, OT);
  check('restart: tokens from the previous run are invalid', !oldToken.success);
  await cdp2.screenshot(path.join(outDir, '03-after-restart.png'));
  const closed2 = await closeApp(app);
  check('second close is clean', closed2.clean);

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ exe, dataDir, date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E aborted:', err);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ exe, dataDir, aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
