/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean installation of a test-identity installer (product "StorePOS-Test", separate app id,
 * install folder and registry entry: the shop's real StorePOS is never touched):
 * silent install, first start with an empty profile (owner setup screen, no users, products,
 * customers or sales, no default PIN), no network requests, restart, offline start (proxy to a
 * dead address), uninstall (program and entry removed, data kept).
 *
 *   node e2e/clean-install-test.mjs --setup <StorePOS-Test-Setup-x.exe> --dir <test install dir> --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const setup = arg('setup');
const installDir = path.resolve(arg('dir', ''));
const dataDir = path.resolve(arg('data', 'clean-install-profile'));
const outDir = path.resolve(arg('out', 'clean-install-report'));
const version = (path.basename(setup || '').match(/Setup-(.+)\.exe$/i) || [])[1] || '';
const EXE = 'StorePOS-Test.exe';
const realInstall = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'StorePOS');
if (!setup || !fs.existsSync(setup) || !/StorePOS-Test-Setup/.test(setup)) {
  console.error('usage: --setup <StorePOS-Test-Setup-x.exe> --dir <test install dir> --data <empty dir> --out <dir>');
  process.exit(2);
}
if (!/StorePOS-Test/i.test(installDir) || installDir.toLowerCase().startsWith(realInstall.toLowerCase() + path.sep) || installDir.toLowerCase() === realInstall.toLowerCase()) {
  console.error(`refusing: the install folder must be a separate test folder, not ${realInstall}`);
  process.exit(2);
}
if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0) {
  console.error(`refusing to run: ${dataDir} is not empty`);
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
const entries = () => {
  const out = ps(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'StorePOS-Test*' } | Select-Object DisplayName, DisplayVersion | ConvertTo-Json -Compress`);
  return out ? [].concat(JSON.parse(out)) : [];
};
const exePath = path.join(installDir, EXE);
let port = 9500 + Math.floor(Math.random() * 40);

async function main() {
  check('no test-identity installation present before the test', entries().length === 0 && !fs.existsSync(exePath));
  check('installer finishes silently', (await run(setup, ['/S', `/D=${installDir}`])) === 0);
  check('program installed in the test folder with the right version', fs.existsSync(exePath) && ps(`(Get-Item '${exePath.replace(/'/g, "''")}').VersionInfo.FileVersion`) === version, version);
  check('OCR model installed with the program', fs.existsSync(path.join(installDir, 'resources', 'models', 'handwriting-digits.onnx')));
  // V1.2: the installer's language (a silent install takes the Windows display language when it
  // is one of the four, else Georgian) is written for the program's first screens.
  const langFile = path.join(installDir, 'install-language.txt');
  const lcid = fs.existsSync(langFile) ? fs.readFileSync(langFile, 'utf8').trim() : '';
  const LANG_OF = { '1079': ['ka', /მფლობელ/], '1033': ['en', /owner/i], '1049': ['ru', /владельц/i], '3082': ['es', /propietario/i] };
  check("the installer wrote its language for the program's first screens", !!LANG_OF[lcid], `install-language.txt = ${lcid || 'missing'} (${LANG_OF[lcid]?.[0] || '?'})`);
  check('one Windows uninstall entry', entries().length === 1, JSON.stringify(entries()));

  // First start with an empty profile
  let app = await launchApp(exePath, dataDir, port++);
  const network = [];
  app.cdp.on('Network.requestWillBeSent', (p) => network.push(p.request.url));
  await app.cdp.send('Network.enable');
  await app.cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'owner setup form');
  const first = await app.cdp.evaluate(`({ text: document.body.innerText, version: document.querySelector('[data-testid="app-version"]')?.innerText || '' })`);
  check("first start asks to create the owner account (no pre-created user), in the installer's language", (LANG_OF[lcid]?.[1] || /მფლობელ/).test(first.text), `${first.version}, ${LANG_OF[lcid]?.[0] || '?'}`);
  const hasOwner = await app.cdp.ipc('auth:hasOwner', {});
  const users = await app.cdp.ipc('auth:getActiveUsers', {});
  check('no owner and no users exist; nobody can sign in', hasOwner.success && hasOwner.data === false && users.success && users.data.length === 0);
  const tries = [];
  for (const pin of ['0000', '1234', '1111', '123456']) tries.push(await app.cdp.ipc('auth:login', { userId: 1, pin }));
  check('no default PIN works', tries.every((t) => !t.success));
  await sleep(1500);
  const external = network.filter((u) => !/^(file|devtools|data|blob|chrome-extension|storepos-img):/i.test(u));
  check('no network requests on first start', external.length === 0, external.slice(0, 3).join(', '));
  let closed = await closeApp(app);
  check('closes cleanly', closed.clean, `exit ${closed.exitCode}`);

  const dbFile = path.join(dataDir, 'data', 'store.db');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const counts = Object.fromEntries(['users', 'products', 'product_variants', 'customers', 'sales', 'categories', 'expenses', 'user_permissions'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  const schema = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  db.close();
  check('new database is empty (no test customers, products, sales or PINs), schema v12, intact', Object.values(counts).every((n) => n === 0) && schema === 12 && integrity === 'ok', JSON.stringify(counts));

  // Restart, offline (all traffic sent to a dead proxy)
  app = await launchApp(exePath, dataDir, port++, ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>']);
  await app.cdp.waitFor(`document.querySelectorAll('form input').length >= 3`, 20000, 'owner setup after restart');
  const setupOwner = await app.cdp.ipc('auth:setupOwner', { name: 'სუფთა ინსტალაცია', pin: '582917' });
  const T = setupOwner.data?.token;
  const prod = await app.cdp.ipc('products:create', { name: 'პირველი', base_price_tetri: 1000, variants: [{ variant_name: 's', initial_stock: 3, codes: [{ code_type: 'manual_5digit', code_value: '12121' }] }] }, T);
  const sale = await app.cdp.ipc('pos:checkout', { items: [{ variant_id: prod.data?.variants?.[0]?.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 1000 }, T);
  check('restart without internet: owner created, product and sale work', setupOwner.success && prod.success && sale.success, sale.error || prod.error || setupOwner.error);
  closed = await closeApp(app);
  check('closes cleanly again', closed.clean);

  // Uninstall keeps the data
  await run(path.join(installDir, 'Uninstall StorePOS-Test.exe'), ['/S']);
  for (let i = 0; i < 60 && fs.existsSync(exePath); i++) await sleep(1000);
  await sleep(2000);
  check('uninstall removes the program and its entry', !fs.existsSync(exePath) && entries().length === 0);
  check('uninstall keeps the store data', fs.existsSync(dbFile));
}

main()
  .catch((err) => check('test completed without an exception', false, err.stack || String(err)))
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length;
    fs.writeFileSync(path.join(outDir, 'clean-install.json'), JSON.stringify({ when: new Date().toISOString(), setup, results }, null, 2));
    console.log(`\n${results.length - failed}/${results.length} checks passed`);
    process.exit(failed ? 1 : 0);
  });
