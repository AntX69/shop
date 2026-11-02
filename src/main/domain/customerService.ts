/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Customer and Debt Management Domain Service.
 * Tracks customer profiles, outstanding debts, and partial/full repayments.
 * CRITICAL RULE: Debt repayment is a cash collection and NOT counted as a new sale.
 *
 * Every open balance comes from the sale_debt_balances view:
 *   remaining = debt on the sale − repayment allocations (not voided) − debt reduced by returns − write-offs
 * Financial records are never deleted: the owner voids a mistaken repayment or writes off
 * debt, with a reason, the before/after balances and an audit entry.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { Customer, DebtRepayment, User } from '../../shared/types.ts';
import {
  optionalId, optionalIdempotencyKey, optionalString, requireId, requireObject,
  requirePositiveAmount, requireString,
} from './validation.ts';

const CUSTOMER_DEBT_SQL = `COALESCE((SELECT SUM(b.remaining_tetri) FROM sale_debt_balances b WHERE b.customer_id = c.id), 0)`;

export class CustomerService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  private requireOwner(user: User, action: string): void {
    if (user.role !== 'owner') {
      throw new Error(`${action} შეუძლია მხოლოდ მფლობელს`);
    }
  }

  /**
   * Registers a new customer.
   * First name is required.
   */
  createCustomer(requester: User, rawInput: {
    first_name: string;
    last_name?: string;
    phone?: string;
    address?: string;
    notes?: string;
  }): Customer {
    const input = requireObject<any>(rawInput, 'კლიენტი');
    const firstName = optionalString(input.first_name, 100, 'კლიენტის სახელი');
    if (!firstName) {
      throw new Error('კლიენტის სახელი სავალდებულოა');
    }

    const now = new Date().toISOString();
    const res = this.db.prepare(`
      INSERT INTO customers (first_name, last_name, phone, address, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      firstName,
      optionalString(input.last_name, 100, 'გვარი'),
      optionalString(input.phone, 40, 'ტელეფონი'),
      optionalString(input.address, 200, 'მისამართი'),
      optionalString(input.notes, 500, 'შენიშვნა'),
      now
    );

    const customerId = Number(res.lastInsertRowid);

    this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'CUSTOMER_CREATE', 'customers', ?, ?, ?)
    `).run(requester.id, String(customerId), `Created customer ${firstName}`, now);

    return this.getCustomerById(customerId)!;
  }

  /**
   * Lists customers with calculated outstanding debt.
   */
  listCustomers(searchTerm?: string): Customer[] {
    let sql = `
      SELECT c.*, ${CUSTOMER_DEBT_SQL} as total_debt_tetri
      FROM customers c
    `;
    const params: any[] = [];
    if (searchTerm && searchTerm.trim()) {
      const term = `%${searchTerm.trim()}%`;
      sql += " WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ?";
      params.push(term, term, term);
    }
    sql += " ORDER BY c.first_name ASC";

    return this.db.prepare(sql).all(...params) as any[];
  }

  getCustomerById(id: number): Customer | null {
    const row = this.db.prepare(`
      SELECT c.*, ${CUSTOMER_DEBT_SQL} as total_debt_tetri
      FROM customers c WHERE c.id = ?
    `).get(id) as any;
    return row || null;
  }

  private saleBalance(db: DatabaseSync, saleId: number): number {
    const row = db.prepare("SELECT remaining_tetri FROM sale_debt_balances WHERE sale_id = ?").get(saleId) as any;
    return row ? row.remaining_tetri : 0;
  }

  private allocationsFor(db: DatabaseSync, repaymentId: number): any[] {
    return db.prepare(`
      SELECT dra.*, s.receipt_number
      FROM debt_repayment_allocations dra
      JOIN sales s ON dra.sale_id = s.id
      WHERE dra.repayment_id = ?
      ORDER BY dra.id ASC
    `).all(repaymentId) as any[];
  }

  /**
   * Records a cash debt repayment (Seller and Owner can both accept).
   * Validates positive amount and checks that payment does not exceed customer's total outstanding debt.
   */
  recordRepayment(user: User, rawPayload: {
    customer_id: number;
    amount_tetri: number;
    sale_id?: number | null;
    notes?: string;
    idempotency_key?: string;
  }): DebtRepayment {
    const payload = requireObject<any>(rawPayload, 'დაფარვა');
    const customerId = requireId(payload.customer_id, 'კლიენტი');
    if (typeof payload.amount_tetri === 'number' && payload.amount_tetri <= 0) {
      throw new Error('დაფარვის თანხა უნდა იყოს 0-ზე მეტი');
    }
    const amount = requirePositiveAmount(payload.amount_tetri, 'დაფარვის თანხა');
    const saleId = optionalId(payload.sale_id, 'გაყიდვა');
    const notes = optionalString(payload.notes, 500, 'შენიშვნა');
    const idempotencyKey = optionalIdempotencyKey(payload.idempotency_key);

    return runInTransaction((db) => {
      // Idempotency check: prevent accidental double repayment
      if (idempotencyKey) {
        const existing = db.prepare(
          "SELECT dr.*, u.name as user_name FROM debt_repayments dr JOIN users u ON dr.user_id = u.id WHERE dr.idempotency_key = ?"
        ).get(idempotencyKey) as any;
        if (existing) {
          if (existing.customer_id !== customerId || existing.amount_tetri !== amount) {
            throw new Error('Idempotency key mismatch: ამ გასაღებით უკვე დაფიქსირებულია განსხვავებული გადახდა');
          }
          return {
            id: existing.id,
            customer_id: existing.customer_id,
            sale_id: existing.sale_id,
            amount_tetri: existing.amount_tetri,
            user_id: existing.user_id,
            user_name: existing.user_name,
            payment_method: 'cash',
            notes: existing.notes || undefined,
            idempotency_key: existing.idempotency_key,
            created_at: existing.created_at,
            allocations: this.allocationsFor(db, existing.id)
          };
        }
      }

      const customer = this.getCustomerById(customerId);
      if (!customer) {
        throw new Error('კლიენტი ვერ მოიძებნა');
      }

      const currentDebt = customer.total_debt_tetri || 0;
      if (currentDebt <= 0) {
        throw new Error(`კლიენტს (${customer.first_name}) დავალიანება არ ერიცხება`);
      }

      if (amount > currentDebt) {
        throw new Error(
          `შეტანილი თანხა (${(amount / 100).toFixed(2)} ₾) აღემატება მიმდინარე დავალიანებას (${(currentDebt / 100).toFixed(2)} ₾)`
        );
      }

      const now = new Date().toISOString();

      // If specific sale is designated, validate that sale's owner and open balance
      if (saleId) {
        const saleRow = db.prepare("SELECT id, customer_id FROM sales WHERE id = ?").get(saleId) as any;
        if (!saleRow) {
          throw new Error('მითითებული გაყიდვა ვერ მოიძებნა');
        }
        if (saleRow.customer_id !== customer.id) {
          throw new Error('ეს გაყიდვა არ ეკუთვნის აღნიშნულ კლიენტს');
        }
        const saleRemaining = this.saleBalance(db, saleId);
        if (amount > saleRemaining) {
          throw new Error(
            `შეტანილი თანხა (${(amount / 100).toFixed(2)} ₾) აღემატება ამ ჩეკის დარჩენილ ვალს (${(saleRemaining / 100).toFixed(2)} ₾)`
          );
        }
      }

      const res = db.prepare(`
        INSERT INTO debt_repayments (customer_id, sale_id, amount_tetri, user_id, payment_method, notes, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, 'cash', ?, ?, ?)
      `).run(customer.id, saleId, amount, user.id, notes, idempotencyKey, now);

      const repaymentId = Number(res.lastInsertRowid);
      const allocStmt = db.prepare(`
        INSERT INTO debt_repayment_allocations (repayment_id, sale_id, customer_id, allocated_tetri, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      if (saleId) {
        // Direct allocation to the targeted sale
        allocStmt.run(repaymentId, saleId, customer.id, amount, now);
      } else {
        // General repayment -> deterministic FIFO across the customer's open debt sales (oldest first)
        let unallocated = amount;
        const openSales = db.prepare(`
          SELECT sale_id, remaining_tetri FROM sale_debt_balances
          WHERE customer_id = ? AND remaining_tetri > 0
          ORDER BY sale_id ASC
        `).all(customer.id) as Array<{ sale_id: number; remaining_tetri: number }>;

        for (const os of openSales) {
          if (unallocated <= 0) break;
          const portion = Math.min(os.remaining_tetri, unallocated);
          allocStmt.run(repaymentId, os.sale_id, customer.id, portion, now);
          unallocated -= portion;
        }
        if (unallocated > 0) {
          throw new Error('დაფარვის განაწილება ვერ მოხერხდა: ნისიის ნაშთები შეუთანხმებელია');
        }
      }

      const allocations = this.allocationsFor(db, repaymentId);
      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'DEBT_REPAYMENT', 'debt_repayments', ?, ?, ?)
      `).run(
        user.id,
        String(repaymentId),
        `Repaid ${(amount / 100).toFixed(2)} GEL for customer ${customer.first_name} by ${user.name}. Allocated across ${allocations.length} sales.`,
        now
      );

      return {
        id: repaymentId,
        customer_id: customer.id,
        sale_id: saleId,
        amount_tetri: amount,
        user_id: user.id,
        user_name: user.name,
        payment_method: 'cash',
        notes: notes || undefined,
        created_at: now,
        allocations
      };
    }, this.db);
  }

  /**
   * Owner correction: voids a mistaken repayment (wrong amount, wrong customer, entered twice).
   * The repayment stays in history marked as voided; its allocations stop counting.
   */
  voidRepayment(user: User, rawPayload: { repayment_id: number; reason: string }): {
    repayment_id: number;
    customer_balance_before_tetri: number;
    customer_balance_after_tetri: number;
  } {
    this.requireOwner(user, 'დაფარვის გაუქმება');
    const payload = requireObject<any>(rawPayload, 'დაფარვის გაუქმება');
    const repaymentId = requireId(payload.repayment_id, 'დაფარვა');
    const reason = requireString(payload.reason, 300, 'გაუქმების მიზეზი');

    return runInTransaction((db) => {
      const rep = db.prepare("SELECT * FROM debt_repayments WHERE id = ?").get(repaymentId) as any;
      if (!rep) throw new Error('დაფარვა ვერ მოიძებნა');
      if (rep.voided_at) throw new Error('ეს დაფარვა უკვე გაუქმებულია');

      const before = this.getCustomerById(rep.customer_id)!.total_debt_tetri || 0;
      const now = new Date().toISOString();
      db.prepare("UPDATE debt_repayments SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?")
        .run(now, user.id, reason, repaymentId);
      const after = this.getCustomerById(rep.customer_id)!.total_debt_tetri || 0;

      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'DEBT_REPAYMENT_VOID', 'debt_repayments', ?, ?, ?)
      `).run(user.id, String(repaymentId), JSON.stringify({
        reason,
        amount_tetri: rep.amount_tetri,
        customer_id: rep.customer_id,
        repayment_created_at: rep.created_at,
        customer_balance_before_tetri: before,
        customer_balance_after_tetri: after
      }), now);

      return { repayment_id: repaymentId, customer_balance_before_tetri: before, customer_balance_after_tetri: after };
    }, this.db);
  }

  /**
   * Owner correction: writes off (forgives) part or all of the debt still open on one sale.
   */
  writeOffDebt(user: User, rawPayload: { sale_id: number; amount_tetri: number; reason: string; idempotency_key?: string }): any {
    this.requireOwner(user, 'ნისიის ჩამოწერა');
    const payload = requireObject<any>(rawPayload, 'ნისიის ჩამოწერა');
    const saleId = requireId(payload.sale_id, 'გაყიდვა');
    const amount = requirePositiveAmount(payload.amount_tetri, 'ჩამოსაწერი თანხა');
    const reason = requireString(payload.reason, 300, 'ჩამოწერის მიზეზი');
    const idempotencyKey = optionalIdempotencyKey(payload.idempotency_key);

    return runInTransaction((db) => {
      if (idempotencyKey) {
        const existing = db.prepare("SELECT * FROM debt_adjustments WHERE idempotency_key = ?").get(idempotencyKey) as any;
        if (existing) {
          if (existing.sale_id !== saleId || existing.amount_tetri !== amount) {
            throw new Error('Idempotency key mismatch: ამ გასაღებით უკვე დაფიქსირებულია განსხვავებული კორექცია');
          }
          return existing;
        }
      }

      const sale = db.prepare("SELECT id, customer_id, receipt_number FROM sales WHERE id = ?").get(saleId) as any;
      if (!sale || !sale.customer_id) throw new Error('ნისიის გაყიდვა ვერ მოიძებნა');

      const saleBefore = this.saleBalance(db, saleId);
      if (amount > saleBefore) {
        throw new Error(`ჩამოსაწერი თანხა (${(amount / 100).toFixed(2)} ₾) აღემატება ჩეკის დარჩენილ ვალს (${(saleBefore / 100).toFixed(2)} ₾)`);
      }
      const customerBefore = this.getCustomerById(sale.customer_id)!.total_debt_tetri || 0;
      const now = new Date().toISOString();

      const res = db.prepare(`
        INSERT INTO debt_adjustments (
          customer_id, sale_id, adjustment_type, amount_tetri, reason,
          sale_balance_before_tetri, sale_balance_after_tetri,
          customer_balance_before_tetri, customer_balance_after_tetri,
          user_id, idempotency_key, created_at
        ) VALUES (?, ?, 'write_off', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sale.customer_id, saleId, amount, reason,
        saleBefore, saleBefore - amount,
        customerBefore, customerBefore - amount,
        user.id, idempotencyKey, now
      );
      const adjustmentId = Number(res.lastInsertRowid);

      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'DEBT_WRITE_OFF', 'debt_adjustments', ?, ?, ?)
      `).run(user.id, String(adjustmentId), JSON.stringify({
        reason,
        receipt_number: sale.receipt_number,
        amount_tetri: amount,
        sale_balance_before_tetri: saleBefore,
        sale_balance_after_tetri: saleBefore - amount,
        customer_balance_before_tetri: customerBefore,
        customer_balance_after_tetri: customerBefore - amount
      }), now);

      return db.prepare("SELECT * FROM debt_adjustments WHERE id = ?").get(adjustmentId);
    }, this.db);
  }

  /** Owner view of all debt corrections for a customer (write-offs and voided repayments). */
  getDebtCorrections(user: User, customerId: number): { write_offs: any[]; voided_repayments: any[] } {
    this.requireOwner(user, 'ნისიის კორექციების ნახვა');
    const write_offs = this.db.prepare(`
      SELECT da.*, s.receipt_number, u.name AS user_name
      FROM debt_adjustments da JOIN sales s ON s.id = da.sale_id JOIN users u ON u.id = da.user_id
      WHERE da.customer_id = ? ORDER BY da.id DESC
    `).all(customerId);
    const voided_repayments = this.db.prepare(`
      SELECT dr.*, u.name AS voided_by_name
      FROM debt_repayments dr LEFT JOIN users u ON u.id = dr.voided_by
      WHERE dr.customer_id = ? AND dr.voided_at IS NOT NULL ORDER BY dr.id DESC
    `).all(customerId);
    return { write_offs, voided_repayments };
  }

  /**
   * Returns list of repayments for a customer with allocation details.
   */
  getRepayments(customerId: number): DebtRepayment[] {
    const reps = this.db.prepare(`
      SELECT dr.*, u.name as user_name, vu.name as voided_by_name
      FROM debt_repayments dr
      JOIN users u ON dr.user_id = u.id
      LEFT JOIN users vu ON vu.id = dr.voided_by
      WHERE dr.customer_id = ?
      ORDER BY dr.id DESC
    `).all(customerId) as any[];

    for (const r of reps) {
      r.allocations = this.allocationsFor(this.db, r.id);
    }

    return reps;
  }

  /**
   * Returns unified chronological ledger of all customer debt debits & credits:
   * - Sales creating debt (+)
   * - Cash repayments (-), and their voiding by the owner (+)
   * - Returns reducing debt (-)
   * - Owner write-offs (-)
   */
  getCustomerLedger(customerId: number): any[] {
    const customer = this.getCustomerById(customerId);
    if (!customer) return [];

    const sales = this.db.prepare(`
      SELECT s.id, s.receipt_number, s.debt_amount_tetri, s.created_at, u.name as user_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      WHERE s.customer_id = ? AND s.debt_amount_tetri > 0
    `).all(customerId) as any[];

    const repayments = this.db.prepare(`
      SELECT dr.id, dr.amount_tetri, dr.notes, dr.created_at, dr.voided_at, dr.void_reason,
             u.name as user_name, vu.name as voided_by_name
      FROM debt_repayments dr
      JOIN users u ON dr.user_id = u.id
      LEFT JOIN users vu ON vu.id = dr.voided_by
      WHERE dr.customer_id = ?
    `).all(customerId) as any[];

    const returns = this.db.prepare(`
      SELECT r.id, r.debt_deduction_tetri, s.receipt_number, r.created_at, u.name as user_name
      FROM returns r
      JOIN sales s ON r.sale_id = s.id
      JOIN users u ON r.user_id = u.id
      WHERE s.customer_id = ? AND r.debt_deduction_tetri > 0
    `).all(customerId) as any[];

    const writeOffs = this.db.prepare(`
      SELECT da.id, da.amount_tetri, da.reason, da.created_at, s.receipt_number, u.name as user_name
      FROM debt_adjustments da
      JOIN sales s ON s.id = da.sale_id
      JOIN users u ON u.id = da.user_id
      WHERE da.customer_id = ?
    `).all(customerId) as any[];

    type LedgerType = 'sale_debt' | 'repayment' | 'repayment_void' | 'return_credit' | 'write_off';
    const events: Array<{
      id: string;
      type: LedgerType;
      title: string;
      date: string;
      receipt_number?: string;
      reference_id: number;
      user_name?: string;
      debit_tetri: number;
      credit_tetri: number;
      description: string;
      notes?: string;
      voided?: boolean;
    }> = [];

    for (const s of sales) {
      events.push({
        id: `sale-${s.id}`,
        type: 'sale_debt',
        title: 'ნისია',
        date: s.created_at,
        receipt_number: s.receipt_number,
        reference_id: s.id,
        user_name: s.user_name,
        debit_tetri: s.debt_amount_tetri,
        credit_tetri: 0,
        description: `ნისია გაყიდვიდან #${s.receipt_number}`
      });
    }

    for (const r of repayments) {
      events.push({
        id: `repay-${r.id}`,
        type: 'repayment',
        title: 'დაფარვა',
        date: r.created_at,
        reference_id: r.id,
        user_name: r.user_name,
        debit_tetri: 0,
        credit_tetri: r.amount_tetri,
        description: 'ნისიის დაფარვა (ნაღდი ფული)',
        notes: r.notes || undefined,
        voided: !!r.voided_at
      });
      if (r.voided_at) {
        events.push({
          id: `repay-void-${r.id}`,
          type: 'repayment_void',
          title: 'დაფარვის გაუქმება',
          date: r.voided_at,
          reference_id: r.id,
          user_name: r.voided_by_name || undefined,
          debit_tetri: r.amount_tetri,
          credit_tetri: 0,
          description: 'მფლობელმა გააუქმა შეცდომით შეტანილი დაფარვა',
          notes: r.void_reason || undefined
        });
      }
    }

    for (const ret of returns) {
      events.push({
        id: `return-${ret.id}`,
        type: 'return_credit',
        title: 'დაბრუნება',
        date: ret.created_at,
        receipt_number: ret.receipt_number,
        reference_id: ret.id,
        user_name: ret.user_name,
        debit_tetri: 0,
        credit_tetri: ret.debt_deduction_tetri,
        description: `დაბრუნებით ვალის შემცირება (ჩეკი #${ret.receipt_number})`
      });
    }

    for (const w of writeOffs) {
      events.push({
        id: `writeoff-${w.id}`,
        type: 'write_off',
        title: 'ნისიის ჩამოწერა',
        date: w.created_at,
        receipt_number: w.receipt_number,
        reference_id: w.id,
        user_name: w.user_name,
        debit_tetri: 0,
        credit_tetri: w.amount_tetri,
        description: `მფლობელის მიერ ჩამოწერილი ვალი (ჩეკი #${w.receipt_number})`,
        notes: w.reason
      });
    }

    // Deterministic tie-breaker sorting:
    // 1. Date ascending (timestamp)
    // 2. Type priority: sale_debt -> repayment -> return_credit -> write_off -> repayment_void
    // 3. Reference ID ascending
    const typePriority: Record<string, number> = {
      'sale_debt': 1,
      'repayment': 2,
      'return_credit': 3,
      'write_off': 4,
      'repayment_void': 5
    };

    events.sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (timeDiff !== 0) return timeDiff;
      const prioDiff = (typePriority[a.type] || 99) - (typePriority[b.type] || 99);
      if (prioDiff !== 0) return prioDiff;
      return (a.reference_id || 0) - (b.reference_id || 0);
    });

    let runningBalance = 0;
    return events.map(ev => {
      const change = ev.debit_tetri - ev.credit_tetri;
      runningBalance += change;
      return {
        ...ev,
        change_tetri: change,
        running_balance_tetri: Math.max(0, runningBalance)
      };
    });
  }

  /**
   * Returns sales for a customer that currently have an unpaid debt.
   */
  getCustomerActiveSales(customerId: number): any[] {
    const sales = this.db.prepare(`
      SELECT s.*, u.name as user_name, b.remaining_tetri AS debt_remaining_tetri,
             b.repaid_tetri AS debt_repaid_tetri, b.returned_tetri AS debt_returned_tetri,
             b.written_off_tetri AS debt_written_off_tetri
      FROM sale_debt_balances b
      JOIN sales s ON s.id = b.sale_id
      JOIN users u ON s.user_id = u.id
      WHERE b.customer_id = ? AND b.remaining_tetri > 0
      ORDER BY s.id DESC
    `).all(customerId) as any[];

    const itemsStmt = this.db.prepare("SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC");
    for (const s of sales) {
      s.items = itemsStmt.all(s.id);
    }
    return sales;
  }
}
