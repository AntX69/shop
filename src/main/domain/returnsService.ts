/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Returns & Exchanges Domain Service.
 * Ensures returns are linked to real sales, validates available returnable quantity,
 * deducts open debt first before any cash refund, and handles resellable vs damaged stock.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { ExchangePayload, ReturnPayload, User } from '../../shared/types.ts';
import { PosService } from './posService.ts';

export class ReturnsService {
  private db: DatabaseSync;
  private posService: PosService;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
    this.posService = new PosService(db);
  }

  /**
   * Processes a return for a historical sale.
   */
  processReturn(user: User, payload: ReturnPayload): {
    return_id: number;
    total_refund_tetri: number;
    debt_deduction_tetri: number;
    cash_refund_tetri: number;
  } {
    if (!payload.items || payload.items.length === 0) {
      throw new Error('დასაბრუნებელი პროდუქტები არ არის არჩეული');
    }

    return runInTransaction((db) => {
      const now = new Date().toISOString();

      // 1. Get original sale
      const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(payload.sale_id) as any;
      if (!sale) {
        throw new Error('ორიგინალი გაყიდვა ვერ მოიძებნა');
      }

      // Calculate already returned amounts and remaining debt for this sale
      const pastReturns = db.prepare(`
        SELECT COALESCE(SUM(debt_deduction_tetri), 0) as past_debt_deduction,
               COALESCE(SUM(cash_refund_tetri), 0) as past_cash_refund
        FROM returns WHERE sale_id = ?
      `).get(sale.id) as { past_debt_deduction: number; past_cash_refund: number };

      const pastRepayments = db.prepare(`
        SELECT COALESCE(SUM(amount_tetri), 0) as total_repaid
        FROM debt_repayments WHERE sale_id = ?
      `).get(sale.id) as { total_repaid: number };

      const remainingSaleDebt = Math.max(0, sale.debt_amount_tetri - pastReturns.past_debt_deduction - pastRepayments.total_repaid);
      const remainingCashPaid = Math.max(0, (sale.cash_received_tetri - sale.change_given_tetri) + pastRepayments.total_repaid - pastReturns.past_cash_refund);

      let totalRefundTetri = 0;

      // 2. Validate line items and returnable quantities
      const processedItems: Array<{
        sale_item_id: number;
        variant_id: number;
        quantity: number;
        unit_price_tetri: number;
        line_total_tetri: number;
        condition: 'resellable' | 'damaged';
      }> = [];

      for (const reqItem of payload.items) {
        if (reqItem.quantity <= 0) {
          throw new Error('დასაბრუნებელი რაოდენობა უნდა იყოს მინიმუმ 1');
        }

        const saleItem = db.prepare(`
          SELECT * FROM sale_items WHERE id = ? AND sale_id = ?
        `).get(reqItem.sale_item_id, sale.id) as any;

        if (!saleItem) {
          throw new Error(`გაყიდული პოზიცია #${reqItem.sale_item_id} არ ეკუთვნის ამ გაყიდვას`);
        }

        const maxReturnable = saleItem.quantity - saleItem.returned_quantity;
        if (reqItem.quantity > maxReturnable) {
          throw new Error(
            `შეცდომა: "${saleItem.product_name_snap}"-სთვის დასაბრუნებელი რაოდენობა (${reqItem.quantity}) ` +
            `აღემატება დარჩენილ დაბრუნებად რაოდენობას (${maxReturnable})`
          );
        }

        const lineTotal = reqItem.quantity * saleItem.unit_price_tetri;
        totalRefundTetri += lineTotal;

        processedItems.push({
          sale_item_id: saleItem.id,
          variant_id: reqItem.variant_id,
          quantity: reqItem.quantity,
          unit_price_tetri: saleItem.unit_price_tetri,
          line_total_tetri: lineTotal,
          condition: reqItem.condition
        });
      }

      // 3. Determine financial allocation: Deduct debt first, refund cash second
      const debtDeductionTetri = Math.min(totalRefundTetri, remainingSaleDebt);
      const remainingRefundTetri = totalRefundTetri - debtDeductionTetri;
      const cashRefundTetri = Math.min(remainingRefundTetri, remainingCashPaid);

      // 4. Create Return record
      const returnRes = db.prepare(`
        INSERT INTO returns (
          sale_id, user_id, return_type, total_refund_tetri,
          debt_deduction_tetri, cash_refund_tetri, condition, reason, created_at
        ) VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)
      `).run(
        sale.id,
        user.id,
        totalRefundTetri,
        debtDeductionTetri,
        cashRefundTetri,
        payload.items[0].condition, // Primary condition
        payload.reason?.trim() || null,
        now
      );
      const returnId = Number(returnRes.lastInsertRowid);

      // 5. Insert return items and update inventory & sale_items
      for (const pItem of processedItems) {
        db.prepare(`
          INSERT INTO return_items (return_id, sale_item_id, variant_id, quantity, unit_price_tetri, total_tetri)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          returnId,
          pItem.sale_item_id,
          pItem.variant_id,
          pItem.quantity,
          pItem.unit_price_tetri,
          pItem.line_total_tetri
        );

        // Update returned_quantity on original sale item
        db.prepare(`
          UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?
        `).run(pItem.quantity, pItem.sale_item_id);

        // Handle inventory: if resellable, add back to stock and lot
        const variant = db.prepare("SELECT stock_quantity FROM product_variants WHERE id = ?").get(pItem.variant_id) as any;
        const currentStock = variant ? variant.stock_quantity : 0;

        if (pItem.condition === 'resellable') {
          const newStock = currentStock + pItem.quantity;
          db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(newStock, pItem.variant_id);

          const moveRes = db.prepare(`
            INSERT INTO inventory_movements (
              variant_id, movement_type, quantity_change, resulting_stock,
              unit_cost_tetri, reason, reference_id, user_id, created_at
            ) VALUES (?, 'return', ?, ?, NULL, 'დაბრუნება (ვარგისი)', ?, ?, ?)
          `).run(
            pItem.variant_id,
            pItem.quantity,
            newStock,
            sale.receipt_number,
            user.id,
            now
          );

          // Add to inventory lots
          db.prepare(`
            INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at)
            VALUES (?, ?, ?, NULL, ?, ?)
          `).run(pItem.variant_id, pItem.quantity, pItem.quantity, Number(moveRes.lastInsertRowid), now);
        } else {
          // Damaged: does not enter sellable stock
          db.prepare(`
            INSERT INTO inventory_movements (
              variant_id, movement_type, quantity_change, resulting_stock,
              unit_cost_tetri, reason, reference_id, user_id, created_at
            ) VALUES (?, 'return', 0, ?, NULL, 'დაბრუნება (დაზიანებული/ჩამოწერილი)', ?, ?, ?)
          `).run(
            pItem.variant_id,
            currentStock,
            sale.receipt_number,
            user.id,
            now
          );
        }
      }

      // Check if all items in original sale are now returned
      const checkItems = db.prepare(`
        SELECT SUM(quantity) as total_qty, SUM(returned_quantity) as total_ret
        FROM sale_items WHERE sale_id = ?
      `).get(sale.id) as { total_qty: number; total_ret: number };

      const newSaleStatus = checkItems.total_ret >= checkItems.total_qty ? 'returned' : 'partially_returned';
      db.prepare("UPDATE sales SET status = ? WHERE id = ?").run(newSaleStatus, sale.id);

      // Audit log
      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'SALE_RETURN', 'returns', ?, ?, ?)
      `).run(
        user.id,
        String(returnId),
        `Return processed for sale ${sale.receipt_number}: total ${totalRefundTetri} tetri (debt reduced: ${debtDeductionTetri}, cash refunded: ${cashRefundTetri})`,
        now
      );

      return {
        return_id: returnId,
        total_refund_tetri: totalRefundTetri,
        debt_deduction_tetri: debtDeductionTetri,
        cash_refund_tetri: cashRefundTetri
      };
    }, this.db);
  }

  /**
   * Performs an atomic exchange: returns old item(s) and purchases new item(s).
   */
  processExchange(user: User, payload: ExchangePayload): {
    return_id: number;
    new_sale_id: number;
    difference_tetri: number;
  } {
    return runInTransaction((db) => {
      // 1. Process return part
      const returnResult = this.processReturn(user, {
        sale_id: payload.original_sale_id,
        items: payload.return_items,
        reason: 'გაცვლა (Exchange)'
      });

      // 2. Calculate new items total
      const newTotalTetri = payload.new_items.reduce((sum, it) => sum + (it.quantity * it.unit_price_tetri), 0);
      const diffTetri = newTotalTetri - returnResult.total_refund_tetri;

      // 3. Checkout new items
      const originalSale = db.prepare("SELECT * FROM sales WHERE id = ?").get(payload.original_sale_id) as any;
      const newSale = this.posService.checkout(user, {
        items: payload.new_items,
        payment_method: 'cash',
        customer_id: originalSale.customer_id,
        cash_received_tetri: Math.max(newTotalTetri, 0),
        notes: `გაცვლა გაყიდვიდან #${originalSale.receipt_number}`
      });

      // Record audit
      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'EXCHANGE', 'sales', ?, ?, datetime('now'))
      `).run(
        user.id,
        String(newSale.id),
        `Exchange linked to original sale ${originalSale.receipt_number}. Return value: ${returnResult.total_refund_tetri}, New value: ${newTotalTetri}, Difference: ${diffTetri}`
      );

      return {
        return_id: returnResult.return_id,
        new_sale_id: newSale.id,
        difference_tetri: diffTetri
      };
    }, this.db);
  }
}
