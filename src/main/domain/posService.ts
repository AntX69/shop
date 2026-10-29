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
        return this.getSaleById(existingSale.id)!;
      }
    }

    // Validate quantities
    for (const item of payload.items) {
      if (!item.quantity || item.quantity <= 0) {
        throw new Error('რაოდენობა უნდა იყოს მინიმუმ 1');
      }
    }

    // Calculate total price in tetri
    const totalTetri = payload.items.reduce((sum, item) => sum + (item.quantity * item.unit_price_tetri), 0);
    if (totalTetri <= 0) {
      throw new Error('გაყიდვის ჯამური თანხა უნდა აღემატებოდეს 0-ს');
    }

    // Validate payment method and customer requirements
    let cashReceivedTetri = 0;
    let changeGivenTetri = 0;
    let debtAmountTetri = 0;

    if (payload.payment_method === 'cash') {
      cashReceivedTetri = payload.cash_received_tetri;
      if (cashReceivedTetri < totalTetri) {
        throw new Error(`მიღებული ნაღდი თანხა (${(cashReceivedTetri / 100).toFixed(2)} ₾) ნაკლებია ჯამურ თანხაზე (${(totalTetri / 100).toFixed(2)} ₾)`);
      }
      changeGivenTetri = cashReceivedTetri - totalTetri;
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
      cashReceivedTetri = payload.cash_received_tetri;
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

      // 4. Insert Sale record
      const saleRes = db.prepare(`
        INSERT INTO sales (
          receipt_number, user_id, customer_id, payment_method,
          total_tetri, cash_received_tetri, change_given_tetri,
          debt_amount_tetri, status, notes, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(
        receiptNumber,
        user.id,
        payload.customer_id || null,
        payload.payment_method,
        totalTetri,
        cashReceivedTetri,
        changeGivenTetri,
        debtAmountTetri,
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
        `Sale ${receiptNumber} completed: total ${totalTetri} tetri, method: ${payload.payment_method}`,
        now
      );

      return this.getSaleById(saleId)!;
    }, this.db);
  }

  /**
   * Retrieves sale with all items and customer info.
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

    return {
      ...sale,
      items
    };
  }

  /**
   * Search sales for history or returns.
   */
  searchSales(params?: {
    searchTerm?: string; // Receipt number or customer name or product code
    startDate?: string;
    endDate?: string;
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

    sql += " ORDER BY s.id DESC LIMIT ?";
    args.push(params?.limit || 50);

    const sales = this.db.prepare(sql).all(...args) as any[];
    for (const s of sales) {
      s.items = this.db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(s.id);
    }
    return sales;
  }
}
