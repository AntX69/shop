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
  }): DebtRepayment {
    if (payload.amount_tetri <= 0) {
      throw new Error('დაფარვის თანხა უნდა იყოს 0-ზე მეტი');
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
        INSERT INTO debt_repayments (customer_id, sale_id, amount_tetri, user_id, payment_method, notes, created_at)
        VALUES (?, ?, ?, ?, 'cash', ?, ?)
      `).run(
        customer.id,
        payload.sale_id || null,
        payload.amount_tetri,
        user.id,
        payload.notes?.trim() || null,
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
}
