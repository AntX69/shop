/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bookkeeping identities checked directly in a StorePOS SQLite file (read-only, separate
 * connection; safe while the app is running thanks to WAL). Used by the soak, restart and
 * disaster-recovery tests.
 */

import { DatabaseSync } from 'node:sqlite';

/** Returns [{ name, ok, detail }] plus the key figures of the database. */
export function reconcileDatabase(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 5000');
  try {
    const one = (sql) => Object.values(db.prepare(sql).get())[0];
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

    const quick = one('PRAGMA quick_check');
    add('SQLite quick_check', quick === 'ok', String(quick));
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    add('no broken foreign keys', fk === 0, `${fk} rows`);
    const drift = one(`SELECT COUNT(*) FROM product_variants pv WHERE pv.stock_quantity != COALESCE((SELECT SUM(remaining_quantity) FROM inventory_lots l WHERE l.variant_id = pv.id), 0)`);
    add('stock = FIFO layers for every variant', drift === 0, `${drift} out of step`);
    const negative = one(`SELECT COUNT(*) FROM product_variants WHERE stock_quantity < 0`) + one(`SELECT COUNT(*) FROM inventory_lots WHERE remaining_quantity < 0 OR remaining_quantity > initial_quantity`);
    add('no negative stock or overdrawn layer', negative === 0, `${negative}`);
    const debtView = one(`SELECT COALESCE(SUM(remaining_tetri), 0) FROM sale_debt_balances`);
    const allocated = one(`SELECT COALESCE(SUM(a.allocated_tetri), 0) FROM debt_repayment_allocations a JOIN debt_repayments r ON r.id = a.repayment_id WHERE r.voided_at IS NULL`);
    const debtBooks = one(`SELECT COALESCE(SUM(debt_amount_tetri), 0) FROM sales`) - allocated - one(`SELECT COALESCE(SUM(debt_deduction_tetri), 0) FROM returns`) - one(`SELECT COALESCE(SUM(amount_tetri), 0) FROM debt_adjustments`);
    const repaid = one(`SELECT COALESCE(SUM(amount_tetri), 0) FROM debt_repayments WHERE voided_at IS NULL`);
    add('debt balances = debt − repayments − return deductions − write-offs; repayments fully allocated', debtView === debtBooks && repaid === allocated, `open ${debtView}, books ${debtBooks}, repaid ${repaid}, allocated ${allocated}`);
    const sold = one(`SELECT COALESCE(SUM(quantity), 0) FROM sale_items`);
    const layered = one(`SELECT COALESCE(SUM(quantity), 0) FROM sale_item_lots`);
    const retLines = one(`SELECT COALESCE(SUM(returned_quantity), 0) FROM sale_items`);
    const retLayers = one(`SELECT COALESCE(SUM(returned_quantity), 0) FROM sale_item_lots`);
    add('every sold/returned unit sits on a FIFO layer', sold === layered && retLines === retLayers, `sold ${sold}, returned ${retLines}`);
    const saleSplit = one(`SELECT COUNT(*) FROM sales WHERE total_tetri != (cash_received_tetri - change_given_tetri) + debt_amount_tetri + exchange_credit_tetri`);
    const refundSplit = one(`SELECT COUNT(*) FROM returns WHERE total_refund_tetri != debt_deduction_tetri + exchange_credit_tetri + cash_refund_tetri`);
    add('every sale and return splits exactly into cash, debt and exchange credit', saleSplit === 0 && refundSplit === 0, `${saleSplit} sales, ${refundSplit} returns off`);

    const figures = {
      products: one('SELECT COUNT(*) FROM products'),
      variants: one('SELECT COUNT(*) FROM product_variants'),
      users: one('SELECT COUNT(*) FROM users'),
      customers: one('SELECT COUNT(*) FROM customers'),
      sales: one('SELECT COUNT(*) FROM sales'),
      returns: one('SELECT COUNT(*) FROM returns'),
      repayments: one('SELECT COUNT(*) FROM debt_repayments'),
      images: one('SELECT COUNT(*) FROM product_images'),
      stock_units: one('SELECT COALESCE(SUM(stock_quantity), 0) FROM product_variants'),
      open_debt_tetri: debtView,
      sales_total_tetri: one('SELECT COALESCE(SUM(total_tetri), 0) FROM sales'),
    };
    return { checks, figures };
  } finally {
    db.close();
  }
}
