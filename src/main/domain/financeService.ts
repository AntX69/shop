/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Financial Reporting and Store Expenses Domain Service (Owner Only).
 * Implements strict separation between:
 * - Sales Revenue
 * - Cash Inflow (direct cash + debt collections - cash returns)
 * - Receivables (open debts)
 * - Returns & Cost of Goods Sold (COGS)
 * - Profit Calculation with explicit warning for unknown purchase costs.
 */

import { DatabaseSync } from 'node:sqlite';
import { getDb } from '../db/database.ts';
import { Expense, FinancialSummary, User } from '../../shared/types.ts';

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
   * Generates comprehensive financial summary for a date range.
   */
  getFinancialSummary(user: User, startDate?: string, endDate?: string): FinancialSummary {
    this.checkOwner(user);

    let salesWhere = "WHERE 1=1";
    let repaymentsWhere = "WHERE 1=1";
    let returnsWhere = "WHERE 1=1";
    let expensesWhere = "WHERE 1=1";

    const salesParams: any[] = [];
    const repParams: any[] = [];
    const retParams: any[] = [];
    const expParams: any[] = [];

    if (startDate) {
      salesWhere += " AND created_at >= ?";
      repaymentsWhere += " AND created_at >= ?";
      returnsWhere += " AND created_at >= ?";
      expensesWhere += " AND expense_date >= ?";
      salesParams.push(startDate);
      repParams.push(startDate);
      retParams.push(startDate);
      expParams.push(startDate);
    }

    if (endDate) {
      salesWhere += " AND created_at <= ?";
      repaymentsWhere += " AND created_at <= ?";
      returnsWhere += " AND created_at <= ?";
      expensesWhere += " AND expense_date <= ?";
      salesParams.push(endDate);
      repParams.push(endDate);
      retParams.push(endDate);
      expParams.push(endDate);
    }

    // 1. Sales aggregates
    const salesRow = this.db.prepare(`
      SELECT 
        COUNT(*) as sales_count,
        COALESCE(SUM(total_tetri), 0) as gross_revenue_tetri,
        COALESCE(SUM(cash_received_tetri - change_given_tetri), 0) as direct_cash_tetri,
        COALESCE(SUM(debt_amount_tetri), 0) as new_debt_tetri
      FROM sales ${salesWhere}
    `).get(...salesParams) as any;

    // 2. Debt repayments (Cash collected from old debts)
    const repRow = this.db.prepare(`
      SELECT COALESCE(SUM(amount_tetri), 0) as debt_cash_tetri
      FROM debt_repayments ${repaymentsWhere}
    `).get(...repParams) as any;

    // 3. Returns and cash refunds
    const retRow = this.db.prepare(`
      SELECT 
        COALESCE(SUM(total_refund_tetri), 0) as total_returns_tetri,
        COALESCE(SUM(cash_refund_tetri), 0) as cash_refunds_tetri
      FROM returns ${returnsWhere}
    `).get(...retParams) as any;

    // 4. Expenses
    const expRow = this.db.prepare(`
      SELECT COALESCE(SUM(amount_tetri), 0) as total_expenses_tetri
      FROM expenses ${expensesWhere}
    `).get(...expParams) as any;

    // 5. Cost of goods sold (COGS) & Unknown cost detection
    const cogsQuery = `
      SELECT 
        si.quantity,
        si.unit_cost_tetri,
        si.total_price_tetri
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      ${salesWhere.replace(/created_at/g, 's.created_at')}
    `;
    const cogsRows = this.db.prepare(cogsQuery).all(...salesParams) as any[];

    let cogsTetri = 0;
    let unknownCostItemsCount = 0;

    for (const r of cogsRows) {
      if (r.unit_cost_tetri === null || r.unit_cost_tetri === undefined) {
        unknownCostItemsCount += r.quantity;
      } else {
        cogsTetri += (r.quantity * r.unit_cost_tetri);
      }
    }

    const hasUnknownCosts = unknownCostItemsCount > 0;
    const directCash = salesRow.direct_cash_tetri || 0;
    const debtCash = repRow.debt_cash_tetri || 0;
    const cashRefunds = retRow.cash_refunds_tetri || 0;
    const totalCashInflow = directCash + debtCash - cashRefunds;
    const expenses = expRow.total_expenses_tetri || 0;
    const netCashFlow = totalCashInflow - expenses;

    // Gross profit: (Gross Revenue - Total Returns) - COGS
    const netRevenue = (salesRow.gross_revenue_tetri || 0) - (retRow.total_returns_tetri || 0);
    const estimatedProfit = hasUnknownCosts ? null : (netRevenue - cogsTetri - expenses);

    return {
      period_start: startDate || 'დასაწყისიდან',
      period_end: endDate || 'დღემდე',
      total_sales_count: salesRow.sales_count || 0,
      total_sales_revenue_tetri: salesRow.gross_revenue_tetri || 0,
      cash_collected_direct_tetri: directCash,
      cash_collected_debts_tetri: debtCash,
      total_cash_inflow_tetri: totalCashInflow,
      total_new_debt_tetri: salesRow.new_debt_tetri || 0,
      total_returns_amount_tetri: retRow.total_returns_tetri || 0,
      total_expenses_tetri: expenses,
      cost_of_goods_sold_tetri: cogsTetri,
      has_unknown_costs: hasUnknownCosts,
      unknown_cost_items_count: unknownCostItemsCount,
      estimated_gross_profit_tetri: estimatedProfit,
      net_cash_flow_tetri: netCashFlow
    };
  }

  // --- Expenses Management ---

  createExpense(user: User, payload: {
    category: string;
    description: string;
    amount_tetri: number;
    expense_date?: string;
  }): Expense {
    this.checkOwner(user);

    if (payload.amount_tetri <= 0) {
      throw new Error('ხარჯის თანხა უნდა იყოს 0-ზე მეტი');
    }

    const desc = payload.description.trim();
    if (!desc) {
      throw new Error('ხარჯის აღწერა სავალდებულოა');
    }

    const now = new Date().toISOString();
    const expenseDate = payload.expense_date || now.split('T')[0];

    const res = this.db.prepare(`
      INSERT INTO expenses (category, description, amount_tetri, user_id, expense_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      payload.category.trim() || 'სხვა',
      desc,
      payload.amount_tetri,
      user.id,
      expenseDate,
      now
    );

    const id = Number(res.lastInsertRowid);

    this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'EXPENSE_CREATE', 'expenses', ?, ?, ?)
    `).run(user.id, String(id), `Expense ${desc}: ${payload.amount_tetri} tetri`, now);

    return {
      id,
      category: payload.category,
      description: desc,
      amount_tetri: payload.amount_tetri,
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
    `).all(limit) as any[];
  }

  /**
   * Generates a UTF-8 BOM CSV export for Sales.
   */
  exportSalesCSV(user: User): string {
    this.checkOwner(user);
    const sales = this.db.prepare(`
      SELECT s.receipt_number, s.created_at, u.name as seller, 
             c.first_name || ' ' || COALESCE(c.last_name, '') as customer,
             s.payment_method, s.total_tetri, s.cash_received_tetri, s.debt_amount_tetri, s.status
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      ORDER BY s.id DESC
    `).all() as any[];

    // UTF-8 BOM (\uFEFF) for Excel Georgian character compatibility
    let csv = '\uFEFFჩეკის #,თარიღი,გამყიდველი,კლიენტი,გადახდის მეთოდი,ჯამი (₾),მიღებული ნაღდი (₾),ნისია (₾),სტატუსი\n';

    for (const s of sales) {
      const totalGEL = (s.total_tetri / 100).toFixed(2);
      const cashGEL = (s.cash_received_tetri / 100).toFixed(2);
      const debtGEL = (s.debt_amount_tetri / 100).toFixed(2);
      const method = s.payment_method === 'cash' ? 'ნაღდი' : s.payment_method === 'debt' ? 'ნისია' : 'შერეული';
      const status = s.status === 'completed' ? 'დასრულებული' : s.status === 'returned' ? 'დაბრუნებული' : 'ნაწილობრივ დაბრუნებული';
      csv += `"${s.receipt_number}","${s.created_at}","${s.seller}","${s.customer || '-'}","${method}","${totalGEL}","${cashGEL}","${debtGEL}","${status}"\n`;
    }

    return csv;
  }
}
