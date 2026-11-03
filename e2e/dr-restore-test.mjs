/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Disaster recovery with the real StorePOS.exe, on isolated test profiles only:
 * profile A plays the shop computer, profile B a new computer where StorePOS was just installed.
 * A: owner + seller, products with photos, cash/debt/mixed sales, repayments, returns,
 *    an exchange, a debt write-off, an expense; USB mirror missing, then present.
 * B: first start (temporary owner), the backup copied from the "USB" folder, restore, sign in
 *    with A's PIN, and every figure compared with A: users, products and stock, customers and
 *    debts, sales, finance summary, photo files byte for byte, the bookkeeping identities.
 *
 *   node e2e/dr-restore-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchApp, closeApp } from './cdp.mjs';
import { reconcileDatabase } from './reconcile.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const exe = arg('exe');
const root = path.resolve(arg('data', 'dr-profiles'));
const outDir = path.resolve(arg('out', 'dr-report'));
if (!exe || !fs.existsSync(exe)) {
  console.error('usage: node e2e/dr-restore-test.mjs --exe <StorePOS.exe> --data <empty dir> --out <report dir>');
  process.exit(2);
}
if (fs.existsSync(root) && fs.readdirSync(root).length) {
  console.error(`refusing to run: ${root} is not empty`);
  process.exit(2);
}
const profileA = path.join(root, 'shop-pc');
const profileB = path.join(root, 'new-pc');
const usb = path.join(root, 'usb-stick', 'StorePOS-Backups');
fs.mkdirSync(usb, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let port = 9550 + Math.floor(Math.random() * 40);
const must = async (cdp, channel, payload, token) => {
  const r = await cdp.ipc(channel, payload, token);
  if (!r.success) throw new Error(`${channel}: ${r.error}`);
  return r.data;
};
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const photoHashes = (profile) => {
  const dir = path.join(profile, 'data', 'images');
  return Object.fromEntries((fs.existsSync(dir) ? fs.readdirSync(dir) : []).sort().map((f) => [f, sha(fs.readFileSync(path.join(dir, f)))]));
};
const unusedDrive = () => ['Z', 'Y', 'X', 'W', 'V', 'U', 'T'].find((d) => !fs.existsSync(`${d}:\\`));

/** Everything the owner can see that must come back identically. */
async function fingerprint(cdp, T) {
  const products = (await must(cdp, 'products:list', { stockFilter: 'all' }, T)).map((p) => ({
    name: p.name, price: p.base_price_tetri, cost: p.base_cost_tetri, images: (p.images || []).length,
    variants: (p.variants || []).map((v) => ({ name: v.variant_name, stock: v.stock_quantity, codes: (v.codes || []).map((c) => c.code_value).sort() })),
  }));
  const customers = await must(cdp, 'customers:list', {}, T);
  const debts = [];
  for (const c of customers) debts.push({ name: `${c.first_name} ${c.last_name || ''}`.trim(), debt: (await must(cdp, 'customers:get', { customerId: c.id }, T)).total_debt_tetri });
  const users = (await must(cdp, 'auth:getActiveUsers', {})).map((u) => `${u.name}/${u.role}`).sort();
  const sales = (await must(cdp, 'pos:searchSales', { limit: 1000 }, T)).map((s) => `${s.id}:${s.total_tetri}:${s.payment_method}`).sort();
  const finance = await must(cdp, 'finance:summary', { preset: 'all' }, T);
  return { users, products, debts, sales, finance };
}

async function main() {
  // ================= A: the shop computer =================
  let app = await launchApp(exe, profileA, port++);
  let cdp = app.cdp;
  const OT = (await must(cdp, 'auth:setupOwner', { name: 'მაღაზიის მფლობელი', pin: '2468' })).token;
  await must(cdp, 'auth:addUser', { name: 'გამყიდველი ნინო', pin: '1357', role: 'seller' }, OT);
  const jpeg = () => cdp.evaluate(`(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 600; const x = c.getContext('2d');
    for (let i = 0; i < 400; i++) { x.fillStyle = 'hsl(' + ((i * 37) % 360) + ',70%,50%)'; x.fillRect((i * 53) % 800, (i * 29) % 600, 40 + (i % 60), 30 + (i % 50)); }
    x.fillStyle = '#000'; x.font = '48px Arial'; x.fillText('StorePOS ' + Math.random().toFixed(6), 40, 300); return c.toDataURL('image/jpeg', 0.85); })()`);
  const created = [];
  for (let i = 0; i < 8; i++) {
    created.push(await must(cdp, 'products:create', {
      name: `პროდუქტი ${i}`, base_price_tetri: 1500 + i * 250, base_cost_tetri: i === 7 ? null : 700 + i * 100,
      variants: [
        { variant_name: 'S', size: 'S', initial_stock: 15, codes: [{ code_type: 'manual_5digit', code_value: String(30000 + i * 2) }] },
        { variant_name: 'M', size: 'M', initial_stock: 9, codes: [{ code_type: 'manual_5digit', code_value: String(30001 + i * 2) }, { code_type: 'barcode', code_value: `00${4860000000 + i}` }] },
      ],
      image_paths: i < 5 ? [await jpeg(), ...(i === 0 ? [await jpeg()] : [])] : [],
    }, OT));
  }
  const v = (i, k = 0) => created[i].variants[k].id;
  const c1 = await must(cdp, 'customers:create', { first_name: 'გიორგი', last_name: 'ბერიძე', phone: '599111222' }, OT);
  const c2 = await must(cdp, 'customers:create', { first_name: 'მარიამ', phone: '577333444' }, OT);
  const s1 = await must(cdp, 'pos:checkout', { items: [{ variant_id: v(0), quantity: 2 }, { variant_id: v(1, 1), quantity: 1 }], payment_method: 'cash', cash_received_tetri: 10000 }, OT);
  const s2 = await must(cdp, 'pos:checkout', { items: [{ variant_id: v(2), quantity: 3 }], payment_method: 'debt', customer_id: c1.id }, OT);
  const s3 = await must(cdp, 'pos:checkout', { items: [{ variant_id: v(3, 1), quantity: 2 }], payment_method: 'mixed', customer_id: c2.id, cash_received_tetri: 2000 }, OT);
  await must(cdp, 'pos:checkout', { items: [{ variant_id: v(7), quantity: 1 }], payment_method: 'debt', customer_id: c2.id }, OT);
  await must(cdp, 'customers:repay', { customer_id: c1.id, amount_tetri: 1500 }, OT);
  await must(cdp, 'customers:repay', { customer_id: c2.id, sale_id: s3.id, amount_tetri: 500 }, OT);
  await must(cdp, 'returns:process', { sale_id: s1.id, items: [{ sale_item_id: s1.items[0].id, quantity: 1, condition: 'resellable' }] }, OT);
  await must(cdp, 'returns:process', { sale_id: s1.id, items: [{ sale_item_id: s1.items[1].id, quantity: 1, condition: 'damaged' }] }, OT);
  await must(cdp, 'returns:exchange', { original_sale_id: s2.id, return_items: [{ sale_item_id: s2.items[0].id, quantity: 1 }], new_items: [{ variant_id: v(4), quantity: 1 }], payment_method: 'debt' }, OT);
  await must(cdp, 'debts:writeOff', { customer_id: c2.id, sale_id: s3.id, amount_tetri: 300, reason: 'შეთანხმებით ჩამოწერა' }, OT);
  await must(cdp, 'finance:createExpense', { category: 'იჯარა', description: 'ნოემბრის იჯარა', amount_tetri: 50000 }, OT);
  const fpA = await fingerprint(cdp, OT);
  const photosA = photoHashes(profileA);
  check('shop computer: data with photos, debts, returns, exchange, write-off', Object.keys(photosA).length === 6 && fpA.sales.length >= 5, `${Object.keys(photosA).length} photos, ${fpA.sales.length} sales`);

  // USB stick missing: the backup still lands in the main folder, the owner is told
  const drive = unusedDrive();
  const missing = `${drive}:\\StorePOS-Backups`;
  const set = await cdp.ipc('backup:updateSettings', { settings: { backup_mirror_directory: missing } }, OT);
  check('a USB folder on a drive that is not connected cannot be chosen (write test fails)', !set.success, set.error || '');
  await must(cdp, 'backup:updateSettings', { settings: { backup_mirror_directory: usb } }, OT);
  fs.renameSync(path.dirname(usb), `${path.dirname(usb)}-unplugged`); // the stick is pulled out
  const b1 = await must(cdp, 'backup:create', {}, OT);
  check('USB stick pulled out: backup written to the main folder, the reason is reported', fs.existsSync(b1.filepath) && !b1.mirror_filepath && /ხელმისაწვდომი არ არის/.test(b1.mirror_error || ''), b1.mirror_error || '');
  fs.renameSync(`${path.dirname(usb)}-unplugged`, path.dirname(usb)); // plugged in again
  const b2 = await must(cdp, 'backup:create', {}, OT);
  check('USB stick back: the backup is copied there too, byte for byte', !!b2.mirror_filepath && fs.readFileSync(b2.mirror_filepath).equals(fs.readFileSync(b2.filepath)), b2.mirror_filepath || b2.mirror_error);
  const verify = await must(cdp, 'backup:verify', { filename: b2.backup_filename }, OT);
  check('the backup verifies (database checksum, integrity_check, photo checksums)', verify.is_valid && verify.stats.damaged_images === 0, verify.integrity_status);
  const closedA = await closeApp(app);
  check('shop computer closes cleanly', closedA.clean);

  // ================= B: a new computer =================
  app = await launchApp(exe, profileB, port++);
  cdp = app.cdp;
  const TT = (await must(cdp, 'auth:setupOwner', { name: 'დროებითი მფლობელი', pin: '9999' })).token;
  const backupsB = path.join(profileB, 'data', 'backups');
  fs.mkdirSync(backupsB, { recursive: true });
  const fromUsb = path.join(usb, path.basename(b2.mirror_filepath));

  // a damaged copy is refused and changes nothing
  const damagedName = 'storepos_manual_damaged-copy.posbackup';
  const raw = fs.readFileSync(fromUsb, 'utf-8');
  const bundle = JSON.parse(raw);
  const mid = Math.floor(bundle.db_base64.length / 2);
  bundle.db_base64 = bundle.db_base64.slice(0, mid) + (bundle.db_base64[mid] === 'A' ? 'B' : 'A') + bundle.db_base64.slice(mid + 1);
  fs.writeFileSync(path.join(backupsB, damagedName), JSON.stringify(bundle));
  const refused = await cdp.ipc('backup:restoreFromList', { filename: damagedName }, TT);
  const stillTemp = (await must(cdp, 'auth:getActiveUsers', {})).map((u) => u.name);
  check('a damaged backup copy is refused on the new computer; nothing changes', !refused.success && /Checksum|დაზიანებ/.test(refused.error) && stillTemp.join() === 'დროებითი მფლობელი', refused.error);

  fs.copyFileSync(fromUsb, path.join(backupsB, path.basename(fromUsb)));
  const restored = await must(cdp, 'backup:restoreFromList', { filename: path.basename(fromUsb) }, TT);
  check('restore on the new computer succeeds; all photos restored', restored.success && restored.restored_stats.images_restored === 6 && restored.restored_stats.images_damaged === 0, restored.message);
  const oldToken = await cdp.ipc('customers:list', {}, TT);
  check('the temporary owner is signed out (the restored store has its own users)', !oldToken.success);
  const owner = (await must(cdp, 'auth:getActiveUsers', {})).find((u) => u.role === 'owner');
  const OB = (await must(cdp, 'auth:login', { userId: owner.id, pin: '2468' })).token;
  const fpB = await fingerprint(cdp, OB);
  check('users: the shop\'s owner and seller (PINs work), no temporary owner', JSON.stringify(fpB.users) === JSON.stringify(fpA.users), fpB.users.join(', '));
  check('products, variants, codes and stock identical', JSON.stringify(fpB.products) === JSON.stringify(fpA.products), `${fpB.products.length} products`);
  check('customers and their debts identical', JSON.stringify(fpB.debts) === JSON.stringify(fpA.debts), JSON.stringify(fpB.debts));
  check('sales identical', JSON.stringify(fpB.sales) === JSON.stringify(fpA.sales), `${fpB.sales.length} sales`);
  check('finance summary identical (sales, returns, COGS, cash, debt, expenses)', JSON.stringify(fpB.finance) === JSON.stringify(fpA.finance));
  const photosB = photoHashes(profileB);
  check('photo files restored byte for byte', JSON.stringify(photosB) === JSON.stringify(photosA), `${Object.keys(photosB).length} files`);
  // The screen asks everyone to sign in again after a restore: sign in as the shop's owner.
  await cdp.evaluate('location.reload(), true').catch(() => {});
  await cdp.waitFor(`document.body.innerText.includes('მაღაზიის მფლობელი')`, 20000, 'sign-in screen with the restored users');
  await cdp.evaluate(`([...document.querySelectorAll('button')].find((b) => b.innerText.includes('მაღაზიის მფლობელი'))?.click(), true)`);
  await sleep(400);
  await cdp.typeDigits('2468');
  await cdp.key('Enter', { code: 'Enter', vk: 13, text: '\r' });
  await cdp.waitFor(`document.body.innerText.includes('გაყიდვის დადასტურება')`, 15000, 'POS after signing in with the old PIN');
  await cdp.key('F2', { code: 'F2', vk: 113 });
  await cdp.waitFor(`[...document.images].filter((i) => i.src.startsWith('storepos-img://') && i.complete && i.naturalWidth > 0).length >= 5`, 15000, 'photos on screen');
  check('sign-in screen with the old PIN; restored photos are shown in the products screen', true);
  const recB = reconcileDatabase(path.join(profileB, 'data', 'store.db'));
  check('bookkeeping identities hold after the restore', recB.checks.every((x) => x.ok), JSON.stringify(recB.checks.filter((x) => !x.ok)));
  const closedB = await closeApp(app);

  app = await launchApp(exe, profileB, port++);
  const OB2 = (await must(app.cdp, 'auth:login', { userId: owner.id, pin: '2468' })).token;
  const fpB2 = await fingerprint(app.cdp, OB2);
  await closeApp(app);
  check('after restarting the new computer everything is still there', closedB.clean && JSON.stringify(fpB2) === JSON.stringify(fpA));

  fs.writeFileSync(path.join(outDir, 'dr-report.json'), JSON.stringify({ exe, date: new Date().toISOString(), restored: restored.restored_stats, results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} disaster-recovery checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('DR test aborted:', err);
  fs.writeFileSync(path.join(outDir, 'dr-report.json'), JSON.stringify({ aborted: String(err?.stack || err), results }, null, 2));
  process.exit(1);
});
