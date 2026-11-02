/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Opening the store database at start-up: transient Windows file errors are retried, a damaged
 * or foreign file is reported at once and left untouched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initDatabaseWithRetry, isTransientOpenError, closeDatabase } from './database.ts';

test('transient errors (busy, locked, I/O, cannot open) are retried; damaged files are not', () => {
  assert.equal(isTransientOpenError({ errcode: 1546, message: 'disk I/O error' }), true, 'SQLITE_IOERR_TRUNCATE (file still held)');
  assert.equal(isTransientOpenError({ errcode: 5, message: 'database is locked' }), true);
  assert.equal(isTransientOpenError({ errcode: 14, message: 'unable to open database file' }), true);
  assert.equal(isTransientOpenError({ errcode: 26, message: 'file is not a database' }), false);
  assert.equal(isTransientOpenError({ errcode: 11, message: 'database disk image is malformed' }), false);
  assert.equal(isTransientOpenError(new Error('disk I/O error')), true);
});

test('a database held by another program opens as soon as it is released', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-open-'));
  const dbPath = path.join(dir, 'store.db');
  const first = new DatabaseSync(dbPath);
  first.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x); PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
  setTimeout(() => { first.exec('ROLLBACK;'); first.close(); }, 1500);
  const t0 = Date.now();
  const db = await initDatabaseWithRetry(dbPath, 20000);
  assert.ok(Date.now() - t0 >= 1000, 'waited for the other program');
  assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  closeDatabase();
});

test('a damaged file is reported at once and left exactly as it was', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-open-'));
  const dbPath = path.join(dir, 'store.db');
  const garbage = Buffer.concat([Buffer.from('not an SQLite database '), crypto.randomBytes(8192)]);
  fs.writeFileSync(dbPath, garbage);
  const t0 = Date.now();
  await assert.rejects(() => initDatabaseWithRetry(dbPath, 20000), /not a database/);
  assert.ok(Date.now() - t0 < 3000, 'no pointless retries for a damaged file');
  assert.ok(fs.readFileSync(dbPath).equals(garbage), 'file unchanged');
});
