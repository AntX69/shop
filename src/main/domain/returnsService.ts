/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Returns & Exchanges Domain Service.
 *
 * Accounting rules:
 * - A return is never a sale and only happens against a specific historical sale.
 * - The refund value is the net amount the customer paid for the returned units
 *   (discounts included), split so that successive partial returns add up exactly.
 * - The value first reduces debt still open on that sale; only the rest is paid in cash.
 * - The exact FIFO cost layers consumed by the sale are reversed: resellable units go back
 *   into their original lot with their original cost; damaged units leave stock and their
 *   cost is reported as a damage write-off. Unknown costs stay unknown.
 * - In an exchange the returned value is credit for the new goods, not cash. Only the part
 *   above the new goods' value reduces debt still open on the original sale, and only what is
 *   left after that is paid back in cash. An even exchange of goods bought on debt therefore
 *   leaves the debt unchanged; a more expensive new item is paid for explicitly.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { ExchangePayload, ReturnPayload, ReturnRecord, User } from '../../shared/types.ts';
import { proratedLineAmount } from '../../shared/money.ts';
import { boundToUtc } from '../../shared/time.ts';
import { PosService } from './posService.ts';
import {
  oneOf, optionalAmount, optionalIdempotencyKey, optionalString,
  requireArray, requireId, requireObject, requireQuantity,
} from './validation.ts';

export interface ReturnResult {
  return_id: number;
  id?: number;
  total_refund_tetri: number;
  debt_deduction_tetri: number;
  refund_debt_reduction_tetri?: number;
  cash_refund_tetri: number;
  refund_cash_tetri?: number;
  exchange_credit_tetri: number;
}

type Condition = 'resellable' | 'damaged';

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
  processReturn(user: User, payload: ReturnPayload): ReturnResult {
    return this.createReturn(user, payload, 'refund');
  }

  private toResult(row: any): ReturnResult {
    return {
      return_id: row.id,
      id: row.id,
      total_refund_tetri: row.total_refund_tetri,
      debt_deduction_tetri: row.debt_deduction_tetri,
      refund_debt_reduction_tetri: row.debt_deduction_tetri,
      cash_refund_tetri: row.cash_refund_tetri,
      refund_cash_tetri: row.cash_refund_tetri,
      exchange_credit_tetri: row.exchange_credit_tetri || 0,
    };
  }

  private createReturn(user: User, rawPayload: ReturnPayload, mode: 'refund' | 'exchange', exchangeNewValueTetri: number = 0): ReturnResult {
    const payload = requireObject<ReturnPayload>(rawPayload, 'დაბრუნება');
    const saleId = requireId(payload.sale_id, 'გაყიდვა');
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error('დასაბრუნებელი პროდუქტები არ არის არჩეული');
    }
    const rawItems = requireArray<any>(payload.items, 'დასაბრუნებელი პროდუქტები', 200);
    const reason = optionalString(payload.reason, 500, 'დაბრუნების მიზეზი');
    const idempotencyKey = optionalIdempotencyKey(payload.idempotency_key);

    return runInTransaction((db) => {
      if (idempotencyKey) {
        const existingReturn = db.prepare("SELECT * FROM returns WHERE idempotency_key = ?").get(idempotencyKey) as any;
        if (existingReturn) {
          if (existingReturn.sale_id !== saleId) {
            throw new Error('Idempotency key mismatch: ამ გასაღებით უკვე დაფიქსირებულია განსხვავებული დაბრუნება');
          }
          return this.toResult(existingReturn);
        }
      }

      const now = new Date().toISOString();
      const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(saleId) as any;
      if (!sale) {
        throw new Error('ორიგინალი გაყიდვა ვერ მოიძებნა');
      }
      if (sale.status === 'returned') {
        throw new Error('შეცდომა: ამ გაყიდვაზე ყველა ნივთი უკვე დაბრუნებულია (აღემატება დარჩენილ დაბრუნებად რაოდენობას)');
      }

      // 1. Resolve requested lines. The same line listed several times is summed and
      //    checked against what is still returnable, so it can never be refunded twice.
      const requests: Array<{ saleItem: any; quantity: number; condition: Condition }> = [];
      const requestedBySaleItem = new Map<number, number>();
      for (const raw of rawItems) {
        const item = requireObject<any>(raw, 'დასაბრუნებელი პოზიცია');
        const quantity = requireQuantity(item.quantity, 'დასაბრუნებელი რაოდენობა');
        const condition: Condition = item.condition == null
          ? 'resellable'
          : oneOf(item.condition, ['resellable', 'damaged'] as const, 'ნივთის მდგომარეობა');

        let saleItem: any = null;
        if (item.sale_item_id != null) {
          saleItem = db.prepare("SELECT * FROM sale_items WHERE id = ? AND sale_id = ?")
            .get(requireId(item.sale_item_id, 'გაყიდული პოზიცია'), sale.id);
        } else if (item.variant_id != null) {
          saleItem = db.prepare(`
            SELECT * FROM sale_items WHERE variant_id = ? AND sale_id = ? AND quantity > returned_quantity ORDER BY id ASC LIMIT 1
          `).get(requireId(item.variant_id, 'პროდუქტის ვარიანტი'), sale.id);
        }
        if (!saleItem) {
          throw new Error(`გაყიდული პოზიცია არ ეკუთვნის ამ გაყიდვას`);
        }

        const requested = (requestedBySaleItem.get(saleItem.id) || 0) + quantity;
        const maxReturnable = saleItem.quantity - saleItem.returned_quantity;
        if (requested > maxReturnable) {
          throw new Error(
            `შეცდომა: "${saleItem.product_name_snap}"-სთვის დაბრუნების რაოდენობა (${requested}) ` +
            `აღემატება დარჩენილ დაბრუნებად რაოდენობას (${maxReturnable})`
          );
        }
        requestedBySaleItem.set(saleItem.id, requested);
        requests.push({ saleItem, quantity, condition });
      }

      // 2. Refund value of each line: net paid amount, prorated without fractional tetri.
      const processedBySaleItem = new Map<number, number>();
      const lines = requests.map((req) => {
        const done = processedBySaleItem.get(req.saleItem.id) || 0;
        const refund = proratedLineAmount(
          req.saleItem.total_price_tetri,
          req.saleItem.quantity,
          req.saleItem.returned_quantity + done,
          req.quantity
        );
        processedBySaleItem.set(req.saleItem.id, done + req.quantity);
        return { ...req, refund };
      });
      const totalRefundTetri = lines.reduce((s, l) => s + l.refund, 0);

      // 3. Refund: debt on this sale is reduced first, the rest is cash.
      //    Exchange: the value pays for the new goods first; only the excess reduces debt, then cash.
      const balance = db.prepare("SELECT remaining_tetri FROM sale_debt_balances WHERE sale_id = ?").get(sale.id) as any;
      const remainingSaleDebt = balance ? balance.remaining_tetri : 0;
      const exchangeCreditTetri = mode === 'exchange' ? Math.min(totalRefundTetri, exchangeNewValueTetri) : 0;
      const excess = totalRefundTetri - exchangeCreditTetri;
      const debtDeductionTetri = Math.min(excess, remainingSaleDebt);
      const cashRefundTetri = excess - debtDeductionTetri;

      const primaryCondition: Condition = lines.every((l) => l.condition === 'damaged') ? 'damaged' : 'resellable';
      const returnRes = db.prepare(`
        INSERT INTO returns (
          sale_id, user_id, return_type, total_refund_tetri,
          debt_deduction_tetri, cash_refund_tetri, exchange_credit_tetri,
          condition, reason, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sale.id,
        user.id,
        mode,
        totalRefundTetri,
        debtDeductionTetri,
        cashRefundTetri,
        exchangeCreditTetri,
        primaryCondition,
        reason || (mode === 'exchange' ? 'გაცვლა' : null),
        idempotencyKey,
        now
      );
      const returnId = Number(returnRes.lastInsertRowid);

      // 4. Stock and FIFO cost layers.
      let cogsReversedTetri = 0;
      for (const line of lines) {
        const plan = this.planLayerReversal(db, line.saleItem.id, line.quantity);
        const knownCost = plan.reduce((s, p) => s + (p.unit_cost_tetri ?? 0) * p.quantity, 0);
        const unknownQty = plan.filter((p) => p.unit_cost_tetri === null).reduce((s, p) => s + p.quantity, 0);
        cogsReversedTetri += knownCost;
        const avgCost = unknownQty === 0 ? Math.round(knownCost / line.quantity) : null;

        db.prepare(`
          INSERT INTO return_items (
            return_id, sale_item_id, variant_id, quantity, unit_price_tetri, total_tetri,
            condition, cost_total_tetri, unknown_cost_quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          returnId,
          line.saleItem.id,
          line.saleItem.variant_id,
          line.quantity,
          Math.round(line.refund / line.quantity),
          line.refund,
          line.condition,
          knownCost,
          unknownQty
        );

        db.prepare("UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?").run(line.quantity, line.saleItem.id);

        let movementId: number | null = null;
        if (line.condition === 'resellable') {
          db.prepare("UPDATE product_variants SET stock_quantity = stock_quantity + ? WHERE id = ?").run(line.quantity, line.saleItem.variant_id);
          const stock = (db.prepare("SELECT stock_quantity FROM product_variants WHERE id = ?").get(line.saleItem.variant_id) as any).stock_quantity;
          movementId = Number(db.prepare(`
            INSERT INTO inventory_movements (
              variant_id, movement_type, quantity_change, resulting_stock,
              unit_cost_tetri, reason, reference_id, user_id, created_at
            ) VALUES (?, 'return', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            line.saleItem.variant_id, line.quantity, stock, avgCost,
            mode === 'exchange' ? 'გაცვლა: დაბრუნება (ვარგისი)' : 'დაბრუნება (ვარგისი)',
            sale.receipt_number, user.id, now
          ).lastInsertRowid);
        } else {
          // Damaged: does not enter sellable stock; its cost is a damage write-off.
          const stock = (db.prepare("SELECT stock_quantity FROM product_variants WHERE id = ?").get(line.saleItem.variant_id) as any)?.stock_quantity ?? 0;
          db.prepare(`
            INSERT INTO inventory_movements (
              variant_id, movement_type, quantity_change, resulting_stock,
              unit_cost_tetri, reason, reference_id, user_id, created_at
            ) VALUES (?, 'return', 0, ?, ?, ?, ?, ?, ?)
          `).run(
            line.saleItem.variant_id, stock, avgCost,
            `დაბრუნება (დაზიანებული/ჩამოწერილი, ${line.quantity} ც.)`,
            sale.receipt_number, user.id, now
          );
        }

        this.applyLayerReversal(db, plan, line.saleItem.variant_id, line.condition, movementId, now);
      }

      // 5. Sale status.
      const checkItems = db.prepare(`
        SELECT SUM(quantity) as total_qty, SUM(returned_quantity) as total_ret
        FROM sale_items WHERE sale_id = ?
      `).get(sale.id) as { total_qty: number; total_ret: number };
      const newSaleStatus = checkItems.total_ret >= checkItems.total_qty ? 'returned' : 'partially_returned';
      db.prepare("UPDATE sales SET status = ? WHERE id = ?").run(newSaleStatus, sale.id);

      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, ?, 'returns', ?, ?, ?)
      `).run(
        user.id,
        mode === 'exchange' ? 'EXCHANGE_RETURN' : 'SALE_RETURN',
        String(returnId),
        `Return processed for sale ${sale.receipt_number}: total ${totalRefundTetri} tetri ` +
        `(exchange credit: ${exchangeCreditTetri}, debt reduced: ${debtDeductionTetri}, cash refunded: ${cashRefundTetri}, ` +
        `cost reversed: ${cogsReversedTetri})`,
        now
      );

      return {
        return_id: returnId,
        id: returnId,
        total_refund_tetri: totalRefundTetri,
        debt_deduction_tetri: debtDeductionTetri,
        refund_debt_reduction_tetri: debtDeductionTetri,
        cash_refund_tetri: cashRefundTetri,
        refund_cash_tetri: cashRefundTetri,
        exchange_credit_tetri: exchangeCreditTetri,
      };
    }, this.db);
  }

  /** Which consumed cost layers the returned units come from (most recently consumed first). */
  private planLayerReversal(db: DatabaseSync, saleItemId: number, quantity: number) {
    const layers = db.prepare(`
      SELECT id, lot_id, quantity, returned_quantity, unit_cost_tetri
      FROM sale_item_lots
      WHERE sale_item_id = ? AND quantity > returned_quantity
      ORDER BY id DESC
    `).all(saleItemId) as Array<{ id: number; lot_id: number | null; quantity: number; returned_quantity: number; unit_cost_tetri: number | null }>;

    const plan: Array<{ layer_id: number | null; lot_id: number | null; quantity: number; unit_cost_tetri: number | null }> = [];
    let left = quantity;
    for (const layer of layers) {
      if (left <= 0) break;
      const take = Math.min(left, layer.quantity - layer.returned_quantity);
      plan.push({ layer_id: layer.id, lot_id: layer.lot_id, quantity: take, unit_cost_tetri: layer.unit_cost_tetri });
      left -= take;
    }
    if (left > 0) {
      // No recorded layer (inconsistent legacy data): the cost of these units is unknown.
      plan.push({ layer_id: null, lot_id: null, quantity: left, unit_cost_tetri: null });
    }
    return plan;
  }

  private applyLayerReversal(
    db: DatabaseSync,
    plan: ReturnType<ReturnsService['planLayerReversal']>,
    variantId: number,
    condition: Condition,
    movementId: number | null,
    now: string
  ): void {
    for (const step of plan) {
      if (step.layer_id !== null) {
        db.prepare("UPDATE sale_item_lots SET returned_quantity = returned_quantity + ? WHERE id = ?").run(step.quantity, step.layer_id);
      }
      if (condition !== 'resellable') continue;
      if (step.lot_id !== null) {
        // Back into the original cost layer: same cost, same FIFO position.
        db.prepare("UPDATE inventory_lots SET remaining_quantity = remaining_quantity + ? WHERE id = ?").run(step.quantity, step.lot_id);
      } else {
        db.prepare(`
          INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(variantId, step.quantity, step.quantity, step.unit_cost_tetri, movementId, now);
      }
    }
  }

  /**
   * Performs an atomic exchange: returns old item(s) and sells new item(s).
   * The returned value first reduces debt still open on the original sale, then pays for
   * the new goods as credit; an excess is paid back in cash, a shortfall is paid by the
   * customer in cash, on debt or mixed.
   */
  processExchange(user: User, rawPayload: ExchangePayload): {
    return_id: number;
    new_sale_id: number;
    difference_tetri: number;
    returned_value_tetri: number;
    new_items_value_tetri: number;
    debt_deduction_tetri: number;
    credit_applied_tetri: number;
    cash_refund_tetri: number;
    amount_due_tetri: number;
    cash_action: 'customer_pays' | 'store_refunds' | 'even';
    new_sale?: any;
    return_record?: any;
  } {
    const payload = requireObject<ExchangePayload>(rawPayload, 'გაცვლა');
    const originalSaleId = requireId(payload.original_sale_id, 'ორიგინალი გაყიდვა');
    requireArray(payload.return_items, 'დასაბრუნებელი პროდუქტები', 200);
    const newItemsRaw = requireArray<any>(payload.new_items, 'ახალი პროდუქტები', 200);
    const paymentMethod = payload.payment_method == null
      ? 'cash'
      : oneOf(payload.payment_method, ['cash', 'debt', 'mixed'] as const, 'გადახდის მეთოდი');
    const cashInput = optionalAmount(payload.cash_received_tetri, 'მიღებული ნაღდი თანხა');
    const idempotencyKey = optionalIdempotencyKey(payload.idempotency_key);
    const notes = optionalString(payload.notes, 500, 'შენიშვნა');

    return runInTransaction((db) => {
      const now = new Date().toISOString();

      if (idempotencyKey) {
        const existing = db.prepare("SELECT * FROM returns WHERE idempotency_key = ?").get(`ret_${idempotencyKey}`) as any;
        if (existing) {
          if (existing.sale_id !== originalSaleId || !existing.related_sale_id) {
            throw new Error('Idempotency key mismatch: ამ გასაღებით უკვე დაფიქსირებულია განსხვავებული გაცვლა');
          }
          return this.describeExchange(existing.id);
        }
      }

      const originalSale = db.prepare("SELECT * FROM sales WHERE id = ?").get(originalSaleId) as any;
      if (!originalSale) {
        throw new Error('ორიგინალი გაყიდვა ვერ მოიძებნა');
      }

      // New goods at list price (no discounts inside an exchange).
      const newItems = newItemsRaw.map((it) => ({ variant_id: it?.variant_id, quantity: it?.quantity }));
      const newValue = this.posService.priceCart(user, newItems, undefined, db).total_tetri;

      // 1. Return part: its value pays for the new goods first; the excess reduces the
      //    original sale's debt and only then is paid back in cash.
      const ret = this.createReturn(user, {
        sale_id: originalSaleId,
        items: payload.return_items,
        reason: notes || 'გაცვლა (Exchange)',
        idempotency_key: idempotencyKey ? `ret_${idempotencyKey}` : undefined
      }, 'exchange', newValue);

      const creditApplied = ret.exchange_credit_tetri;
      const cashBack = ret.cash_refund_tetri;
      const due = newValue - creditApplied;

      // 2. A more expensive new item is paid explicitly; cash is never assumed.
      const method: 'cash' | 'debt' | 'mixed' = due === 0 ? 'cash' : paymentMethod;
      if ((method === 'debt' || method === 'mixed') && !originalSale.customer_id) {
        throw new Error('ნისიით ან შერეული გადახდისთვის ორიგინალ გაყიდვაზე კლიენტი უნდა იყოს მითითებული');
      }
      if (due > 0 && method !== 'debt' && cashInput === null) {
        throw new Error(`მიუთითეთ კლიენტისგან მიღებული ნაღდი თანხა (გადასახდელია ${(due / 100).toFixed(2)} ₾)`);
      }
      const cashReceived = due === 0 || method === 'debt' ? 0 : (cashInput ?? 0);

      const newSale = this.posService.checkout(user, {
        items: newItems as any,
        payment_method: method,
        customer_id: originalSale.customer_id,
        cash_received_tetri: cashReceived,
        notes: `გაცვლა გაყიდვიდან #${originalSale.receipt_number}`,
        idempotency_key: idempotencyKey ? `sale_${idempotencyKey}` : undefined,
      }, {
        relatedReturnId: ret.return_id,
        exchangeCreditTetri: creditApplied,
        exchangeDiffTetri: newValue - ret.total_refund_tetri,
      });

      db.prepare("UPDATE returns SET related_sale_id = ? WHERE id = ?").run(newSale.id, ret.return_id);

      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'EXCHANGE', 'sales', ?, ?, ?)
      `).run(
        user.id,
        String(newSale.id),
        `Exchange for sale ${originalSale.receipt_number}: returned ${ret.total_refund_tetri} (debt reduced ${ret.debt_deduction_tetri}), ` +
        `new goods ${newValue}, credit applied ${creditApplied}, cash back ${cashBack}, customer pays ${due} (${method})`,
        now
      );

      return this.describeExchange(ret.return_id);
    }, this.db);
  }

  private describeExchange(returnId: number) {
    const ret = this.db.prepare("SELECT * FROM returns WHERE id = ?").get(returnId) as any;
    const sale = this.posService.getSaleById(ret.related_sale_id)!;
    const due = sale.total_tetri - (sale as any).exchange_credit_tetri;
    const difference = sale.total_tetri - ret.total_refund_tetri;
    return {
      return_id: ret.id,
      new_sale_id: sale.id,
      difference_tetri: difference,
      returned_value_tetri: ret.total_refund_tetri,
      new_items_value_tetri: sale.total_tetri,
      debt_deduction_tetri: ret.debt_deduction_tetri,
      credit_applied_tetri: ret.exchange_credit_tetri,
      cash_refund_tetri: ret.cash_refund_tetri,
      amount_due_tetri: due,
      cash_action: (due > 0 ? 'customer_pays' : ret.cash_refund_tetri > 0 ? 'store_refunds' : 'even') as 'customer_pays' | 'store_refunds' | 'even',
      new_sale: sale,
      return_record: this.getReturnById(ret.id)
    };
  }

  /**
   * Retrieves a single return by ID.
   */
  getReturnById(returnId: number): ReturnRecord | null {
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
   * Lists returns with customer, cashier, and returned items info.
   * Date bounds may be local days (YYYY-MM-DD, Tbilisi) or ISO instants.
   */
  listReturns(params?: {
    saleId?: number;
    returnType?: 'refund' | 'exchange';
    searchTerm?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
    offset?: number;
  }): ReturnRecord[] {
    let sql = `
      SELECT r.*, s.receipt_number, u.name as user_name,
             c.id as customer_id,
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name,
             ns.receipt_number as related_receipt_number
      FROM returns r
      JOIN sales s ON r.sale_id = s.id
      JOIN users u ON r.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN sales ns ON ns.id = r.related_sale_id
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
    if (params?.searchTerm && params.searchTerm.trim()) {
      const term = `%${params.searchTerm.trim()}%`;
      sql += ` AND (
        s.receipt_number LIKE ? OR
        ns.receipt_number LIKE ? OR
        c.first_name LIKE ? OR
        c.last_name LIKE ? OR
        c.phone LIKE ? OR
        r.reason LIKE ? OR
        r.id IN (
          SELECT ri.return_id FROM return_items ri
          JOIN sale_items si ON si.id = ri.sale_item_id
          WHERE si.code_snap LIKE ? OR si.product_name_snap LIKE ?
        )
      )`;
      args.push(term, term, term, term, term, term, term, term);
    }
    if (params?.startDate) {
      sql += " AND r.created_at >= ?";
      args.push(boundToUtc(params.startDate, 'start'));
    }
    if (params?.endDate) {
      sql += " AND r.created_at < ?";
      args.push(boundToUtc(params.endDate, 'end'));
    }

    const limit = Math.min(Math.max(1, Math.floor(Number(params?.limit) || 100)), 500);
    const offset = Math.max(0, Math.floor(Number(params?.offset) || 0));
    sql += " ORDER BY r.id DESC LIMIT ? OFFSET ?";
    args.push(limit, offset);

    const rows = this.db.prepare(sql).all(...args) as any[];
    const itemsStmt = this.db.prepare(`
      SELECT ri.*, si.product_name_snap as product_name, si.variant_name_snap as variant_name, si.code_snap as code
      FROM return_items ri
      JOIN sale_items si ON ri.sale_item_id = si.id
      WHERE ri.return_id = ?
    `);
    for (const row of rows) {
      row.items = itemsStmt.all(row.id);
    }
    return rows;
  }
}
