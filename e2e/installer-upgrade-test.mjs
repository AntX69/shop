/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Installer update test: an older installer, data, then the newer installer over it (with the
 * old program still running), then uninstall. Run it with installers built under a separate
 * test identity (product "StorePOS-Test", its own app id, install folder and registry entry),
 * so the shop's real StorePOS installation and data on this computer are never touched:
 *
 *   npx electron-builder --win nsis -c.productName=StorePOS-Test -c.appId=com.storepos.offline.test \
 *     -c.extraMetadata.productName=StorePOS-Test -c.extraMetadata.name=storepos-test \
 *     -c.extraMetadata.version=<1.0.0 | 1.0.0-rc.2> -c.artifactName='StorePOS-Test-Setup-${version}.${ext}' \
 *     -c.nsis.createDesktopShortcut=false -c.nsis.createStartMenuShortcut=false -c.directories.output=<dir>
 *   node e2e/installer-upgrade-test.mjs --old <setup 1.0.0> --new <setup 1.0.0-rc.2> --dir <install dir> --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchApp, closeApp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const oldSetup = arg('old');
const newSetup = arg('new');
const installDir = path.resolve(arg('dir', ''));
const dataDir = path.resolve(arg('data', 'installer-profile'));
const outDir = path.resolve(arg('out', 'installer-report'));
const EXE = 'StorePOS-Test.exe';
const realInstall = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'StorePOS');
if (!oldSetup || !newSetup || !fs.existsSync(oldSetup) || !fs.existsSync(newSetup) || !/StorePOS-Test-Setup/.test(oldSetup + newSetup)) {
  console.error('usage: --old <StorePOS-Test-Setup-1.0.0.exe> --new <StorePOS-Test-Setup-1.0.0-rc.2.exe> --dir <install dir> --data <empty dir> --out <dir>');
  process.exit(2);
}
if (!/StorePOS-Test/i.test(installDir) || path.resolve(installDir).toLowerCase().startsWith(realInstall.toLowerCase())) {
  console.error(`refusing: the install folder must be a separate test folder, not ${realInstall}`);
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
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 60000 }).trim();
const run = (file, args) => new Promise((resolve) => {
  const p = spawn(file, args, { stdio: 'ignore', windowsVerbatimArguments: true });
  p.on('exit', (code) => resolve(code));
});
const uninstallEntries = () => {
  const out = ps(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'StorePOS-Test*' } | Select-Object DisplayName, DisplayVersion, InstallLocation | ConvertTo-Json -Compress`);
  return out ? [].concat(JSON.parse(out)) : [];
};
const productVersion = (file) => ps(`(Get-Item '${file.replace(/'/g, "''")}').VersionInfo.FileVersion`);
const exePath = path.join(installDir, EXE);
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
let port = 9450 + Math.floor(Math.random() * 40);

async function fingerprint(cdp, T) {
  const products = (await must(cdp, 'products:list', { stockFilter: 'all' }, T)).map((p) => `${p.name}:${(p.variants || []).map((v) => v.stock_quantity).join('/')}:${(p.images || []).length}`);
  const sales = (await must(cdp, 'pos:searchSales', { limit: 100 }, T)).map((s) => `${s.id}:${s.total_tetri}`);
  const finance = await must(cdp, 'finance:summary', { preset: 'all' }, T);
  return JSON.stringify({ products, sales, finance });
}

async function main() {
  // 1. older version
  check('older installer finishes silently', (await run(oldSetup, ['/S', `/D=${installDir}`])) === 0);
  check('older version installed in the test folder', fs.existsSync(exePath), productVersion(exePath));
  const entries1 = uninstallEntries();
  check('one Windows uninstall entry for the test identity', entries1.length === 1, JSON.stringify(entries1));

  // 2. shop data in the older version
  let app = await launchApp(exePath, dataDir, port++);
  const T = (await must(app.cdp, 'auth:setupOwner', { name: 'განახლების ტესტი', pin: '7531' })).token;
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const p = await must(app.cdp, 'products:create', { name: 'სათამაშო', base_price_tetri: 2500, base_cost_tetri: 1200, image_paths: [PNG],
    variants: [{ variant_name: 'სტ', initial_stock: 12, codes: [{ code_type: 'manual_5digit', code_value: '45678' }] }] }, T);
  const cust = await must(app.cdp, 'customers:create', { first_name: 'თამარ' }, T);
  await must(app.cdp, 'pos:checkout', { items: [{ variant_id: p.variants[0].id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 5000 }, T);
  await must(app.cdp, 'pos:checkout', { items: [{ variant_id: p.variants[0].id, quantity: 1 }], payment_method: 'debt', customer_id: cust.id }, T);
  await must(app.cdp, 'backup:create', {}, T);
  const before = await fingerprint(app.cdp, T);
  await closeApp(app);

  // 3. the old program is running while the update is installed
  const running = spawn(exePath, [`--user-data-dir=${dataDir}`], { stdio: 'ignore' });
  await sleep(6000);
  const t0 = Date.now();
  const code = await run(newSetup, ['/S', `/D=${installDir}`]);
  await sleep(2000);
  const stillRunning = (() => { try { process.kill(running.pid, 0); return true; } catch { return false; } })();
  check('newer installer finishes silently over the running older version', code === 0, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check('the running older program was closed by the installer (only the test folder\'s program)', !stillRunning);
  const v2 = fs.existsSync(exePath) ? productVersion(exePath) : 'missing';
  check('the program in the folder is now the newer version', v2 === '1.0.0-rc.2', v2);
  const entries2 = uninstallEntries();
  check('still exactly one uninstall entry, with the new version', entries2.length === 1 && entries2[0].DisplayVersion === '1.0.0-rc.2', JSON.stringify(entries2));

  // 4. data after the update
  app = await launchApp(exePath, dataDir, port++);
  const shown = await app.cdp.evaluate(`document.querySelector('[data-testid="app-version"]')?.innerText || ''`).catch(() => '');
  const owner = (await must(app.cdp, 'auth:getActiveUsers', {})).find((u) => u.role === 'owner');
  const T2 = (await must(app.cdp, 'auth:login', { userId: owner.id, pin: '7531' })).token;
  const after = await fingerprint(app.cdp, T2);
  check('after the update: same owner and PIN, products, stock, photo, sales, debt and finance', after === before);
  check('the sign-in screen shows the new version', /1\.0\.0-rc\.2/.test(shown), shown);
  const backups = await must(app.cdp, 'backup:list', {}, T2);
  check('backups made by the older version are listed and valid', backups.length >= 1 && backups.every((b) => b.is_valid));
  await closeApp(app);
  const rec = reconcileDatabase(path.join(dataDir, 'data', 'store.db'));
  check('bookkeeping identities hold after the update', rec.checks.every((c) => c.ok), JSON.stringify(rec.checks.filter((c) => !c.ok)));

  // 5. uninstall keeps the data
  const uninstaller = path.join(installDir, 'Uninstall StorePOS-Test.exe');
  await run(uninstaller, ['/S']);
  for (let i = 0; i < 60 && fs.existsSync(exePath); i++) await sleep(1000);
  await sleep(2000);
  check('uninstall removes the program', !fs.existsSync(exePath));
  check('uninstall removes the Windows uninstall entry', uninstallEntries().length === 0);
  check('uninstall keeps the store data', fs.existsSync(path.join(dataDir, 'data', 'store.db')) && rec.figures.sales === 2);

  fs.writeFileSync(path.join(outDir, 'installer-report.json'), JSON.stringify({ oldSetup, newSetup, installDir, date: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} installer update checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('installer test aborted:', err);
  fs.writeFileSync(path.join(outDir, 'installer-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
