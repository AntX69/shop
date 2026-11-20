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

    // Lines add up to their documents; returned quantities match the return lines.
    const saleLines = one(`SELECT COUNT(*) FROM sales s WHERE s.total_tetri != (SELECT COALESCE(SUM(total_price_tetri), 0) FROM sale_items si WHERE si.sale_id = s.id)`);
    const returnLines = one(`SELECT COUNT(*) FROM returns r WHERE r.total_refund_tetri != (SELECT COALESCE(SUM(total_tetri), 0) FROM return_items ri WHERE ri.return_id = r.id)`);
    const returnedQty = one(`SELECT COUNT(*) FROM sale_items si WHERE si.returned_quantity != (SELECT COALESCE(SUM(quantity), 0) FROM return_items ri WHERE ri.sale_item_id = si.id)`);
    const overReturned = one(`SELECT COUNT(*) FROM sale_items WHERE returned_quantity > quantity OR returned_quantity < 0`);
    add('sale and return lines add up to their totals; returned quantities match return lines', saleLines + returnLines + returnedQty + overReturned === 0,
      `${saleLines} sales, ${returnLines} returns, ${returnedQty} lines, ${overReturned} over-returned`);
    const dupReceipts = one(`SELECT COUNT(*) - COUNT(DISTINCT receipt_number) FROM sales`);
    const dupKeys = one(`SELECT COUNT(idempotency_key) - COUNT(DISTINCT idempotency_key) FROM sales`) + one(`SELECT COUNT(idempotency_key) - COUNT(DISTINCT idempotency_key) FROM returns`);
    add('no duplicate receipts or replayed requests', dupReceipts === 0 && dupKeys === 0, `${dupReceipts} receipts, ${dupKeys} keys`);

    // V1.1 exact FIFO costs (only where the columns exist).
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (cols('inventory_lots').includes('remaining_cost_tetri')) {
      const badLayer = one(`SELECT COUNT(*) FROM inventory_lots WHERE (unit_cost_tetri IS NULL) != (initial_cost_tetri IS NULL) OR (initial_cost_tetri IS NULL) != (remaining_cost_tetri IS NULL)
        OR remaining_cost_tetri < 0 OR (remaining_quantity = 0 AND remaining_cost_tetri != 0)`);
      const pieceLayer = one(`SELECT COUNT(*) FROM inventory_lots WHERE COALESCE(unit_type, 'piece') <> 'kg' AND remaining_cost_tetri IS NOT NULL AND remaining_cost_tetri != unit_cost_tetri * remaining_quantity`);
      add('FIFO layer costs consistent (known/unknown, never negative, empty layer = 0, piece layer = unit × quantity)', badLayer + pieceLayer === 0, `${badLayer} inconsistent, ${pieceLayer} piece layers off`);
      const badPart = one(`SELECT COUNT(*) FROM sale_item_lots WHERE returned_quantity > quantity OR returned_cost_tetri < 0
        OR (cost_tetri IS NOT NULL AND returned_cost_tetri > cost_tetri) OR (cost_tetri IS NOT NULL AND returned_quantity = quantity AND returned_cost_tetri != cost_tetri)`);
      add('consumed parts: returns never exceed the part; a fully returned part brings back exactly its cost', badPart === 0, `${badPart} parts off`);
      const retCost = one(`SELECT COALESCE(SUM(cost_total_tetri), 0) FROM return_items`);
      const partsBack = one(`SELECT COALESCE(SUM(returned_cost_tetri), 0) FROM sale_item_lots`);
      add('cost reversed by returns = cost brought back by the consumed parts', retCost === partsBack, `return lines ${retCost}, parts ${partsBack}`);
      const unknownMoves = one(`SELECT COUNT(*) FROM inventory_movements WHERE cost_total_tetri IS NULL`);
      const unknownLayers = one(`SELECT COUNT(*) FROM inventory_lots WHERE remaining_cost_tetri IS NULL AND remaining_quantity > 0`);
      if (unknownMoves === 0 && unknownLayers === 0) {
        const byMoves = one(`SELECT COALESCE(SUM(cost_total_tetri), 0) FROM inventory_movements`);
        const onShelf = one(`SELECT COALESCE(SUM(remaining_cost_tetri), 0) FROM inventory_lots`);
        add('stock value: sum of every movement\'s cost = cost of what is on the shelf', byMoves === onShelf, `movements ${byMoves}, shelf ${onShelf}`);
      } else {
        // Per variant, wherever every movement and layer of that variant has a known cost.
        const perVariant = db.prepare(`
          SELECT pv.id,
            (SELECT COALESCE(SUM(cost_total_tetri), 0) FROM inventory_movements m WHERE m.variant_id = pv.id) AS by_moves,
            (SELECT COALESCE(SUM(remaining_cost_tetri), 0) FROM inventory_lots l WHERE l.variant_id = pv.id) AS on_shelf
          FROM product_variants pv
          WHERE NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.variant_id = pv.id AND m.cost_total_tetri IS NULL)
            AND NOT EXISTS (SELECT 1 FROM inventory_lots l WHERE l.variant_id = pv.id AND l.remaining_cost_tetri IS NULL)
            AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.variant_id = pv.id)
        `).all();
        const off = perVariant.filter((r) => r.by_moves !== r.on_shelf);
        add('stock value per variant: movements\' costs = shelf cost (variants with only known costs)', perVariant.length > 0 && off.length === 0,
          `${perVariant.length} variants checked, ${off.length} off; skipped: ${unknownMoves} movements / ${unknownLayers} layers without cost`);
      }
    }

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
      // Independent recomputation of the finance figures (all time), straight from the tables.
      net_sales_tetri: one('SELECT COALESCE(SUM(total_tetri), 0) FROM sales') - one('SELECT COALESCE(SUM(total_refund_tetri), 0) FROM returns'),
      cash_flow_tetri: one('SELECT COALESCE(SUM(cash_received_tetri - change_given_tetri), 0) FROM sales')
        + one('SELECT COALESCE(SUM(amount_tetri), 0) FROM debt_repayments WHERE voided_at IS NULL')
        - one('SELECT COALESCE(SUM(cash_refund_tetri), 0) FROM returns'),
      expenses_tetri: one('SELECT COALESCE(SUM(amount_tetri), 0) FROM expenses'),
    };
    const lotCols = db.prepare('PRAGMA table_info(inventory_lots)').all().map((c) => c.name);
    if (lotCols.includes('remaining_cost_tetri')) {
      figures.cogs_known_tetri = one('SELECT COALESCE(SUM(cost_tetri), 0) FROM sale_item_lots');
      figures.cost_reversed_tetri = one('SELECT COALESCE(SUM(cost_total_tetri), 0) FROM return_items');
      figures.stock_value_known_tetri = one('SELECT COALESCE(SUM(remaining_cost_tetri), 0) FROM inventory_lots WHERE remaining_quantity > 0');
      figures.stock_grams = one("SELECT COALESCE(SUM(pv.stock_quantity), 0) FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE COALESCE(pv.unit_type, p.unit_type) = 'kg'");
      figures.stock_pieces = one("SELECT COALESCE(SUM(pv.stock_quantity), 0) FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE COALESCE(pv.unit_type, p.unit_type, 'piece') <> 'kg'");
    }
    return { checks, figures };
  } finally {
    db.close();
  }
}
