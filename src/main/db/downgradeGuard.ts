/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Downgrade guard: an older StorePOS program (1.0 RC3 and earlier) must not change a database
 * that StorePOS 1.1 has upgraded. Those programs cannot be changed any more and do not check the
 * schema version, so the protection lives in the database itself:
 *
 *  - every table that holds stock, costs, sales, debts, returns, products, customers or staff
 *    rights has BEFORE INSERT / UPDATE / DELETE triggers whose condition calls the SQL function
 *    `requires_storepos_v1_1()`;
 *  - StorePOS 1.1 defines that function (returning 1) on every connection it opens, so the
 *    triggers never fire for it;
 *  - an older program does not know the function: SQLite refuses to prepare any statement that
 *    would run such a trigger ("no such function: requires_storepos_v1_1"), so the write fails
 *    before anything is written and the program's transaction is rolled back. Reading still works.
 *
 * Left writable for an older program on purpose, so that it can still start, let the owner sign in
 * and restore its own backup (the documented way back to RC3): app_settings, audit_logs,
 * system_error_logs, schema_migrations and the sign-in lockout counters of users
 * (failed_pin_attempts, locked_until). None of them affects stock, costs or money.
 *
 * Every later StorePOS version MUST keep defining GUARD_FUNCTION on every connection
 * (initDatabase and runMigrations do it), or it cannot write its own data.
 */

import type { DatabaseSync } from 'node:sqlite';

export const GUARD_FUNCTION = 'requires_storepos_v1_1';

/** Tables an older program must not change at all. */
export const GUARDED_TABLES = [
  'categories',
  'products',
  'product_variants',
  'product_codes',
  'product_images',
  'customers',
  'inventory_movements',
  'inventory_lots',
  'sales',
  'sale_items',
  'sale_item_lots',
  'debt_repayments',
  'debt_repayment_allocations',
  'debt_adjustments',
  'returns',
  'return_items',
  'expenses',
  'user_permissions',
] as const;

/** users: no new or deleted staff, no change of name, role, PIN or active state. */
const USERS_GUARDED_COLUMNS = ['name', 'role', 'pin_hash', 'pin_salt', 'is_active', 'created_at'];

const MESSAGE = 'This StorePOS database was upgraded to StorePOS 1.1 and can only be changed by StorePOS 1.1 or newer';

/** Defines the guard function on a connection (idempotent). Call before any write. */
export function registerDowngradeGuardFunction(db: DatabaseSync): void {
  db.function(GUARD_FUNCTION, { deterministic: true }, () => 1);
}

interface GuardTrigger { name: string; sql: string }

function trigger(name: string, event: string, table: string): GuardTrigger {
  return {
    name,
    sql: `CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${event} ON ${table} ` +
      `WHEN ${GUARD_FUNCTION}() IS NOT 1 BEGIN SELECT RAISE(ABORT, '${MESSAGE}'); END;`,
  };
}

/** Every guard trigger (for the given tables, default: all of them): name and CREATE statement. */
export function downgradeGuardTriggers(tables: readonly string[] = GUARDED_TABLES): GuardTrigger[] {
  const out: GuardTrigger[] = [];
  for (const table of tables) {
    out.push(trigger(`v11_guard_${table}_insert`, 'INSERT', table));
    out.push(trigger(`v11_guard_${table}_update`, 'UPDATE', table));
    out.push(trigger(`v11_guard_${table}_delete`, 'DELETE', table));
  }
  out.push(trigger('v11_guard_users_insert', 'INSERT', 'users'));
  out.push(trigger('v11_guard_users_update', `UPDATE OF ${USERS_GUARDED_COLUMNS.join(', ')}`, 'users'));
  out.push(trigger('v11_guard_users_delete', 'DELETE', 'users'));
  return out;
}

/** Names of guard triggers that are not in the database (empty when fully protected). */
export function missingDowngradeGuardTriggers(db: DatabaseSync, tables: readonly string[] = GUARDED_TABLES): string[] {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((r) => r.name)
  );
  return downgradeGuardTriggers(tables).map((t) => t.name).filter((n) => !present.has(n));
}

/**
 * Creates the guard triggers that are missing (all of them on first use). Returns how many were
 * created. Runs inside the caller's transaction when there is one.
 */
export function installDowngradeGuard(db: DatabaseSync, tables: readonly string[] = GUARDED_TABLES): number {
  const missing = new Set(missingDowngradeGuardTriggers(db, tables));
  if (missing.size === 0) return 0;
  for (const t of downgradeGuardTriggers(tables)) {
    if (missing.has(t.name)) db.exec(t.sql);
  }
  return missing.size;
}
