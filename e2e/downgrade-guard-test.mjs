/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Downgrade protection, tested with the REAL old RC3 program (StorePOS.exe unpacked from the
 * shipped StorePOS-Setup-1.0.0-rc.3.exe, never installed) on isolated profiles only:
 *
 *  A. RC3 builds a shop with history and makes a manual backup (the "before upgrade" backup);
 *  B. the new program (V1.1 RC2) opens it: schema v11, all guard triggers, every RC3 record and
 *     finance figure unchanged; then normal V1.1 work (kg product, kg sale, partial kg return,
 *     restock, debt sale, repayment, exchange, expense, category) succeeds;
 *  C. the OLD RC3 program opens the V1.1 database: it starts and the owner and a seller can sign
 *     in and read, but every RC3 operation that changes stock, costs, sales, debts, returns,
 *     products, customers or staff fails with the guard error, including RC3's database reset;
 *     afterwards every guarded table is byte-for-byte what V1.1 left (only RC3's logs, settings
 *     and sign-in counters may change) and the bookkeeping/FIFO identities hold;
 *  D. V1.1 opens it again: every record and finance figure identical, guard intact, V1.1 works;
 *  E. rollback to RC3 (documented procedure): RC3 signs in on the V1.1 database and restores the
 *     RC3 backup from A -> exactly the RC3 shop, RC3 works normally again; a V1.1 backup is
 *     refused by RC3; then the rollback is undone: V1.1 upgrades the RC3 data again and restores
 *     RC3's own pre-restore safety backup -> exactly the V1.1 shop from D;
 *  F. the real StorePOS installation was not touched.
 *
 *   node e2e/downgrade-guard-test.mjs --new-exe <StorePOS-Test.exe of RC2> --rc3-exe <RC3 StorePOS.exe>
 *        --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { launchApp, closeApp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';
import { must, PINS, PNG, fingerprint, sameAsRc3, buildRc3Shop } from './rc3-shop.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const newExe = arg('new-exe');
const rc3Exe = arg('rc3-exe');
const root = path.resolve(arg('data', 'downgrade-guard'));
const outDir = path.resolve(arg('out', 'downgrade-guard-report'));
const realInstalls = [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'StorePOS'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'StorePOS')];
const insideReal = (p) => realInstalls.some((r) => path.resolve(p).toLowerCase().startsWith(r.toLowerCase() + path.sep));
if (!newExe || !rc3Exe || !fs.existsSync(newExe) || !fs.existsSync(rc3Exe)) {
  console.error('usage: --new-exe <StorePOS-Test.exe> --rc3-exe <RC3 StorePOS.exe> --data <empty dir> --out <dir>');
  process.exit(2);
}
if (insideReal(newExe) || insideReal(rc3Exe) || insideReal(root)) {
  console.error('refusing: never use the real StorePOS installation');
  process.exit(2);
}
const P = path.join(root, 'shop');
const P2 = path.join(root, 'rollback');
for (const p of [P, P2]) if (fs.existsSync(path.join(p, 'data', 'store.db'))) { console.error(`refusing to run: ${p} already contains a store database`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const GUARD = /no such function: requires_storepos_v1_1/;
const GUARDED = ['categories', 'products', 'product_variants', 'product_codes', 'product_images', 'customers', 'inventory_movements', 'inventory_lots',
  'sales', 'sale_items', 'sale_item_lots', 'debt_repayments', 'debt_repayment_allocations', 'debt_adjustments', 'returns', 'return_items', 'expenses', 'user_permissions'];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s] ${m}`);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let port = 9700 + Math.floor(Math.random() * 80);
const dbFile = (profile) => path.join(profile, 'data', 'store.db');

/** Every table's rows (users without sign-in counters), read from a copy of the files. */
function tables(dbPath) {
  const tmp = fs.mkdtempSync(path.join(root, 'dump-'));
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, path.join(tmp, 'x.db' + suffix));
  const db = new DatabaseSync(path.join(tmp, 'x.db'));
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    let rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    if (name === 'users') rows = rows.map(({ failed_pin_attempts, locked_until, ...r }) => r);
    out[name] = sha(JSON.stringify(rows));
  }
  const meta = {
    schema: db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v,
    guards: db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'v11_guard_%'").get().n,
  };
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  return { out, meta };
}
const changedTables = (a, b) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

async function login(cdp, role, name) {
  const users = await must(cdp, 'auth:getActiveUsers', {});
  const u = users.find((x) => (name ? x.name === name : x.role === role));
  const pin = name === 'RC3 გამყიდველი ანა' ? PINS.s1 : name === 'RC3 გამყიდველი გიორგი' ? PINS.s2 : PINS.owner;
  return (await must(cdp, 'auth:login', { userId: u.id, pin })).token;
}

async function main() {
  const realStat = () => realInstalls.map((r) => path.join(r, 'StorePOS.exe')).filter((f) => fs.existsSync(f)).map((f) => { const st = fs.statSync(f); return { f, size: st.size, mtime: st.mtimeMs }; });
  const realBefore = realStat();

  // ===== A. RC3 builds a shop and a manual "before upgrade" backup =====
  log('A. RC3 builds the shop');
  let app = await launchApp(rc3Exe, P, port++);
  const shop = await buildRc3Shop(app.cdp);
  const fpRc3 = await fingerprint(app.cdp, shop.OT);
  await closeApp(app);
  const preUpgradeBackup = shop.backup2.backup_filename;
  check('A. the real RC3 program builds a shop with history and a manual backup', shop.counts.sales >= 150 && !!preUpgradeBackup,
    `${shop.counts.sales} sales, ${shop.counts.restocks} purchase batches, ${shop.counts.returns} returns, backup ${preUpgradeBackup}`);

  // ===== B. V1.1 upgrades it and works normally =====
  log('B. V1.1 opens the RC3 shop');
  app = await launchApp(newExe, P, port++);
  let OT = await login(app.cdp, 'owner');
  const fpUpgraded = await fingerprint(app.cdp, OT);
  const same = sameAsRc3(fpRc3, fpUpgraded);
  await closeApp(app);
  const afterUpgrade = tables(dbFile(P));
  check('B. V1.1 upgrade: schema v11, all 57 guard triggers, every RC3 record and finance figure unchanged',
    afterUpgrade.meta.schema === 11 && afterUpgrade.meta.guards === 57 && same.ok, `schema v${afterUpgrade.meta.schema}, ${afterUpgrade.meta.guards} triggers ${same.detail}`);

  app = await launchApp(newExe, P, port++);
  OT = await login(app.cdp, 'owner');
  const work = {};
  const call = async (key, channel, payload, token = OT) => {
    const r = await app.cdp.ipc(channel, payload, token);
    work[key] = r.success ? 'ok' : r.error;
    return r.data;
  };
  const emptyCat = await call('category', 'products:createCategory', { name: 'ცარიელი კატეგორია' });
  const kgProduct = await call('kg product', 'products:create', {
    name: 'ვაშლი (კგ)', unit_type: 'kg', category_id: shop.variants.length ? undefined : undefined, base_price_tetri: 350, base_cost_tetri: 200,
    variants: [{ variant_name: 'სტანდარტული', initial_stock: 20000, codes: [{ code_type: 'manual_5digit', code_value: '77001' }] }],
  });
  const kgVariant = kgProduct?.variants?.[0];
  await call('kg restock', 'inventory:restock', { variant_id: kgVariant?.id, added_quantity: 5000, unit_cost_tetri: 260 });
  const kgSale = await call('kg sale', 'pos:checkout', { items: [{ variant_id: kgVariant?.id, quantity: 23250 }], payment_method: 'debt', customer_id: shop.customers[0].id });
  await call('kg partial return', 'returns:process', { sale_id: kgSale?.id, items: [{ sale_item_id: kgSale?.items?.[0]?.id, quantity: 1250, condition: 'resellable' }], reason: 'V1.1 დაბრუნება' });
  const piece = shop.variants[3];
  await call('piece restock', 'inventory:restock', { variant_id: piece.id, added_quantity: 12, unit_cost_tetri: piece.cost + 111 });
  const cashSale = await call('cash sale', 'pos:checkout', { items: [{ variant_id: piece.id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: piece.price * 2 });
  await call('repayment', 'customers:repay', { customer_id: shop.customers[0].id, amount_tetri: 1500 });
  await call('exchange', 'returns:exchange', { original_sale_id: cashSale?.id, return_items: [{ sale_item_id: cashSale?.items?.[0]?.id, quantity: 1 }], new_items: [{ variant_id: shop.variants[7].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: shop.variants[7].price + 1000 });
  await call('expense', 'finance:createExpense', { category: 'იჯარა', description: 'V1.1 ხარჯი', amount_tetri: 12345 });
  const fpA = await fingerprint(app.cdp, OT);
  await closeApp(app);
  const failedWork = Object.entries(work).filter(([, v]) => v !== 'ok');
  check('B. V1.1 works normally with the guard (category, kg product, kg restock, kg sale, partial kg return, restock, cash sale, repayment, exchange, expense)',
    failedWork.length === 0, failedWork.map(([k, v]) => `${k}: ${v}`).join(' | ') || `${Object.keys(work).length} operations`);
  const recB = reconcileDatabase(dbFile(P));
  check('B. bookkeeping and FIFO identities hold after V1.1 work', recB.checks.every((x) => x.ok), JSON.stringify(recB.checks.filter((x) => !x.ok)));
  const beforeRc3 = tables(dbFile(P));

  // ===== C. the OLD RC3 program opens the V1.1 database =====
  log('C. the old RC3 program opens the V1.1 database');
  app = await launchApp(rc3Exe, P, port++);
  check('C. the old RC3 program starts on the V1.1 database (reading is allowed)', true, `started in ${app.startedMs} ms`);
  const TO = await login(app.cdp, 'owner');
  const TS = await login(app.cdp, 'seller', 'RC3 გამყიდველი ანა');
  const rc3Products = await must(app.cdp, 'products:list', { stockFilter: 'all' }, TO);
  const rc3Sales = await must(app.cdp, 'pos:searchSales', { limit: 5000 }, TO);
  check('C. owner and seller sign in to RC3 and can read products and sales', !!TO && !!TS && rc3Products.length === fpA.products.length && rc3Sales.length === fpA.sales.length,
    `${rc3Products.length} products, ${rc3Sales.length} sales`);

  const kgInRc3 = rc3Products.find((p) => p.name === 'ვაშლი (კგ)');
  const withImage = rc3Products.find((p) => (p.images || []).length > 0);
  const repayments = await must(app.cdp, 'customers:getRepayments', { customerId: shop.customers[0].id }, TO);
  const activeDebts = await must(app.cdp, 'customers:getActiveSales', { customerId: shop.customers[0].id }, TO);
  const openDebt = activeDebts.find((x) => (x.debt_remaining_tetri ?? 0) > 100);
  const seller = (await must(app.cdp, 'auth:getAllUsers', {}, TO)).find((u) => u.role === 'seller');
  const v11Sale = rc3Sales.find((s) => s.id === kgSale?.id) ? await must(app.cdp, 'pos:getSale', { saleId: kgSale.id }, TO).catch(() => null) : null;
  const multi = shop.variants[10];
  const attempts = [
    ['sale (cash, owner)', 'pos:checkout', { items: [{ variant_id: multi.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: multi.price + 500 }, TO],
    ['sale (cash, seller)', 'pos:checkout', { items: [{ variant_id: multi.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: multi.price + 500 }, TS],
    ['sale on debt', 'pos:checkout', { items: [{ variant_id: multi.id, quantity: 1 }], payment_method: 'debt', customer_id: shop.customers[1].id }, TO],
    ['sale of the kg product (RC3 would count pieces)', 'pos:checkout', { items: [{ variant_id: kgInRc3?.variants?.[0]?.id, quantity: 2 }], payment_method: 'cash', cash_received_tetri: 100000 }, TO],
    ['restock (new purchase batch)', 'inventory:restock', { variant_id: multi.id, added_quantity: 5, unit_cost_tetri: 777 }, TO],
    ['stock count correction', 'inventory:correct', { variant_id: multi.id, counted_quantity: 1, reason: 'RC3 აღწერა' }, TO],
    ['return of a V1.1 kg sale', 'returns:process', { sale_id: kgSale?.id, items: [{ sale_item_id: kgSale?.items?.[0]?.id, quantity: 1, condition: 'resellable' }], reason: 'RC3' }, TO],
    ['exchange', 'returns:exchange', { original_sale_id: shop.sales.find((s) => s.method === 'cash').sale.id, return_items: [{ sale_item_id: shop.sales.find((s) => s.method === 'cash').sale.items[0].id, quantity: 1 }], new_items: [{ variant_id: multi.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: multi.price + 1000 }, TO],
    ['new customer', 'customers:create', { first_name: 'RC3 კლიენტი' }, TS],
    ['debt repayment', 'customers:repay', { customer_id: shop.customers[0].id, amount_tetri: 100 }, TS],
    ['debt write-off', 'debts:writeOff', { customer_id: shop.customers[0].id, sale_id: openDebt?.id, amount_tetri: 50, reason: 'RC3' }, TO],
    ['void a repayment', 'debts:voidRepayment', { repayment_id: repayments?.[0]?.id, reason: 'RC3' }, TO],
    ['new product', 'products:create', { name: 'RC3 ახალი', base_price_tetri: 1000, base_cost_tetri: 500, variants: [{ variant_name: 'ვ1', initial_stock: 5, codes: [{ code_type: 'manual_5digit', code_value: '88001' }] }] }, TO],
    ['price change', 'products:update', { productId: rc3Products[0].id, base_price_tetri: rc3Products[0].base_price_tetri + 100 }, TO],
    ['archive a product', 'products:setActive', { productId: rc3Products[1].id, isActive: false }, TO],
    ['add a variant', 'products:addVariant', { productId: rc3Products[2].id, variant: { variant_name: 'RC3 ვ', initial_stock: 3, codes: [{ code_type: 'manual_5digit', code_value: '88002' }] } }, TO],
    ['change a variant price', 'products:updateVariant', { variantId: rc3Products[2].variants[0].id, price_override_tetri: 999 }, TO],
    ['archive a variant', 'products:setVariantActive', { variantId: rc3Products[3].variants[0].id, isActive: false }, TO],
    ['add a photo', 'products:addImage', { productId: rc3Products[4].id, filePath: PNG, isPrimary: false }, TO],
    ['delete a photo', 'products:deleteImage', { imageId: withImage?.images?.[0]?.id }, TO],
    ['set the main photo', 'products:setPrimaryImage', { imageId: withImage?.images?.[0]?.id }, TO],
    ['new category', 'products:createCategory', { name: 'RC3 კატეგორია' }, TO],
    ['rename a category', 'products:renameCategory', { categoryId: emptyCat?.id, name: 'RC3 სახელი' }, TO],
    ['delete a category', 'products:deleteCategory', { categoryId: emptyCat?.id }, TO],
    ['expense', 'finance:createExpense', { category: 'იჯარა', description: 'RC3 ხარჯი', amount_tetri: 1000 }, TO],
    ['new seller', 'auth:addUser', { name: 'RC3 ახალი გამყიდველი', pin: '9182', role: 'seller' }, TO],
    ['deactivate a seller', 'auth:setUserActive', { userId: seller.id, isActive: false }, TO],
    ['reset a seller PIN', 'auth:resetPin', { userId: seller.id, newPin: '5555' }, TO],
    ['change own PIN', 'auth:changeOwnPin', { currentPin: PINS.owner, newPin: '8642' }, TO],
    ['erase the whole database (RC3 reset)', 'auth:resetStoreDatabase', { pin: PINS.owner }, TO],
  ];
  const refused = [];
  for (const [label, channel, payload, token] of attempts) {
    const r = await app.cdp.ipc(channel, payload, token);
    refused.push({ label, channel, ok: !r.success && GUARD.test(r.error || ''), result: r.success ? 'ACCEPTED' : r.error });
  }
  const notGuarded = refused.filter((x) => !x.ok);
  check(`C. RC3 cannot do any of ${attempts.length} operations that change stock, costs, sales, debts, returns, products, customers or staff (each refused by the guard)`,
    notGuarded.length === 0, notGuarded.map((x) => `${x.label} (${x.channel}): ${x.result}`).join(' | ') || `e.g. "${refused[0].result}"`);
  const rc3Backup = await app.cdp.ipc('backup:create', {}, TO);
  check('C. RC3 can still make its own backup of the V1.1 data (backups are reading)', rc3Backup.success, rc3Backup.error || rc3Backup.data?.backup_filename);
  await closeApp(app);
  const afterRc3 = tables(dbFile(P));
  const changed = changedTables(beforeRc3.out, afterRc3.out);
  const guardedChanged = changed.filter((t) => GUARDED.includes(t) || t === 'users' || t === 'schema_migrations');
  check('C. after RC3: every guarded table (and users apart from sign-in counters) exactly as V1.1 left it; guard intact',
    guardedChanged.length === 0 && afterRc3.meta.guards === 57 && afterRc3.meta.schema === 11, `changed: ${changed.join(', ') || 'none'} (only logs/settings may change)`);
  const recC = reconcileDatabase(dbFile(P));
  check('C. bookkeeping and FIFO identities hold after RC3 ran', recC.checks.every((x) => x.ok), JSON.stringify(recC.checks.filter((x) => !x.ok)));

  // ===== D. V1.1 opens it again =====
  log('D. V1.1 opens the database again');
  app = await launchApp(newExe, P, port++);
  OT = await login(app.cdp, 'owner');
  const fpD0 = await fingerprint(app.cdp, OT);
  const sameD = JSON.stringify(fpD0) === JSON.stringify(fpA);
  const changedFinance = Object.keys(fpA.finance).filter((k) => JSON.stringify(fpA.finance[k]) !== JSON.stringify(fpD0.finance[k]));
  const after = await app.cdp.ipc('pos:checkout', { items: [{ variant_id: kgVariant?.id, quantity: 1500 }], payment_method: 'cash', cash_received_tetri: 1000 }, OT);
  const fpD = await fingerprint(app.cdp, OT);
  const v11Backup = await must(app.cdp, 'backup:create', {}, OT);
  await closeApp(app);
  check('D. V1.1 again: every user, product, stock, debt, sale and finance figure identical to before RC3; V1.1 sells normally',
    sameD && after.success, sameD ? (after.error || 'identical') : `finance changed: ${changedFinance.join(', ')}; parts differ: ${['users', 'products', 'debts', 'sales'].filter((k) => JSON.stringify(fpA[k]) !== JSON.stringify(fpD0[k])).join(', ')}`);
  const recD = reconcileDatabase(dbFile(P));
  check('D. bookkeeping and FIFO identities hold', recD.checks.every((x) => x.ok), JSON.stringify(recD.checks.filter((x) => !x.ok)));

  // ===== E. rollback to RC3, then undo the rollback =====
  log('E. rollback procedure on a copy');
  fs.mkdirSync(P2, { recursive: true });
  fs.cpSync(path.join(P, 'data'), path.join(P2, 'data'), { recursive: true });
  app = await launchApp(rc3Exe, P2, port++);
  let TR = await login(app.cdp, 'owner');
  const verifyV11 = await must(app.cdp, 'backup:verify', { filename: v11Backup.backup_filename }, TR);
  const restoreV11 = await app.cdp.ipc('backup:restoreFromList', { filename: v11Backup.backup_filename }, TR);
  check('E. RC3 refuses a backup made by V1.1 (newer schema): verification fails and restore is refused',
    verifyV11.is_valid === false && !restoreV11.success, `${verifyV11.integrity_status} | ${restoreV11.error || 'RESTORED'}`);
  const restored = await app.cdp.ipc('backup:restoreFromList', { filename: preUpgradeBackup }, TR);
  TR = await login(app.cdp, 'owner');
  const fpRolled = await fingerprint(app.cdp, TR);
  const rolledSame = JSON.stringify(fpRolled) === JSON.stringify(fpRc3);
  const sale3 = await app.cdp.ipc('pos:checkout', { items: [{ variant_id: multi.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: multi.price + 500 }, TR);
  const restock3 = await app.cdp.ipc('inventory:restock', { variant_id: multi.id, added_quantity: 4, unit_cost_tetri: 555 }, TR);
  const fpRolledWork = await fingerprint(app.cdp, TR);
  await closeApp(app);
  const rolled = tables(dbFile(P2));
  check('E. rollback: RC3 restores its "before upgrade" backup on the V1.1 database -> exactly the RC3 shop (schema v6, no guard)',
    restored.success && rolledSame && rolled.meta.schema === 6 && rolled.meta.guards === 0, restored.success ? `schema v${rolled.meta.schema}, ${rolled.meta.guards} triggers${rolledSame ? '' : ', data differ'}` : restored.error);
  check('E. after the rollback RC3 works normally (sale and restock accepted)', sale3.success && restock3.success, [sale3.error, restock3.error].filter(Boolean).join(' | '));
  const safety = path.basename(restored.data?.safety_backup || '');

  app = await launchApp(newExe, P2, port++);
  OT = await login(app.cdp, 'owner');
  const fpReUp = await fingerprint(app.cdp, OT);
  const reUp = sameAsRc3(fpRolledWork, fpReUp);
  const undo = await app.cdp.ipc('backup:restoreFromList', { filename: safety }, OT);
  OT = await login(app.cdp, 'owner');
  const fpUndone = await fingerprint(app.cdp, OT);
  const sale4 = await app.cdp.ipc('pos:checkout', { items: [{ variant_id: multi.id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: multi.price + 500 }, OT);
  await closeApp(app);
  const undone = tables(dbFile(P2));
  check('E. V1.1 can be installed again after a rollback: it upgrades the RC3 data (incl. work done in RC3) with every record unchanged',
    reUp.ok, reUp.detail || 'identical');
  check('E. the rollback can be undone: V1.1 restores RC3\'s own pre-restore safety backup -> exactly the V1.1 shop from D, guard intact, V1.1 sells',
    !!safety && undo.success && JSON.stringify(fpUndone) === JSON.stringify(fpD) && undone.meta.guards === 57 && sale4.success,
    !safety ? 'no safety backup reported' : !undo.success ? undo.error : JSON.stringify(fpUndone) !== JSON.stringify(fpD) ? 'data differ' : (sale4.error || `${safety}`));
  const recE = reconcileDatabase(dbFile(P2));
  check('E. bookkeeping and FIFO identities hold after undoing the rollback', recE.checks.every((x) => x.ok), JSON.stringify(recE.checks.filter((x) => !x.ok)));

  // ===== F. the real installation =====
  const realAfter = realStat();
  check('F. the real StorePOS installation on this computer was not touched (program file size and time unchanged)',
    JSON.stringify(realBefore) === JSON.stringify(realAfter),
    realBefore.length ? realBefore.map((r) => `${r.f}: ${r.size} bytes, ${new Date(r.mtime).toISOString()}`).join('; ') : 'no real installation found');

  fs.writeFileSync(path.join(outDir, 'downgrade-guard-report.json'), JSON.stringify({ newExe, rc3Exe, date: new Date().toISOString(), counts: shop.counts, work, refused, results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} downgrade-guard checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('downgrade-guard test aborted:', err);
  fs.writeFileSync(path.join(outDir, 'downgrade-guard-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
