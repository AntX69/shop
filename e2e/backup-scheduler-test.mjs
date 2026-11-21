/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Daily automatic backup of the real StorePOS.exe in real time, on isolated test profiles
 * (never the store's). The scheduler runs with its production settings: first check 60 s after
 * start, then every 30 minutes; a due backup waits for 20 s without requests from the window
 * (checked every 15 s), at most 30 minutes.
 *
 *  1. idle till: written at the first check, at least 20 s after the last request;
 *  2. restart the same day: nothing extra;
 *  3. frozen program (all its processes suspended for 90 s, like a PC that stops and resumes):
 *     the overdue check runs right after it resumes, one backup;
 *  4. busy till, then a pause: nothing while requests keep coming, written in the first pause;
 *  5. till never quiet for 30+ minutes: written after the 30-minute maximum wait; the driver
 *     proves it never paused (largest gap between requests) and measures lookups meanwhile;
 *  6. retention: only the newest N automatic backups stay, manual ones are never removed;
 *  7. every backup verifies; the newest is restored on a second, fresh profile and the data is
 *     identical (users and PINs, products and stock, debts, sales, finance), also after restart.
 *
 * "The next day" is made by setting the stored date of the last automatic backup to yesterday
 * while the program is closed; the computer's clock is never changed.
 *
 *   node e2e/backup-scheduler-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--busy-minutes 33]
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const root = path.resolve(arg('data', 'scheduler-profile'));
const outDir = path.resolve(arg('out', 'scheduler-report'));
const busyMinutes = Number(arg('busy-minutes', '33'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/backup-scheduler-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--busy-minutes 33]');
  process.exit(2);
}
const profileA = path.join(root, 'shop');
const profileB = path.join(root, 'restore');
for (const p of [profileA, profileB]) {
  if (fs.existsSync(path.join(p, 'data', 'store.db'))) { console.error(`refusing to run: ${p} already contains a store database`); process.exit(2); }
}
fs.mkdirSync(outDir, { recursive: true });
const dbFile = path.join(profileA, 'data', 'store.db');
const backupDir = path.join(profileA, 'data', 'backups');

const results = [];
const timeline = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const t0 = Date.now();
const log = (msg) => { const line = `[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)} s] ${msg}`; timeline.push(line); console.log(line); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 9700 + Math.floor(Math.random() * 80);
const PIN = '4826';
const SELLER_PIN = '3917';
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
const s = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Automatic backups on disk with the moment each was written (from its Tbilisi file stamp). */
function autos() {
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir).filter((f) => /^storepos_auto_.*\.posbackup$/.test(f)).sort().map((f) => {
    const m = f.match(/^storepos_auto_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})/);
    return { file: f, at: Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}+04:00`) };
  });
}
const manuals = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => /^storepos_manual_.*\.posbackup$/.test(f)).sort() : []);
const tbilisiDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(d);
function setting(key) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const v = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
  db.close();
  return v;
}
/** "The next day": the program is closed, the stored date of the last automatic backup becomes yesterday. */
function makeItTheNextDay() {
  const db = new DatabaseSync(dbFile);
  const yesterday = tbilisiDate(new Date(Date.now() - 24 * 3600 * 1000));
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_auto_backup_date', ?)").run(yesterday);
  db.close();
  return yesterday;
}
/** Waits (polling the folder once a second, never blocking) until there are `count` automatic backups. */
async function waitForAutos(count, maxMs) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (autos().length >= count) return autos();
    await sleep(1000);
  }
  return autos();
}

/** All processes of the program (main + children), for suspending and resuming them. */
function appPids(mainPid) {
  return new Promise((resolve) => {
    const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${mainPid} -or $_.ParentProcessId -eq ${mainPid} } | ForEach-Object { $_.ProcessId }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }, (err, out) => {
      resolve(err ? [mainPid] : out.split(/\s+/).filter(Boolean).map(Number));
    });
  });
}
function suspendResume(pids, action) {
  const fn = action === 'suspend' ? 'NtSuspendProcess' : 'NtResumeProcess';
  const ps = [
    `Add-Type -Namespace StorePosTest -Name Proc -MemberDefinition '[DllImport("ntdll.dll")] public static extern int ${fn}(IntPtr h); [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool i, int id); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);'`,
    `foreach ($id in @(${pids.join(',')})) { $h = [StorePosTest.Proc]::OpenProcess(0x0800, $false, $id); if ($h -ne [IntPtr]::Zero) { [void][StorePosTest.Proc]::${fn}($h); [void][StorePosTest.Proc]::CloseHandle($h); "$id ok" } else { "$id failed" } }`,
  ].join('; ');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60000 }, (err, out) => resolve(err ? `error: ${err.message}` : out.trim().replace(/\s+/g, ' ')));
  });
}

/**
 * A busy till: a product lookup every 0.3-1.1 s and a sale about every eighth request, without
 * any blocking call in this process. Records every request's start, the largest gap between
 * two requests and the lookup times.
 */
function busyTill(cdp, token, variants) {
  const state = { running: true, requests: [], latencies: [], sales: 0, errors: [] };
  state.done = (async () => {
    let i = 0;
    while (state.running) {
      const v = variants[i % variants.length];
      const started = Date.now();
      state.requests.push(started);
      try {
        if (i % 8 === 7) {
          const r = await cdp.ipc('pos:checkout', { items: [{ variant_id: v.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 10000 }, token);
          if (r.success) state.sales++; else state.errors.push(r.error);
        } else {
          const r = await cdp.ipc('products:lookupCode', { code: v.code }, token);
          if (!r.success) state.errors.push(r.error);
          state.latencies.push({ at: started, ms: Date.now() - started });
        }
      } catch (err) {
        state.errors.push(String(err?.message || err));
      }
      i++;
      await sleep(300 + Math.floor(Math.random() * 800));
    }
  })();
  state.stop = async () => { state.running = false; await state.done; };
  state.maxGap = () => state.requests.slice(1).reduce((m, t, k) => Math.max(m, t - state.requests[k]), 0);
  state.lastRequest = () => state.requests[state.requests.length - 1];
  return state;
}

async function login(cdp, pin = PIN, role = 'owner') {
  const user = (await must(cdp, 'auth:getActiveUsers', {})).find((u) => u.role === role);
  return (await must(cdp, 'auth:login', { userId: user.id, pin })).token;
}

async function fingerprint(cdp, T) {
  const products = (await must(cdp, 'products:list', { stockFilter: 'all' }, T)).map((p) => ({
    name: p.name, price: p.base_price_tetri, cost: p.base_cost_tetri,
    variants: (p.variants || []).map((v) => ({ name: v.variant_name, stock: v.stock_quantity, codes: (v.codes || []).map((c) => c.code_value).sort() })),
  }));
  const customers = await must(cdp, 'customers:list', {}, T);
  const debts = [];
  for (const c of customers) debts.push({ name: c.first_name, debt: (await must(cdp, 'customers:get', { customerId: c.id }, T)).total_debt_tetri });
  const users = (await must(cdp, 'auth:getActiveUsers', {})).map((u) => `${u.name}/${u.role}`).sort();
  const sales = (await must(cdp, 'pos:searchSales', { limit: 5000 }, T)).map((x) => `${x.id}:${x.total_tetri}:${x.payment_method}`).sort();
  const finance = await must(cdp, 'finance:summary', { preset: 'all' }, T);
  return { users, products, debts, sales, finance };
}

async function main() {
  // ============ 1. a new shop, then nobody touches the till ============
  log('start 1: new shop, set-up, then idle');
  let launchedAt = Date.now();
  let app = await launchApp(exe, profileA, port++);
  let T = (await must(app.cdp, 'auth:setupOwner', { name: 'დამგეგმავის მფლობელი', pin: PIN })).token;
  await must(app.cdp, 'auth:addUser', { name: 'დამგეგმავის გამყიდველი', pin: SELLER_PIN, role: 'seller' }, T);
  const variants = [];
  for (let i = 0; i < 30; i++) {
    const p = await must(app.cdp, 'products:create', {
      name: `სატესტო ნივთი ${i + 1}`, base_price_tetri: 500 + i * 37, base_cost_tetri: 250 + i * 11,
      variants: [{ variant_name: 'სტანდარტი', initial_stock: 2000, codes: [{ code_type: 'manual_5digit', code_value: String(40000 + i) }] }],
    }, T);
    variants.push({ id: p.variants[0].id, code: String(40000 + i) });
  }
  const cust = await must(app.cdp, 'customers:create', { first_name: 'ნათია' }, T);
  await must(app.cdp, 'pos:checkout', { items: [{ variant_id: variants[0].id, quantity: 3 }], payment_method: 'debt', customer_id: cust.id }, T);
  await must(app.cdp, 'pos:checkout', { items: [{ variant_id: variants[1].id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 5000 }, T);
  await must(app.cdp, 'customers:repay', { customer_id: cust.id, amount_tetri: 400 }, T);
  const lastSetupRequest = Date.now();
  log(`set-up done ${s(lastSetupRequest - launchedAt)} after launch; now idle`);
  let list = await waitForAutos(1, 150_000);
  const first = list[0];
  check('1. idle till: one automatic backup at the first check (60 s after start, after 20 s without requests)',
    list.length === 1 && first.at - launchedAt >= 55_000 && first.at - launchedAt <= 100_000 && first.at - lastSetupRequest >= 20_000,
    first ? `written ${s(first.at - launchedAt)} after launch, ${s(first.at - lastSetupRequest)} after the last request` : 'none within 150 s');
  check('1. the stored date of the last automatic backup is today (Tbilisi)', setting('last_auto_backup_date') === tbilisiDate(new Date()), setting('last_auto_backup_date'));
  await sleep(45_000);
  check('1. no second automatic backup the same day', autos().length === 1, `${autos().length}`);
  let closed = await closeApp(app);

  // ============ 2. restart the same day ============
  log('start 2: restart the same day, idle 100 s');
  app = await launchApp(exe, profileA, port++);
  await sleep(100_000);
  check('2. restart the same day: no extra automatic backup', autos().length === 1, `${autos().length} automatic backups`);
  closed = await closeApp(app);

  // ============ 3. the program is frozen and resumes ============
  makeItTheNextDay();
  log('start 3: "next day", the program is suspended 20 s after launch for 90 s');
  launchedAt = Date.now();
  app = await launchApp(exe, profileA, port++);
  await sleep(Math.max(0, 20_000 - (Date.now() - launchedAt)));
  const pids = await appPids(app.proc.pid);
  const suspended = await suspendResume(pids, 'suspend');
  const frozenAt = Date.now();
  log(`suspended ${pids.length} processes: ${suspended}`);
  let resumedAt = 0;
  try {
    await sleep(90_000);
    check('3. nothing is written while the program is frozen (the first check was due at 60 s)', autos().length === 1, `${autos().length}`);
  } finally {
    const resumed = await suspendResume(pids, 'resume');
    resumedAt = Date.now();
    log(`resumed after ${s(resumedAt - frozenAt)}: ${resumed}`);
  }
  list = await waitForAutos(2, 60_000);
  const afterFreeze = list[1];
  check('3. after resuming, the overdue first check runs at once and writes one backup',
    list.length === 2 && afterFreeze.at - resumedAt < 20_000, afterFreeze ? `written ${s(afterFreeze.at - resumedAt)} after resuming` : 'none within 60 s');
  const T3 = await login(app.cdp);
  const alive = await app.cdp.ipc('products:lookupCode', { code: variants[2].code }, T3);
  check('3. the till works normally after resuming', alive.success, alive.error || '');
  await sleep(40_000);
  check('3. still only one backup for that day', autos().length === 2, `${autos().length}`);
  closed = await closeApp(app);

  // ============ 4. busy till, then a pause ============
  makeItTheNextDay();
  log('start 4: "next day", the till is busy from the start for 4 minutes, then pauses');
  launchedAt = Date.now();
  app = await launchApp(exe, profileA, port++);
  T = await login(app.cdp);
  let busy = busyTill(app.cdp, T, variants);
  await sleep(4 * 60_000);
  const duringBusy = autos().length;
  await busy.stop();
  const pauseFrom = busy.lastRequest();
  log(`busy phase: ${busy.requests.length} requests, ${busy.sales} sales, largest gap ${s(busy.maxGap())}; pause`);
  check('4. no automatic backup while the till is busy (4 minutes, due since 60 s)', duringBusy === 2 && busy.maxGap() < 15_000, `${duringBusy - 2} new, largest gap between requests ${s(busy.maxGap())}`);
  list = await waitForAutos(3, 90_000);
  const inPause = list[2];
  check('4. written in the first pause: 20 s after the last request, within one more check (15 s)',
    list.length === 3 && inPause.at - pauseFrom >= 20_000 && inPause.at - pauseFrom <= 38_000, inPause ? `${s(inPause.at - pauseFrom)} after the last request` : 'none within 90 s');
  check('4. no failed request during the busy phase', busy.errors.length === 0, busy.errors.slice(0, 3).join('; '));
  closed = await closeApp(app);

  // ============ 5. never quiet: the 30-minute maximum ============
  makeItTheNextDay();
  log(`start 5: "next day", the till is busy for ${busyMinutes} minutes without a pause`);
  launchedAt = Date.now();
  app = await launchApp(exe, profileA, port++);
  T = await login(app.cdp);
  busy = busyTill(app.cdp, T, variants);
  let forced = null;
  while (Date.now() - launchedAt < busyMinutes * 60_000) {
    await sleep(5000);
    if (!forced && autos().length >= 4) { forced = autos()[3]; log(`automatic backup written ${s(forced.at - launchedAt)} after launch while busy`); }
  }
  await busy.stop();
  forced = forced || autos()[3] || null;
  const gap = busy.maxGap();
  log(`busy phase: ${busy.requests.length} requests, ${busy.sales} sales, largest gap ${s(gap)}`);
  check('5. the till was never quiet for 20 s (proof that no pause triggered the backup)', gap < 15_000, `largest gap between requests ${s(gap)}`);
  const sinceLaunch = forced ? forced.at - launchedAt : null;
  check('5. written after the 30-minute maximum wait (first check at 60 s + 30 min, ±15 s)',
    forced && sinceLaunch >= 30.9 * 60_000 && sinceLaunch <= 31.8 * 60_000, forced ? `${(sinceLaunch / 60_000).toFixed(2)} min after launch` : 'none');
  const around = forced ? busy.latencies.filter((l) => Math.abs(l.at - forced.at) < 10_000) : [];
  const worst = Math.max(0, ...around.map((l) => l.ms));
  check('5. the till keeps answering while the backup is written (slowest lookup within ±10 s < 3 s)', forced && worst < 3000, `${around.length} lookups, slowest ${worst} ms`);
  check('5. no failed request during the long busy phase', busy.errors.length === 0, busy.errors.slice(0, 3).join('; '));
  check('5. exactly one automatic backup that day', autos().length === 4, `${autos().length}`);

  // ============ 6. retention ============
  await must(app.cdp, 'backup:updateSettings', { settings: { backup_retention_count: '3' } }, T);
  const m1 = await must(app.cdp, 'backup:create', {}, T);
  const m2 = await must(app.cdp, 'backup:create', {}, T);
  closed = await closeApp(app);
  log('start 6: two more "days" with 3 automatic backups kept');
  for (let day = 0; day < 2; day++) {
    makeItTheNextDay();
    app = await launchApp(exe, profileA, port++);
    await waitForAutos(99, 85_000); // idle; the folder is read when the check has run
    if (day === 0) closed = await closeApp(app);
  }
  // The program from the last "day" stays open (idle): nothing was written after its backup.
  const kept = autos();
  check('6. retention: only the newest 3 automatic backups are kept (6 were written)', kept.length === 3 && kept[0].at >= (forced?.at ?? 0), kept.map((a) => a.file).join(', '));
  check('6. manual backups are never removed by retention', manuals().includes(m1.backup_filename) && manuals().includes(m2.backup_filename), manuals().join(', '));

  // ============ 7. integrity and restore ============
  T = await login(app.cdp);
  const all = [...kept.map((a) => a.file), ...manuals()];
  const verified = [];
  for (const f of all) verified.push({ f, v: await must(app.cdp, 'backup:verify', { filename: f }, T) });
  check('7. every remaining backup verifies (SHA-256 + SQLite integrity_check)', verified.every((x) => x.v.is_valid), verified.map((x) => `${x.f.slice(9, 13)}:${x.v.is_valid}`).join(' '));
  const newest = kept[kept.length - 1].file;
  const fpA = await fingerprint(app.cdp, T);
  closed = await closeApp(app);
  const recA = reconcileDatabase(dbFile);

  log('restore the newest automatic backup on a fresh profile');
  app = await launchApp(exe, profileB, port++);
  const TT = (await must(app.cdp, 'auth:setupOwner', { name: 'დროებითი', pin: '9999' })).token;
  fs.mkdirSync(path.join(profileB, 'data', 'backups'), { recursive: true });
  fs.copyFileSync(path.join(backupDir, newest), path.join(profileB, 'data', 'backups', newest));
  const restored = await must(app.cdp, 'backup:restoreFromList', { filename: newest }, TT);
  check('7. the newest automatic backup restores on a fresh profile', restored.success, restored.message);
  const TB = await login(app.cdp);
  const sellerLogin = await app.cdp.ipc('auth:login', { userId: (await must(app.cdp, 'auth:getActiveUsers', {})).find((u) => u.role === 'seller').id, pin: SELLER_PIN });
  const fpB = await fingerprint(app.cdp, TB);
  check('7. restored: owner and seller sign in with their PINs; no temporary owner', sellerLogin.success && JSON.stringify(fpB.users) === JSON.stringify(fpA.users), fpB.users.join(', '));
  check('7. restored: products and stock identical', JSON.stringify(fpB.products) === JSON.stringify(fpA.products), `${fpB.products.length} products`);
  check('7. restored: customer debts identical', JSON.stringify(fpB.debts) === JSON.stringify(fpA.debts), JSON.stringify(fpB.debts));
  check('7. restored: sales identical', JSON.stringify(fpB.sales) === JSON.stringify(fpA.sales), `${fpB.sales.length} sales`);
  check('7. restored: finance summary identical', JSON.stringify(fpB.finance) === JSON.stringify(fpA.finance));
  await closeApp(app);
  const recB = reconcileDatabase(path.join(profileB, 'data', 'store.db'));
  check('7. bookkeeping identities hold in the shop and in the restored copy', recA.checks.every((c) => c.ok) && recB.checks.every((c) => c.ok),
    JSON.stringify([...recA.checks, ...recB.checks].filter((c) => !c.ok)));
  app = await launchApp(exe, profileB, port++);
  const fpB2 = await fingerprint(app.cdp, await login(app.cdp));
  await closeApp(app);
  check('7. the restored copy is unchanged after a restart', JSON.stringify(fpB2) === JSON.stringify(fpA));

  fs.writeFileSync(path.join(outDir, 'scheduler-report.json'), JSON.stringify({ exe, date: new Date().toISOString(), busyMinutes, timeline, autos: autos(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} backup scheduler checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('scheduler test aborted:', err);
  fs.writeFileSync(path.join(outDir, 'scheduler-report.json'), JSON.stringify({ aborted: String(err?.stack || err), timeline, results }, null, 2));
  process.exit(1);
});
