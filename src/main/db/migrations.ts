/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Database Schema Migrations for SQLite.
 * Uses strict transactions, foreign key constraints, integer tetri representation,
 * and tracks executed migrations in schema_migrations table.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: (db: DatabaseSync) => {
      // 1. Users table (owner and sellers with salted PIN hash)
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'seller')),
          pin_hash TEXT NOT NULL,
          pin_salt TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
      `);

      // 2. Categories
      db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 3. Products
      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          description TEXT,
          base_price_tetri INTEGER NOT NULL,
          base_cost_tetri INTEGER,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);

      // 4. Product Variants (sizes, colors, price overrides, stock)
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_variants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          variant_name TEXT NOT NULL,
          size TEXT,
          color TEXT,
          price_override_tetri INTEGER,
          cost_override_tetri INTEGER,
          stock_quantity INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1
        );
      `);

      // 5. Product Codes (Factory Barcodes and 5-Digit Manual Codes)
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
          code_type TEXT NOT NULL CHECK(code_type IN ('barcode', 'manual_5digit')),
          code_value TEXT UNIQUE NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_product_codes_value ON product_codes(code_value);
      `);

      // 6. Product Images (local storage paths)
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `);

      // 7. Customers
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          first_name TEXT NOT NULL,
          last_name TEXT,
          phone TEXT,
          address TEXT,
          notes TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // 8. Inventory Movements (Audit of all stock changes)
      db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          movement_type TEXT NOT NULL CHECK(movement_type IN ('initial', 'restock', 'sale', 'return', 'exchange', 'correction')),
          quantity_change INTEGER NOT NULL,
          resulting_stock INTEGER NOT NULL,
          unit_cost_tetri INTEGER,
          reason TEXT,
          reference_id TEXT,
          user_id INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL
        );
      `);

      // 9. Inventory Lots (FIFO cost tracking)
      db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_lots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          initial_quantity INTEGER NOT NULL,
          remaining_quantity INTEGER NOT NULL,
          unit_cost_tetri INTEGER,
          movement_id INTEGER REFERENCES inventory_movements(id),
          created_at TEXT NOT NULL
        );
      `);

      // 10. Sales
      db.exec(`
        CREATE TABLE IF NOT EXISTS sales (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_number TEXT UNIQUE NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          customer_id INTEGER REFERENCES customers(id),
          payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'debt', 'mixed')),
          total_tetri INTEGER NOT NULL,
          cash_received_tetri INTEGER NOT NULL,
          change_given_tetri INTEGER NOT NULL,
          debt_amount_tetri INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'returned', 'partially_returned')),
          notes TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);
        CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
      `);

      // 11. Sale Items (Immutable price snapshot at checkout)
      db.exec(`
        CREATE TABLE IF NOT EXISTS sale_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          product_name_snap TEXT NOT NULL,
          variant_name_snap TEXT,
          code_snap TEXT,
          quantity INTEGER NOT NULL,
          unit_price_tetri INTEGER NOT NULL,
          unit_cost_tetri INTEGER,
          total_price_tetri INTEGER NOT NULL,
          returned_quantity INTEGER NOT NULL DEFAULT 0
        );
      `);

      // 12. Debt Repayments (Cash collected for existing customer debt)
      db.exec(`
        CREATE TABLE IF NOT EXISTS debt_repayments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          sale_id INTEGER REFERENCES sales(id),
          amount_tetri INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          payment_method TEXT NOT NULL DEFAULT 'cash',
          notes TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // 13. Returns
      db.exec(`
        CREATE TABLE IF NOT EXISTS returns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER NOT NULL REFERENCES sales(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          return_type TEXT NOT NULL CHECK(return_type IN ('refund', 'exchange')),
          total_refund_tetri INTEGER NOT NULL,
          debt_deduction_tetri INTEGER NOT NULL,
          cash_refund_tetri INTEGER NOT NULL,
          condition TEXT NOT NULL CHECK(condition IN ('resellable', 'damaged')),
          reason TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // 14. Return Items
      db.exec(`
        CREATE TABLE IF NOT EXISTS return_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
          sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          quantity INTEGER NOT NULL,
          unit_price_tetri INTEGER NOT NULL,
          total_tetri INTEGER NOT NULL
        );
      `);

      // 15. Expenses (Store expenses: rent, utilities, transport, etc.)
      db.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          amount_tetri INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          expense_date TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);

      // 16. Audit Logs
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          action TEXT NOT NULL,
          entity TEXT NOT NULL,
          entity_id TEXT,
          details TEXT,
          created_at TEXT NOT NULL
        );
      `);

      // 17. App Settings
      db.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      // Set default app settings
      db.exec(`
        INSERT OR IGNORE INTO app_settings (key, value) VALUES 
        ('store_name', 'ჩემი მაღაზია'),
        ('currency', 'GEL'),
        ('timezone', 'Asia/Tbilisi'),
        ('inactivity_lock_minutes', '15');
      `);
    }
  },
  {
    version: 2,
    name: 'system_error_logs',
    up: (db: DatabaseSync) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_error_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          error_source TEXT NOT NULL,
          error_message TEXT NOT NULL,
          stack_trace TEXT,
          severity TEXT NOT NULL DEFAULT 'error',
          created_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 3,
    name: 'idempotency_keys_and_backup_settings',
    up: (db: DatabaseSync) => {
      // 1. Add idempotency_key to sales to prevent duplicate checkouts
      try {
        db.exec("ALTER TABLE sales ADD COLUMN idempotency_key TEXT;");
      } catch {}
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL;");

      // 2. Add idempotency_key to debt_repayments
      try {
        db.exec("ALTER TABLE debt_repayments ADD COLUMN idempotency_key TEXT;");
      } catch {}
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_repayments_idempotency ON debt_repayments(idempotency_key) WHERE idempotency_key IS NOT NULL;");

      // 3. Add default backup settings
      db.exec(`
        INSERT OR IGNORE INTO app_settings (key, value) VALUES 
        ('auto_backup_enabled', '1'),
        ('backup_directory', ''),
        ('last_backup_date', '');
      `);
    }
  },
  {
    version: 4,
    name: 'returns_idempotency_and_exchanges_tracking',
    up: (db: DatabaseSync) => {
      // 1. Add idempotency_key to returns
      try {
        db.exec("ALTER TABLE returns ADD COLUMN idempotency_key TEXT;");
      } catch {}
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_idempotency ON returns(idempotency_key) WHERE idempotency_key IS NOT NULL;");

      // 2. Add related_sale_id to returns (for tracking exchange sale)
      try {
        db.exec("ALTER TABLE returns ADD COLUMN related_sale_id INTEGER REFERENCES sales(id);");
      } catch {}

      // 3. Add exchange & tracking columns to sales
      try {
        db.exec("ALTER TABLE sales ADD COLUMN sale_type TEXT NOT NULL DEFAULT 'standard';");
      } catch {}
      try {
        db.exec("ALTER TABLE sales ADD COLUMN related_return_id INTEGER REFERENCES returns(id);");
      } catch {}
      try {
        db.exec("ALTER TABLE sales ADD COLUMN exchange_diff_tetri INTEGER DEFAULT 0;");
      } catch {}
      try {
        db.exec("ALTER TABLE sales ADD COLUMN discount_authorized_by INTEGER REFERENCES users(id);");
      } catch {}
      try {
        db.exec("ALTER TABLE sales ADD COLUMN discount_reason TEXT;");
      } catch {}
    }
  }
];

export function runMigrations(db: DatabaseSync, dbPath?: string): void {
  // Ensure schema_migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as Array<{ version: number }>;
  const appliedVersions = new Set(appliedRows.map(r => r.version));

  const pending = migrations.filter(m => !appliedVersions.has(m.version));
  if (pending.length === 0) return;

  // Pre-migration safety backup if operating on a physical database file
  if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      const backupPath = `${dbPath}.before_migration_v${pending[0].version}_${Date.now()}.bak`;
      fs.copyFileSync(dbPath, backupPath);
      console.log(`[DB Migration] Safety pre-migration backup created: ${backupPath}`);
    } catch (bkErr) {
      console.warn('[DB Migration Warning] Could not create pre-migration backup:', bkErr);
    }
  }

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(db);
      const insertStmt = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
      insertStmt.run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT;');
      console.log(`[DB Migration] Applied migration #${migration.version}: ${migration.name}`);
    } catch (err) {
      db.exec('ROLLBACK;');
      console.error(`[DB Migration Error] Failed at migration #${migration.version}: ${migration.name}`, err);
      throw err;
    }
  }
}
