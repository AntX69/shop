import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { ExchangePayload, ReturnPayload, ReturnRecord, User } from '../../shared/types.ts';
import { PosService } from './posService.ts';
import { CustomerService } from './customerService.ts';

export class ReturnsService {
  private db: DatabaseSync;
  private posService: PosService;
  private customerService: CustomerService;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
    this.posService = new PosService(db);
    this.customerService = new CustomerService(db);
  }

  /**
   * Processes a return for a historical sale.
   */
  processReturn(user: User, payload: ReturnPayload): {
    return_id: number;
    id?: number;
    total_refund_tetri: number;
    debt_deduction_tetri: number;
    refund_debt_reduction_tetri?: number;
    cash_refund_tetri: number;
    refund_cash_tetri?: number;
  } {
    if (!payload.items || payload.items.length === 0) {
      throw new Error('დასაბრუნებელი პროდუქტები არ არის არჩეული');
    }

    // Idempotency check: prevent duplicate returns
    if (payload.idempotency_key) {
      const existingReturn = this.db.prepare(
        "SELECT * FROM returns WHERE idempotency_key = ?"
      ).get(payload.idempotency_key) as any;

      if (existingReturn) {
        if (existingReturn.sale_id !== payload.sale_id) {
          throw new Error('Idempotency key mismatch: ამ გასაღებით უკვე დაფიქსირებულია განსხვავებული დაბრუნება');
        }
        return {
          return_id: existingReturn.id,
          id: existingReturn.id,
          total_refund_tetri: existingReturn.total_refund_tetri,
          debt_deduction_tetri: existingReturn.debt_deduction_tetri,
          refund_debt_reduction_tetri: existingReturn.debt_deduction_tetri,
          cash_refund_tetri: existingReturn.cash_refund_tetri,
          refund_cash_tetri: existingReturn.cash_refund_tetri
        };
      }
    }

    return runInTransaction((db) => {
      const now = new Date().toISOString();

      // 1. Get original sale
      const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(payload.sale_id) as any;
      if (!sale) {
        throw new Error('ორიგინალი გაყიდვა ვერ მოიძებნა');
      }

      if (sale.status === 'returned') {
        throw new Error('შეცდომა: ამ გაყიდვაზე ყველა ნივთი უკვე დაბრუნებულია (აღემატება დარჩენილ დაბრუნებად რაოდენობას)');
      }

      // Calculate already returned amounts and repayments for this sale
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

      // Check customer's overall debt across the store so customer debt NEVER goes negative
      const customerTotalDebt = sale.customer_id
        ? (this.customerService.getCustomerById(sale.customer_id)?.total_debt_tetri || 0)
        : 0;

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

        let saleItem: any = null;
        if (reqItem.sale_item_id) {
          saleItem = db.prepare(`
            SELECT * FROM sale_items WHERE id = ? AND sale_id = ?
          `).get(reqItem.sale_item_id, sale.id) as any;
        } else if ((reqItem as any).variant_id) {
          saleItem = db.prepare(`
            SELECT * FROM sale_items WHERE variant_id = ? AND sale_id = ?
          `).get((reqItem as any).variant_id, sale.id) as any;
        }

        if (!saleItem) {
          throw new Error(`გაყიდული პოზიცია არ ეკუთვნის ამ გაყიდვას`);
        }

        const maxReturnable = saleItem.quantity - saleItem.returned_quantity;
        if (reqItem.quantity > maxReturnable) {
          throw new Error(
            `შეცდომა: "${saleItem.product_name_snap}"-სთვის დაბრუნების რაოდენობა (${reqItem.quantity}) ` +
            `აღემატება დარჩენილ დაბრუნებად რაოდენობას (${maxReturnable})`
          );
        }

        const lineTotal = reqItem.quantity * saleItem.unit_price_tetri;
        totalRefundTetri += lineTotal;

        processedItems.push({
          sale_item_id: saleItem.id,
          variant_id: saleItem.variant_id,
          quantity: reqItem.quantity,
          unit_price_tetri: saleItem.unit_price_tetri,
          line_total_tetri: lineTotal,
          condition: reqItem.condition || 'resellable'
        });
      }

      // 3. Determine financial allocation:
      // Deduct debt first up to the customer's actual remaining debt, then refund the rest in CASH.
      // Customer's total debt NEVER becomes negative.
      const maxDebtDeductible = Math.min(remainingSaleDebt, customerTotalDebt);
      const debtDeductionTetri = Math.min(totalRefundTetri, maxDebtDeductible);
      const cashRefundTetri = totalRefundTetri - debtDeductionTetri;

      // 4. Create Return record
      const returnRes = db.prepare(`
        INSERT INTO returns (
          sale_id, user_id, return_type, total_refund_tetri,
          debt_deduction_tetri, cash_refund_tetri, condition, reason, idempotency_key, created_at
        ) VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sale.id,
        user.id,
        totalRefundTetri,
        debtDeductionTetri,
        cashRefundTetri,
        payload.items[0]?.condition || 'resellable', // Primary condition
        payload.reason?.trim() || null,
        payload.idempotency_key || null,
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
        id: returnId,
        total_refund_tetri: totalRefundTetri,
        debt_deduction_tetri: debtDeductionTetri,
        refund_debt_reduction_tetri: debtDeductionTetri,
        cash_refund_tetri: cashRefundTetri,
        refund_cash_tetri: cashRefundTetri
      };
    }, this.db);
  }

  /**
   * Performs an atomic exchange: returns old item(s) and issues new item(s) with price difference handling.
   */
  processExchange(user: User, payload: ExchangePayload): {
    return_id: number;
    new_sale_id: number;
    difference_tetri: number;
    cash_action?: 'customer_pays' | 'store_refunds' | 'even';
    new_sale?: any;
    return_record?: any;
  } {
    return runInTransaction((db) => {
      const now = new Date().toISOString();

      // 1. Process return part
      const returnResult = this.processReturn(user, {
        sale_id: payload.original_sale_id,
        items: payload.return_items,
        reason: payload.notes || 'გაცვლა (Exchange)',
        idempotency_key: payload.idempotency_key ? `ret_${payload.idempotency_key}` : undefined
      });

      // Update return type to 'exchange'
      db.prepare("UPDATE returns SET return_type = 'exchange' WHERE id = ?").run(returnResult.return_id);

      // 2. Calculate authoritative price of new items from database
      let newTotalTetri = 0;
      for (const it of payload.new_items) {
        const vDb = db.prepare(`
          SELECT pv.price_override_tetri, p.base_price_tetri
          FROM product_variants pv JOIN products p ON pv.product_id = p.id
          WHERE pv.id = ?
        `).get(it.variant_id) as any;
        const authoritativeUnitPrice = vDb ? (vDb.price_override_tetri ?? vDb.base_price_tetri) : it.unit_price_tetri;
        it.unit_price_tetri = authoritativeUnitPrice;
        newTotalTetri += (it.quantity * authoritativeUnitPrice);
      }

      const diffTetri = newTotalTetri - returnResult.total_refund_tetri;
      const originalSale = db.prepare("SELECT * FROM sales WHERE id = ?").get(payload.original_sale_id) as any;

      // 3. Checkout new items based on price difference
      let paymentMethod: 'cash' | 'debt' = payload.payment_method === 'debt' && originalSale.customer_id ? 'debt' : 'cash';
      let cashReceivedTetri = 0;

      if (diffTetri > 0) {
        // New item is more expensive: customer pays difference
        cashReceivedTetri = paymentMethod === 'cash' ? diffTetri : 0;
      } else {
        // Even exchange or customer gets cash back
        paymentMethod = 'cash';
        cashReceivedTetri = 0;
      }

      // Perform checkout with special sale_type = 'exchange'
      const newSale = this.posService.checkout(user, {
        items: payload.new_items,
        payment_method: paymentMethod,
        customer_id: originalSale.customer_id,
        cash_received_tetri: cashReceivedTetri,
        notes: `გაცვლა გაყიდვიდან #${originalSale.receipt_number}. სხვაობა: ${(diffTetri / 100).toFixed(2)} ₾`,
        idempotency_key: payload.idempotency_key ? `sale_${payload.idempotency_key}` : undefined,
        sale_type: 'exchange',
        related_return_id: returnResult.return_id,
        exchange_diff_tetri: diffTetri,
        exchange_credit_tetri: returnResult.total_refund_tetri
      } as any);

      // Link new sale to return record
      db.prepare("UPDATE returns SET related_sale_id = ? WHERE id = ?").run(newSale.id, returnResult.return_id);

      // Record audit
      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'EXCHANGE', 'sales', ?, ?, ?)
      `).run(
        user.id,
        String(newSale.id),
        `Exchange completed for sale ${originalSale.receipt_number}. Returned value: ${returnResult.total_refund_tetri}, New sale value: ${newTotalTetri}, Difference: ${diffTetri}`,
        now
      );

      const returnRecord = this.getReturnById(returnResult.return_id);

      return {
        return_id: returnResult.return_id,
        new_sale_id: newSale.id,
        difference_tetri: diffTetri,
        cash_action: diffTetri > 0 ? 'customer_pays' : diffTetri < 0 ? 'store_refunds' : 'even',
        new_sale: newSale,
        return_record: returnRecord
      } as any;
    }, this.db);
  }

  /**
   * Retrieves a single return by ID.
   */
  getReturnById(returnId: number): ReturnRecord | null {
    const returns = this.listReturns({ limit: 1 });
    const row = this.db.prepare(`
      SELECT r.*, s.receipt_number, u.name as user_name,
             c.id as customer_id,
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name
      FROM returns r
      JOIN sales s ON r.sale_id = s.id
      JOIN users u ON r.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE r.id = ?
    `).get(returnId) as any;

    if (!row) return null;
    row.items = this.db.prepare(`
      SELECT ri.*, si.product_name_snap as product_name, si.variant_name_snap as variant_name, si.code_snap as code
      FROM return_items ri
      JOIN sale_items si ON ri.sale_item_id = si.id
      WHERE ri.return_id = ?
    `).all(row.id);
    return row;
  }

  /**
   * Lists all returns with customer, cashier, and returned items info.
   */
  listReturns(params?: {
    saleId?: number;
    returnType?: 'refund' | 'exchange';
    limit?: number;
  }): ReturnRecord[] {
    let sql = `
      SELECT r.*, s.receipt_number, u.name as user_name,
             c.id as customer_id,
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name
      FROM returns r
      JOIN sales s ON r.sale_id = s.id
      JOIN users u ON r.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE 1=1
    `;
    const args: any[] = [];

    if (params?.saleId) {
      sql += " AND r.sale_id = ?";
      args.push(params.saleId);
    }
    if (params?.returnType) {
      sql += " AND r.return_type = ?";
      args.push(params.returnType);
    }

    sql += " ORDER BY r.id DESC LIMIT ?";
    args.push(params?.limit || 100);

    const rows = this.db.prepare(sql).all(...args) as any[];
    for (const row of rows) {
      row.items = this.db.prepare(`
        SELECT ri.*, si.product_name_snap as product_name, si.variant_name_snap as variant_name, si.code_snap as code
        FROM return_items ri
        JOIN sale_items si ON ri.sale_item_id = si.id
        WHERE ri.return_id = ?
      `).all(row.id);
    }
    return rows;
  }
}
