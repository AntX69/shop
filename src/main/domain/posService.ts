/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Point of Sale (POS) & Checkout Domain Service.
 * Implements strict atomic checkout transactions, stock deduction,
 * cash/debt/mixed payment validation, and FIFO lot depletion.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { CheckoutPayload, Sale, User } from '../../shared/types.ts';

export class PosService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  /**
   * Generates a unique sequential receipt number for today: RCP-YYYYMMDD-XXXX
   */
  generateReceiptNumber(): string {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const prefix = `RCP-${yyyy}${mm}${dd}-`;

    const last = this.db.prepare(
      "SELECT receipt_number FROM sales WHERE receipt_number LIKE ? ORDER BY id DESC LIMIT 1"
    ).get(`${prefix}%`) as { receipt_number: string } | undefined;

    let seq = 1;
    if (last) {
      const parts = last.receipt_number.split('-');
      const lastSeq = parseInt(parts[2], 10);
      if (!isNaN(lastSeq)) {
        seq = lastSeq + 1;
      }
    }

    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  /**
   * Performs an atomic checkout.
   * Validates stock, calculates change and debt, depletes FIFO lots, updates inventory.
   */
  checkout(user: User, payload: CheckoutPayload): Sale {
    if (!payload.items || payload.items.length === 0) {
      throw new Error('კალათა ცარიელია');
    }

    // Idempotency check: prevent duplicate checkouts on network stutter or accidental double-click
    if (payload.idempotency_key) {
      const existingSale = this.db.prepare(
        "SELECT id FROM sales WHERE idempotency_key = ?"
      ).get(payload.idempotency_key) as { id: number } | undefined;
      if (existingSale) {
        const fullExisting = this.getSaleById(existingSale.id)!;
        if (
          fullExisting.payment_method !== payload.payment_method ||
          (fullExisting.customer_id || null) !== (payload.customer_id || null) ||
          (fullExisting.items?.length || 0) !== payload.items.length
        ) {
          throw new Error('იდემპოტენტურობის გასაღები უკვე გამოყენებულია სხვა ტრანზაქციისთვის');
        }
        return fullExisting;
      }
    }

    // Validate quantities
    for (const item of payload.items) {
      if (!item.quantity || item.quantity <= 0) {
        throw new Error('რაოდენობა უნდა იყოს მინიმუმ 1');
      }
    }

    // Authoritative Price Verification from SQLite database
    let hasDiscount = false;
    let totalDiscountTetri = 0;

    for (const item of payload.items) {
      const variantDb = this.db.prepare(`
        SELECT pv.id, pv.price_override_tetri, p.base_price_tetri, p.name as product_name, pv.variant_name
        FROM product_variants pv
        JOIN products p ON pv.product_id = p.id
        WHERE pv.id = ?
      `).get(item.variant_id) as any;

      if (!variantDb) {
        throw new Error(`ვარიანტი #${item.variant_id} ვერ მოიძებნა`);
      }

      const authoritativePriceTetri = variantDb.price_override_tetri ?? variantDb.base_price_tetri;

      if (item.unit_price_tetri !== authoritativePriceTetri) {
        // Price differs: verify permission
        if (user.role !== 'owner') {
          throw new Error(
            `გამყიდველს ფასის შეცვლის ან ფასდაკლების უფლება არ აქვს. ` +
            `"${variantDb.product_name}"-ის აქტუალური ფასია: ${(authoritativePriceTetri / 100).toFixed(2)} ₾ (გაგზავნილი: ${(item.unit_price_tetri / 100).toFixed(2)} ₾)`
          );
        }
        // Owner authorized discount or adjustment
        hasDiscount = true;
        totalDiscountTetri += (authoritativePriceTetri - item.unit_price_tetri) * item.quantity;
      }
    }

    // Calculate total price in tetri based on verified prices
    const totalTetri = payload.items.reduce((sum, item) => sum + (item.quantity * item.unit_price_tetri), 0);
    if (totalTetri <= 0) {
      throw new Error('გაყიდვის ჯამური თანხა უნდა აღემატებოდეს 0-ს');
    }

    // Idempotency check: prevent duplicate checkouts and reject mismatched payloads
    if (payload.idempotency_key) {
      const existingSale = this.db.prepare(
        "SELECT id, total_tetri, payment_method, customer_id FROM sales WHERE idempotency_key = ?"
      ).get(payload.idempotency_key) as any;

      if (existingSale) {
        const customerMatches = (existingSale.customer_id || null) === (payload.customer_id || null);
        const methodMatches = existingSale.payment_method === payload.payment_method;
        const totalMatches = existingSale.total_tetri === totalTetri;

        if (!customerMatches || !methodMatches || !totalMatches) {
          throw new Error('Idempotency key mismatch: ამ გასაღებით უკვე დაფიქსირებულია განსხვავებული გაყიდვა');
        }
        return this.getSaleById(existingSale.id)!;
      }
    }

    // Validate payment method and customer requirements
    let cashReceivedTetri = 0;
    let changeGivenTetri = 0;
    let debtAmountTetri = 0;

    const exchangeCreditTetri = (payload as any).exchange_credit_tetri || 0;
    const effectiveCashNeeded = Math.max(0, totalTetri - exchangeCreditTetri);

    if (payload.payment_method === 'cash') {
      cashReceivedTetri = payload.cash_received_tetri || 0;
      if (cashReceivedTetri < effectiveCashNeeded) {
        throw new Error(`მიღებული ნაღდი თანხა (${(cashReceivedTetri / 100).toFixed(2)} ₾) ნაკლებია ჯამურ თანხაზე (${(effectiveCashNeeded / 100).toFixed(2)} ₾)`);
      }
      changeGivenTetri = cashReceivedTetri - effectiveCashNeeded;
      debtAmountTetri = 0;
    } else if (payload.payment_method === 'debt') {
      if (!payload.customer_id) {
        throw new Error('ნისიით გაყიდვისთვის კლიენტის არჩევა ან რეგისტრაცია აუცილებელია');
      }
      cashReceivedTetri = 0;
      changeGivenTetri = 0;
      debtAmountTetri = totalTetri;
    } else if (payload.payment_method === 'mixed') {
      if (!payload.customer_id) {
        throw new Error('შერეული გადახდისთვის (ნაღდი + ნისია) კლიენტის არჩევა ან რეგისტრაცია აუცილებელია');
      }
      cashReceivedTetri = payload.cash_received_tetri || 0;
      if (cashReceivedTetri <= 0 || cashReceivedTetri >= totalTetri) {
        throw new Error(`შერეული გადახდისას მიღებული ნაღდი თანხა უნდა იყოს 0-ზე მეტი და მთლიან თანხაზე (${(totalTetri / 100).toFixed(2)} ₾) ნაკლები`);
      }
      changeGivenTetri = 0;
      debtAmountTetri = totalTetri - cashReceivedTetri;
    } else {
      throw new Error('გადახდის მეთოდი არასწორია');
    }

    return runInTransaction((db) => {
      const now = new Date().toISOString();

      // 1. Verify customer exists if provided
      if (payload.customer_id) {
        const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(payload.customer_id);
        if (!customer) {
          throw new Error('მითითებული კლიენტი ვერ მოიძებნა');
        }
      }

      // 2. Validate stock for all items
      for (const item of payload.items) {
        const variant = db.prepare(`
          SELECT pv.id, pv.stock_quantity, pv.variant_name, p.name as product_name
          FROM product_variants pv
          JOIN products p ON pv.product_id = p.id
          WHERE pv.id = ?
        `).get(item.variant_id) as any;

        if (!variant) {
          throw new Error(`ვარიანტი #${item.variant_id} ვერ მოიძებნა`);
        }

        if (variant.stock_quantity < item.quantity) {
          throw new Error(
            `არასაკმარისი მარაგი: "${variant.product_name}" (${variant.variant_name}). ` +
            `ხელმისაწვდომია: ${variant.stock_quantity}, მოთხოვნილია: ${item.quantity}`
          );
        }
      }

      // 3. Generate receipt number
      const receiptNumber = this.generateReceiptNumber();

      const saleType = (payload as any).sale_type || 'standard';
      const relatedReturnId = (payload as any).related_return_id || null;
      const exchangeDiffTetri = (payload as any).exchange_diff_tetri || 0;
      const discountAuthorizedBy = hasDiscount ? user.id : null;
      const discountReason = hasDiscount ? ((payload as any).discount_reason || payload.notes || 'მფლობელის ფასდაკლება') : null;

      // 4. Insert Sale record
      const saleRes = db.prepare(`
        INSERT INTO sales (
          receipt_number, user_id, customer_id, payment_method,
          total_tetri, cash_received_tetri, change_given_tetri,
          debt_amount_tetri, status, sale_type, related_return_id,
          exchange_diff_tetri, discount_authorized_by, discount_reason,
          notes, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptNumber,
        user.id,
        payload.customer_id || null,
        payload.payment_method,
        totalTetri,
        cashReceivedTetri,
        changeGivenTetri,
        debtAmountTetri,
        saleType,
        relatedReturnId,
        exchangeDiffTetri,
        discountAuthorizedBy,
        discountReason,
        payload.notes?.trim() || null,
        payload.idempotency_key || null,
        now
      );
      const saleId = Number(saleRes.lastInsertRowid);

      // 5. Process each sale item, snapshot prices, decrement stock, FIFO cost lots
      for (const item of payload.items) {
        const variantInfo = db.prepare(`
          SELECT pv.id, pv.variant_name, pv.stock_quantity, p.name as product_name, p.base_cost_tetri, pv.cost_override_tetri
          FROM product_variants pv
          JOIN products p ON pv.product_id = p.id
          WHERE pv.id = ?
        `).get(item.variant_id) as any;

        // Find primary code for snapshot
        const codeRow = db.prepare(
          "SELECT code_value FROM product_codes WHERE variant_id = ? ORDER BY id ASC LIMIT 1"
        ).get(item.variant_id) as { code_value: string } | undefined;

        // FIFO lot cost allocation
        let neededQty = item.quantity;
        let totalCostForLineTetri = 0;
        let knownCostUnits = 0;

        const lots = db.prepare(`
          SELECT id, remaining_quantity, unit_cost_tetri
          FROM inventory_lots
          WHERE variant_id = ? AND remaining_quantity > 0
          ORDER BY id ASC
        `).all(item.variant_id) as any[];

        for (const lot of lots) {
          if (neededQty <= 0) break;
          const take = Math.min(neededQty, lot.remaining_quantity);
          const newRem = lot.remaining_quantity - take;
          db.prepare("UPDATE inventory_lots SET remaining_quantity = ? WHERE id = ?").run(newRem, lot.id);

          if (lot.unit_cost_tetri !== null && lot.unit_cost_tetri !== undefined) {
            totalCostForLineTetri += (take * lot.unit_cost_tetri);
            knownCostUnits += take;
          }
          neededQty -= take;
        }

        // If FIFO lots didn't cover or were missing, check if variant has a known cost
        let finalUnitCostTetri: number | null = null;
        if (knownCostUnits === item.quantity) {
          finalUnitCostTetri = Math.round(totalCostForLineTetri / item.quantity);
        } else if (variantInfo.cost_override_tetri !== null) {
          finalUnitCostTetri = variantInfo.cost_override_tetri;
        } else if (variantInfo.base_cost_tetri !== null) {
          finalUnitCostTetri = variantInfo.base_cost_tetri;
        }

        const lineTotalTetri = item.quantity * item.unit_price_tetri;

        // Insert sale item
        db.prepare(`
          INSERT INTO sale_items (
            sale_id, variant_id, product_name_snap, variant_name_snap,
            code_snap, quantity, unit_price_tetri, unit_cost_tetri,
            total_price_tetri, returned_quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          saleId,
          item.variant_id,
          variantInfo.product_name,
          variantInfo.variant_name,
          codeRow?.code_value || null,
          item.quantity,
          item.unit_price_tetri,
          finalUnitCostTetri,
          lineTotalTetri
        );

        // Deduct variant stock
        const resultingStock = variantInfo.stock_quantity - item.quantity;
        db.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(resultingStock, item.variant_id);

        // Record inventory movement
        db.prepare(`
          INSERT INTO inventory_movements (
            variant_id, movement_type, quantity_change, resulting_stock,
            unit_cost_tetri, reason, reference_id, user_id, created_at
          ) VALUES (?, 'sale', ?, ?, ?, 'გაყიდვა', ?, ?, ?)
        `).run(
          item.variant_id,
          -item.quantity,
          resultingStock,
          finalUnitCostTetri,
          receiptNumber,
          user.id,
          now
        );
      }

      // 6. Audit log
      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'SALE_CHECKOUT', 'sales', ?, ?, ?)
      `).run(
        user.id,
        String(saleId),
        `Sale ${receiptNumber} (${saleType}) completed: total ${totalTetri} tetri, method: ${payload.payment_method}` +
        (hasDiscount ? `, owner discount: ${totalDiscountTetri} tetri` : ''),
        now
      );

      return this.getSaleById(saleId)!;
    }, this.db);
  }

  /**
   * Retrieves sale with all items, customer info, and linked return records.
   */
  getSaleById(saleId: number): Sale | null {
    const sale = this.db.prepare(`
      SELECT s.*, u.name as user_name, 
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.id = ?
    `).get(saleId) as any;

    if (!sale) return null;

    const items = this.db.prepare(`
      SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC
    `).all(saleId) as any[];

    // Calculate remaining debt on this specific sale
    if (sale.debt_amount_tetri > 0) {
      const repaid = this.db.prepare(`
        SELECT COALESCE(SUM(amount_tetri), 0) as total FROM debt_repayments WHERE sale_id = ?
      `).get(saleId) as { total: number };

      const returnedDebt = this.db.prepare(`
        SELECT COALESCE(SUM(debt_deduction_tetri), 0) as total FROM returns WHERE sale_id = ?
      `).get(saleId) as { total: number };

      sale.debt_remaining_tetri = Math.max(0, sale.debt_amount_tetri - repaid.total - returnedDebt.total);
    } else {
      sale.debt_remaining_tetri = 0;
    }

    // Retrieve linked returns for this sale
    const returns = this.db.prepare(`
      SELECT r.*, u.name as user_name
      FROM returns r
      JOIN users u ON r.user_id = u.id
      WHERE r.sale_id = ?
      ORDER BY r.id DESC
    `).all(saleId) as any[];

    for (const ret of returns) {
      ret.items = this.db.prepare(`
        SELECT ri.*, si.product_name_snap as product_name, si.variant_name_snap as variant_name, si.code_snap as code
        FROM return_items ri
        JOIN sale_items si ON ri.sale_item_id = si.id
        WHERE ri.return_id = ?
      `).all(ret.id);
    }

    return {
      ...sale,
      final_total_tetri: sale.total_tetri,
      items,
      returns
    };
  }

  /**
   * Search sales for history, returns, and filtering.
   */
  searchSales(params?: {
    searchTerm?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    saleType?: string;
    hasDebt?: boolean;
    limit?: number;
  }): Sale[] {
    let sql = `
      SELECT s.*, u.name as user_name,
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE 1=1
    `;
    const args: any[] = [];

    if (params?.searchTerm) {
      const term = `%${params.searchTerm.trim()}%`;
      sql += ` AND (
        s.receipt_number LIKE ? OR 
        c.first_name LIKE ? OR 
        c.last_name LIKE ? OR
        s.id IN (SELECT sale_id FROM sale_items WHERE code_snap LIKE ? OR product_name_snap LIKE ?)
      )`;
      args.push(term, term, term, term, term);
    }

    if (params?.startDate) {
      sql += " AND s.created_at >= ?";
      args.push(params.startDate);
    }
    if (params?.endDate) {
      sql += " AND s.created_at <= ?";
      args.push(params.endDate);
    }
    if (params?.status) {
      sql += " AND s.status = ?";
      args.push(params.status);
    }
    if (params?.saleType) {
      sql += " AND s.sale_type = ?";
      args.push(params.saleType);
    }
    if (params?.hasDebt) {
      sql += " AND s.debt_amount_tetri > 0";
    }

    sql += " ORDER BY s.id DESC LIMIT ?";
    args.push(params?.limit || 100);

    const sales = this.db.prepare(sql).all(...args) as any[];
    for (const s of sales) {
      s.items = this.db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(s.id);
      
      // Calculate remaining debt on each sale
      if (s.debt_amount_tetri > 0) {
        const repaid = this.db.prepare(`
          SELECT COALESCE(SUM(amount_tetri), 0) as total FROM debt_repayments WHERE sale_id = ?
        `).get(s.id) as { total: number };
        const returnedDebt = this.db.prepare(`
          SELECT COALESCE(SUM(debt_deduction_tetri), 0) as total FROM returns WHERE sale_id = ?
        `).get(s.id) as { total: number };
        s.debt_remaining_tetri = Math.max(0, s.debt_amount_tetri - repaid.total - returnedDebt.total);
      } else {
        s.debt_remaining_tetri = 0;
      }

      // Check return count
      const retCount = this.db.prepare("SELECT COUNT(*) as count FROM returns WHERE sale_id = ?").get(s.id) as { count: number };
      s.returns_count = retCount.count;
    }
    return sales;
  }
}
