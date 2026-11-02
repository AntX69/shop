/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The daily automatic backup waits for a quiet moment at the till (real timers, short delays).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './db/migrations.ts';
import { AuthService } from './domain/authService.ts';
import { BackupService } from './domain/backupService.ts';
import { startBackupScheduler } from './backupScheduler.ts';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-sched-'));
  const dbPath = path.join(dir, 'store.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  runMigrations(db, dbPath);
  new AuthService(db).setupInitialOwner('მფლობელი', '1111');
  return { dir, service: () => new BackupService(db, dbPath) };
}
const autos = (dir: string) => (fs.existsSync(path.join(dir, 'backups')) ? fs.readdirSync(path.join(dir, 'backups')).filter((f) => f.startsWith('storepos_auto_')) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a due backup waits while the till is in use and runs once it is quiet', async () => {
  const e = setup();
  // While "selling", the last request is always just now; afterwards the till is quiet.
  let selling = true;
  let quietSince = 0;
  const lastActivity = () => (selling ? Date.now() : quietSince);
  const stop = startBackupScheduler({ firstRunDelayMs: 10, intervalMs: 60_000, idleMs: 200, idleCheckMs: 50, maxDeferMs: 60_000, lastActivity, service: e.service });
  try {
    await sleep(600);
    assert.equal(autos(e.dir).length, 0, 'no backup in the middle of sales');
    quietSince = Date.now();
    selling = false;
    for (let i = 0; i < 100 && autos(e.dir).length === 0; i++) await sleep(50);
    assert.equal(autos(e.dir).length, 1, 'backup written in the quiet moment');
    assert.ok(Date.now() - quietSince >= 200, 'only after the till was quiet for idleMs');
    await sleep(300);
    assert.equal(autos(e.dir).length, 1, 'only one per day');
  } finally {
    stop();
  }
});

test('a till that is never quiet still gets its backup after the maximum wait', async () => {
  const e = setup();
  const started = Date.now();
  const stop = startBackupScheduler({ firstRunDelayMs: 10, intervalMs: 60_000, idleMs: 10_000, idleCheckMs: 50, maxDeferMs: 400, lastActivity: () => Date.now(), service: e.service });
  try {
    for (let i = 0; i < 100 && autos(e.dir).length === 0; i++) await sleep(50);
    assert.equal(autos(e.dir).length, 1, 'written after the maximum wait despite activity');
    assert.ok(Date.now() - started >= 400, 'not before the maximum wait');
  } finally {
    stop();
  }
});

test('nothing is written before the first owner exists, or when automatic backup is off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-sched-'));
  const dbPath = path.join(dir, 'store.db');
  const db = new DatabaseSync(dbPath);
  runMigrations(db, dbPath);
  const service = () => new BackupService(db, dbPath);
  assert.equal(service().isScheduledBackupDue(), false, 'no owner yet');
  const owner = new AuthService(db).setupInitialOwner('მფლობელი', '1111').user;
  assert.equal(service().isScheduledBackupDue(), true);
  service().updateSettings(owner, { auto_backup_enabled: '0' });
  assert.equal(service().isScheduledBackupDue(), false, 'switched off');
});
