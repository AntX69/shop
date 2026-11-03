/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Long-running (soak) test of the real StorePOS.exe on an isolated test profile — never the
 * store's database. For --minutes (default 120) it keeps working like a busy till:
 * product lookups and catalogue loads, cash/debt/mixed sales, repayments, returns
 * (resellable and damaged), exchanges, expenses, stock refills, screen changes, the camera
 * dialog opened and closed (Chromium's fake camera), a manual backup every 10 minutes with
 * the till's responsiveness measured during it, and the bookkeeping checked in SQLite every
 * 5 minutes through a separate read-only connection.
 *
 * The daily automatic backup is checked in real time: after each automatic backup the test
 * sets the "last automatic backup" date in the test database back to yesterday (the same as
 * the till staying open past midnight) and waits for the scheduler's next 30-minute check.
 *
 *   node e2e/soak-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--minutes 120]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp, Cdp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'soak-profile'));
const outDir = path.resolve(arg('out', 'soak-report'));
const minutes = Number(arg('minutes', '120'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/soak-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--minutes 120]');
  process.exit(2);
}
if (fs.existsSync(path.join(dataDir, 'data', 'store.db'))) {
  console.error(`refusing to run: ${dataDir} already contains a store database`);
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const dbFile = path.join(dataDir, 'data', 'store.db');
const backupDir = path.join(dataDir, 'data', 'backups');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timings = {};
const stats = (arr = []) => {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  return { n: s.length, p50: Math.round(s[Math.floor(s.length * 0.5)]), p95: Math.round(s[Math.floor(s.length * 0.95)] ?? s[s.length - 1]), max: Math.round(s[s.length - 1]) };
};
let seed = 7;
// LCG; the high bits are used (the low bits of an LCG repeat with a short period).
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
const tbilisiDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tbilisi' });

/** Working set / private bytes of the app's processes (main + its children). */
function processMemory(pid) {
  try {
    const ps = `$p = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${pid} -or $_.ParentProcessId -eq ${pid} };` +
      `$p | Select-Object ProcessId, WorkingSetSize, PrivatePageCount, @{n='Type';e={ if ($_.CommandLine -match '--type=(\\S+)') { $matches[1] } else { 'main' } }} | ConvertTo-Json -Compress`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 });
    const rows = [].concat(JSON.parse(out || '[]'));
    const mb = (n) => Math.round(Number(n) / 1048576);
    const by = (t) => rows.filter((r) => r.Type === t).reduce((s, r) => s + mb(r.PrivatePageCount), 0);
    return { total_private_mb: rows.reduce((s, r) => s + mb(r.PrivatePageCount), 0), main_mb: by('main'), renderer_mb: by('renderer'), gpu_mb: by('gpu-process'), processes: rows.length };
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  }
}

async function main() {
  const startedAt = Date.now();
  const port = 9600 + Math.floor(Math.random() * 90);
  const app = await launchApp(exe, dataDir, port, ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']);
  let cdp = app.cdp;
  const appLogFile = path.join(outDir, 'app-output.log');
  const flushAppLog = () => { try { fs.writeFileSync(appLogFile, app.log.join('')); } catch {} };
  let pageReloads = 0;
  const failures = [];
  const call = async (label, ch, p, t) => {
    const t0 = performance.now();
    const r = await cdp.ipc(ch, p, t);
    (timings[label] ||= []).push(performance.now() - t0);
    if (!r.success) throw Object.assign(new Error(`${ch}: ${r.error}`), { ipcError: r.error });
    return r.data;
  };
  const softCall = async (label, ch, p, t) => {
    try { return await call(label, ch, p, t); } catch (err) { failures.push({ at: new Date().toISOString(), label, error: err.message }); return null; }
  };

  // ---- set-up: owner through the UI, seller, catalogue with photos, customers ----
  await cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'owner form');
  for (const [i, v] of ['სოაკ მფლობელი', '3579', '3579'].entries()) {
    await cdp.evaluate(`(() => { const el = document.querySelectorAll('form input')[${i}]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  }
  await cdp.evaluate(`document.querySelector('form').requestSubmit(), true`);
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS');
  const OT = await cdp.evaluate(`sessionStorage.getItem('storepos_session_token')`);
  await call('settings', 'backup:updateSettings', { settings: { inactivity_lock_minutes: '240' } }, OT);
  await call('user', 'auth:addUser', { name: 'სოაკ გამყიდველი', pin: '8642', role: 'seller' }, OT);
  const seller = (await call('user', 'auth:getActiveUsers', {})).find((u) => u.role === 'seller');
  const ST = (await call('login', 'auth:login', { userId: seller.id, pin: '8642' })).token;

  // photos made in the page: 1024x768 JPEGs of noise (~150-250 KB each, like phone photos)
  const photo = () => cdp.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 1024; c.height = 768; const x = c.getContext('2d');
    const img = x.createImageData(1024, 768); for (let i = 0; i < img.data.length; i += 4) { const v = (Math.random() * 255) | 0; img.data[i] = v; img.data[i + 1] = (v * 7) & 255; img.data[i + 2] = (v * 13) & 255; img.data[i + 3] = 255; }
    x.putImageData(img, 0, 0); return c.toDataURL('image/jpeg', 0.6); })()`);
  const variants = [];
  const cats = [];
  for (const name of ['სათამაშოები', 'ტანსაცმელი', 'ფეხსაცმელი', 'აქსესუარები', 'სასკოლო']) cats.push(await call('category', 'products:createCategory', { name }, OT));
  let code = 10000;
  for (let i = 0; i < 400; i++) {
    const price = 300 + rnd(12000);
    const p = await call('product:create', 'products:create', {
      name: `სოაკ პროდუქტი ${i}`, category_id: cats[i % cats.length].id, base_price_tetri: price,
      base_cost_tetri: i % 9 === 0 ? null : Math.round(price * 0.6),
      variants: ['S', 'M', 'L'].map((size) => ({ variant_name: size, size, initial_stock: 30 + rnd(40), codes: [{ code_type: 'manual_5digit', code_value: String(code++) }] })),
      image_paths: i < 60 ? [await photo()] : [],
    }, OT);
    for (const v of p.variants) variants.push({ id: v.id, price, code: v.codes[0].code_value });
  }
  const customers = [];
  for (let i = 0; i < 50; i++) customers.push(await call('customer', 'customers:create', { first_name: `სოაკ კლიენტი ${i}`, phone: `5970000${String(i).padStart(2, '0')}` }, ST));
  const imagesMb = fs.readdirSync(path.join(dataDir, 'data', 'images')).reduce((s, f) => s + fs.statSync(path.join(dataDir, 'data', 'images', f)).size, 0) / 1048576;
  log(`set-up done: ${variants.length} variants, 60 photos (${imagesMb.toFixed(1)} MB), ${customers.length} customers`);

  await cdp.send('Performance.enable');
  await cdp.evaluate(`(() => { if (!window.__origGUM) window.__origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__streams = []; navigator.mediaDevices.getUserMedia = async (c) => { const s = await window.__origGUM(c); window.__streams.push(s); return s; }; return true; })()`);

  const counters = { sales: 0, cash: 0, debt: 0, mixed: 0, repayments: 0, returns: 0, damaged: 0, exchanges: 0, expenses: 0, restocks: 0, lookups: 0, catalogue_loads: 0, ui_rounds: 0, camera_rounds: 0, manual_backups: 0, reconciliations: 0, auto_backups_seen: 0 };
  const recentSales = [];
  const samples = [];
  const backupRuns = [];
  const reconcileRuns = [];
  const cameraLeaks = [];
  let dateResets = 0;
  const autoTimes = [];

  const sample = async (label) => {
    try { await cdp.send('HeapProfiler.collectGarbage'); } catch {}
    const heap = await cdp.send('Runtime.getHeapUsage');
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const wal = fs.existsSync(`${dbFile}-wal`) ? fs.statSync(`${dbFile}-wal`).size : 0;
    const s = {
      minute: Math.round((Date.now() - startedAt) / 60000), label,
      renderer_heap_mb: +(heap.usedSize / 1048576).toFixed(1), dom_nodes: m.Nodes, js_listeners: m.JSEventListeners,
      db_mb: +(fs.statSync(dbFile).size / 1048576).toFixed(2), wal_mb: +(wal / 1048576).toFixed(2),
      ...processMemory(app.proc.pid),
    };
    samples.push(s);
    flushAppLog();
    log(`sample: heap ${s.renderer_heap_mb} MB, nodes ${s.dom_nodes}, app private ${s.total_private_mb} MB (main ${s.main_mb}, renderer ${s.renderer_mb}), db ${s.db_mb} MB, wal ${s.wal_mb} MB`);
  };

  const sell = async () => {
    const lines = [...new Map(Array.from({ length: 1 + rnd(4) }, () => {
      const v = variants[rnd(variants.length)];
      return [v.id, { variant_id: v.id, quantity: 1 + rnd(2) }];
    })).values()];
    const total = lines.reduce((s, l) => s + l.quantity * variants.find((v) => v.id === l.variant_id).price, 0);
    const r = rnd(100);
    const kind = r < 70 ? 'cash' : r < 85 ? 'debt' : 'mixed';
    const payload = { items: lines, payment_method: kind, idempotency_key: `soak-${Date.now()}-${rnd(1e9)}` };
    if (kind !== 'cash') payload.customer_id = customers[rnd(customers.length)].id;
    if (kind === 'cash') payload.cash_received_tetri = total + rnd(1000);
    if (kind === 'mixed') payload.cash_received_tetri = Math.max(1, Math.floor(total / 2));
    try {
      const sale = await call('pos:checkout', 'pos:checkout', payload, ST);
      counters.sales++; counters[kind]++;
      recentSales.push(sale);
      if (recentSales.length > 80) recentSales.shift();
    } catch (err) {
      if (/მარაგ/.test(err.ipcError || '')) {
        for (const l of lines) await softCall('inventory:restock', 'inventory:restock', { variant_id: l.variant_id, added_quantity: 60, unit_cost_tetri: 500 }, OT);
        counters.restocks++;
      } else {
        failures.push({ at: new Date().toISOString(), label: 'pos:checkout', error: err.message });
      }
    }
  };

  const backupWithLatency = async (label) => {
    // the till keeps asking for products while the backup runs
    let running = true;
    const latencies = [];
    const prober = (async () => {
      while (running) {
        const t0 = performance.now();
        await cdp.ipc('products:lookupCode', { code: variants[rnd(variants.length)].code }, ST);
        latencies.push(performance.now() - t0);
        await sleep(50);
      }
    })();
    const t0 = performance.now();
    const b = await softCall('backup:create', 'backup:create', {}, OT);
    const ms = performance.now() - t0;
    running = false;
    await prober;
    if (!b) return;
    const v = await softCall('backup:verify', 'backup:verify', { filename: b.backup_filename }, OT);
    backupRuns.push({ label, minute: Math.round((Date.now() - startedAt) / 60000), size_mb: +(b.size_bytes / 1048576).toFixed(1), ms: Math.round(ms), verified: !!v?.is_valid, max_lookup_ms_during_backup: Math.round(Math.max(0, ...latencies)) });
    counters.manual_backups++;
    log(`backup ${label}: ${(b.size_bytes / 1048576).toFixed(1)} MB in ${Math.round(ms)} ms, verified ${!!v?.is_valid}, slowest lookup meanwhile ${Math.round(Math.max(0, ...latencies))} ms`);
  };

  const reconcile = (label) => {
    const r = reconcileDatabase(dbFile);
    const bad = r.checks.filter((c) => !c.ok);
    reconcileRuns.push({ label, minute: Math.round((Date.now() - startedAt) / 60000), ok: bad.length === 0, bad, figures: r.figures });
    counters.reconciliations++;
    if (bad.length) log(`RECONCILIATION FAILED: ${JSON.stringify(bad)}`);
    return r;
  };

  const autoBackups = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => /^storepos_auto_.*\.posbackup$/.test(f)) : []);
  const pushDateBack = () => {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 10000');
    const yesterday = tbilisiDate(new Date(Date.now() - 24 * 3600 * 1000));
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_auto_backup_date', ?)").run(yesterday);
    db.close();
    dateResets++;
    log(`automatic backup date set back to ${yesterday} (reset #${dateResets})`);
  };

  await sample('start');
  reconcile('start');
  const endAt = startedAt + minutes * 60000;
  let lastSample = Date.now(), lastBackup = Date.now(), lastReconcile = Date.now(), lastUi = Date.now(), lastCamera = Date.now();
  let seenAuto = 0;
  let cycle = 0;
  let closedEarly = false;
  while (Date.now() < endAt) {
    if (cdp.closed || app.proc.exitCode !== null) {
      await sleep(5000);
      flushAppLog();
      if (app.proc.exitCode === null) {
        // The page went away but the app is alive: it reloads a crashed page. Reconnect and go on.
        let target = null;
        for (let i = 0; i < 40 && !target; i++) {
          try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {}
          if (!target) await sleep(500);
        }
        if (target) {
          pageReloads++;
          failures.push({ at: new Date().toISOString(), label: 'page', error: `page process gone, reloaded by the app (#${pageReloads}); main log: ${app.log.filter((l) => /Page process gone/.test(l)).join(' ').trim().slice(0, 200)}` });
          log(`page process gone and reloaded by the app (#${pageReloads}): reconnecting`);
          cdp = await Cdp.connect(target.webSocketDebuggerUrl);
          await cdp.send('Runtime.enable');
          await cdp.send('Performance.enable');
          await cdp.waitFor(`typeof window.electronAPI?.invoke === 'function'`, 20000, 'bridge after reload');
          await cdp.evaluate(`(() => { if (!window.__origGUM) window.__origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            window.__streams = []; navigator.mediaDevices.getUserMedia = async (c) => { const s = await window.__origGUM(c); window.__streams.push(s); return s; }; return true; })()`);
          continue;
        }
      }
      closedEarly = true;
      failures.push({ at: new Date().toISOString(), label: 'app', error: `StorePOS window closed during the soak (exit code ${app.proc.exitCode}) — closed by hand or crashed` });
      log('StorePOS closed during the soak: stopping');
      break;
    }
    cycle++;
    // lookups like a scanner, and an occasional full catalogue load (new POS screen)
    for (let i = 0; i < 3; i++) { await softCall('lookup', 'products:lookupCode', { code: variants[rnd(variants.length)].code }, ST); counters.lookups++; }
    if (cycle % 20 === 0) { await softCall('products:list', 'products:list', { stockFilter: 'all' }, ST); counters.catalogue_loads++; }
    await sell();
    if (cycle % 5 === 0) {
      const c = customers[rnd(customers.length)];
      const info = await softCall('customers:get', 'customers:get', { customerId: c.id }, ST);
      if (info?.total_debt_tetri > 0) {
        await softCall('repay', 'customers:repay', { customer_id: c.id, amount_tetri: Math.max(1, Math.floor(info.total_debt_tetri / 3)), idempotency_key: `soak-rep-${cycle}` }, ST);
        counters.repayments++;
      }
    }
    if (cycle % 7 === 0 && recentSales.length > 10) {
      const s = recentSales[rnd(recentSales.length - 5)];
      const item = s.items[0];
      if (!item.__returned) {
        const damaged = rnd(4) === 0;
        const ok = await softCall('return', 'returns:process', { sale_id: s.id, items: [{ sale_item_id: item.id, quantity: 1, condition: damaged ? 'damaged' : 'resellable' }], idempotency_key: `soak-ret-${cycle}` }, ST);
        if (ok) { counters.returns++; if (damaged) counters.damaged++; item.__returned = true; }
      }
    }
    if (cycle % 29 === 0) {
      const s = recentSales.find((x) => x.debt_amount_tetri > 0 && !x.items[0].__returned);
      if (s) {
        const newVariant = variants[rnd(variants.length)];
        try {
          await call('exchange', 'returns:exchange', { original_sale_id: s.id, return_items: [{ sale_item_id: s.items[0].id, quantity: 1 }], new_items: [{ variant_id: newVariant.id, quantity: 1 }], payment_method: 'debt', idempotency_key: `soak-exc-${cycle}` }, ST);
          counters.exchanges++; s.items[0].__returned = true;
        } catch (err) {
          if (/მარაგ/.test(err.ipcError || '')) {
            // correctly refused: the new item is out of stock; refill it like the shop would
            counters.refused_out_of_stock = (counters.refused_out_of_stock || 0) + 1;
            await softCall('inventory:restock', 'inventory:restock', { variant_id: newVariant.id, added_quantity: 60, unit_cost_tetri: 500 }, OT);
          } else {
            failures.push({ at: new Date().toISOString(), label: 'exchange', error: err.message });
          }
        }
      }
    }
    if (cycle % 41 === 0) { await softCall('expense', 'finance:createExpense', { category: 'სხვა', description: `ხარჯი ${cycle}`, amount_tetri: 500 + rnd(3000) }, OT); counters.expenses++; }

    // screens: every 2 minutes walk through all eight tabs and back to the till
    if (Date.now() - lastUi > 2 * 60000) {
      for (let n = 1; n <= 8; n++) { await cdp.key(`F${n}`, { code: `F${n}`, vk: 111 + n }); await sleep(350); }
      await cdp.key('F1', { code: 'F1', vk: 112 });
      await sleep(400);
      counters.ui_rounds++;
      lastUi = Date.now();
    }
    // camera dialog: every 6 minutes open, wait for the picture, close, check the camera is off
    if (Date.now() - lastCamera > 6 * 60000) {
      try {
        await cdp.evaluate(`([...document.querySelectorAll('button')].find((b) => (b.title || '').includes('ვებკამერით'))?.click(), true)`);
        await cdp.waitFor(`(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; })()`, 10000, 'camera');
        await cdp.evaluate(`(() => { const h = [...document.querySelectorAll('h3')].find((x) => x.innerText.includes('ვებკამერით 5-ნიშნა')); h.closest('.max-w-2xl').querySelector('button[aria-label="დახურვა"]').click(); return true; })()`);
        await sleep(500);
        const live = await cdp.evaluate(`window.__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length`);
        if (live !== 0) cameraLeaks.push({ minute: Math.round((Date.now() - startedAt) / 60000), live });
        counters.camera_rounds++;
      } catch (err) {
        failures.push({ at: new Date().toISOString(), label: 'camera', error: String(err.message || err) });
      }
      lastCamera = Date.now();
    }
    if (Date.now() - lastBackup > 10 * 60000) { await backupWithLatency(`manual #${counters.manual_backups + 1}`); lastBackup = Date.now(); }
    if (Date.now() - lastReconcile > 5 * 60000) { reconcile(`minute ${Math.round((Date.now() - startedAt) / 60000)}`); lastReconcile = Date.now(); }
    if (Date.now() - lastSample > 5 * 60000) { await sample('periodic'); lastSample = Date.now(); }

    // automatic backup in real time
    const autos = autoBackups().length;
    if (autos > seenAuto) {
      seenAuto = autos;
      counters.auto_backups_seen = autos;
      autoTimes.push(Math.round((Date.now() - startedAt) / 60000));
      log(`automatic backup #${autos} written by the scheduler`);
      pushDateBack();
    } else if (dateResets === 0 && Date.now() - startedAt > 3 * 60000) {
      pushDateBack(); // no automatic backup yet (owner created after the first check): ask for one
    }
    await sleep(300 + rnd(700));
  }

  if (!closedEarly) await sample('end');
  const finalSummary = closedEarly ? null : await call('finance', 'finance:summary', { preset: 'all' }, OT);
  const closed = closedEarly ? { clean: false, seconds: 0 } : await closeApp(app);
  const final = reconcile('after close');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  db.close();

  // ---- verdict ----
  const durationMin = Math.round((Date.now() - startedAt) / 60000);
  check(`soak ran for ${durationMin} minutes with ${counters.sales} sales`, durationMin >= minutes - 1 && counters.sales > 100, JSON.stringify(counters));
  check('no unexpected IPC failure', failures.length === 0, failures.slice(0, 5).map((f) => `${f.label}: ${f.error}`).join(' | '));
  check('bookkeeping identities held at every check', reconcileRuns.every((r) => r.ok), `${reconcileRuns.length} checks; ${reconcileRuns.filter((r) => !r.ok).length} failed`);
  check('database intact after the run (integrity_check)', integrity === 'ok' && final.checks.every((c) => c.ok), integrity);
  check('every manual backup was written and verified', backupRuns.length >= Math.floor(minutes / 10) - 1 && backupRuns.every((b) => b.verified), backupRuns.map((b) => `${b.size_mb}MB/${b.ms}ms`).join(', '));
  const worstDuringBackup = Math.max(0, ...backupRuns.map((b) => b.max_lookup_ms_during_backup));
  check('till stays responsive during backups (slowest lookup < 3 s)', worstDuringBackup < 3000, `${worstDuringBackup} ms`);
  // The till is never quiet in this test, so each due backup waits the maximum 30 minutes.
  const expectedAuto = Math.max(1, Math.floor((durationMin - 31) / 60) + 1);
  check('daily automatic backup runs in real time; while the till is busy it waits (at most 30 minutes)', counters.auto_backups_seen >= expectedAuto && autoTimes[0] >= 25,
    `${counters.auto_backups_seen} automatic backups at minutes ${autoTimes.join(', ')}; ${dateResets} date changes`);
  check('camera released every time the dialog closed', cameraLeaks.length === 0 && counters.camera_rounds >= Math.floor(minutes / 6) - 1, `${counters.camera_rounds} rounds, ${cameraLeaks.length} leaks`);
  const base = samples.find((s) => s.minute >= 10) || samples[0];
  const end = samples[samples.length - 1];
  check('renderer memory does not keep growing (heap after GC ≤ 1.5× the 10-minute level + 20 MB)', end.renderer_heap_mb <= base.renderer_heap_mb * 1.5 + 20, `${base.renderer_heap_mb} → ${end.renderer_heap_mb} MB`);
  check('app memory does not keep growing (private bytes ≤ 1.5× the 10-minute level + 100 MB)', !end.total_private_mb || end.total_private_mb <= base.total_private_mb * 1.5 + 100, `${base.total_private_mb} → ${end.total_private_mb} MB`);
  check('WAL file stays bounded (checkpointing works)', Math.max(...samples.map((s) => s.wal_mb)) < 64, `max ${Math.max(...samples.map((s) => s.wal_mb))} MB`);
  check('app closes cleanly at the end', closed.clean, `${closed.seconds.toFixed(1)} s`);
  check('finance figures match the database', finalSummary?.outstanding_debt_tetri === final.figures.open_debt_tetri, `open debt ${final.figures.open_debt_tetri}`);

  flushAppLog();
  const report = { exe, dataDir, minutes, date: new Date().toISOString(), counters, autoTimes, pageReloads, timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stats(v)])), backupRuns, samples, reconcileRuns: reconcileRuns.map((r) => ({ label: r.label, ok: r.ok, bad: r.bad })), failures, cameraLeaks, results };
  fs.writeFileSync(path.join(outDir, 'soak-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'soak-memory.csv'), ['minute,label,renderer_heap_mb,dom_nodes,js_listeners,total_private_mb,main_mb,renderer_mb,gpu_mb,db_mb,wal_mb']
    .concat(samples.map((s) => [s.minute, s.label, s.renderer_heap_mb, s.dom_nodes, s.js_listeners, s.total_private_mb, s.main_mb, s.renderer_mb, s.gpu_mb, s.db_mb, s.wal_mb].join(','))).join('\n'));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} soak checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('soak aborted:', err);
  fs.writeFileSync(path.join(outDir, 'soak-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
