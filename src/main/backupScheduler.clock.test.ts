/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The daily automatic backup scheduler with a controlled clock (node:test mock timers for Date,
 * setTimeout and setInterval) and the scheduler's real production settings: first check 60 s
 * after start, then every 30 minutes; a due backup waits for 20 s without requests from the
 * window (checked every 15 s), at most 30 minutes. Covers what real-time tests cannot do in a
 * reasonable time: an idle or busy till, midnight while the program runs, Windows sleep (the
 * wall clock jumps while no timer runs), restarts, a failed backup and retention over days.
 * The backups are real files written by the real BackupService into a temporary folder.
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

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** An instant given as Tbilisi wall-clock time (UTC+4 all year). */
const tbilisi = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+04:00`);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-clock-'));
  const dbPath = path.join(dir, 'store.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  runMigrations(db, dbPath);
  const owner = new AuthService(db).setupInitialOwner('მფლობელი', '1111').user;
  const service = () => new BackupService(db, dbPath);
  const backupDir = path.join(dir, 'backups');
  const autos = () => (fs.existsSync(backupDir) && fs.statSync(backupDir).isDirectory() ? fs.readdirSync(backupDir).filter((f) => /^storepos_auto_.*\.posbackup$/.test(f)).sort() : []);
  const setting = (key: string) => (db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as any)?.value ?? null;
  return { dir, db, dbPath, owner, service, backupDir, autos, setting };
}

/**
 * Advances the mocked clock in 1-second steps. (A single tick(n) moves Date to the end of the
 * whole span before it runs the timers that fall inside it, so every callback would see the
 * end time; with 1 s steps each callback sees its own moment, to the second.)
 */
function advance(t: any, ms: number, step = SEC) {
  for (let left = ms; left > 0; left -= step) t.mock.timers.tick(Math.min(step, left));
}

/** Production settings; only the activity source and the service are injected. */
function start(e: ReturnType<typeof setup>, lastActivity: () => number) {
  return startBackupScheduler({ lastActivity, service: e.service });
}

test('idle till: the backup is written at the first check (60 s after start), once per day', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '10:00') });
  const e = setup();
  const startedAt = Date.now();
  const stop = start(e, () => startedAt); // one request at start-up, then nobody touches the till
  try {
    advance(t, 59 * SEC);
    assert.equal(e.autos().length, 0, 'not before the first check');
    advance(t, 1 * SEC);
    assert.deepEqual(e.autos().map((f) => f.slice(14, 24)), ['2026-11-10'], 'written at the first check');
    assert.equal(e.setting('last_auto_backup_date'), '2026-11-10');
    advance(t, 10 * HOUR);
    assert.equal(e.autos().length, 1, 'still one: one automatic backup per day');
  } finally {
    stop();
  }
});

test('the program runs past midnight: the next day gets its backup within 30 minutes of midnight', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '23:10') });
  const e = setup();
  const quiet = Date.now();
  const stop = start(e, () => quiet);
  try {
    advance(t, 1 * MIN);
    assert.equal(e.autos().length, 1, 'today (23:11)');
    // interval checks at 23:40 and 00:10
    advance(t, tbilisi('2026-11-11', '00:09') - Date.now());
    assert.equal(e.autos().length, 1, 'nothing extra before the first check after midnight');
    advance(t, 2 * MIN);
    assert.deepEqual(e.autos().map((f) => f.slice(14, 24)), ['2026-11-10', '2026-11-11']);
    assert.equal(e.setting('last_auto_backup_date'), '2026-11-11');
  } finally {
    stop();
  }
});

test('busy till (requests all the time): no backup in the middle of sales, then it runs after at most 30 minutes', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '12:00') });
  const e = setup();
  const stop = start(e, () => Date.now()); // the last request is always "just now"
  try {
    advance(t, 1 * MIN); // first check: due, but the till is busy
    const dueAt = Date.now();
    advance(t, 30 * MIN - 1 * SEC);
    assert.equal(e.autos().length, 0, 'waits while the till is in use');
    advance(t, 16 * SEC);
    assert.equal(e.autos().length, 1, 'runs anyway once it has waited 30 minutes');
    const stamp = e.autos()[0].slice(25, 33); // HH-MM-SS
    assert.equal(stamp, '12-31-00', `written at the first check after 30 minutes of waiting (${stamp})`);
    assert.ok(Date.now() - dueAt >= 30 * MIN);
  } finally {
    stop();
  }
});

test('busy till with a pause: the backup runs in the first 20-second pause, not before', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '12:00') });
  const e = setup();
  let pauseFrom: number | null = null;
  const stop = start(e, () => pauseFrom ?? Date.now());
  try {
    advance(t, 10 * MIN);
    assert.equal(e.autos().length, 0, 'ten minutes of sales: nothing written');
    pauseFrom = Date.now();
    advance(t, 19 * SEC);
    assert.equal(e.autos().length, 0, 'not within 20 s of the last request');
    advance(t, 16 * SEC);
    assert.equal(e.autos().length, 1, 'written within one check interval after 20 s of quiet');
  } finally {
    stop();
  }
});

test('Windows sleep while a backup is waiting: after waking, it is written once for the new day', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '20:00') });
  const e = setup();
  const stop = start(e, () => Date.now()); // busy
  try {
    advance(t, 5 * MIN); // due at 20:01, waiting
    assert.equal(e.autos().length, 0);
    // Sleep: the wall clock jumps 9 hours, no timer runs meanwhile.
    t.mock.timers.setTime(Date.now() + 9 * HOUR); // 05:05 next day
    assert.equal(e.autos().length, 0, 'nothing happens while asleep');
    advance(t, 15 * SEC); // the pending 15 s check fires after waking
    assert.deepEqual(e.autos().map((f) => f.slice(14, 24)), ['2026-11-11'], 'one backup, dated the new day');
    advance(t, 2 * HOUR);
    assert.equal(e.autos().length, 1, 'no second backup the same day');
  } finally {
    stop();
  }
});

test('Windows sleep overnight with nothing pending: the next day is backed up within 30 minutes of waking', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '10:00') });
  const e = setup();
  let last = Date.now();
  const stop = start(e, () => last);
  try {
    advance(t, 1 * MIN);
    assert.equal(e.autos().length, 1, 'today at 10:01');
    advance(t, 2 * HOUR - 1 * MIN); // 12:00, asleep until 08:00 the next day
    t.mock.timers.setTime(tbilisi('2026-11-11', '08:00'));
    last = Date.now(); // someone wakes the PC and signs in
    // Worst case: the interval timer did not count the sleep and fires up to 30 minutes later.
    advance(t, 30 * MIN + 20 * SEC);
    assert.deepEqual(e.autos().map((f) => f.slice(14, 24)), ['2026-11-10', '2026-11-11']);
  } finally {
    stop();
  }
});

test('restarts: a restart the same day writes nothing extra; the first start of a new day writes one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '09:00') });
  const e = setup();
  const quiet = () => Date.now() - HOUR;
  let stop = start(e, quiet);
  advance(t, 1 * MIN);
  stop();
  assert.equal(e.autos().length, 1, 'first start of the day');
  for (let i = 0; i < 3; i++) { // closed and opened again three times the same day
    advance(t, 1 * HOUR);
    stop = start(e, quiet);
    advance(t, 5 * MIN);
    stop();
  }
  assert.equal(e.autos().length, 1, 'restarts the same day: still one');
  t.mock.timers.setTime(tbilisi('2026-11-11', '09:00')); // program closed overnight
  stop = start(e, quiet);
  advance(t, 1 * MIN);
  stop();
  assert.deepEqual(e.autos().map((f) => f.slice(14, 24)), ['2026-11-10', '2026-11-11']);
});

test('a failed backup is logged as critical and retried at the next check; nothing is marked as done', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-10', '10:00') });
  const e = setup();
  fs.writeFileSync(e.backupDir, 'not a folder'); // the backup folder cannot be written
  const stop = start(e, () => Date.now() - HOUR);
  try {
    advance(t, 1 * MIN);
    assert.ok(!e.setting('last_auto_backup_date'), 'not marked as done');
    const logged = e.db.prepare("SELECT severity FROM system_error_logs WHERE error_source = 'backup:auto'").all() as any[];
    assert.ok(logged.length >= 1 && logged.every((r) => r.severity === 'critical'), 'logged as critical');
    fs.unlinkSync(e.backupDir); // fixed
    advance(t, 30 * MIN);
    assert.equal(e.autos().length, 1, 'retried and written at the next check');
    assert.equal(e.setting('last_auto_backup_date'), '2026-11-10');
  } finally {
    stop();
  }
});

test('retention over many days: the newest N automatic backups stay, manual backups are never removed, all verify', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: tbilisi('2026-11-01', '10:00') });
  const e = setup();
  e.service().updateSettings(e.owner, { backup_retention_count: '3' });
  const manual1 = e.service().createBackup(e.owner, undefined, 'manual').backup_filename;
  const stop = start(e, () => Date.now() - HOUR);
  try {
    advance(t, 6 * 24 * HOUR); // six days with the program running
    const manual2 = e.service().createBackup(e.owner, undefined, 'manual').backup_filename;
    advance(t, 24 * HOUR);
    const autos = e.autos();
    assert.deepEqual(autos.map((f) => f.slice(14, 24)), ['2026-11-06', '2026-11-07', '2026-11-08'], 'the newest three days (eight were written, 1st to 8th)');
    const all = fs.readdirSync(e.backupDir);
    assert.ok(all.includes(manual1) && all.includes(manual2), 'manual backups kept');
    for (const f of [...autos, manual1, manual2]) {
      const v = e.service().verifyBackup(e.owner, undefined, f);
      assert.equal(v.is_valid, true, `${f}: ${v.integrity_status}`);
    }
  } finally {
    stop();
  }
});
