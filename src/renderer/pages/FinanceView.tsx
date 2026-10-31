/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Finance & Profit Analysis View (Owner Only).
 * Implements:
 * - Gross Sales Volume vs Net Cash Inflow (direct + debt collections)
 * - Returns, Open Receivables, Expenses
 * - FIFO Cost of Goods Sold (COGS)
 * - Profit calculation with warning if unknown purchase costs exist
 * - Expenses Management (ქირა, კომუნალური, ტრანსპორტი, სხვა)
 * - UTF-8 BOM CSV Export.
 */

import React, { useState, useEffect } from 'react';
import { Expense, FinancialSummary, User } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  TrendingUp, 
  DollarSign, 
  Calendar, 
  Download, 
  Plus, 
  AlertTriangle, 
  Receipt, 
  CreditCard, 
  ArrowDownLeft, 
  ArrowUpRight,
  X
} from 'lucide-react';

interface FinanceViewProps {
  currentUser: User;
}

export const FinanceView: React.FC<FinanceViewProps> = ({ currentUser }) => {
  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Period Filter
  const [periodPreset, setPeriodPreset] = useState<'today' | 'week' | 'month' | 'all'>('month');

  // New Expense Modal
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState<boolean>(false);
  const [expenseCat, setExpenseCat] = useState<string>('ქირა');
  const [expenseDesc, setExpenseDesc] = useState<string>('');
  const [expenseAmount, setExpenseAmount] = useState<string>('');
  const [expenseError, setExpenseError] = useState<string>('');

  const getDatesForPreset = (preset: 'today' | 'week' | 'month' | 'all'): { start?: string; end?: string } => {
    const now = new Date();
    if (preset === 'today') {
      const todayStr = now.toISOString().split('T')[0];
      return { start: `${todayStr}T00:00:00.000Z` };
    }
    if (preset === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return { start: d.toISOString() };
    }
    if (preset === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: d.toISOString() };
    }
    return {};
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const { start, end } = getDatesForPreset(periodPreset);
      const [sum, exps] = await Promise.all([
        invokeIpc<FinancialSummary>('finance:summary', { startDate: start, endDate: end }),
        invokeIpc<Expense[]>('finance:listExpenses', { limit: 100 })
      ]);
      setSummary(sum);
      setExpenses(exps);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [periodPreset]);

  const handleExportCSV = async () => {
    try {
      const csvString = await invokeIpc<string>('finance:exportSalesCSV');
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `storepos_sales_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      alert(err.message || 'CSV ექსპორტი ვერ მოხერხდა');
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setExpenseError('');

    if (!expenseDesc.trim()) {
      setExpenseError('ხარჯის აღწერა სავალდებულოა');
      return;
    }

    let tetri = 0;
    try {
      tetri = gelToTetri(expenseAmount);
      if (tetri <= 0) {
        setExpenseError('თანხა უნდა აღემატებოდეს 0-ს');
        return;
      }
    } catch (err: any) {
      setExpenseError(err.message);
      return;
    }

    try {
      await invokeIpc('finance:createExpense', {
        category: expenseCat,
        description: expenseDesc.trim(),
        amount_tetri: tetri
      });

      setIsExpenseModalOpen(false);
      setExpenseDesc('');
      setExpenseAmount('');
      loadData();
    } catch (err: any) {
      setExpenseError(err.message || 'ხარჯის დამატება ვერ მოხერხდა');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-3 sm:p-4 lg:p-6 overflow-hidden min-h-0 select-none">
      
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 lg:mb-4 shrink-0">
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-white flex items-center space-x-2">
            <TrendingUp className="w-5 h-5 lg:w-6 lg:h-6 text-emerald-400" />
            <span>ფინანსები, მოგება და ხარჯები</span>
          </h1>
          <p className="text-[11px] lg:text-xs text-slate-400 mt-0.5">შემოსავალი, რეალურად მიღებული ნაღდი, თვითღირებულება და მოგების ანალიზი</p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {/* Period selector */}
          <div className="bg-slate-900 border border-slate-800 p-1 rounded-xl flex items-center space-x-1">
            {(['today', 'week', 'month', 'all'] as const).map(p => (
              <button
                key={p}
                onClick={() => setPeriodPreset(p)}
                className={`px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                  periodPreset === p ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                {p === 'today' ? 'დღეს' : p === 'week' ? '7 დღე' : p === 'month' ? 'მიმდინარე თვე' : 'სრული'}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsExpenseModalOpen(true)}
            className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center space-x-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>ხარჯის დამატება</span>
          </button>

          <button
            onClick={handleExportCSV}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>CSV ექსპორტი</span>
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto space-y-4 sm:space-y-5 pr-1 min-h-0">
        
        {/* Stat Cards Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
          
          <div className="bg-slate-900 border border-slate-800 p-3.5 sm:p-4 rounded-2xl shadow-xl">
            <div className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase tracking-wider">გაყიდვების ბრუნვა</div>
            <div className="text-xl sm:text-2xl font-black text-white mt-1 tabular-nums">
              {formatTetri(summary?.total_sales_revenue_tetri)}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              სულ {summary?.total_sales_count || 0} გაყიდვა
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-3.5 sm:p-4 rounded-2xl shadow-xl">
            <div className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase tracking-wider">რეალურად მიღებული ნაღდი</div>
            <div className="text-xl sm:text-2xl font-black text-emerald-400 mt-1 tabular-nums">
              {formatTetri(summary?.total_cash_inflow_tetri)}
            </div>
            <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
              სალარო: {formatTetri(summary?.cash_collected_direct_tetri)} + ნისიები: {formatTetri(summary?.cash_collected_debts_tetri)}
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-3.5 sm:p-4 rounded-2xl shadow-xl">
            <div className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase tracking-wider">აქტიური ნისიები (ვალი)</div>
            <div className="text-xl sm:text-2xl font-black text-amber-400 mt-1 tabular-nums">
              {formatTetri(summary?.total_new_debt_tetri)}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              პერიოდის ახალი დავალიანება
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-3.5 sm:p-4 rounded-2xl shadow-xl">
            <div className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase tracking-wider">დაბრუნებული პროდუქცია</div>
            <div className="text-xl sm:text-2xl font-black text-red-400 mt-1 tabular-nums">
              {formatTetri(summary?.total_returns_amount_tetri)}
            </div>
            <div className="text-xs text-slate-400 mt-1">
              დაბრუნებული საქონლის ღირებულება
            </div>
          </div>

        </div>

        {/* Profit and Cost Overview */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
          
          <div className="bg-slate-900 border border-slate-800 p-4 sm:p-5 rounded-2xl shadow-xl space-y-2 sm:space-y-3">
            <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              თვითღირებულება (FIFO COGS)
            </div>
            <div className="text-2xl sm:text-3xl font-black text-white tabular-nums">
              {formatTetri(summary?.cost_of_goods_sold_tetri)}
            </div>
            <div className="text-xs text-slate-400">
              შესყიდვის ფასი პარტიების (Lots) მიხედვით
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 sm:p-5 rounded-2xl shadow-xl space-y-2 sm:space-y-3">
            <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              მაღაზიის ხარჯები
            </div>
            <div className="text-2xl sm:text-3xl font-black text-red-400 tabular-nums">
              {formatTetri(summary?.total_expenses_tetri)}
            </div>
            <div className="text-xs text-slate-400">
              ქირა, კომუნალური, ტრანსპორტი და სხვა
            </div>
          </div>

          <div className="bg-slate-900 border border-slate-800 p-4 sm:p-5 rounded-2xl shadow-xl space-y-2 sm:space-y-3">
            <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              სავარაუდო წმინდა მოგება
            </div>
            <div className="text-2xl sm:text-3xl font-black text-emerald-400 tabular-nums">
              {summary?.has_unknown_costs ? (
                <span className="text-amber-400 text-lg sm:text-xl font-bold flex items-center space-x-1.5">
                  <AlertTriangle className="w-5 h-5 flex-shrink-0" />
                  <span>არასრული (უცნობი ხარჯი)</span>
                </span>
              ) : (
                formatTetri(summary?.estimated_gross_profit_tetri)
              )}
            </div>
            <div className="text-xs text-slate-400">
              {summary?.has_unknown_costs
                ? `ზოგიერთ გაყიდულ ნივთს (${summary?.unknown_cost_items_count} ც) შესყიდვის ფასი არ ჰქონდა მითითებული. 0 თვითღირებულება არ იქნა გამოყენებული!`
                : 'სრული მოგება (ბრუნვა − დაბრუნება − თვითღირებულება − ხარჯები)'}
            </div>
          </div>

        </div>

        {/* Expenses List */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
          <div className="flex flex-wrap justify-between items-center gap-2 mb-3 sm:mb-4">
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">
              მაღაზიის დაფიქსირებული ხარჯები
            </h2>
            <button
              onClick={() => setIsExpenseModalOpen(true)}
              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center space-x-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>+ ახალი ხარჯი</span>
            </button>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto min-h-0">
            <table className="w-full text-left text-xs min-w-[500px]">
              <thead className="bg-slate-900 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">თარიღი</th>
                  <th className="py-2.5 px-3">კატეგორია</th>
                  <th className="py-2.5 px-3">აღწერა</th>
                  <th className="py-2.5 px-3 text-right">თანხა</th>
                  <th className="py-2.5 px-3">ჩაწერა</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">ხარჯები არ ფიქსირდება</td>
                  </tr>
                ) : (
                  expenses.map(e => (
                    <tr key={e.id} className="hover:bg-slate-900/40">
                      <td className="py-2.5 px-3 font-mono text-slate-400 whitespace-nowrap">{e.expense_date}</td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium text-[11px]">
                          {e.category}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-white font-medium">{e.description}</td>
                      <td className="py-2.5 px-3 text-right font-extrabold text-red-400 text-xs sm:text-sm tabular-nums whitespace-nowrap">
                        -{formatTetri(e.amount_tetri)}
                      </td>
                      <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">{e.user_name}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>

      {/* --- MODAL: Add Expense --- */}
      {isExpenseModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white">მაღაზიის ხარჯის დამატება</h3>
              <button onClick={() => setIsExpenseModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0">
              {expenseError && (
                <div className="mb-3 p-2 bg-red-950/60 border border-red-800 rounded-lg text-red-200 text-xs">
                  {expenseError}
                </div>
              )}

              <form id="expense-form" onSubmit={handleCreateExpense} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">კატეგორია</label>
                  <select
                    value={expenseCat}
                    onChange={(e) => setExpenseCat(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                  >
                    <option value="ქირა">ქირა</option>
                    <option value="კომუნალური">კომუნალური</option>
                    <option value="ტრანსპორტი">ტრანსპორტი / მიწოდება</option>
                    <option value="ხელფასი">ხელფასი</option>
                    <option value="სხვა">სხვა ხარჯი</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">აღწერა *</label>
                  <input
                    type="text"
                    required
                    value={expenseDesc}
                    onChange={(e) => setExpenseDesc(e.target.value)}
                    placeholder="მაგ. მაღაზიის ქირა (ოქტომბერი)"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">თანხა (₾) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={expenseAmount}
                    onChange={(e) => setExpenseAmount(e.target.value)}
                    placeholder="150.00"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm font-bold tabular-nums"
                  />
                </div>
              </form>
            </div>

            <div className="flex space-x-2 p-4 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsExpenseModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700"
              >
                გაუქმება
              </button>
              <button
                type="submit"
                form="expense-form"
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40"
              >
                დამატება
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
