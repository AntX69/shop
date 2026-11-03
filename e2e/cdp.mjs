/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal Chrome DevTools Protocol client for driving the real StorePOS.exe in E2E tests
 * (no browser-automation dependency). Uses Node's built-in WebSocket and fetch.
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    // If the app window goes away (closed by hand, crashed), fail loudly instead of leaving
    // promises that never settle (Node would then exit silently with code 0).
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP connection closed: the StorePOS window was closed or crashed'));
      this.pending.clear();
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP connection failed: ${wsUrl}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed: the StorePOS window was closed or crashed'));
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  /** Evaluates an expression in the page (promises awaited) and returns its JSON value. */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /** Calls the real preload bridge: renderer -> IPC -> main process -> SQLite. */
  async ipc(channel, payload, token) {
    const res = await this.evaluate(`window.electronAPI.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload ?? null)}, ${JSON.stringify(token ?? '')})`);
    return res;
  }

  async waitFor(predicateJs, timeoutMs = 15000, label = predicateJs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        if (await this.evaluate(`Boolean(${predicateJs})`)) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timeout waiting for: ${label}`);
  }

  async key(key, { code, vk, text } = {}) {
    const base = { key, code: code || key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async typeDigits(digits) {
    for (const d of digits) await this.key(d, { code: `Digit${d}`, vk: 48 + Number(d), text: d });
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

/** Starts StorePOS.exe with an isolated profile and a debugging port; returns process + page client. */
export async function launchApp(exe, userDataDir, port, extraArgs = []) {
  fs.mkdirSync(userDataDir, { recursive: true });
  // Keep painting and timers running when the test window is covered by another window, so
  // timing measurements do not depend on how windows happen to be stacked on the screen.
  const steady = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  const proc = spawn(exe, [`--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, ...steady, ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STOREPOS_NO_MAXIMIZE: '1', ELECTRON_ENABLE_LOGGING: '1' },
  });
  const log = [];
  proc.stdout.on('data', (d) => log.push(d.toString()));
  proc.stderr.on('data', (d) => log.push(d.toString()));

  const t0 = Date.now();
  let target = null;
  while (Date.now() - t0 < 45000) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
      if (target) break;
    } catch {}
    if (proc.exitCode !== null) throw new Error(`StorePOS exited early (code ${proc.exitCode}):\n${log.join('')}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!target) throw new Error(`app page not found on port ${port}\n${log.join('')}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  // The page target can exist before the preload has exposed the bridge.
  await cdp.waitFor(`typeof window.electronAPI?.invoke === 'function' && document.readyState !== 'loading'`, 20000, 'preload bridge');
  const startedMs = Date.now() - t0;
  const app = { proc, cdp, log, startedMs, pageUrl: target.url };
  if (process.env.STOREPOS_E2E_VISIBLE !== '1') app.window = moveOffscreen(app);
  return app;
}

/**
 * Moves the test window beyond the right edge of all monitors (Win32 MoveWindow on this test
 * process's own window), so long tests do not pop up in front of the person using the
 * computer. Painting continues thanks to the launch flags.
 */
export function moveOffscreen(app) {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -Namespace StorePosTest -Name Win -MemberDefinition \'[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);\'',
    '$v = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    `for ($i = 0; $i -lt 40; $i++) { $h = (Get-Process -Id ${app.proc.pid} -ErrorAction SilentlyContinue).MainWindowHandle; if ($h -and $h -ne 0) { break }; Start-Sleep -Milliseconds 250 }`,
    'if (-not $h -or $h -eq 0) { "no-window" } else { [void][StorePosTest.Win]::MoveWindow($h, $v.Right + 400, $v.Top, 1440, 900, $true); "moved to x=$($v.Right + 400)" }',
  ].join('; ');
  try {
    return execSync(`powershell.exe -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 60000 }).trim();
  } catch (err) {
    return `move failed: ${String(err?.message || err).slice(0, 200)}`;
  }
}

/** Closes the window the way a user does and waits for a clean exit. */
export async function closeApp(app, timeoutMs = 15000) {
  try { await app.cdp.evaluate('window.close(), true'); } catch {}
  app.cdp.close();
  const t0 = Date.now();
  while (app.proc.exitCode === null && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const clean = app.proc.exitCode !== null;
  if (!clean) {
    try { execSync(`taskkill /PID ${app.proc.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
  return { clean, exitCode: app.proc.exitCode, seconds: (Date.now() - t0) / 1000 };
}
