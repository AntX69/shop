/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Customer and Debt Management Domain Service.
 * Tracks customer profiles, outstanding debts, and partial/full repayments.
 * CRITICAL RULE: Debt repayment is a cash collection and NOT counted as a new sale.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb, runInTransaction } from '../db/database.ts';
import { Customer, DebtRepayment, User } from '../../shared/types.ts';

export class CustomerService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  /**
   * Registers a new customer.
   * First name is required.
   */
  createCustomer(requester: User, input: {
    first_name: string;
    last_name?: string;
    phone?: string;
    address?: string;
    notes?: string;
  }): Customer {
    const firstName = input.first_name.trim();
    if (!firstName) {
      throw new Error('კლიენტის სახელი სავალდებულოა');
    }

    const now = new Date().toISOString();
    const res = this.db.prepare(`
      INSERT INTO customers (first_name, last_name, phone, address, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      firstName,
      input.last_name?.trim() || null,
      input.phone?.trim() || null,
      input.address?.trim() || null,
      input.notes?.trim() || null,
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
      SELECT c.*,
        (
          COALESCE((SELECT SUM(debt_amount_tetri) FROM sales WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(amount_tetri) FROM debt_repayments WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(r.debt_deduction_tetri) FROM returns r JOIN sales s ON r.sale_id = s.id WHERE s.customer_id = c.id), 0)
        ) as total_debt_tetri
      FROM customers c
    `;
    const params: any[] = [];
    if (searchTerm && searchTerm.trim()) {
      const term = `%${searchTerm.trim()}%`;
      sql += " WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ?";
      params.push(term, term, term);
    }
    sql += " ORDER BY c.first_name ASC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(r => ({
      ...r,
      total_debt_tetri: Math.max(0, r.total_debt_tetri || 0)
    }));
  }

  getCustomerById(id: number): Customer | null {
    const row = this.db.prepare(`
      SELECT c.*,
        (
          COALESCE((SELECT SUM(debt_amount_tetri) FROM sales WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(amount_tetri) FROM debt_repayments WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(r.debt_deduction_tetri) FROM returns r JOIN sales s ON r.sale_id = s.id WHERE s.customer_id = c.id), 0)
        ) as total_debt_tetri
      FROM customers c WHERE c.id = ?
    `).get(id) as any;

    if (!row) return null;
    return {
      ...row,
      total_debt_tetri: Math.max(0, row.total_debt_tetri || 0)
    };
  }

  /**
   * Records a cash debt repayment (Seller and Owner can both accept).
   * Validates positive amount and checks that payment does not exceed customer's total outstanding debt.
   */
  recordRepayment(user: User, payload: {
    customer_id: number;
    amount_tetri: number;
    sale_id?: number | null;
    notes?: string;
    idempotency_key?: string;
  }): DebtRepayment {
    if (payload.amount_tetri <= 0) {
      throw new Error('დაფარვის თანხა უნდა იყოს 0-ზე მეტი');
    }

    // Idempotency check: prevent accidental double repayment
    if (payload.idempotency_key) {
      const existing = this.db.prepare(
        "SELECT dr.*, u.name as user_name FROM debt_repayments dr JOIN users u ON dr.user_id = u.id WHERE dr.idempotency_key = ?"
      ).get(payload.idempotency_key) as any;
      if (existing) {
        if (existing.customer_id !== payload.customer_id || existing.amount_tetri !== payload.amount_tetri) {
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
          created_at: existing.created_at
        };
      }
    }

    return runInTransaction((db) => {
      const customer = this.getCustomerById(payload.customer_id);
      if (!customer) {
        throw new Error('კლიენტი ვერ მოიძებნა');
      }

      const currentDebt = customer.total_debt_tetri || 0;
      if (currentDebt <= 0) {
        throw new Error(`კლიენტს (${customer.first_name}) დავალიანება არ ერიცხება`);
      }

      if (payload.amount_tetri > currentDebt) {
        throw new Error(
          `შეტანილი თანხა (${(payload.amount_tetri / 100).toFixed(2)} ₾) აღემატება მიმდინარე დავალიანებას (${(currentDebt / 100).toFixed(2)} ₾)`
        );
      }

      const now = new Date().toISOString();
      const res = db.prepare(`
        INSERT INTO debt_repayments (customer_id, sale_id, amount_tetri, user_id, payment_method, notes, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, 'cash', ?, ?, ?)
      `).run(
        customer.id,
        payload.sale_id || null,
        payload.amount_tetri,
        user.id,
        payload.notes?.trim() || null,
        payload.idempotency_key || null,
        now
      );

      const repaymentId = Number(res.lastInsertRowid);

      db.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'DEBT_REPAYMENT', 'debt_repayments', ?, ?, ?)
      `).run(
        user.id,
        String(repaymentId),
        `Repaid ${(payload.amount_tetri / 100).toFixed(2)} GEL for customer ${customer.first_name} by ${user.name}`,
        now
      );

      return {
        id: repaymentId,
        customer_id: customer.id,
        sale_id: payload.sale_id || null,
        amount_tetri: payload.amount_tetri,
        user_id: user.id,
        user_name: user.name,
        payment_method: 'cash',
        notes: payload.notes?.trim() || undefined,
        created_at: now
      };
    }, this.db);
  }

  /**
   * Returns list of repayments for a customer.
   */
  getRepayments(customerId: number): DebtRepayment[] {
    return this.db.prepare(`
      SELECT dr.*, u.name as user_name
      FROM debt_repayments dr
      JOIN users u ON dr.user_id = u.id
      WHERE dr.customer_id = ?
      ORDER BY dr.id DESC
    `).all(customerId) as any[];
  }

  /**
   * Returns unified chronological ledger of all customer debt debits & credits:
   * - Sales creating debt (+)
   * - Cash repayments (-)
   * - Returns reducing debt (-)
   */
  getCustomerLedger(customerId: number): any[] {
    const customer = this.getCustomerById(customerId);
    if (!customer) return [];

    // 1. Debt Sales
    const sales = this.db.prepare(`
      SELECT s.id, s.receipt_number, s.debt_amount_tetri, s.created_at, u.name as user_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      WHERE s.customer_id = ? AND s.debt_amount_tetri > 0
    `).all(customerId) as any[];

    // 2. Repayments
    const repayments = this.db.prepare(`
      SELECT dr.id, dr.amount_tetri, dr.notes, dr.created_at, u.name as user_name
      FROM debt_repayments dr
      JOIN users u ON dr.user_id = u.id
      WHERE dr.customer_id = ?
    `).all(customerId) as any[];

    // 3. Returns that reduced debt
    const returns = this.db.prepare(`
      SELECT r.id, r.debt_deduction_tetri, s.receipt_number, r.created_at, u.name as user_name
      FROM returns r
      JOIN sales s ON r.sale_id = s.id
      JOIN users u ON r.user_id = u.id
      WHERE s.customer_id = ? AND r.debt_deduction_tetri > 0
    `).all(customerId) as any[];

    // Merge into single chronological timeline
    const events: Array<{
      id: string;
      type: 'sale_debt' | 'repayment' | 'return_credit';
      title: string;
      date: string;
      receipt_number?: string;
      reference_id: number;
      user_name?: string;
      debit_tetri: number;
      credit_tetri: number;
      description: string;
      notes?: string;
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
        notes: r.notes || undefined
      });
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

    // Sort ascending by date to compute accurate running balance
    events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    let runningBalance = 0;
    const ledger = events.map(ev => {
      const change = ev.debit_tetri - ev.credit_tetri;
      runningBalance += change;
      return {
        ...ev,
        change_tetri: change,
        running_balance_tetri: Math.max(0, runningBalance)
      };
    });

    return ledger;
  }

  /**
   * Returns sales for a customer that currently have an unpaid debt.
   */
  getCustomerActiveSales(customerId: number): any[] {
    const sales = this.db.prepare(`
      SELECT s.*, u.name as user_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      WHERE s.customer_id = ? AND s.debt_amount_tetri > 0
      ORDER BY s.id DESC
    `).all(customerId) as any[];

    for (const s of sales) {
      s.items = this.db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(s.id);
      const repaid = this.db.prepare("SELECT COALESCE(SUM(amount_tetri), 0) as total FROM debt_repayments WHERE sale_id = ?").get(s.id) as { total: number };
      const returnedDebt = this.db.prepare("SELECT COALESCE(SUM(debt_deduction_tetri), 0) as total FROM returns WHERE sale_id = ?").get(s.id) as { total: number };
      s.debt_remaining_tetri = Math.max(0, s.debt_amount_tetri - repaid.total - returnedDebt.total);
    }

    return sales;
  }
}
