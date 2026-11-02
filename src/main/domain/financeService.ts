/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Financial Reporting and Store Expenses Domain Service (Owner Only).
 *
 * Periods are local calendar days in Asia/Tbilisi. Within a period:
 *   gross sales        = what customers were charged on sales made in the period (after discounts)
 *   returns            = value of goods returned in the period (at the price paid)
 *   net sales          = gross sales − returns
 *   COGS sold          = FIFO cost of units sold in the period
 *   COGS reversed      = FIFO cost of units returned in the period (the original cost)
 *   gross profit       = net sales − (COGS sold − COGS reversed)
 *   operating result   = gross profit − damaged goods written off − debt written off − expenses
 *   cash flow          = cash from sales + cash from debt repayments − cash refunded
 * A sale followed by a full resellable return nets to zero in every line. A return booked
 * in a later period than its sale can legitimately make a period negative; it is shown as is.
 * Unknown purchase costs are never treated as 0: affected units are counted and the profit
 * lines are flagged as incomplete.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { Expense, FinancialSummary, User } from '../../shared/types.ts';
import { isValidLocalDate, localDate, PeriodInput, resolvePeriod } from '../../shared/time.ts';
import { optionalString, requirePositiveAmount, requireObject, requireString } from './validation.ts';

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export class FinanceService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync = getDb()) {
    this.db = db;
  }

  private checkOwner(user: User): void {
    if (user.role !== 'owner') {
      throw new Error('ფინანსური მონაცემების ნახვის უფლება აქვს მხოლოდ მფლობელს');
    }
  }

  /**
   * Generates the financial summary for a period.
   * Accepts { preset, from, to } (local days); legacy startDate/endDate strings are accepted too.
   */
  getFinancialSummary(user: User, periodOrStart?: PeriodInput | string, legacyEnd?: string): FinancialSummary {
    this.checkOwner(user);

    let input: PeriodInput;
    if (typeof periodOrStart === 'string' || legacyEnd) {
      const toDay = (v?: string) => (v ? (isValidLocalDate(v) ? v : localDate(new Date(v))) : null);
      input = { preset: 'custom', from: toDay(periodOrStart as string | undefined), to: toDay(legacyEnd) };
    } else {
      input = periodOrStart || { preset: 'all' };
    }
    const period = resolvePeriod(input);

    const range = (column: string) => {
      const clauses: string[] = [];
      const params: string[] = [];
      if (period.startUtc) { clauses.push(`${column} >= ?`); params.push(period.startUtc); }
      if (period.endUtc) { clauses.push(`${column} < ?`); params.push(period.endUtc); }
      return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
    };
    const salesRange = range('s.created_at');
    const returnsRange = range('r.created_at');
    const repaymentsRange = range('dr.created_at');
    const writeOffRange = range('da.created_at');

    // 1. Sales made in the period
    const salesRow = this.db.prepare(`
      SELECT
        COUNT(*) as sales_count,
        COALESCE(SUM(s.total_tetri), 0) as gross_tetri,
        COALESCE(SUM(COALESCE(s.subtotal_tetri, s.total_tetri)), 0) as before_discount_tetri,
        COALESCE(SUM(s.discount_tetri), 0) as discount_tetri,
        COALESCE(SUM(s.cash_received_tetri - s.change_given_tetri), 0) as cash_tetri,
        COALESCE(SUM(s.debt_amount_tetri), 0) as new_debt_tetri,
        COALESCE(SUM(s.exchange_credit_tetri), 0) as exchange_credit_tetri,
        COALESCE(SUM(CASE WHEN s.sale_type = 'exchange' THEN 1 ELSE 0 END), 0) as exchange_count
      FROM sales s WHERE 1=1 ${salesRange.sql}
    `).get(...salesRange.params) as any;

    // 2. FIFO cost of the units sold in the period
    const cogsRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN sil.unit_cost_tetri IS NOT NULL THEN sil.quantity * sil.unit_cost_tetri ELSE 0 END), 0) as cogs_tetri,
        COALESCE(SUM(CASE WHEN sil.unit_cost_tetri IS NULL THEN sil.quantity ELSE 0 END), 0) as unknown_units,
        COALESCE(SUM(sil.quantity), 0) as units
      FROM sale_item_lots sil
      JOIN sale_items si ON si.id = sil.sale_item_id
      JOIN sales s ON s.id = si.sale_id
      WHERE 1=1 ${salesRange.sql}
    `).get(...salesRange.params) as any;

    // 3. Returns made in the period, with the cost they reverse
    const returnsRow = this.db.prepare(`
      SELECT
        COUNT(*) as returns_count,
        COALESCE(SUM(r.total_refund_tetri), 0) as returns_tetri,
        COALESCE(SUM(r.cash_refund_tetri), 0) as cash_refund_tetri,
        COALESCE(SUM(r.debt_deduction_tetri), 0) as debt_deduction_tetri,
        COALESCE(SUM(r.exchange_credit_tetri), 0) as exchange_credit_tetri
      FROM returns r WHERE 1=1 ${returnsRange.sql}
    `).get(...returnsRange.params) as any;

    const returnCostRow = this.db.prepare(`
      SELECT
        COALESCE(SUM(ri.cost_total_tetri), 0) as reversed_tetri,
        COALESCE(SUM(ri.unknown_cost_quantity), 0) as unknown_units,
        COALESCE(SUM(CASE WHEN ri.condition = 'damaged' THEN ri.cost_total_tetri ELSE 0 END), 0) as damaged_cost_tetri,
        COALESCE(SUM(CASE WHEN ri.condition = 'damaged' THEN ri.quantity ELSE 0 END), 0) as damaged_units,
        COALESCE(SUM(CASE WHEN ri.condition = 'damaged' THEN ri.unknown_cost_quantity ELSE 0 END), 0) as damaged_unknown_units
      FROM return_items ri
      JOIN returns r ON r.id = ri.return_id
      WHERE 1=1 ${returnsRange.sql}
    `).get(...returnsRange.params) as any;

    // 4. Cash collected on earlier debts (voided repayments never count)
    const repRow = this.db.prepare(`
      SELECT COALESCE(SUM(dr.amount_tetri), 0) as debt_cash_tetri, COUNT(*) as repayments_count
      FROM debt_repayments dr WHERE dr.voided_at IS NULL ${repaymentsRange.sql}
    `).get(...repaymentsRange.params) as any;

    // 5. Debt written off by the owner
    const writeOffRow = this.db.prepare(`
      SELECT COALESCE(SUM(da.amount_tetri), 0) as written_off_tetri
      FROM debt_adjustments da WHERE da.adjustment_type = 'write_off' ${writeOffRange.sql}
    `).get(...writeOffRange.params) as any;

    // 6. Expenses (local calendar dates)
    const expClauses: string[] = [];
    const expParams: string[] = [];
    if (period.from) { expClauses.push('expense_date >= ?'); expParams.push(period.from); }
    if (period.to) { expClauses.push('expense_date <= ?'); expParams.push(period.to); }
    const expRow = this.db.prepare(`
      SELECT COALESCE(SUM(amount_tetri), 0) as total_expenses_tetri
      FROM expenses ${expClauses.length ? 'WHERE ' + expClauses.join(' AND ') : ''}
    `).get(...expParams) as any;

    // 7. Receivables right now
    const debtNowRow = this.db.prepare(`
      SELECT COALESCE(SUM(remaining_tetri), 0) as outstanding_tetri,
             COUNT(DISTINCT CASE WHEN remaining_tetri > 0 THEN customer_id END) as customers_with_debt
      FROM sale_debt_balances
    `).get() as any;

    const grossSales: number = salesRow.gross_tetri;
    const returnsValue: number = returnsRow.returns_tetri;
    const netSales = grossSales - returnsValue;
    const cogsSold: number = cogsRow.cogs_tetri;
    const cogsReversed: number = returnCostRow.reversed_tetri;
    const netCogs = cogsSold - cogsReversed;
    const unknownSold: number = cogsRow.unknown_units;
    const unknownReturned: number = returnCostRow.unknown_units;
    const hasUnknownCosts = unknownSold > 0 || unknownReturned > 0;
    const grossProfit = netSales - netCogs;
    const damagedWriteOff: number = returnCostRow.damaged_cost_tetri;
    const debtWrittenOff: number = writeOffRow.written_off_tetri;
    const expenses: number = expRow.total_expenses_tetri;
    const operatingResult = grossProfit - damagedWriteOff - debtWrittenOff - expenses;

    const cashFromSales: number = salesRow.cash_tetri;
    const cashFromRepayments: number = repRow.debt_cash_tetri;
    const cashRefunded: number = returnsRow.cash_refund_tetri;
    const cashFlow = cashFromSales + cashFromRepayments - cashRefunded;

    return {
      period_preset: period.preset,
      period_start: period.from || 'დასაწყისიდან',
      period_end: period.to || 'დღემდე',
      period_start_utc: period.startUtc,
      period_end_utc: period.endUtc,

      total_sales_count: salesRow.sales_count,
      exchange_sales_count: salesRow.exchange_count,
      sales_before_discount_tetri: salesRow.before_discount_tetri,
      total_discounts_tetri: salesRow.discount_tetri,
      total_sales_revenue_tetri: grossSales,
      total_returns_count: returnsRow.returns_count,
      total_returns_amount_tetri: returnsValue,
      net_sales_tetri: netSales,

      cost_of_goods_sold_tetri: cogsSold,
      cogs_reversed_by_returns_tetri: cogsReversed,
      net_cogs_tetri: netCogs,
      has_unknown_costs: hasUnknownCosts,
      unknown_cost_items_count: unknownSold,
      unknown_cost_returned_items_count: unknownReturned,
      // With any unknown cost the exact profit cannot be known: null, plus a clearly
      // labelled partial figure computed from the known costs only.
      estimated_gross_profit_tetri: hasUnknownCosts ? null : grossProfit,
      gross_profit_partial_tetri: grossProfit,
      damaged_goods_writeoff_tetri: damagedWriteOff,
      damaged_goods_units: returnCostRow.damaged_units,
      debt_written_off_tetri: debtWrittenOff,
      total_expenses_tetri: expenses,
      operating_result_tetri: hasUnknownCosts ? null : operatingResult,
      operating_result_partial_tetri: operatingResult,

      cash_collected_direct_tetri: cashFromSales,
      cash_collected_debts_tetri: cashFromRepayments,
      repayments_count: repRow.repayments_count,
      cash_refunded_tetri: cashRefunded,
      total_cash_inflow_tetri: cashFlow,
      net_cash_flow_tetri: cashFlow,
      net_cash_after_expenses_tetri: cashFlow - expenses,
      exchange_credit_used_tetri: salesRow.exchange_credit_tetri,
      returns_debt_reduction_tetri: returnsRow.debt_deduction_tetri,

      total_new_debt_tetri: salesRow.new_debt_tetri,
      outstanding_debt_tetri: debtNowRow.outstanding_tetri,
      customers_with_debt_count: debtNowRow.customers_with_debt
    };
  }

  /** Owner-authorized discounts in a period, newest first. */
  listDiscounts(user: User, period?: PeriodInput, limit: number = 200): any[] {
    this.checkOwner(user);
    const p = resolvePeriod(period || { preset: 'all' });
    const clauses = ['s.discount_tetri > 0'];
    const params: any[] = [];
    if (p.startUtc) { clauses.push('s.created_at >= ?'); params.push(p.startUtc); }
    if (p.endUtc) { clauses.push('s.created_at < ?'); params.push(p.endUtc); }
    params.push(Math.min(Math.max(1, Math.floor(limit) || 200), 1000));
    return this.db.prepare(`
      SELECT s.id, s.receipt_number, s.created_at, s.subtotal_tetri, s.discount_tetri, s.total_tetri,
             s.discount_reason, u.name AS authorized_by_name, su.name AS seller_name
      FROM sales s
      LEFT JOIN users u ON u.id = s.discount_authorized_by
      JOIN users su ON su.id = s.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.id DESC LIMIT ?
    `).all(...params) as any[];
  }

  // --- Expenses Management ---

  createExpense(user: User, rawPayload: {
    category: string;
    description: string;
    amount_tetri: number;
    expense_date?: string;
  }): Expense {
    this.checkOwner(user);
    const payload = requireObject<any>(rawPayload, 'ხარჯი');

    if (typeof payload.amount_tetri === 'number' && payload.amount_tetri <= 0) {
      throw new Error('ხარჯის თანხა უნდა იყოს 0-ზე მეტი');
    }
    const amount = requirePositiveAmount(payload.amount_tetri, 'ხარჯის თანხა');
    const desc = requireString(payload.description, 300, 'ხარჯის აღწერა');
    const category = optionalString(payload.category, 100, 'ხარჯის კატეგორია') || 'სხვა';

    const now = new Date().toISOString();
    let expenseDate = localDate();
    if (payload.expense_date) {
      if (!isValidLocalDate(payload.expense_date)) {
        throw new Error(`ხარჯის თარიღი არასწორია: "${payload.expense_date}"`);
      }
      expenseDate = payload.expense_date;
    }

    const res = this.db.prepare(`
      INSERT INTO expenses (category, description, amount_tetri, user_id, expense_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(category, desc, amount, user.id, expenseDate, now);

    const id = Number(res.lastInsertRowid);

    this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'EXPENSE_CREATE', 'expenses', ?, ?, ?)
    `).run(user.id, String(id), `Expense ${desc}: ${amount} tetri on ${expenseDate}`, now);

    return {
      id,
      category,
      description: desc,
      amount_tetri: amount,
      user_id: user.id,
      user_name: user.name,
      expense_date: expenseDate,
      created_at: now
    };
  }

  listExpenses(user: User, limit: number = 100): Expense[] {
    this.checkOwner(user);
    return this.db.prepare(`
      SELECT e.*, u.name as user_name
      FROM expenses e
      JOIN users u ON e.user_id = u.id
      ORDER BY e.expense_date DESC, e.id DESC
      LIMIT ?
    `).all(Math.min(Math.max(1, Math.floor(limit) || 100), 1000)) as any[];
  }

  /**
   * Generates a UTF-8 BOM CSV export for Sales.
   */
  exportSalesCSV(user: User): string {
    this.checkOwner(user);
    const sales = this.db.prepare(`
      SELECT s.receipt_number, s.created_at, u.name as seller,
             c.first_name || ' ' || COALESCE(c.last_name, '') as customer,
             s.payment_method, s.sale_type, s.subtotal_tetri, s.discount_tetri, s.total_tetri,
             s.cash_received_tetri, s.change_given_tetri, s.debt_amount_tetri, s.exchange_credit_tetri, s.status
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      ORDER BY s.id DESC
    `).all() as any[];

    const gel = (t: number | null) => ((t || 0) / 100).toFixed(2);
    const header = ['ჩეკის #', 'თარიღი (UTC)', 'გამყიდველი', 'კლიენტი', 'გადახდის მეთოდი', 'ტიპი', 'ფასდაკლებამდე (₾)', 'ფასდაკლება (₾)', 'ჯამი (₾)', 'ნაღდი (₾)', 'ნისია (₾)', 'გაცვლის კრედიტი (₾)', 'სტატუსი'];
    // UTF-8 BOM (﻿) for Excel Georgian character compatibility
    let csv = '﻿' + header.map(csvCell).join(',') + '\n';

    for (const s of sales) {
      const method = s.payment_method === 'cash' ? 'ნაღდი' : s.payment_method === 'debt' ? 'ნისია' : 'შერეული';
      const status = s.status === 'completed' ? 'დასრულებული' : s.status === 'returned' ? 'დაბრუნებული' : 'ნაწილობრივ დაბრუნებული';
      csv += [
        s.receipt_number, s.created_at, s.seller, (s.customer || '').trim() || '-', method,
        s.sale_type === 'exchange' ? 'გაცვლა' : 'გაყიდვა',
        gel(s.subtotal_tetri ?? s.total_tetri), gel(s.discount_tetri), gel(s.total_tetri),
        gel(s.cash_received_tetri - s.change_given_tetri), gel(s.debt_amount_tetri), gel(s.exchange_credit_tetri), status
      ].map(csvCell).join(',') + '\n';
    }

    return csv;
  }
}
