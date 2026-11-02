/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Remaining production risks of backups, on real database files in a temp folder:
 * a full disk, a missing or slow USB mirror, damaged backup files and damaged photos.
 * A full disk is simulated by making the write fail with ENOSPC after part of the data
 * was written (what Windows does when the drive fills up mid-write).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { AuthService } from './authService.ts';
import { ProductsService } from './productsService.ts';
import { PosService } from './posService.ts';
import { BackupService, ensureFreeSpace, describeWriteError } from './backupService.ts';

const PNG_1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-bkrisk-'));
  const dbPath = path.join(dir, 'store.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  runMigrations(db, dbPath);
  const owner = new AuthService(db).setupInitialOwner('მფლობელი', '1111').user;
  const products = new ProductsService(db);
  const p = products.createProduct(owner, {
    name: 'სათამაშო', base_price_tetri: 3000, base_cost_tetri: 1000,
    variants: [{ variant_name: 'სტ', initial_stock: 10, codes: [{ code_type: 'manual_5digit', code_value: '31000' }] }],
    image_paths: [PNG_1, PNG_2],
  });
  new PosService(db).checkout(owner, { items: [{ variant_id: p.variants![0].id, quantity: 1 }], payment_method: 'cash', cash_received_tetri: 3000 });
  return { dir, dbPath, db, owner, backup: new BackupService(db, dbPath) };
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as any).c;
const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

async function waitFor(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('full disk while writing a backup: clear message, no partial file, earlier backups and data untouched', () => {
  const e = setup();
  const first = e.backup.createBackup(e.owner);
  const firstBytes = fs.readFileSync(first.filepath);
  const realWrite = fs.writeFileSync;
  (fs as any).writeFileSync = (file: any, data: any, ...rest: any[]) => {
    if (String(file).endsWith('.posbackup.partial')) {
      realWrite(file, Buffer.from(data).subarray(0, 1000)); // the drive fills up mid-write
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }
    return realWrite(file, data, ...rest);
  };
  try {
    assert.throws(() => e.backup.createBackup(e.owner), /დისკზე ადგილი აღარ არის/);
  } finally {
    (fs as any).writeFileSync = realWrite;
  }
  const files = listDir(path.join(e.dir, 'backups'));
  assert.deepEqual(files.filter((f) => f.endsWith('.partial')), [], 'no half-written file is left');
  assert.equal(files.filter((f) => f.endsWith('.posbackup')).length, 1);
  assert.ok(fs.readFileSync(first.filepath).equals(firstBytes), 'the earlier backup is unchanged');
  assert.equal((e.db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  assert.equal(count(e.db, 'sales'), 1);
});

test('free-space check refuses a backup that cannot fit before writing anything', () => {
  assert.throws(() => ensureFreeSpace('E:\\', 100 * 1024 * 1024, 10 * 1024 * 1024), /საჭიროა 106\.0 MB, თავისუფალია 10\.0 MB/);
  assert.doesNotThrow(() => ensureFreeSpace('E:\\', 10 * 1024 * 1024, 500 * 1024 * 1024));
  assert.doesNotThrow(() => ensureFreeSpace('E:\\', 10 * 1024 * 1024, null), 'unknown free space: the write itself decides');
  assert.equal(describeWriteError({ code: 'ENOSPC' }), 'დისკზე ადგილი აღარ არის');
  assert.equal(describeWriteError({ code: 'EIO' }), 'დისკის შეცდომა (შესაძლოა USB დისკი გამოძვრა)');
});

test('USB mirror is written in the background; the main backup returns first', async () => {
  const e = setup();
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-usb-'));
  e.backup.updateSettings(e.owner, { backup_mirror_directory: usb });
  const res = await e.backup.createBackupWithMirror(e.owner);
  assert.ok(res.mirror_filepath && fs.existsSync(res.mirror_filepath));
  assert.ok(fs.readFileSync(res.mirror_filepath).equals(fs.readFileSync(res.filepath)));
  assert.equal(res.mirror_error, null);
  assert.deepEqual(listDir(usb).filter((f) => f.endsWith('.partial')), []);

  // Scheduled backup: returns before the USB copy is finished, the copy follows.
  assert.equal(e.backup.runScheduledBackupIfDue(new Date('2026-11-05T08:00:00Z')), true);
  await waitFor(() => count(e.db, "audit_logs WHERE action = 'BACKUP_MIRROR'") >= 2);
  assert.ok(listDir(usb).some((f) => f.startsWith('storepos_auto_') && f.endsWith('.posbackup')));
});

test('USB unplugged or full: the main backup succeeds, the mirror reports why, no partial file', async () => {
  const e = setup();
  const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-usb-'));
  e.backup.updateSettings(e.owner, { backup_mirror_directory: usb });

  fs.rmSync(usb, { recursive: true, force: true }); // unplugged
  const gone = await e.backup.createBackupWithMirror(e.owner);
  assert.ok(fs.existsSync(gone.filepath));
  assert.equal(gone.mirror_filepath, null);
  assert.match(gone.mirror_error!, /ხელმისაწვდომი არ არის/);

  fs.mkdirSync(usb); // plugged in again, but it fills up during the copy
  const realCopy = fs.promises.copyFile;
  (fs.promises as any).copyFile = async (src: string, dest: string) => {
    fs.writeFileSync(dest, 'half');
    throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
  };
  try {
    const full = await e.backup.createBackupWithMirror(e.owner);
    assert.ok(fs.existsSync(full.filepath));
    assert.equal(full.mirror_filepath, null);
    assert.equal(full.mirror_error, 'დისკზე ადგილი აღარ არის');
  } finally {
    (fs.promises as any).copyFile = realCopy;
  }
  assert.deepEqual(listDir(usb), [], 'nothing half-written on the USB drive');
  assert.ok(count(e.db, "system_error_logs WHERE error_source = 'backup:mirror'") >= 2);
});

test('damaged backup files are refused before anything changes', () => {
  const e = setup();
  const file = e.backup.createBackup(e.owner).filepath;
  const raw = fs.readFileSync(file, 'utf-8');

  const truncated = raw.slice(0, Math.floor(raw.length / 2));
  assert.equal(e.backup.verifyBackup(e.owner, truncated).is_valid, false);
  assert.throws(() => e.backup.restoreBackup(e.owner, truncated), /დაზიანებულია|არ არის StorePOS/);

  // one character changed inside the database part
  const bundle = JSON.parse(raw);
  const i = Math.floor(bundle.db_base64.length / 2);
  bundle.db_base64 = bundle.db_base64.slice(0, i) + (bundle.db_base64[i] === 'A' ? 'B' : 'A') + bundle.db_base64.slice(i + 1);
  assert.throws(() => e.backup.restoreBackup(e.owner, JSON.stringify(bundle)), /Checksum/);
  assert.equal(count(e.db, 'sales'), 1, 'live data untouched');
});

test('a damaged photo inside a backup is detected; restore keeps the data and skips only that photo', () => {
  const e = setup();
  const file = e.backup.createBackup(e.owner).filepath;
  const bundle = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.equal(bundle.version, '1.2');
  assert.equal(bundle.images.length, 2);
  assert.ok(bundle.images.every((img: any) => /^[a-f0-9]{64}$/.test(img.sha256)), 'every photo has a SHA-256');
  const damagedName = path.basename(bundle.images[0].file_path);
  const intactName = path.basename(bundle.images[1].file_path);
  const intactBytes = fs.readFileSync(path.join(e.dir, 'images', intactName));
  bundle.images[0].data_base64 = bundle.images[0].data_base64.replace(/.{8}$/, 'AAAAAAA=');

  const check = e.backup.verifyBackup(e.owner, JSON.stringify(bundle));
  assert.equal(check.is_valid, true, 'the database itself is fine');
  assert.match(check.integrity_status, /1 ფოტო დაზიანებულია/);

  for (const f of fs.readdirSync(path.join(e.dir, 'images'))) fs.unlinkSync(path.join(e.dir, 'images', f));
  const res = e.backup.restoreBackup(e.owner, JSON.stringify(bundle));
  assert.equal(res.success, true);
  assert.equal(res.restored_stats!.images_restored, 1);
  assert.equal(res.restored_stats!.images_damaged, 1);
  assert.match(res.message, /1 ფოტო ასლში დაზიანებული იყო/);
  assert.equal(fs.existsSync(path.join(e.dir, 'images', damagedName)), false, 'damaged photo not written');
  assert.ok(fs.readFileSync(path.join(e.dir, 'images', intactName)).equals(intactBytes), 'intact photo restored byte for byte');
  const live = e.backup.getConnection();
  assert.equal(count(live, 'sales'), 1);
  live.close();
});

test('backups made by RC1 (format 1.1, no photo checksums) still restore', () => {
  const e = setup();
  const bundle = JSON.parse(fs.readFileSync(e.backup.createBackup(e.owner).filepath, 'utf-8'));
  bundle.version = '1.1';
  for (const img of bundle.images) delete img.sha256;
  for (const f of fs.readdirSync(path.join(e.dir, 'images'))) fs.unlinkSync(path.join(e.dir, 'images', f));
  const res = e.backup.restoreBackup(e.owner, JSON.stringify(bundle));
  assert.equal(res.success, true);
  assert.equal(res.restored_stats!.images_restored, 2);
  assert.equal(res.restored_stats!.images_damaged, 0);
  e.backup.getConnection().close();
});
