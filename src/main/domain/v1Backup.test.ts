/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backup / restore / reset regression suite on real database files in a temp folder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, LATEST_SCHEMA_VERSION } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { PosService } from './posService.ts';
import { CustomerService } from './customerService.ts';
import { ReturnsService } from './returnsService.ts';
import { BackupService } from './backupService.ts';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-backup-'));
  const dbPath = path.join(dir, 'store.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  runMigrations(db, dbPath);
  const auth = new AuthService(db);
  const owner = auth.setupInitialOwner('მფლობელი', '1111').user;
  const seller = auth.addUser(owner, 'გამყიდველი', '2222', 'seller');
  const products = new ProductsService(db);
  const p = products.createProduct(owner, {
    name: 'სათამაშო', base_price_tetri: 3000, base_cost_tetri: 1000,
    variants: [{ variant_name: 'სტ', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '31000' }] }],
  });
  return { dir, dbPath, db, auth, owner, seller, products, variant: p.variants![0], backup: new BackupService(db, dbPath) };
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;

test('F13: database reset works with returns, exchanges and repayments, after a verified backup', () => {
  const e = setup();
  const pos = new PosService(e.db);
  const customers = new CustomerService(e.db);
  const returns = new ReturnsService(e.db);
  const cust = customers.createCustomer(e.seller, { first_name: 'ნინო' });
  const sale = pos.checkout(e.seller, { items: [{ variant_id: e.variant.id, quantity: 2 }], payment_method: 'debt', customer_id: cust.id });
  customers.recordRepayment(e.seller, { customer_id: cust.id, amount_tetri: 1000 });
  returns.processReturn(e.seller, { sale_id: sale.id, items: [{ sale_item_id: sale.items![0].id, variant_id: e.variant.id, quantity: 1 }] });
  returns.processExchange(e.seller, {
    original_sale_id: sale.id,
    return_items: [{ sale_item_id: sale.items![0].id, variant_id: e.variant.id, quantity: 1 }],
    new_items: [{ variant_id: e.variant.id, quantity: 1 }],
  });

  e.auth.resetStoreDatabase(e.owner, '1111', e.backup);
  for (const t of ['users', 'sales', 'returns', 'debt_repayments', 'products', 'sale_item_lots']) {
    assert.equal(count(e.db, t), 0, `${t} emptied`);
  }
  const prereset = fs.readdirSync(path.join(e.dir, 'backups')).filter((f) => f.startsWith('storepos_prereset_'));
  assert.equal(prereset.length, 1);
  const check = e.backup.verifyBackup(e.owner, fs.readFileSync(path.join(e.dir, 'backups', prereset[0]), 'utf-8'));
  assert.equal(check.is_valid, true);
  assert.equal(check.stats.sales_count, 2);
});

test('automatic backups: once per Tbilisi day, retention keeps the newest N, manual ones are kept', () => {
  const e = setup();
  e.backup.updateSettings(e.owner, { backup_retention_count: '3' });
  assert.equal(e.backup.runScheduledBackupIfDue(new Date('2026-11-01T08:00:00Z')), true);
  assert.equal(e.backup.runScheduledBackupIfDue(new Date('2026-11-01T15:00:00Z')), false, 'same day: no second backup');
  e.backup.createBackup(e.owner); // manual
  for (let d = 2; d <= 6; d++) {
    assert.equal(e.backup.runScheduledBackupIfDue(new Date(`2026-11-0${d}T08:00:00Z`)), true);
  }
  const files = fs.readdirSync(path.join(e.dir, 'backups'));
  assert.equal(files.filter((f) => f.startsWith('storepos_auto_')).length, 3);
  assert.equal(files.filter((f) => f.startsWith('storepos_manual_')).length, 1);
  const list = e.backup.listBackups(e.owner);
  assert.equal(list.length, 4);
  assert.ok(list.every((b) => b.is_valid && b.stats?.products_count === 1));
  assert.deepEqual([...new Set(list.map((b) => b.kind))].sort(), ['auto', 'manual']);
});

test('mirror folder (USB): copied when present; a missing drive never fails the backup', () => {
  const e = setup();
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-usb-'));
  e.backup.updateSettings(e.owner, { backup_mirror_directory: usb });
  const ok = e.backup.createBackup(e.owner);
  assert.ok(ok.mirror_filepath && fs.existsSync(ok.mirror_filepath));
  assert.equal(fs.readFileSync(ok.mirror_filepath).equals(fs.readFileSync(ok.filepath)), true);

  fs.rmSync(usb, { recursive: true, force: true }); // drive unplugged
  const res = e.backup.createBackup(e.owner);
  assert.ok(fs.existsSync(res.filepath));
  assert.equal(res.mirror_filepath, null);
  assert.ok(res.mirror_error);
  assert.ok(count(e.db, "system_error_logs WHERE error_source = 'backup:mirror'") >= 1);
});

test('settings: only known keys with valid values are accepted', () => {
  const e = setup();
  assert.throws(() => e.backup.updateSettings(e.owner, { evil_key: '1' }), /უცნობი პარამეტრი/);
  assert.throws(() => e.backup.updateSettings(e.owner, { inactivity_lock_minutes: '0' }), /1–240/);
  assert.throws(() => e.backup.updateSettings(e.owner, { backup_directory: 'relative\\folder' }), /სრული მისამართი/);
  assert.throws(() => e.backup.updateSettings(e.seller, { store_name: 'x' }), /მხოლოდ მფლობელს/);
  e.backup.updateSettings(e.owner, { store_name: '  სათამაშოების სახლი ', inactivity_lock_minutes: '20' });
  assert.equal(e.backup.getSettings().store_name, 'სათამაშოების სახლი');
});

test('restore refuses corrupted files and backups from a newer schema', () => {
  const e = setup();
  const good = JSON.parse(fs.readFileSync(e.backup.createBackup(e.owner).filepath, 'utf-8'));
  assert.throws(() => e.backup.restoreBackup(e.owner, 'not a backup at all'), /არ არის StorePOS-ის სარეზერვო ასლი/);
  assert.throws(() => e.backup.restoreBackup(e.owner, JSON.stringify({ ...good, db_base64: Buffer.from('garbage').toString('base64') })), /Checksum/);
  assert.throws(() => e.backup.restoreBackup(e.owner, JSON.stringify({ ...good, schema_version: LATEST_SCHEMA_VERSION + 1 })), /უფრო ახალი ვერსიით/);
  assert.equal(count(e.db, 'products'), 1, 'live data untouched');
});

test('restore writes photos only into the photo folder, never to paths from the file', () => {
  const e = setup();
  const backupFile = e.backup.createBackup(e.owner).filepath;
  const bundle = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
  const outside = path.join(e.dir, 'outside-target.txt');
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  bundle.images = [
    { product_id: 1, file_path: outside, is_primary: 0, data_base64: png },
    { product_id: 1, file_path: '..\\..\\escape.png', is_primary: 0, data_base64: png },
    { product_id: 1, file_path: 'good_photo.png', is_primary: 1, data_base64: png },
  ];
  const res = e.backup.restoreBackup(e.owner, JSON.stringify(bundle));
  assert.equal(res.success, true);
  assert.equal(fs.existsSync(outside), false, 'absolute path from the backup is not written');
  assert.ok(fs.existsSync(path.join(e.dir, 'images', 'good_photo.png')));
  assert.ok(fs.existsSync(path.join(e.dir, 'images', 'outside-target.txt')), 'stored by plain file name inside the photo folder');
  assert.equal(fs.existsSync(path.join(e.dir, '..', 'escape.png')), false);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'escape.png')), false);
  e.backup.getConnection().close();
});

test('a restore that fails midway is rolled back and the live data is unchanged', () => {
  const e = setup();
  const backupFile = e.backup.createBackup(e.owner).filepath;
  const bundle = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
  bundle.images = [{ product_id: 1, file_path: 'blocked.jpg', is_primary: 1, data_base64: 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64') }];
  // Data created after the backup must survive the failed restore.
  new ProductsService(e.db).createProduct(e.owner, {
    name: 'ახალი', base_price_tetri: 100,
    variants: [{ variant_name: 'სტ', codes: [{ code_type: 'manual_5digit', code_value: '31001' }] }],
  });
  fs.mkdirSync(path.join(e.dir, 'images', 'blocked.jpg'), { recursive: true }); // makes writing the photo fail

  assert.throws(() => e.backup.restoreBackup(e.owner, JSON.stringify(bundle)), /მიმდინარე მონაცემები უცვლელია/);
  const live = new DatabaseSync(e.dbPath);
  assert.equal(count(live, 'products'), 2, 'the newer product is still there');
  live.close();
  e.backup.getConnection().close();
});
