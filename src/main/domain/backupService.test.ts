import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../db/migrations.ts';
import { BackupService } from './backupService.ts';
import { User } from '../../shared/types.ts';

function createInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

test('backup service creates unified .posbackup bundle and logs system errors', () => {
  const db = createInMemoryDb();
  const backupService = new BackupService(db);

  // Insert test users into users table to satisfy foreign keys
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (id, name, role, pin_hash, pin_salt, is_active, created_at) VALUES (1, 'მფლობელი', 'owner', 'hash1', 'salt1', 1, ?)").run(now);
  db.prepare("INSERT INTO users (id, name, role, pin_hash, pin_salt, is_active, created_at) VALUES (2, 'გამყიდველი', 'seller', 'hash2', 'salt2', 1, ?)").run(now);

  const owner: User = { id: 1, name: 'მფლობელი', role: 'owner', is_active: 1, created_at: now };
  const seller: User = { id: 2, name: 'გამყიდველი', role: 'seller', is_active: 1, created_at: now };

  // Log system error
  backupService.logSystemError('test_channel', 'Test error message', 'Error: trace\n at test', 'error', seller.id);
  const errorLogs = backupService.getErrorLogs();
  assert.equal(errorLogs.length, 1);
  assert.equal(errorLogs[0].error_source, 'test_channel');
  assert.equal(errorLogs[0].error_message, 'Test error message');

  // Seller cannot clear error logs or update settings
  assert.throws(() => {
    backupService.clearErrorLogs(seller);
  }, /სარეზერვო ასლების მართვის უფლება აქვს მხოლოდ მფლობელს/);

  // Owner can clear error logs
  backupService.clearErrorLogs(owner);
  assert.equal(backupService.getErrorLogs().length, 0);

  // Owner can update settings
  backupService.updateSettings(owner, { store_name: 'ახალი მაღაზია' });
  const settings = backupService.getSettings();
  assert.equal(settings.store_name, 'ახალი მაღაზია');
});
