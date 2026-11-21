/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Downgrade guard (migration 11): a connection that does not define requires_storepos_v1_1()
 * - like the old RC3 program - can read a V1.1 database but cannot change stock, costs, sales,
 * debts, returns, products, customers or staff; StorePOS 1.1 itself works normally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, migrations, runMigrations } from './migrations.ts';
import {
  GUARD_FUNCTION,
  GUARDED_TABLES,
  downgradeGuardTriggers,
  missingDowngradeGuardTriggers,
  registerDowngradeGuardFunction,
} from './downgradeGuard.ts';

const NO_FUNCTION = new RegExp(`no such function: ${GUARD_FUNCTION}`);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-guard-'));
}

/** A V1.1 database with one row in every guarded table, written by V1.1 (function defined). */
function v11DatabaseWithData(file: string): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  runMigrations(db, file);
  const now = '2026-11-21T10:00:00.000Z';
  db.exec(`
    INSERT INTO users (id, name, role, pin_hash, pin_salt, is_active, created_at) VALUES
      (1, 'მფლობელი', 'owner', 'h1', 's1', 1, '${now}'), (2, 'გამყიდველი', 'seller', 'h2', 's2', 1, '${now}');
    INSERT INTO user_permissions (user_id, permission, created_at) VALUES (2, 'pos.access', '${now}');
    INSERT INTO categories (id, name, created_at) VALUES (1, 'ხილი', '${now}');
    INSERT INTO products (id, name, category_id, base_price_tetri, base_cost_tetri, unit_type, created_at, updated_at)
      VALUES (1, 'ვაშლი', 1, 350, 200, 'kg', '${now}', '${now}');
    INSERT INTO product_variants (id, product_id, variant_name, stock_quantity, unit_type) VALUES (1, 1, 'სტანდარტული', 9500, 'kg');
    INSERT INTO product_codes (variant_id, code_type, code_value) VALUES (1, 'manual_5digit', '10001');
    INSERT INTO product_images (product_id, file_path, is_primary, created_at) VALUES (1, 'a.png', 1, '${now}');
    INSERT INTO customers (id, first_name, created_at) VALUES (1, 'ნინო', '${now}');
    INSERT INTO inventory_movements (id, variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, user_id, created_at, unit_type, cost_total_tetri)
      VALUES (1, 1, 'restock', 10000, 10000, 200, 1, '${now}', 'kg', 2000);
    INSERT INTO inventory_lots (id, variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at, unit_type, initial_cost_tetri, remaining_cost_tetri)
      VALUES (1, 1, 10000, 9500, 200, 1, '${now}', 'kg', 2000, 1900);
    INSERT INTO sales (id, receipt_number, user_id, customer_id, payment_method, total_tetri, cash_received_tetri, change_given_tetri, debt_amount_tetri, created_at)
      VALUES (1, 'R-1', 1, 1, 'debt', 175, 0, 0, 175, '${now}');
    INSERT INTO sale_items (id, sale_id, variant_id, product_name_snap, quantity, unit_price_tetri, unit_cost_tetri, total_price_tetri, unit_type)
      VALUES (1, 1, 1, 'ვაშლი', 500, 350, 200, 175, 'kg');
    INSERT INTO sale_item_lots (sale_item_id, lot_id, quantity, unit_cost_tetri, cost_tetri) VALUES (1, 1, 500, 200, 100);
    INSERT INTO debt_repayments (id, customer_id, sale_id, amount_tetri, user_id, created_at) VALUES (1, 1, 1, 75, 1, '${now}');
    INSERT INTO debt_repayment_allocations (repayment_id, sale_id, customer_id, allocated_tetri, created_at) VALUES (1, 1, 1, 75, '${now}');
    INSERT INTO debt_adjustments (customer_id, sale_id, adjustment_type, amount_tetri, reason, sale_balance_before_tetri, sale_balance_after_tetri,
      customer_balance_before_tetri, customer_balance_after_tetri, user_id, created_at)
      VALUES (1, 1, 'write_off', 10, 'ტესტი', 100, 90, 100, 90, 1, '${now}');
    INSERT INTO returns (id, sale_id, user_id, return_type, total_refund_tetri, debt_deduction_tetri, cash_refund_tetri, condition, created_at)
      VALUES (1, 1, 1, 'refund', 0, 0, 0, 'damaged', '${now}');
    INSERT INTO return_items (return_id, sale_item_id, variant_id, quantity, unit_price_tetri, total_tetri, condition, unit_type)
      VALUES (1, 1, 1, 100, 350, 35, 'damaged', 'kg');
    INSERT INTO expenses (category, description, amount_tetri, user_id, expense_date, created_at) VALUES ('იჯარა', 'ნოემბერი', 50000, 1, '2026-11-21', '${now}');
  `);
  db.close();
}

/** Content of every table, so a test can prove that nothing changed. */
function dump(db: DatabaseSync): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>) {
    out[name] = JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all());
  }
  return out;
}

test('migration 11: schema v11, every guard trigger is installed', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  assert.equal(LATEST_SCHEMA_VERSION, 11);
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as any).v, 11);
  assert.deepEqual(missingDowngradeGuardTriggers(db), []);
  assert.equal(downgradeGuardTriggers().length, GUARDED_TABLES.length * 3 + 3);
  // every guarded table really exists (a trigger on a missing table would fail the migration)
  for (const t of GUARDED_TABLES) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
});

test('a connection without the guard function (like RC3) cannot change any guarded table; nothing is written', () => {
  const dir = tempDir();
  const file = path.join(dir, 'store.db');
  try {
    v11DatabaseWithData(file);
    const old = new DatabaseSync(file); // what an older program does: open and use, no guard function
    old.exec('PRAGMA foreign_keys = ON;');
    const before = dump(old);
    for (const table of GUARDED_TABLES) {
      assert.ok((old.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n >= 1, `${table} has a row and can be read`);
      assert.throws(() => old.prepare(`INSERT INTO ${table} DEFAULT VALUES`).run(), NO_FUNCTION, `${table} insert`);
      assert.throws(() => old.prepare(`UPDATE ${table} SET rowid = rowid`).run(), NO_FUNCTION, `${table} update`);
      assert.throws(() => old.prepare(`DELETE FROM ${table}`).run(), NO_FUNCTION, `${table} delete`);
    }
    // staff: no new or removed users, no change of name, role, PIN or active state
    assert.throws(() => old.prepare("INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES ('x', 'seller', 'h', 's', 1, 'now')").run(), NO_FUNCTION);
    assert.throws(() => old.prepare('DELETE FROM users WHERE id = 2').run(), NO_FUNCTION);
    for (const set of ["pin_hash = 'x'", "pin_salt = 'x'", "role = 'owner'", 'is_active = 0', "name = 'x'", "created_at = 'x'"]) {
      assert.throws(() => old.prepare(`UPDATE users SET ${set} WHERE id = 2`).run(), NO_FUNCTION, set);
    }
    // a multi-statement script (like RC3's database reset) stops at its first guarded statement
    assert.throws(() => old.exec('BEGIN; DELETE FROM audit_logs; DELETE FROM sales; DELETE FROM users; COMMIT;'), NO_FUNCTION);
    old.exec('ROLLBACK;');
    assert.deepEqual(dump(old), before, 'not a single row changed');

    // left writable on purpose: start, sign in (lockout counters), settings, logs, backup bookkeeping
    old.prepare("UPDATE users SET failed_pin_attempts = 1, locked_until = NULL WHERE id = 1").run();
    old.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_backup_date', '2026-11-21')").run();
    old.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (1, 'LOGIN', 'users', '1', '', 'now')").run();
    old.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('StorePOS 1.1 itself (function defined) writes every guarded table normally', () => {
  const dir = tempDir();
  const file = path.join(dir, 'store.db');
  try {
    v11DatabaseWithData(file);
    const db = new DatabaseSync(file);
    runMigrations(db, file); // defines the function, nothing pending
    for (const table of GUARDED_TABLES) {
      assert.equal(db.prepare(`UPDATE ${table} SET rowid = rowid`).run().changes >= 1, true, table);
    }
    const r = db.prepare("INSERT INTO categories (name, created_at) VALUES ('ბოსტნეული', 'now')").run();
    assert.equal(r.changes, 1);
    assert.ok(Number(r.lastInsertRowid) > 1, 'lastInsertRowid is the new row, not affected by the trigger');
    assert.equal(db.prepare('DELETE FROM categories WHERE id = ?').run(r.lastInsertRowid).changes, 1);
    db.prepare("UPDATE users SET pin_hash = 'n', pin_salt = 'n' WHERE id = 2").run();
    db.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('a tool that defines the function with another value is stopped by the trigger itself', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  db.function(GUARD_FUNCTION, () => 0);
  assert.throws(() => db.prepare("INSERT INTO categories (name, created_at) VALUES ('x', 'now')").run(), /can only be changed by StorePOS 1\.1 or newer/);
  registerDowngradeGuardFunction(db);
  db.prepare("INSERT INTO categories (name, created_at) VALUES ('x', 'now')").run();
});

test('a removed guard trigger is put back the next time StorePOS 1.1 opens the database', () => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db);
  db.exec('DROP TRIGGER v11_guard_sales_insert; DROP TRIGGER v11_guard_users_update;');
  assert.deepEqual(missingDowngradeGuardTriggers(db).sort(), ['v11_guard_sales_insert', 'v11_guard_users_update']);
  runMigrations(db);
  assert.deepEqual(missingDowngradeGuardTriggers(db), []);
});

test('an RC3-schema database (migrations 1-6) gets the guard when V1.1 upgrades it; a snapshot keeps it', () => {
  const dir = tempDir();
  const file = path.join(dir, 'store.db');
  try {
    const rc3 = new DatabaseSync(file);
    rc3.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);');
    for (const m of migrations.filter((x) => x.version <= 6)) {
      m.up(rc3);
      rc3.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, 'then');
    }
    rc3.prepare("INSERT INTO categories (name, created_at) VALUES ('RC3', 'then')").run(); // RC3 writes freely
    assert.equal(rc3.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'v11_guard_%'").get()!.n, 0);
    rc3.close();

    const v11 = new DatabaseSync(file);
    runMigrations(v11, file);
    assert.deepEqual(missingDowngradeGuardTriggers(v11), []);
    const snap = path.join(dir, 'snapshot.db');
    v11.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`); // how backups are taken
    v11.close();

    const fromBackup = new DatabaseSync(snap);
    assert.equal((fromBackup.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
    assert.equal((fromBackup.prepare('SELECT COUNT(*) AS n FROM categories').get() as any).n, 1);
    assert.throws(() => fromBackup.prepare("INSERT INTO categories (name, created_at) VALUES ('old', 'now')").run(), NO_FUNCTION);
    fromBackup.close();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
