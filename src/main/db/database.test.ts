import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from './migrations.ts';
import { runInTransaction } from './database.ts';

test('database migrations initialize all required tables successfully', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);

  // Check tables exist
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  const tableNames = new Set(tables.map(t => t.name));

  assert.equal(tableNames.has('users'), true);
  assert.equal(tableNames.has('categories'), true);
  assert.equal(tableNames.has('products'), true);
  assert.equal(tableNames.has('product_variants'), true);
  assert.equal(tableNames.has('product_codes'), true);
  assert.equal(tableNames.has('inventory_movements'), true);
  assert.equal(tableNames.has('inventory_lots'), true);
  assert.equal(tableNames.has('sales'), true);
  assert.equal(tableNames.has('sale_items'), true);
  assert.equal(tableNames.has('debt_repayments'), true);
  assert.equal(tableNames.has('returns'), true);
  assert.equal(tableNames.has('expenses'), true);
  assert.equal(tableNames.has('audit_logs'), true);
  assert.equal(tableNames.has('app_settings'), true);
  assert.equal(tableNames.has('schema_migrations'), true);
});

test('transaction rolls back completely on error without leaving partial data', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);

  assert.throws(() => {
    runInTransaction((txDb) => {
      txDb.prepare("INSERT INTO categories (name, created_at) VALUES ('ტესტი-1', datetime('now'))").run();
      // Cause an error on purpose:
      throw new Error('Rollback test error');
    }, db);
  }, /Rollback test error/);

  // Verify that category was NOT saved
  const cat = db.prepare("SELECT * FROM categories WHERE name = 'ტესტი-1'").all();
  assert.equal(cat.length, 0);
});
