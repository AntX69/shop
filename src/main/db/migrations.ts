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
  },
  {
    version: 5,
    name: 'debt_repayment_allocations',
    up: (db: DatabaseSync) => {
      // 1. Create repayment allocations table
      db.exec(`
        CREATE TABLE IF NOT EXISTS debt_repayment_allocations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repayment_id INTEGER NOT NULL REFERENCES debt_repayments(id) ON DELETE CASCADE,
          sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          allocated_tetri INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_repay_alloc_sale ON debt_repayment_allocations(sale_id);
        CREATE INDEX IF NOT EXISTS idx_repay_alloc_repay ON debt_repayment_allocations(repayment_id);
        CREATE INDEX IF NOT EXISTS idx_repay_alloc_cust ON debt_repayment_allocations(customer_id);
      `);

      // 2. Safe migration of existing debt_repayments that have a specific sale_id
      db.exec(`
        INSERT INTO debt_repayment_allocations (repayment_id, sale_id, customer_id, allocated_tetri, created_at)
        SELECT id, sale_id, customer_id, amount_tetri, created_at
        FROM debt_repayments
        WHERE sale_id IS NOT NULL;
      `);

      // 3. Safe migration of existing unallocated repayments (sale_id IS NULL)
      // Distribute FIFO across the customer's unpaid sales
      const unallocatedRepayments = db.prepare(`
        SELECT id, customer_id, amount_tetri, created_at
        FROM debt_repayments
        WHERE sale_id IS NULL
        ORDER BY id ASC
      `).all() as Array<{ id: number; customer_id: number; amount_tetri: number; created_at: string }>;

      for (const rep of unallocatedRepayments) {
        let remainingToAllocate = rep.amount_tetri;
        const candidateSales = db.prepare(`
          SELECT s.id, s.debt_amount_tetri,
            COALESCE((SELECT SUM(allocated_tetri) FROM debt_repayment_allocations WHERE sale_id = s.id), 0) as already_allocated,
            COALESCE((SELECT SUM(debt_deduction_tetri) FROM returns WHERE sale_id = s.id), 0) as returns_deducted
          FROM sales s
          WHERE s.customer_id = ? AND s.debt_amount_tetri > 0
          ORDER BY s.id ASC
        `).all(rep.customer_id) as Array<{ id: number; debt_amount_tetri: number; already_allocated: number; returns_deducted: number }>;

        for (const cs of candidateSales) {
          const openDebt = cs.debt_amount_tetri - cs.already_allocated - cs.returns_deducted;
          if (openDebt > 0 && remainingToAllocate > 0) {
            const allocPortion = Math.min(openDebt, remainingToAllocate);
            db.prepare(`
              INSERT INTO debt_repayment_allocations (repayment_id, sale_id, customer_id, allocated_tetri, created_at)
              VALUES (?, ?, ?, ?, ?)
            `).run(rep.id, cs.id, rep.customer_id, allocPortion, rep.created_at);
            remainingToAllocate -= allocPortion;
          }
        }
      }
    }
  },
  {
    version: 6,
    name: 'fifo_cost_layers_discounts_debt_admin_pin_lockout',
    up: (db: DatabaseSync) => {
      const now = new Date().toISOString();

      // 1. Exact FIFO consumption per sale line. Returns restore these layers with their
      //    original cost, so a sale followed by a resellable return nets to zero COGS.
      //    lot_id is NULL only for lines sold before this migration (cost known per line only).
      db.exec(`
        CREATE TABLE IF NOT EXISTS sale_item_lots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
          lot_id INTEGER REFERENCES inventory_lots(id),
          quantity INTEGER NOT NULL CHECK(quantity > 0),
          unit_cost_tetri INTEGER,
          returned_quantity INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sale_item_lots_item ON sale_item_lots(sale_item_id);
      `);

      // 2. Discounts (owner only): list price stays in unit_price_tetri, total_price_tetri is the net paid.
      addColumnIfMissing(db, 'sale_items', 'discount_tetri', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'sales', 'subtotal_tetri', 'INTEGER');
      addColumnIfMissing(db, 'sales', 'discount_tetri', 'INTEGER NOT NULL DEFAULT 0');
      // Non-cash credit from an exchange return that paid part of this sale.
      addColumnIfMissing(db, 'sales', 'exchange_credit_tetri', 'INTEGER NOT NULL DEFAULT 0');

      // 3. Per-line return condition and the cost reversed by the return.
      addColumnIfMissing(db, 'return_items', 'condition', "TEXT NOT NULL DEFAULT 'resellable'");
      addColumnIfMissing(db, 'return_items', 'cost_total_tetri', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'return_items', 'unknown_cost_quantity', 'INTEGER NOT NULL DEFAULT 0');
      // total_refund = debt_deduction + exchange_credit + cash_refund
      addColumnIfMissing(db, 'returns', 'exchange_credit_tetri', 'INTEGER NOT NULL DEFAULT 0');

      // 4. Owner debt administration: repayments are voided, never deleted; write-offs are recorded.
      addColumnIfMissing(db, 'debt_repayments', 'voided_at', 'TEXT');
      addColumnIfMissing(db, 'debt_repayments', 'voided_by', 'INTEGER REFERENCES users(id)');
      addColumnIfMissing(db, 'debt_repayments', 'void_reason', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS debt_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          sale_id INTEGER NOT NULL REFERENCES sales(id),
          adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('write_off')),
          amount_tetri INTEGER NOT NULL CHECK(amount_tetri > 0),
          reason TEXT NOT NULL,
          sale_balance_before_tetri INTEGER NOT NULL,
          sale_balance_after_tetri INTEGER NOT NULL,
          customer_balance_before_tetri INTEGER NOT NULL,
          customer_balance_after_tetri INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_adj_idempotency ON debt_adjustments(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_debt_adj_sale ON debt_adjustments(sale_id);
        CREATE INDEX IF NOT EXISTS idx_debt_adj_customer ON debt_adjustments(customer_id);
      `);

      // 5. Single source of truth for the open balance of every debt sale.
      db.exec(`
        DROP VIEW IF EXISTS sale_debt_balances;
        CREATE VIEW sale_debt_balances AS
        SELECT b.*,
               MAX(0, b.debt_amount_tetri - b.repaid_tetri - b.returned_tetri - b.written_off_tetri) AS remaining_tetri
        FROM (
          SELECT s.id AS sale_id,
                 s.customer_id AS customer_id,
                 s.receipt_number AS receipt_number,
                 s.created_at AS created_at,
                 s.debt_amount_tetri AS debt_amount_tetri,
                 COALESCE((SELECT SUM(a.allocated_tetri)
                             FROM debt_repayment_allocations a
                             JOIN debt_repayments r ON r.id = a.repayment_id
                            WHERE a.sale_id = s.id AND r.voided_at IS NULL), 0) AS repaid_tetri,
                 COALESCE((SELECT SUM(rt.debt_deduction_tetri) FROM returns rt WHERE rt.sale_id = s.id), 0) AS returned_tetri,
                 COALESCE((SELECT SUM(da.amount_tetri) FROM debt_adjustments da WHERE da.sale_id = s.id), 0) AS written_off_tetri
          FROM sales s
          WHERE s.debt_amount_tetri > 0
        ) b;
      `);

      // 6. PIN brute-force protection, persisted across restarts.
      addColumnIfMissing(db, 'users', 'failed_pin_attempts', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'users', 'locked_until', 'TEXT');

      // 7. Indexes for history, debts and catalog lookups on thousands of rows.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
        CREATE INDEX IF NOT EXISTS idx_sale_items_variant ON sale_items(variant_id);
        CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
        CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id);
        CREATE INDEX IF NOT EXISTS idx_returns_created_at ON returns(created_at);
        CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);
        CREATE INDEX IF NOT EXISTS idx_return_items_sale_item ON return_items(sale_item_id);
        CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
        CREATE INDEX IF NOT EXISTS idx_codes_variant ON product_codes(variant_id);
        CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id);
        CREATE INDEX IF NOT EXISTS idx_lots_variant ON inventory_lots(variant_id, remaining_quantity);
        CREATE INDEX IF NOT EXISTS idx_movements_variant ON inventory_movements(variant_id);
        CREATE INDEX IF NOT EXISTS idx_repayments_customer ON debt_repayments(customer_id);
        CREATE INDEX IF NOT EXISTS idx_repayments_created_at ON debt_repayments(created_at);
        CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
        CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
      `);

      // 8. Backfill existing rows so history keeps reporting correctly.
      db.exec(`UPDATE sales SET subtotal_tetri = total_tetri WHERE subtotal_tetri IS NULL;`);
      db.exec(`
        UPDATE sales
           SET exchange_credit_tetri = MAX(0, total_tetri - (cash_received_tetri - change_given_tetri) - debt_amount_tetri)
         WHERE sale_type = 'exchange';
      `);
      // Earlier exchanges stored the whole credit as cash_refund_tetri although no cash left the till.
      const oldExchangeReturns = db.prepare(`
        SELECT r.id, r.total_refund_tetri, r.debt_deduction_tetri, COALESCE(s.exchange_credit_tetri, 0) AS sale_credit
        FROM returns r LEFT JOIN sales s ON s.id = r.related_sale_id
        WHERE r.return_type = 'exchange'
      `).all() as Array<{ id: number; total_refund_tetri: number; debt_deduction_tetri: number; sale_credit: number }>;
      for (const r of oldExchangeReturns) {
        const available = Math.max(0, r.total_refund_tetri - r.debt_deduction_tetri);
        const credit = Math.min(available, r.sale_credit);
        db.prepare('UPDATE returns SET exchange_credit_tetri = ?, cash_refund_tetri = ? WHERE id = ?')
          .run(credit, available - credit, r.id);
      }
      db.exec(`
        UPDATE return_items SET
          condition = COALESCE((SELECT r.condition FROM returns r WHERE r.id = return_items.return_id), 'resellable'),
          cost_total_tetri = COALESCE((SELECT si.unit_cost_tetri FROM sale_items si WHERE si.id = return_items.sale_item_id), 0) * quantity,
          unknown_cost_quantity = CASE
            WHEN (SELECT si.unit_cost_tetri FROM sale_items si WHERE si.id = return_items.sale_item_id) IS NULL THEN quantity
            ELSE 0 END;
      `);
      db.exec(`
        INSERT INTO sale_item_lots (sale_item_id, lot_id, quantity, unit_cost_tetri, returned_quantity)
        SELECT si.id, NULL, si.quantity, si.unit_cost_tetri, si.returned_quantity
        FROM sale_items si
        WHERE si.quantity > 0 AND NOT EXISTS (SELECT 1 FROM sale_item_lots sil WHERE sil.sale_item_id = si.id);
      `);
      // Lots re-created by earlier resellable returns were stored without cost; restore the sold cost.
      db.exec(`
        UPDATE inventory_lots SET unit_cost_tetri = (
          SELECT si.unit_cost_tetri
          FROM inventory_movements m
          JOIN sales s ON s.receipt_number = m.reference_id
          JOIN sale_items si ON si.sale_id = s.id AND si.variant_id = inventory_lots.variant_id
          WHERE m.id = inventory_lots.movement_id
          ORDER BY si.id LIMIT 1
        )
        WHERE unit_cost_tetri IS NULL
          AND movement_id IN (SELECT id FROM inventory_movements WHERE movement_type = 'return');
      `);

      // 9. Reconcile stock counters with FIFO layers (earlier stock corrections left the lots untouched).
      reconcileStockWithLots(db, now);

      db.exec(`
        INSERT OR IGNORE INTO app_settings (key, value) VALUES
        ('backup_retention_count', '30'),
        ('backup_mirror_directory', ''),
        ('last_auto_backup_date', '');
      `);
    }
  }
];

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

/**
 * Makes SUM(inventory_lots.remaining_quantity) equal product_variants.stock_quantity for every
 * variant. Surplus layers are consumed oldest first; a shortfall becomes a layer costed at the
 * variant's configured purchase cost, or unknown (NULL) when none is configured.
 * Returns the number of variants that had to be adjusted.
 */
export function reconcileStockWithLots(db: DatabaseSync, now: string = new Date().toISOString()): number {
  const rows = db.prepare(`
    SELECT pv.id, pv.stock_quantity, pv.cost_override_tetri, p.base_cost_tetri,
           COALESCE((SELECT SUM(l.remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0) AS lot_qty
    FROM product_variants pv JOIN products p ON p.id = pv.product_id
  `).all() as Array<{ id: number; stock_quantity: number; cost_override_tetri: number | null; base_cost_tetri: number | null; lot_qty: number }>;

  let adjusted = 0;
  for (const v of rows) {
    if (v.lot_qty === v.stock_quantity) continue;
    adjusted++;
    if (v.lot_qty > v.stock_quantity) {
      let excess = v.lot_qty - Math.max(0, v.stock_quantity);
      const lots = db.prepare('SELECT id, remaining_quantity FROM inventory_lots WHERE variant_id = ? AND remaining_quantity > 0 ORDER BY id ASC')
        .all(v.id) as Array<{ id: number; remaining_quantity: number }>;
      for (const lot of lots) {
        if (excess <= 0) break;
        const take = Math.min(excess, lot.remaining_quantity);
        db.prepare('UPDATE inventory_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?').run(take, lot.id);
        excess -= take;
      }
    } else {
      const missing = v.stock_quantity - v.lot_qty;
      db.prepare('INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)')
        .run(v.id, missing, missing, v.cost_override_tetri ?? v.base_cost_tetri ?? null, now);
    }
    db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (NULL, 'STOCK_LOT_RECONCILE', 'product_variants', ?, ?, ?)")
      .run(String(v.id), `FIFO layers aligned with stock: lots ${v.lot_qty} -> stock ${v.stock_quantity}`, now);
  }
  return adjusted;
}

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

  // Pre-migration safety backup when upgrading an existing store database
  // (a brand-new, empty database has nothing worth backing up).
  if (dbPath && dbPath !== ':memory:' && appliedVersions.size > 0 && fs.existsSync(dbPath)) {
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
