/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Hardware-readiness test of the real StorePOS.exe (isolated profile, never the store data):
 * webcam OCR and USB barcode scanner handled through the real app, without the devices.
 *
 *   node e2e/hardware-readiness.mjs --exe "C:\...\StorePOS.exe" --data <empty dir> --out <report dir>
 *
 * Camera: Chromium's built-in fake cameras (--use-fake-device-for-media-stream, two devices;
 * then a video file with printed digits) — the real cameras of this computer are never opened.
 * Camera faults (blocked access, busy camera, no camera, slow start) are produced by replacing
 * getUserMedia in the page, to check what the seller is shown.
 * Scanner: key events sent through the browser's input pipeline at scanner speed (a few ms per
 * key, Enter/Tab suffix, NumLock-off numpad) and at human speed, like a HID keyboard wedge.
 *
 * What this cannot prove: recognition accuracy on real handwriting with a real webcam, and the
 * behaviour of a particular scanner model (its suffix/keyboard settings) — HARDWARE PENDING.
 */

import fs from 'node:fs';
import path from 'node:path';
import { launchApp, closeApp } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'e2e-hw-profile'));
const outDir = path.resolve(arg('out', 'e2e-hw-report'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/hardware-readiness.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>');
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
const OWNER_PIN = '4826';
const PORT = 9700 + Math.floor(Math.random() * 200);
const FAKE_CAMERAS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=device-count=2'];

const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};

// ---- page helpers ----
const text = (cdp) => cdp.evaluate('document.body.innerText');
async function clickButton(cdp, label, { exact = true } = {}) {
  const ok = await cdp.evaluate(`(() => {
    const want = ${JSON.stringify(label)};
    const b = [...document.querySelectorAll('button')].find((el) => {
      const t = (el.innerText || '').trim();
      return ${exact ? 't === want' : 't.includes(want)'} || el.getAttribute('aria-label') === want || (el.title || '').includes(want);
    });
    if (!b) return false;
    b.focus(); b.click(); return true;
  })()`);
  if (!ok) throw new Error(`button not found: ${label}`);
}
async function setInputValue(cdp, selectorJs, value) {
  await cdp.evaluate(`(() => {
    const el = ${selectorJs};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
const digitKey = (d) => ({ code: `Digit${d}`, vk: 48 + Number(d), text: d });
/** Like a USB scanner: keys back to back (a few ms each), then the suffix. */
async function scan(cdp, code, { suffix = 'Enter', numpadNumLockOff = false } = {}) {
  for (const ch of code) {
    if (numpadNumLockOff) await cdp.key('End', { code: `Numpad${ch}`, vk: 35 });
    else await cdp.key(ch, digitKey(ch));
  }
  if (suffix === 'Enter') await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  if (suffix === 'Tab') await cdp.key('Tab', { code: 'Tab', vk: 9 });
  await sleep(250);
}
/** Like a person: about 7 keys per second. */
async function typeHuman(cdp, digits) {
  for (const ch of digits) {
    await cdp.key(ch, digitKey(ch));
    await sleep(140);
  }
}
const confirmOpen = (cdp) => cdp.evaluate(`[...document.querySelectorAll('h3')].some((h) => h.innerText.trim() === 'პროდუქტის დადასტურება')`);
const confirmInfo = (cdp) => cdp.evaluate(`(() => {
  const h = [...document.querySelectorAll('h3')].find((x) => x.innerText.trim() === 'პროდუქტის დადასტურება');
  if (!h) return null;
  const box = h.closest('.max-w-md');
  return { text: box.innerText, qty: Number(box.querySelector('input[type=number]').value) };
})()`);
const cartRows = (cdp) => cdp.evaluate(`[...document.querySelectorAll('button[aria-label="რაოდენობის გაზრდა"]')].map((b) => ({
  qty: Number(b.previousElementSibling.textContent.trim()),
  row: b.closest('div.flex.items-center.justify-between')?.innerText || ''
}))`);
const webcamOpen = (cdp) => cdp.evaluate(`document.body.innerText.includes('ვებკამერით 5-ნიშნა კოდის ამოცნობა')`);
const digitCells = (cdp) => cdp.evaluate(`[...document.querySelectorAll('input[aria-label^="ციფრი #"]')].map((i) => i.value)`);
async function focusDigitCell(cdp, index) {
  await cdp.evaluate(`(document.querySelectorAll('input[aria-label^="ციფრი #"]')[${index}].focus(), true)`);
}
async function closeWebcam(cdp) {
  await cdp.evaluate(`(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => x.innerText.includes('ვებკამერით 5-ნიშნა'));
    h.closest('.max-w-2xl').querySelector('button[aria-label="დახურვა"]').click();
    return true;
  })()`);
  await sleep(300);
}
/** Records every camera stream the page opens, to check that each one is stopped. */
const INSTALL_STREAM_RECORDER = `(() => {
  if (!window.__origGUM) window.__origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__streams = window.__streams || [];
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await window.__origGUM(c); window.__streams.push(s); return s; };
  return true;
})()`;
const liveTracks = (cdp) => cdp.evaluate(`(window.__streams || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length`);

async function setupOwnerThroughUi(cdp) {
  await cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'first-run owner form');
  for (const [i, v] of ['ტესტ მფლობელი', OWNER_PIN, OWNER_PIN].entries()) {
    await setInputValue(cdp, `document.querySelectorAll('form input')[${i}]`, v);
  }
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS screen');
  return cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
}

async function main() {
  // ================= Launch 1: two fake cameras =================
  let app = await launchApp(exe, dataDir, PORT, FAKE_CAMERAS);
  let { cdp } = app;
  const version = await cdp.evaluate(`document.querySelector('[data-testid="app-version"]')?.innerText || ''`).catch(() => '');
  const OT = await setupOwnerThroughUi(cdp);
  check('app under test started; owner created through the UI', !!OT, version);

  const car = await must(cdp, 'products:create', {
    name: 'სათამაშო მანქანა', base_price_tetri: 4500, base_cost_tetri: 2000,
    variants: [{ variant_name: 'წითელი', initial_stock: 20, codes: [{ code_type: 'manual_5digit', code_value: '12345' }, { code_type: 'barcode', code_value: '0004006381333' }] }],
  }, OT);
  const shoe = await must(cdp, 'products:create', {
    name: 'ბავშვის ფეხსაცმელი', base_price_tetri: 6000,
    variants: [{ variant_name: '30', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '23456' }, { code_type: 'barcode', code_value: '4860123456786' }] }],
  }, OT);
  await must(cdp, 'products:create', {
    name: 'ბურთი', base_price_tetri: 2500,
    variants: [{ variant_name: 'სტ', initial_stock: 9, codes: [{ code_type: 'manual_5digit', code_value: '10001' }] }],
  }, OT);
  // reload the POS catalogue
  await cdp.key('F2', { code: 'F2', vk: 113 }); await sleep(400);
  await cdp.key('F1', { code: 'F1', vk: 112 }); await sleep(600);

  // ---------- Camera: start, two cameras, switch, release ----------
  await cdp.evaluate(INSTALL_STREAM_RECORDER);
  await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
  await cdp.waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; })()`, 15000, 'camera picture');
  const cams = await cdp.evaluate(`[...document.querySelectorAll('select[aria-label="კამერის არჩევა"] option')].map((o) => ({ id: o.value, label: o.textContent }))`);
  const vid = await cdp.evaluate(`(() => { const v = document.querySelector('video'); return { w: v.videoWidth, h: v.videoHeight }; })()`);
  check('camera starts when the dialog opens (fake camera, real capture pipeline)', vid.w > 0, `${vid.w}x${vid.h}`);
  check('two cameras are listed with their names', cams.length === 2 && cams.every((c) => c.label && c.id), cams.map((c) => c.label).join(' | '));
  check('a fresh dialog shows no previous code or product', (await digitCells(cdp)).join('') === '' && !(await text(cdp)).includes('ფასი:'));

  // Capture & recognise; the window must keep drawing while recognising (no freeze)
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.evaluate(`(() => { window.__gaps = []; let last = performance.now(); window.__raf = true;
    const tick = (t) => { window.__gaps.push(t - last); last = t; if (window.__raf) requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
  const t0 = Date.now();
  await clickButton(cdp, 'კადრის გადაღება და ამოცნობა');
  await cdp.waitFor(`!document.body.innerText.includes('ამოცნობა მიმდინარეობს') && (document.body.innerText.includes('სანდოობა:') || document.body.innerText.includes('ვერ ამოიცნო') || document.body.innerText.includes('შეცდომა'))`, 20000, 'OCR result');
  const ocrMs = Date.now() - t0;
  await sleep(300);
  const frames = await cdp.evaluate(`(window.__raf = false, { n: window.__gaps.length, max: window.__gaps.length > 1 ? Math.max(...window.__gaps.slice(1)) : null })`);
  const afterCapture = await text(cdp);
  check('capture + recognition completes and shows editable digits', /სანდოობა:|ვერ ამოიცნო/.test(afterCapture) && !afterCapture.includes('OCR ამოცნობის შეცდომა'), `${ocrMs} ms, cells "${(await digitCells(cdp)).join(',')}"`);
  check('window keeps responding during recognition (longest frame gap < 250 ms)', frames.max !== null && frames.max < 250, frames.max === null ? `no frames painted (${frames.n}): window not visible` : `${Math.round(frames.max)} ms over ${frames.n} frames`);

  // Manual entry and correction through SmartDigitInput (real key events, human speed)
  for (let i = 0; i < 5; i++) { await focusDigitCell(cdp, i); await cdp.key('Delete', { code: 'Delete', vk: 46 }); await sleep(60); }
  await focusDigitCell(cdp, 0);
  await typeHuman(cdp, '12845');
  check('typed code fills the cells in order', (await digitCells(cdp)).join('') === '12845');
  await sleep(400);
  check('a code with no product shows "not found" and no confirm button', (await text(cdp)).includes('კოდით "12845" პროდუქტი ვერ მოიძებნა'));
  await focusDigitCell(cdp, 2);
  await typeHuman(cdp, '3');
  await cdp.waitFor(`document.body.innerText.includes('სათამაშო მანქანა')`, 5000, 'product after correction');
  check('correcting the middle digit changes only that cell and finds the product', (await digitCells(cdp)).join(',') === '1,2,3,4,5');
  await focusDigitCell(cdp, 2);
  await cdp.key('Backspace', { code: 'Backspace', vk: 8 });
  await sleep(300);
  const cellsAfterClear = await digitCells(cdp);
  const confirmHidden = !(await cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'დადასტურება')`));
  check('clearing a middle cell keeps the others in place and hides the confirm button', cellsAfterClear.join(',') === '1,2,,4,5' && confirmHidden, cellsAfterClear.join(','));
  await typeHuman(cdp, '3');
  await cdp.waitFor(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'დადასტურება')`, 5000, 'confirm button');

  // Switch camera: the old stream stops, the new one plays
  await cdp.evaluate(`(() => { const s = document.querySelector('select[aria-label="კამერის არჩევა"]'); s.value = ${JSON.stringify(cams[1]?.id || '')}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(1500);
  const afterSwitch = await cdp.evaluate(`(() => { const v = document.querySelector('video'); return { live: (window.__streams || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').map((t) => t.getSettings().deviceId), w: v?.videoWidth || 0 }; })()`);
  check('switching camera stops the previous stream and starts the chosen one', afterSwitch.live.length === 1 && afterSwitch.live[0] === cams[1]?.id && afterSwitch.w > 0, JSON.stringify(afterSwitch.live.length));

  // Confirm the product -> mandatory product confirmation -> cart
  await clickButton(cdp, 'დადასტურება');
  await sleep(400);
  check('confirming in the camera dialog opens the product confirmation (not the cart directly)', (await confirmOpen(cdp)) && !(await webcamOpen(cdp)) && (await cartRows(cdp)).length === 0);
  check('camera is released when the dialog closes', (await liveTracks(cdp)) === 0);
  await clickButton(cdp, 'კალათაში დამატება');
  await sleep(300);
  const cart1 = await cartRows(cdp);
  check('product added to the cart only after the seller confirmed', cart1.length === 1 && cart1[0].qty === 1);

  // Reopen: remembered camera, clean state
  await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
  await cdp.waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; })()`, 15000, 'camera picture again');
  const remembered = await cdp.evaluate(`(() => { const live = (window.__streams || []).flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live'); return live.map((t) => t.getSettings().deviceId); })()`);
  check('the chosen camera is remembered when the dialog opens again', remembered.length === 1 && remembered[0] === cams[1]?.id);
  check('reopened dialog starts clean (no previous code or product)', (await digitCells(cdp)).join('') === '' && !(await cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'დადასტურება')`)));
  await closeWebcam(cdp);
  check('closing with X releases the camera', (await liveTracks(cdp)) === 0);

  // Closed while the camera is still starting: the late stream must be stopped
  await cdp.evaluate(`(() => { window.__slow = []; navigator.mediaDevices.getUserMedia = async (c) => { await new Promise((r) => setTimeout(r, 800)); const s = await window.__origGUM(c); window.__slow.push(s); return s; }; return true; })()`);
  await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
  await sleep(150);
  await closeWebcam(cdp);
  await sleep(1800);
  const lateLive = await cdp.evaluate(`window.__slow.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length`);
  const lateCount = await cdp.evaluate(`window.__slow.length`);
  check('a camera that finishes starting after the dialog was closed is switched off at once', lateCount === 1 && lateLive === 0, `streams ${lateCount}, live ${lateLive}`);

  // Camera faults the seller can meet
  const faults = [
    ['NotAllowedError', 'კამერაზე წვდომა დაბლოკილია', 'blocked camera access (Windows privacy setting)'],
    ['NotReadableError', 'სხვა პროგრამა', 'camera busy in another program'],
    ['NotFoundError', 'კამერა ვერ მოიძებნა', 'no camera connected'],
  ];
  for (const [name, expected, label] of faults) {
    await cdp.evaluate(`(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('test', ${JSON.stringify(name)}); }; return true; })()`);
    await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
    await sleep(700);
    const t = await text(cdp);
    check(`${label}: plain instruction and a retry button`, t.includes(expected) && t.includes('ხელახლა ცდა') && t.includes('ფოტოს ატვირთვა'));
    await closeWebcam(cdp);
  }
  // Fault fixed -> "retry" brings the picture back without reopening
  await cdp.evaluate(`(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('busy', 'NotReadableError'); }; return true; })()`);
  await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
  await sleep(600);
  await cdp.evaluate(INSTALL_STREAM_RECORDER);
  await clickButton(cdp, 'ხელახლა ცდა');
  await cdp.waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; })()`, 15000, 'picture after retry');
  check('after the fault is fixed, "retry" starts the camera', true);
  await closeWebcam(cdp);
  check('camera released after retry and close', (await liveTracks(cdp)) === 0);

  // ---------- USB scanner (keyboard wedge) ----------
  // S1: focus on the cart "+" button; the scanner's Enter must not press it
  await cdp.evaluate(`(() => { const b = document.querySelector('button[aria-label="რაოდენობის გაზრდა"]'); b.focus(); b.click(); return document.activeElement === b; })()`);
  await sleep(200);
  const qtyBefore = (await cartRows(cdp))[0].qty;
  await scan(cdp, '4860123456786');
  const s1 = await confirmInfo(cdp);
  check('scan with focus on a cart button: opens the scanned product, the button is not pressed', !!s1 && s1.text.includes('ბავშვის ფეხსაცმელი') && (await cartRows(cdp))[0].qty === qtyBefore, `cart qty ${qtyBefore} -> ${(await cartRows(cdp))[0].qty}`);
  // S2: same product again while open -> quantity 2, still waiting for confirmation
  await scan(cdp, '4860123456786');
  const s2 = await confirmInfo(cdp);
  check('same product scanned again: quantity 2 in the open confirmation (not added yet)', s2.qty === 2 && s2.text.includes('იგივე პროდუქტი კიდევ ერთხელ') && (await cartRows(cdp)).length === 1);
  // S3: a different product while open -> queued, never replaces the open one
  await scan(cdp, '0004006381333');
  await scan(cdp, '0004006381333', { suffix: 'Tab' });
  const s3 = await confirmInfo(cdp);
  check('another product while one is open waits in the queue (Tab suffix too)', s3.text.includes('ბავშვის ფეხსაცმელი') && s3.text.includes('რიგში კიდევ 1'));
  // S4: scan into the quantity box: the box keeps the seller's value
  await cdp.evaluate(`(() => { const i = [...document.querySelectorAll('h3')].find((x) => x.innerText.trim() === 'პროდუქტის დადასტურება').closest('.max-w-md').querySelector('input[type=number]'); i.focus(); return true; })()`);
  await scan(cdp, '4860123456786');
  const s4 = await confirmInfo(cdp);
  check('scan while the quantity box has focus: the digits do not land in it', s4.qty === 3, `qty ${s4.qty}`);
  await clickButton(cdp, 'კალათაში დამატება');
  await sleep(400);
  const next = await confirmInfo(cdp);
  check('after confirming, the queued product opens with its scan count; leading zeros kept', !!next && next.text.includes('სათამაშო მანქანა') && next.text.includes('0004006381333') && next.qty === 2, next && `qty ${next.qty}`);
  await clickButton(cdp, 'კალათაში დამატება');
  await sleep(400);
  const cart2 = await cartRows(cdp);
  check('cart after the scans: each product once with the confirmed quantities', cart2.length === 2 && cart2.map((r) => r.qty).sort().join(',') === '3,4', JSON.stringify(cart2.map((r) => r.qty)));

  // S5: unknown barcode
  await scan(cdp, '4860000000000');
  check('unknown barcode: clear message, nothing opened or added', (await text(cdp)).includes('"4860000000000" ბაზაში ვერ მოიძებნა') && !(await confirmOpen(cdp)) && (await cartRows(cdp)).length === 2);
  // S6: NumLock off on a numpad-mode scanner
  await scan(cdp, '10001', { numpadNumLockOff: true });
  const s6 = await confirmInfo(cdp);
  check('numpad scanner with NumLock off is read correctly', !!s6 && s6.text.includes('ბურთი'));
  await clickButton(cdp, 'გაუქმება (Esc)');
  await sleep(300);
  // S7: ten scans in a row (two products alternating) -> nothing lost, nothing duplicated
  for (let i = 0; i < 10; i++) {
    await scan(cdp, i % 2 === 0 ? '23456' : '10001');
    await sleep(40);
  }
  const s7a = await confirmInfo(cdp);
  await clickButton(cdp, 'გაუქმება (Esc)');
  await sleep(300);
  const s7b = await confirmInfo(cdp);
  await clickButton(cdp, 'გაუქმება (Esc)');
  await sleep(300);
  check('ten rapid scans: the first product shows 5, the second waits with 5, nothing else', s7a?.text.includes('ბავშვის ფეხსაცმელი') && s7a.qty === 5 && s7b?.text.includes('ბურთი') && s7b.qty === 5 && !(await confirmOpen(cdp)),
    `${s7a?.qty} / ${s7b?.qty}`);
  // S8: a person typing a code + Enter in the search box still works
  await cdp.evaluate(`(document.querySelector('input[placeholder^="სკანირება"]').focus(), true)`);
  await typeHuman(cdp, '23456');
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await sleep(500);
  const s8 = await confirmInfo(cdp);
  check('typing a code by hand + Enter still works', !!s8 && s8.text.includes('ბავშვის ფეხსაცმელი') && s8.qty === 1);
  await clickButton(cdp, 'გაუქმება (Esc)');
  await sleep(300);
  // S9: scanning during payment is refused with a message
  await clickButton(cdp, 'გაყიდვის დადასტურება', { exact: false });
  await cdp.waitFor(`document.body.innerText.includes('გადახდის დადასტურება')`, 5000, 'payment dialog');
  await scan(cdp, '23456');
  const s9 = await text(cdp);
  check('scan during payment: not processed, the seller is told why', s9.includes('დასკანერებული კოდი 23456 არ დამუშავდა') && !(await confirmOpen(cdp)));
  // complete the sale in cash to reach the receipt
  await setInputValue(cdp, `[...document.querySelectorAll('input')].find((i) => i.closest('div')?.innerText.includes('მიღებული ნაღდი თანხა'))`, '500');
  await clickButton(cdp, 'გაყიდვის დასრულება');
  await cdp.waitFor(`document.body.innerText.includes('ახალი გაყიდვა')`, 10000, 'receipt');
  // S10: next customer's first scan closes the receipt
  await scan(cdp, '10001');
  const s10 = await confirmInfo(cdp);
  check('scan on the receipt screen starts the next sale with the scanned product', !!s10 && s10.text.includes('ბურთი') && !(await text(cdp)).includes('ახალი გაყიდვა'));
  await clickButton(cdp, 'გაუქმება (Esc)');
  await sleep(300);
  // S11: scanning while the camera dialog is open switches to the scanner
  await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
  await sleep(1200);
  await scan(cdp, '23456');
  const s11 = await confirmInfo(cdp);
  check('scan while the camera dialog is open: camera closes, scanned product opens', !!s11 && s11.text.includes('ბავშვის ფეხსაცმელი') && !(await webcamOpen(cdp)) && (await liveTracks(cdp)) === 0);
  await clickButton(cdp, 'გაუქმება (Esc)');
  await sleep(300);

  // Products screen: a scanner's Enter in the barcode field does not submit the new-product form
  await cdp.key('F2', { code: 'F2', vk: 113 });
  await sleep(600);
  const before = (await must(cdp, 'products:list', {}, OT)).length;
  await clickButton(cdp, 'ახალი პროდუქტი', { exact: false }).catch(() => {});
  await sleep(500);
  const hasBarcodeField = await cdp.evaluate(`!!document.querySelector('input[placeholder="სკანირება / ციფრები"]')`);
  if (hasBarcodeField) {
    await cdp.evaluate(`(document.querySelector('input[placeholder="სკანირება / ციფრები"]').focus(), true)`);
    await scan(cdp, '4860999999998');
    const after = (await must(cdp, 'products:list', {}, OT)).length;
    const fieldValue = await cdp.evaluate(`document.querySelector('input[placeholder="სკანირება / ციფრები"]')?.value`);
    check('new product form: scanning the barcode fills the field and does not submit the form', after === before && fieldValue === '4860999999998', `field "${fieldValue}"`);
  } else {
    check('new product form opened for the barcode-field check', false, 'form not found');
  }
  await cdp.key('Escape', { code: 'Escape', vk: 27 });
  await cdp.key('F1', { code: 'F1', vk: 112 });
  await sleep(400);

  // Render a test frame (printed digits on white paper in the camera frame) for launch 2
  const frame = await cdp.evaluate(`(() => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
    const x = c.getContext('2d');
    x.fillStyle = '#8a8f98'; x.fillRect(0, 0, 1280, 720);           // desk
    x.fillStyle = '#fbfbf8'; x.fillRect(200, 250, 880, 220);         // label
    x.fillStyle = '#111827'; x.font = 'bold 120px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    '10001'.split('').forEach((d, i) => x.fillText(d, 330 + i * 155, 362));
    const px = x.getImageData(0, 0, 1280, 720).data;
    let s = ''; const chunk = 0x8000;
    for (let i = 0; i < px.length; i += chunk) s += String.fromCharCode.apply(null, px.subarray(i, i + chunk));
    return btoa(s);
  })()`);
  const rgba = Buffer.from(frame, 'base64');
  const y4m = path.join(outDir, 'camera-test-10001.y4m');
  writeY4m(y4m, rgba, 1280, 720, 15);

  await cdp.screenshot(path.join(outDir, 'hw-01-pos-after-scans.png'));
  const closed = await closeApp(app);
  check('app closes cleanly after the camera and scanner tests', closed.clean, `${closed.seconds.toFixed(1)} s`);

  // ================= Launch 2: camera fed by the test video, after a restart =================
  app = await launchApp(exe, dataDir, PORT + 1, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`]);
  cdp = app.cdp;
  await cdp.waitFor(`document.body.innerText.includes('ტესტ მფლობელი')`, 20000, 'login screen');
  await cdp.evaluate(`([...document.querySelectorAll('button')].find(b => b.innerText.includes('ტესტ მფლობელი'))?.click(), true)`);
  await sleep(400);
  await typeHuman(cdp, OWNER_PIN);
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS after login');
  await clickButton(cdp, 'ვებკამერით 5-ნიშნა კოდის ამოცნობა', { exact: false });
  await cdp.waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; })()`, 15000, 'video-file camera picture');
  await sleep(800);
  await clickButton(cdp, 'კადრის გადაღება და ამოცნობა');
  await cdp.waitFor(`!document.body.innerText.includes('ამოცნობა მიმდინარეობს') && (document.body.innerText.includes('სანდოობა:') || document.body.innerText.includes('ვერ ამოიცნო'))`, 20000, 'OCR result 2');
  await sleep(500);
  const cells = (await digitCells(cdp)).join('');
  const t2 = await text(cdp);
  await cdp.screenshot(path.join(outDir, 'hw-02-ocr-video-frame.png'));
  check('after a restart OCR works again: camera frame -> recognition -> product (printed 10001)', cells === '10001' && t2.includes('ბურთი'), `read "${cells}"`);
  await closeWebcam(cdp);
  const closed2 = await closeApp(app);
  check('second close is clean', closed2.clean);

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ exe, dataDir, version, date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

/** Writes RGBA pixels as a YUV 4:2:0 Y4M video (the format Chromium's fake camera plays). */
function writeY4m(file, rgba, w, h, frames) {
  const ySize = w * h;
  const cSize = (w / 2) * (h / 2);
  const yuv = Buffer.alloc(ySize + 2 * cSize);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      yuv[y * w + x] = Math.max(0, Math.min(255, Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2])));
    }
  }
  for (let y = 0; y < h / 2; y++) {
    for (let x = 0; x < w / 2; x++) {
      const i = ((y * 2) * w + x * 2) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      yuv[ySize + y * (w / 2) + x] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
      yuv[ySize + cSize + y * (w / 2) + x] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
    }
  }
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F15:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < frames; f++) parts.push(Buffer.from('FRAME\n'), yuv);
  fs.writeFileSync(file, Buffer.concat(parts));
}

main().catch((err) => {
  console.error('E2E aborted:', err);
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ exe, dataDir, aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
