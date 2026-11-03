/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Start/stop robustness of the real StorePOS.exe on isolated test profiles (never the store's):
 * - repeated open -> sell -> close cycles, every 5th cycle killed (taskkill /F) in the middle of
 *   a burst of sales, like a power cut or a frozen PC; after every cycle the database is checked
 *   in SQLite and every sale the till confirmed must still be there;
 * - a second copy started by mistake exits at once and the first keeps working;
 * - a crashed page (renderer process) is reloaded by the app;
 * - a damaged database file or a file locked by another program: the app explains and stops,
 *   and leaves the file exactly as it was.
 *
 *   node e2e/restart-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--cycles 25]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp, Cdp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const dataDir = path.resolve(arg('data', 'restart-profile'));
const outDir = path.resolve(arg('out', 'restart-report'));
const cycles = Number(arg('cycles', '25'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/restart-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir> [--cycles 25]');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 9400 + Math.floor(Math.random() * 150);
const PIN = '5173';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killTree = (pid) => { try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {} };

/**
 * Watches (every 100 ms, for `ms`) for a dialog box (#32770) of any StorePOS.exe process and
 * resolves with the titles seen. Started before the app, so even a dialog that someone closes
 * within a second is noticed. The start-up error box (Electron's showErrorBox) is captioned
 * "Error"; its Georgian heading and text are inside the dialog.
 */
function watchDialogs(ms) {
  const ps = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class StorePosDialogs { public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n); }
'@
Write-Output 'ready'
$sw = [Diagnostics.Stopwatch]::StartNew(); $seen = @{}
while ($sw.ElapsedMilliseconds -lt ${ms}) {
  $ids = @(Get-Process StorePOS -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $found = New-Object System.Collections.ArrayList
  [void][StorePosDialogs]::EnumWindows({ param($h, $l) $id = 0; [void][StorePosDialogs]::GetWindowThreadProcessId($h, [ref]$id)
    if ($ids -contains $id -and [StorePosDialogs]::IsWindowVisible($h)) { $c = New-Object System.Text.StringBuilder 64; [void][StorePosDialogs]::GetClassName($h, $c, 64)
      if ($c.ToString() -eq '#32770') { $t = New-Object System.Text.StringBuilder 512; [void][StorePosDialogs]::GetWindowText($h, $t, 512); [void]$found.Add($t.ToString()) } }
    return $true }, [IntPtr]::Zero)
  foreach ($k in $found) { if (-not $seen.ContainsKey($k)) { $seen[$k] = 1; Write-Output ('dialog: ' + $k) } }
  Start-Sleep -Milliseconds 100 }`;
  const w = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] });
  const titles = [];
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  w.stdout.on('data', (d) => {
    for (const line of d.toString('utf8').split(/\r?\n/)) {
      if (line.trim() === 'ready') ready();
      else if (line.startsWith('dialog: ')) titles.push(line.slice(8));
    }
  });
  const done = new Promise((r) => w.on('exit', () => { ready(); r(titles); }));
  return { ready: readyP, done };
}

async function ownerToken(cdp) {
  const owner = (await cdp.ipc('auth:getActiveUsers', {})).data.find((u) => u.role === 'owner');
  const r = await cdp.ipc('auth:login', { userId: owner.id, pin: PIN });
  if (!r.success) throw new Error(`login: ${r.error}`);
  return r.data.token;
}

async function main() {
  // ---- first start: owner and catalogue ----
  let app = await launchApp(exe, dataDir, port++);
  let r = await app.cdp.ipc('auth:setupOwner', { name: 'რესტარტ მფლობელი', pin: PIN });
  if (!r.success) throw new Error(r.error);
  let T = r.data.token;
  const variants = [];
  for (let i = 0; i < 30; i++) {
    const p = (await app.cdp.ipc('products:create', { name: `რესტარტ ${i}`, base_price_tetri: 1000 + i * 10, base_cost_tetri: 500,
      variants: [{ variant_name: 'სტ', initial_stock: 500, codes: [{ code_type: 'manual_5digit', code_value: String(20000 + i) }] }] }, T)).data;
    variants.push({ id: p.variants[0].id, price: 1000 + i * 10 });
  }
  await closeApp(app);

  // ---- open / sell / close cycles, with hard kills ----
  const confirmed = new Set();
  const startTimes = [];
  const cycleProblems = [];
  let kills = 0;
  for (let c = 1; c <= cycles; c++) {
    app = await launchApp(exe, dataDir, port++);
    startTimes.push(app.startedMs);
    T = await ownerToken(app.cdp);
    const sell = async (k) => {
      const v = variants[(c * 7 + k) % variants.length];
      const res = await app.cdp.ipc('pos:checkout', { items: [{ variant_id: v.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: v.price, idempotency_key: `rs-${c}-${k}` }, T);
      if (res.success) confirmed.add(res.data.id);
      return res;
    };
    for (let k = 0; k < 3; k++) await sell(k);
    if (c % 5 === 0) {
      // burst of sales in flight, then the power goes
      const inflight = [];
      for (let k = 3; k < 23; k++) inflight.push(sell(k).catch(() => null));
      await sleep(60 + (c % 3) * 40);
      killTree(app.proc.pid);
      kills++;
      await Promise.allSettled(inflight);
      try { app.cdp.close(); } catch {}
      for (let i = 0; i < 50 && alive(app.proc.pid); i++) await sleep(100);
    } else {
      const closed = await closeApp(app);
      if (!closed.clean) cycleProblems.push(`cycle ${c}: not a clean close`);
    }
    const rec = reconcileDatabase(dbFile);
    const bad = rec.checks.filter((x) => !x.ok);
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const ids = new Set(db.prepare('SELECT id FROM sales').all().map((x) => x.id));
    const orphanItems = db.prepare('SELECT COUNT(*) AS n FROM sales s WHERE NOT EXISTS (SELECT 1 FROM sale_items i WHERE i.sale_id = s.id)').get().n;
    db.close();
    const lost = [...confirmed].filter((id) => !ids.has(id));
    if (bad.length || lost.length || orphanItems) cycleProblems.push(`cycle ${c}: ${JSON.stringify({ bad, lost, orphanItems })}`);
  }
  const s = [...startTimes].sort((a, b) => a - b);
  check(`${cycles} open/close cycles (${kills} hard kills mid-sale): database consistent after every cycle`, cycleProblems.length === 0, cycleProblems.slice(0, 3).join(' | '));
  check('every sale the till confirmed survived the kills (synchronous=FULL)', cycleProblems.every((p) => !p.includes('"lost":[')), `${confirmed.size} confirmed sales`);
  check('start-up time stays steady', s[s.length - 1] < 20000, `median ${(s[Math.floor(s.length / 2)] / 1000).toFixed(1)} s, max ${(s[s.length - 1] / 1000).toFixed(1)} s`);

  // ---- second instance ----
  app = await launchApp(exe, dataDir, port++);
  T = await ownerToken(app.cdp);
  const t0 = Date.now();
  const second = spawn(exe, [`--user-data-dir=${dataDir}`], { stdio: 'ignore' });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still running'), 15000);
    second.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  if (exitCode === 'still running') killTree(second.pid);
  const stillWorks = (await app.cdp.ipc('products:list', {}, T)).success;
  check('a second copy started by mistake exits at once; the first keeps working', exitCode === 0 && stillWorks, `exit ${exitCode} after ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // ---- crashed page is reloaded ----
  await app.cdp.send('Page.crash').catch(() => {});
  app.cdp.close();
  let reloaded = null;
  for (let i = 0; i < 60 && !reloaded; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port - 1}/json/list`)).json();
      const target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (target) {
        const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        if (await cdp.evaluate(`document.readyState === 'complete' && !!document.querySelector('#root')?.children.length`).catch(() => false)) reloaded = cdp;
        else cdp.close();
      }
    } catch {}
  }
  let afterCrash = false;
  if (reloaded) {
    app.cdp = reloaded;
    afterCrash = (await reloaded.ipc('products:list', {}, await ownerToken(reloaded))).success;
  }
  check('a crashed page is reloaded by the app and works again', !!reloaded && afterCrash && alive(app.proc.pid));
  const closedAfterCrash = await closeApp(app);
  check('clean close after the page crash', closedAfterCrash.clean);
  const recAfter = reconcileDatabase(dbFile);
  check('database consistent at the end', recAfter.checks.every((x) => x.ok), JSON.stringify(recAfter.figures));

  // ---- damaged database file ----
  const badDir = path.join(path.dirname(dataDir), `${path.basename(dataDir)}-damaged`);
  fs.mkdirSync(path.join(badDir, 'data'), { recursive: true });
  const badDb = path.join(badDir, 'data', 'store.db');
  fs.writeFileSync(badDb, Buffer.concat([Buffer.from('This is not an SQLite database. '), crypto.randomBytes(64 * 1024)]));
  const badHash = sha(badDb);
  const watch1 = watchDialogs(12000);
  await watch1.ready;
  const p1 = spawn(exe, [`--user-data-dir=${badDir}`], { stdio: 'ignore' });
  const dialogs1 = await watch1.done;
  const stillWaiting1 = alive(p1.pid); // the dialog waits for OK (unless someone already pressed it)
  killTree(p1.pid);
  await sleep(500);
  check('damaged database: the app stops with an explanation instead of starting', dialogs1.some((t) => /^Error$|მონაცემთა ბაზა ვერ გაიხსნა/.test(t)), `dialog ${JSON.stringify(dialogs1)}${stillWaiting1 ? ', waiting for OK' : ', OK pressed by someone'}`);
  check('damaged database file is left exactly as it was (nothing overwritten or deleted)', fs.existsSync(badDb) && sha(badDb) === badHash);

  // ---- database locked by another program ----
  const lockDb = new DatabaseSync(dbFile);
  lockDb.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  const lockedHash = sha(dbFile);
  // the app retries a held file for ~15 s (5 s busy wait per attempt) before it gives up
  const watch2 = watchDialogs(35000);
  await watch2.ready;
  const t2 = Date.now();
  const p2 = spawn(exe, [`--user-data-dir=${dataDir}`], { stdio: 'ignore' });
  const dialogs2 = await watch2.done;
  killTree(p2.pid);
  await sleep(500);
  const unchangedWhileLocked = sha(dbFile) === lockedHash;
  lockDb.exec('ROLLBACK;');
  lockDb.close();
  check('database locked by another program: retried, then explained; the file is not changed', dialogs2.some((t) => /^Error$|მონაცემთა ბაზა ვერ გაიხსნა/.test(t)) && unchangedWhileLocked, `dialog ${JSON.stringify(dialogs2)} (watched ${Math.round((Date.now() - t2) / 1000)} s)`);
  app = await launchApp(exe, dataDir, port++);
  const okAgain = (await app.cdp.ipc('products:list', {}, await ownerToken(app.cdp))).success;
  await closeApp(app);
  check('once the other program lets go, the app starts normally with all data', okAgain && reconcileDatabase(dbFile).checks.every((x) => x.ok));

  fs.writeFileSync(path.join(outDir, 'restart-report.json'), JSON.stringify({ exe, cycles, kills, confirmed: confirmed.size, startTimes, date: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} restart checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('restart test aborted:', err);
  fs.writeFileSync(path.join(outDir, 'restart-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
