/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Point of Sale (POS) & Checkout Domain Service.
 * Implements strict atomic checkout transactions, stock deduction,
 * cash/debt/mixed payment validation, and FIFO lot depletion.
 *
 * Prices are always taken from the database. Only the owner may discount (per line or for
 * the whole cart); the list price stays on the sale line and the net amount paid is stored
 * in total_price_tetri, which is what returns refund. Every unit sold is attributed to the
 * FIFO cost layer it came from (sale_item_lots), so returns can restore the exact cost.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { CheckoutPayload, Sale, User } from '../../shared/types.ts';
import { allocateProportionally, formatTetri } from '../../shared/money.ts';
import { boundToUtc, localDate } from '../../shared/time.ts';
import {
  oneOf, optionalId, optionalIdempotencyKey, optionalString,
  requireAmount, requireArray, requireId, requireObject, requireQuantity,
} from './validation.ts';

/** Server-side context for the sale half of an exchange. Never read from IPC payloads. */
export interface ExchangeSaleContext {
  relatedReturnId: number;
  /** Credit from the returned goods that pays part of this sale (not cash). */
  exchangeCreditTetri: number;
  /** New goods value minus returned goods value, for display. */
  exchangeDiffTetri: number;
}

export interface PricedLine {
  variant_id: number;
  quantity: number;
  product_name: string;
  variant_name: string;
  list_unit_price_tetri: number;
  subtotal_tetri: number;
  line_discount_tetri: number;
  cart_discount_share_tetri: number;
  net_tetri: number;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotal_tetri: number;
  discount_tetri: number;
  total_tetri: number;
}

export class PosService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  /**
   * Generates a unique sequential receipt number for the current Tbilisi day: RCP-YYYYMMDD-XXXX
   */
  generateReceiptNumber(): string {
    const prefix = `RCP-${localDate().replace(/-/g, '')}-`;

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
   * Prices a cart from authoritative database prices and validates discounts.
   * A unit price lower than the list price is accepted only from the owner and is
   * recorded as a line discount; sellers can never change prices or discount.
   */
  priceCart(user: User, rawItems: unknown, rawCartDiscount?: unknown, db: DatabaseSync = this.db): PricedCart {
    const items = requireArray<any>(rawItems, 'კალათა', 200);
    const isOwner = user.role === 'owner';
    const lines: PricedLine[] = [];

    for (const raw of items) {
      const item = requireObject<any>(raw, 'კალათის პოზიცია');
      const variantId = requireId(item.variant_id, 'პროდუქტის ვარიანტი');
      const quantity = requireQuantity(item.quantity);

      const v = db.prepare(`
        SELECT pv.id, pv.variant_name, pv.price_override_tetri, pv.is_active AS variant_active,
               p.name AS product_name, p.base_price_tetri, p.is_active AS product_active
        FROM product_variants pv
        JOIN products p ON pv.product_id = p.id
        WHERE pv.id = ?
      `).get(variantId) as any;

      if (!v) {
        throw new Error(`ვარიანტი #${variantId} ვერ მოიძებნა`);
      }
      if (!v.variant_active || !v.product_active) {
        throw new Error(`"${v.product_name}" (${v.variant_name}) დაარქივებულია და აღარ იყიდება`);
      }

      const listPrice: number = v.price_override_tetri ?? v.base_price_tetri;
      const subtotal = quantity * listPrice;
      let lineDiscount = item.line_discount_tetri == null ? 0 : requireAmount(item.line_discount_tetri, 'ფასდაკლება');

      if (item.unit_price_tetri != null) {
        const sent = requireAmount(item.unit_price_tetri, 'ერთეულის ფასი');
        if (sent !== listPrice) {
          if (!isOwner) {
            throw new Error(
              `გამყიდველს ფასის შეცვლის ან ფასდაკლების უფლება არ აქვს. ` +
              `"${v.product_name}"-ის აქტუალური ფასია: ${(listPrice / 100).toFixed(2)} ₾ (გაგზავნილი: ${(sent / 100).toFixed(2)} ₾)`
            );
          }
          if (sent > listPrice) {
            throw new Error(
              `"${v.product_name}": გასაყიდი ფასი არ შეიძლება აღემატებოდეს პროდუქტის ფასს (${(listPrice / 100).toFixed(2)} ₾). ` +
              `ფასის შესაცვლელად შეცვალეთ პროდუქტის ბარათი.`
            );
          }
          lineDiscount += (listPrice - sent) * quantity;
        }
      }

      if (lineDiscount > 0 && !isOwner) {
        throw new Error('ფასდაკლების გაკეთება შეუძლია მხოლოდ მფლობელს');
      }
      if (lineDiscount > subtotal) {
        throw new Error(`"${v.product_name}": ფასდაკლება აღემატება პოზიციის ღირებულებას`);
      }

      lines.push({
        variant_id: variantId,
        quantity,
        product_name: v.product_name,
        variant_name: v.variant_name,
        list_unit_price_tetri: listPrice,
        subtotal_tetri: subtotal,
        line_discount_tetri: lineDiscount,
        cart_discount_share_tetri: 0,
        net_tetri: subtotal - lineDiscount,
      });
    }

    const cartDiscount = rawCartDiscount == null ? 0 : requireAmount(rawCartDiscount, 'კალათის ფასდაკლება');
    if (cartDiscount > 0) {
      if (!isOwner) {
        throw new Error('ფასდაკლების გაკეთება შეუძლია მხოლოდ მფლობელს');
      }
      const base = lines.reduce((s, l) => s + l.net_tetri, 0);
      if (cartDiscount > base) {
        throw new Error('კალათის ფასდაკლება აღემატება ჯამურ თანხას');
      }
      allocateProportionally(cartDiscount, lines.map((l) => l.net_tetri)).forEach((share, i) => {
        lines[i].cart_discount_share_tetri = share;
        lines[i].net_tetri -= share;
      });
    }

    const subtotalTetri = lines.reduce((s, l) => s + l.subtotal_tetri, 0);
    const totalTetri = lines.reduce((s, l) => s + l.net_tetri, 0);
    return {
      lines,
      subtotal_tetri: subtotalTetri,
      discount_tetri: subtotalTetri - totalTetri,
      total_tetri: totalTetri,
    };
  }

  /**
   * Performs an atomic checkout.
   * Validates stock, calculates change and debt, depletes FIFO lots, updates inventory.
   * `exchange` is supplied only by ReturnsService.processExchange, inside its transaction.
   */
  checkout(user: User, rawPayload: CheckoutPayload, exchange?: ExchangeSaleContext): Sale {
    const payload = requireObject<CheckoutPayload & Record<string, any>>(rawPayload, 'გაყიდვა');
    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw new Error('კალათა ცარიელია');
    }
    const paymentMethod = oneOf(payload.payment_method, ['cash', 'debt', 'mixed'] as const, 'გადახდის მეთოდი');
    const customerId = optionalId(payload.customer_id, 'კლიენტი');
    const cashInput = payload.cash_received_tetri == null ? 0 : requireAmount(payload.cash_received_tetri, 'მიღებული ნაღდი თანხა');
    const idempotencyKey = optionalIdempotencyKey(payload.idempotency_key);
    const notes = optionalString(payload.notes, 500, 'შენიშვნა');
    const discountReasonInput = optionalString(payload.discount_reason, 300, 'ფასდაკლების მიზეზი');

    return runInTransaction((db) => {
      // Idempotency: a retried request with the same key returns the original sale and
      // never deducts stock or money twice.
      if (idempotencyKey) {
        const existing = db.prepare(
          "SELECT id, total_tetri, payment_method, customer_id FROM sales WHERE idempotency_key = ?"
        ).get(idempotencyKey) as any;
        if (existing) {
          const itemCount = (db.prepare("SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ?").get(existing.id) as any).n;
          let totalMatches = true;
          try {
            totalMatches = this.priceCart(user, payload.items, payload.cart_discount_tetri, db).total_tetri === existing.total_tetri;
          } catch {
            // Product changed since the original request; key, method and customer still identify it.
          }
          if (
            existing.payment_method !== paymentMethod ||
            (existing.customer_id ?? null) !== customerId ||
            itemCount !== payload.items.length ||
            !totalMatches
          ) {
            throw new Error('იდემპოტენტურობის გასაღები უკვე გამოყენებულია სხვა ტრანზაქციისთვის (Idempotency key mismatch)');
          }
          return this.getSaleById(existing.id)!;
        }
      }

      const cart = this.priceCart(user, payload.items, payload.cart_discount_tetri, db);
      const totalTetri = cart.total_tetri;
      if (totalTetri <= 0) {
        throw new Error('გაყიდვის ჯამური თანხა უნდა აღემატებოდეს 0-ს');
      }

      // Stock check per variant (the same variant may appear on several lines).
      const neededByVariant = new Map<number, number>();
      for (const line of cart.lines) {
        neededByVariant.set(line.variant_id, (neededByVariant.get(line.variant_id) || 0) + line.quantity);
      }
      for (const [variantId, needed] of neededByVariant) {
        const variant = db.prepare(`
          SELECT pv.stock_quantity, pv.variant_name, p.name as product_name
          FROM product_variants pv JOIN products p ON pv.product_id = p.id
          WHERE pv.id = ?
        `).get(variantId) as any;
        if (variant.stock_quantity < needed) {
          throw new Error(
            `არასაკმარისი მარაგი: "${variant.product_name}" (${variant.variant_name}). ` +
            `ხელმისაწვდომია: ${variant.stock_quantity}, მოთხოვნილია: ${needed}`
          );
        }
      }

      // Payment. Exchange credit reduces what the customer has to pay; it is not cash.
      const creditTetri = exchange ? requireAmount(exchange.exchangeCreditTetri, 'გაცვლის კრედიტი') : 0;
      if (creditTetri > totalTetri) {
        throw new Error('გაცვლის კრედიტი აღემატება ახალი გაყიდვის თანხას');
      }
      const dueTetri = totalTetri - creditTetri;

      let cashReceivedTetri = 0;
      let changeGivenTetri = 0;
      let debtAmountTetri = 0;

      if (paymentMethod === 'cash') {
        cashReceivedTetri = cashInput;
        if (cashReceivedTetri < dueTetri) {
          throw new Error(`მიღებული ნაღდი თანხა (${(cashReceivedTetri / 100).toFixed(2)} ₾) ნაკლებია ჯამურ თანხაზე (${(dueTetri / 100).toFixed(2)} ₾)`);
        }
        changeGivenTetri = cashReceivedTetri - dueTetri;
      } else if (paymentMethod === 'debt') {
        if (!customerId) {
          throw new Error('ნისიით გაყიდვისთვის კლიენტის არჩევა ან რეგისტრაცია აუცილებელია');
        }
        if (dueTetri <= 0) {
          throw new Error('ნისიაზე გასაფორმებელი თანხა არ არის');
        }
        debtAmountTetri = dueTetri;
      } else {
        if (!customerId) {
          throw new Error('შერეული გადახდისთვის (ნაღდი + ნისია) კლიენტის არჩევა ან რეგისტრაცია აუცილებელია');
        }
        cashReceivedTetri = cashInput;
        if (cashReceivedTetri <= 0 || cashReceivedTetri >= dueTetri) {
          throw new Error(`შერეული გადახდისას მიღებული ნაღდი თანხა უნდა იყოს 0-ზე მეტი და მთლიან თანხაზე (${(dueTetri / 100).toFixed(2)} ₾) ნაკლები`);
        }
        debtAmountTetri = dueTetri - cashReceivedTetri;
      }

      if (customerId) {
        const customer = db.prepare("SELECT id FROM customers WHERE id = ?").get(customerId);
        if (!customer) {
          throw new Error('მითითებული კლიენტი ვერ მოიძებნა');
        }
      }

      const now = new Date().toISOString();
      const receiptNumber = this.generateReceiptNumber();
      const hasDiscount = cart.discount_tetri > 0;
      const saleType = exchange ? 'exchange' : 'standard';

      const saleRes = db.prepare(`
        INSERT INTO sales (
          receipt_number, user_id, customer_id, payment_method,
          subtotal_tetri, discount_tetri, total_tetri, exchange_credit_tetri,
          cash_received_tetri, change_given_tetri, debt_amount_tetri, status,
          sale_type, related_return_id, exchange_diff_tetri,
          discount_authorized_by, discount_reason, notes, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receiptNumber,
        user.id,
        customerId,
        paymentMethod,
        cart.subtotal_tetri,
        cart.discount_tetri,
        totalTetri,
        creditTetri,
        cashReceivedTetri,
        changeGivenTetri,
        debtAmountTetri,
        saleType,
        exchange?.relatedReturnId ?? null,
        exchange?.exchangeDiffTetri ?? 0,
        hasDiscount ? user.id : null,
        hasDiscount ? (discountReasonInput || 'მფლობელის ფასდაკლება') : null,
        notes,
        idempotencyKey,
        now
      );
      const saleId = Number(saleRes.lastInsertRowid);

      for (const line of cart.lines) {
        const codeRow = db.prepare(
          "SELECT code_value FROM product_codes WHERE variant_id = ? ORDER BY CASE code_type WHEN 'manual_5digit' THEN 0 ELSE 1 END, id ASC LIMIT 1"
        ).get(line.variant_id) as { code_value: string } | undefined;

        // FIFO: consume the oldest cost layers first and remember exactly which ones.
        const layers: Array<{ lot_id: number | null; quantity: number; unit_cost_tetri: number | null }> = [];
        let needed = line.quantity;
        const lots = db.prepare(`
          SELECT id, remaining_quantity, unit_cost_tetri
          FROM inventory_lots
          WHERE variant_id = ? AND remaining_quantity > 0
          ORDER BY id ASC
        `).all(line.variant_id) as Array<{ id: number; remaining_quantity: number; unit_cost_tetri: number | null }>;

        for (const lot of lots) {
          if (needed <= 0) break;
          const take = Math.min(needed, lot.remaining_quantity);
          db.prepare("UPDATE inventory_lots SET remaining_quantity = remaining_quantity - ? WHERE id = ?").run(take, lot.id);
          layers.push({ lot_id: lot.id, quantity: take, unit_cost_tetri: lot.unit_cost_tetri });
          needed -= take;
        }
        if (needed > 0) {
          // Stock counter is ahead of the cost layers: the cost of these units is unknown, never 0.
          layers.push({ lot_id: null, quantity: needed, unit_cost_tetri: null });
        }

        const allCostsKnown = layers.every((l) => l.unit_cost_tetri !== null);
        const knownCost = layers.reduce((s, l) => s + (l.unit_cost_tetri ?? 0) * l.quantity, 0);
        const avgUnitCost = allCostsKnown ? Math.round(knownCost / line.quantity) : null;

        const itemRes = db.prepare(`
          INSERT INTO sale_items (
            sale_id, variant_id, product_name_snap, variant_name_snap,
            code_snap, quantity, unit_price_tetri, unit_cost_tetri,
            discount_tetri, total_price_tetri, returned_quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          saleId,
          line.variant_id,
          line.product_name,
          line.variant_name,
          codeRow?.code_value || null,
          line.quantity,
          line.list_unit_price_tetri,
          avgUnitCost,
          line.line_discount_tetri + line.cart_discount_share_tetri,
          line.net_tetri
        );
        const saleItemId = Number(itemRes.lastInsertRowid);

        const layerStmt = db.prepare(
          "INSERT INTO sale_item_lots (sale_item_id, lot_id, quantity, unit_cost_tetri, returned_quantity) VALUES (?, ?, ?, ?, 0)"
        );
        for (const layer of layers) {
          layerStmt.run(saleItemId, layer.lot_id, layer.quantity, layer.unit_cost_tetri);
        }

        db.prepare("UPDATE product_variants SET stock_quantity = stock_quantity - ? WHERE id = ?").run(line.quantity, line.variant_id);
        const resultingStock = (db.prepare("SELECT stock_quantity FROM product_variants WHERE id = ?").get(line.variant_id) as any).stock_quantity;

        db.prepare(`
          INSERT INTO inventory_movements (
            variant_id, movement_type, quantity_change, resulting_stock,
            unit_cost_tetri, reason, reference_id, user_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          line.variant_id,
          exchange ? 'exchange' : 'sale',
          -line.quantity,
          resultingStock,
          avgUnitCost,
          exchange ? 'გაცვლა (ახალი ნივთი)' : 'გაყიდვა',
          receiptNumber,
          user.id,
          now
        );
      }

      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'SALE_CHECKOUT', 'sales', ?, ?, ?)
      `).run(
        user.id,
        String(saleId),
        `Sale ${receiptNumber} (${saleType}) completed: total ${totalTetri} tetri, method: ${paymentMethod}` +
        (creditTetri > 0 ? `, exchange credit: ${creditTetri} tetri` : '') +
        (hasDiscount ? `, owner discount: ${cart.discount_tetri} tetri (${formatTetri(cart.discount_tetri)})` : ''),
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
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name,
             COALESCE(b.remaining_tetri, 0) AS debt_remaining_tetri
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN sale_debt_balances b ON b.sale_id = s.id
      WHERE s.id = ?
    `).get(saleId) as any;

    if (!sale) return null;

    const items = this.db.prepare(`
      SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC
    `).all(saleId) as any[];

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
   * Date bounds may be local days (YYYY-MM-DD, Tbilisi) or ISO instants.
   */
  searchSales(params?: {
    searchTerm?: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    saleType?: string;
    hasDebt?: boolean;
    customerId?: number;
    limit?: number;
    offset?: number;
  }): Sale[] {
    let sql = `
      SELECT s.*, u.name as user_name,
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name,
             COALESCE(b.remaining_tetri, 0) AS debt_remaining_tetri,
             (SELECT COUNT(*) FROM returns r WHERE r.sale_id = s.id) AS returns_count
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN sale_debt_balances b ON b.sale_id = s.id
      WHERE 1=1
    `;
    const args: any[] = [];

    if (params?.searchTerm && params.searchTerm.trim()) {
      const term = `%${params.searchTerm.trim()}%`;
      sql += ` AND (
        s.receipt_number LIKE ? OR
        c.first_name LIKE ? OR
        c.last_name LIKE ? OR
        c.phone LIKE ? OR
        s.id IN (SELECT sale_id FROM sale_items WHERE code_snap LIKE ? OR product_name_snap LIKE ?)
      )`;
      args.push(term, term, term, term, term, term);
    }

    if (params?.startDate) {
      sql += " AND s.created_at >= ?";
      args.push(boundToUtc(params.startDate, 'start'));
    }
    if (params?.endDate) {
      sql += " AND s.created_at < ?";
      args.push(boundToUtc(params.endDate, 'end'));
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
      sql += " AND COALESCE(b.remaining_tetri, 0) > 0";
    }
    if (params?.customerId) {
      sql += " AND s.customer_id = ?";
      args.push(params.customerId);
    }

    const limit = Math.min(Math.max(1, Math.floor(Number(params?.limit) || 100)), 500);
    const offset = Math.max(0, Math.floor(Number(params?.offset) || 0));
    sql += " ORDER BY s.id DESC LIMIT ? OFFSET ?";
    args.push(limit, offset);

    const sales = this.db.prepare(sql).all(...args) as any[];
    const itemsStmt = this.db.prepare("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC");
    for (const s of sales) {
      s.items = itemsStmt.all(s.id);
    }
    return sales;
  }
}
