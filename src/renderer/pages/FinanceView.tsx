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

type PeriodPresetUi = 'today' | 'yesterday' | 'week' | 'month' | 'last_month' | 'year' | 'all' | 'custom';

const PERIODS: Array<[PeriodPresetUi, string]> = [
  ['today', 'დღეს'],
  ['yesterday', 'გუშინ'],
  ['week', 'ეს კვირა'],
  ['month', 'ეს თვე'],
  ['last_month', 'წინა თვე'],
  ['year', 'წელი'],
  ['all', 'სრული'],
  ['custom', 'შუალედი'],
];

const TONES: Record<string, string> = {
  white: 'text-white',
  emerald: 'text-emerald-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
  cyan: 'text-cyan-300',
};

const FinanceSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">{title}</h2>
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6 gap-3">{children}</div>
  </section>
);

/** One figure; negative values are shown as they are (a period can legitimately be negative). */
const Stat: React.FC<{ label: string; value: number | null | undefined; hint?: string; tone?: string; strong?: boolean }> = ({ label, value, hint, tone = 'white', strong }) => (
  <div className={`bg-slate-900 border ${strong ? 'border-slate-600' : 'border-slate-800'} p-3.5 rounded-2xl shadow-xl`}>
    <div className="text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase tracking-wider">{label}</div>
    <div className={`${strong ? 'text-2xl' : 'text-xl'} font-black mt-1 tabular-nums ${(value ?? 0) < 0 ? 'text-red-400' : TONES[tone] || 'text-white'}`}>
      {formatTetri(value ?? 0)}
    </div>
    {hint && <div className="text-[11px] text-slate-500 mt-1 leading-snug">{hint}</div>}
  </div>
);

export const FinanceView: React.FC<FinanceViewProps> = ({ currentUser }) => {
  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Period Filter (computed in the main process in Asia/Tbilisi local days)
  const [periodPreset, setPeriodPreset] = useState<PeriodPresetUi>('month');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [discounts, setDiscounts] = useState<any[]>([]);
  const [loadError, setLoadError] = useState<string>('');

  // New Expense Modal
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState<boolean>(false);
  const [expenseCat, setExpenseCat] = useState<string>('ქირა');
  const [expenseDesc, setExpenseDesc] = useState<string>('');
  const [expenseAmount, setExpenseAmount] = useState<string>('');
  const [expenseError, setExpenseError] = useState<string>('');

  const loadData = async () => {
    if (periodPreset === 'custom' && !customFrom && !customTo) return;
    const period = periodPreset === 'custom'
      ? { preset: 'custom', from: customFrom || undefined, to: customTo || undefined }
      : { preset: periodPreset };
    try {
      setLoading(true);
      setLoadError('');
      const [sum, exps, disc] = await Promise.all([
        invokeIpc<FinancialSummary>('finance:summary', period),
        invokeIpc<Expense[]>('finance:listExpenses', { limit: 100 }),
        invokeIpc<any[]>('finance:listDiscounts', { ...period, limit: 50 })
      ]);
      setSummary(sum);
      setExpenses(exps);
      setDiscounts(disc);
    } catch (err: any) {
      setLoadError(err.message || 'ფინანსური მონაცემების ჩატვირთვა ვერ მოხერხდა');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [periodPreset, customFrom, customTo]);

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
          <div className="bg-slate-900 border border-slate-800 p-1 rounded-xl flex flex-wrap items-center gap-1">
            {PERIODS.map(([p, title]) => (
              <button
                key={p}
                onClick={() => setPeriodPreset(p)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  periodPreset === p ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
                }`}
              >
                {title}
              </button>
            ))}
          </div>
          {periodPreset === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs [color-scheme:dark]" aria-label="საწყისი თარიღი" />
              <span>—</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs [color-scheme:dark]" aria-label="საბოლოო თარიღი" />
            </div>
          )}

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
        
        {loadError && (
          <div className="p-3 bg-red-950/60 border border-red-800/60 rounded-xl text-red-300 text-xs">{loadError}</div>
        )}

        {summary && (
          <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />
            <span>პერიოდი (თბილისის დროით): {summary.period_start} — {summary.period_end}{loading ? ' • იტვირთება...' : ''}</span>
          </div>
        )}

        {summary?.has_unknown_costs && (
          <div className="p-3 bg-amber-950/40 border border-amber-800/60 rounded-xl text-amber-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              {summary.unknown_cost_items_count > 0 && `${summary.unknown_cost_items_count} გაყიდულ ერთეულს `}
              {(summary.unknown_cost_returned_items_count || 0) > 0 && `${summary.unknown_cost_returned_items_count} დაბრუნებულ ერთეულს `}
              შესყიდვის ფასი უცნობია. თვითღირებულება 0-ად არ ითვლება, ამიტომ ზუსტი მოგება ვერ დაითვლება — ქვემოთ ნაჩვენებია მხოლოდ ცნობილი ფასების მიხედვით (არასრული).
            </span>
          </div>
        )}

        {/* 1. Sales */}
        <FinanceSection title="გაყიდვები">
          <Stat label="მთლიანი გაყიდვები" value={summary?.total_sales_revenue_tetri}
            hint={`${summary?.total_sales_count || 0} გაყიდვა${(summary?.exchange_sales_count || 0) > 0 ? `, მათ შორის ${summary?.exchange_sales_count} გაცვლა` : ''}`} />
          <Stat label="ფასდაკლებები" value={summary?.total_discounts_tetri} tone="amber"
            hint={`ფასდაკლებამდე: ${formatTetri(summary?.sales_before_discount_tetri)}`} />
          <Stat label="დაბრუნებული საქონელი" value={summary?.total_returns_amount_tetri} tone="red"
            hint={`${summary?.total_returns_count || 0} დაბრუნება/გაცვლა, გადახდილი ფასით`} />
          <Stat label="წმინდა გაყიდვები" value={summary?.net_sales_tetri} tone="white" strong
            hint="მთლიანი გაყიდვები − დაბრუნებები" />
        </FinanceSection>

        {/* 2. Cost and gross profit */}
        <FinanceSection title="თვითღირებულება (FIFO) და მთლიანი მოგება">
          <Stat label="გაყიდულის თვითღირებულება" value={summary?.cost_of_goods_sold_tetri} hint="შესყიდვის ფასი პარტიების მიხედვით" />
          <Stat label="დაბრუნებით უკუგატარებული" value={summary?.cogs_reversed_by_returns_tetri} tone="cyan" hint="დაბრუნებული ნივთების თავდაპირველი თვითღირებულება" />
          <Stat label="წმინდა თვითღირებულება" value={summary?.net_cogs_tetri} hint="გაყიდული − უკუგატარებული" />
          {summary?.estimated_gross_profit_tetri === null ? (
            <Stat label="მთლიანი მოგება (არასრული)" value={summary?.gross_profit_partial_tetri} tone="amber" strong hint="ზოგიერთი ფასი უცნობია" />
          ) : (
            <Stat label="მთლიანი მოგება" value={summary?.estimated_gross_profit_tetri} tone="emerald" strong hint="წმინდა გაყიდვები − წმინდა თვითღირებულება" />
          )}
        </FinanceSection>

        {/* 3. Operating result */}
        <FinanceSection title="საოპერაციო შედეგი">
          <Stat label="დაზიანებული საქონელი" value={summary?.damaged_goods_writeoff_tetri} tone="red"
            hint={`${summary?.damaged_goods_units || 0} ერთეული ჩამოიწერა (თვითღირებულებით)`} />
          <Stat label="ჩამოწერილი ნისია" value={summary?.debt_written_off_tetri} tone="red" hint="მფლობელის მიერ ჩამოწერილი ვალი" />
          <Stat label="საოპერაციო ხარჯები" value={summary?.total_expenses_tetri} tone="red" hint="ქირა, კომუნალური, ტრანსპორტი და სხვა" />
          {summary?.operating_result_tetri === null ? (
            <Stat label="საოპერაციო შედეგი (არასრული)" value={summary?.operating_result_partial_tetri} tone="amber" strong hint="ზოგიერთი ფასი უცნობია" />
          ) : (
            <Stat label="საოპერაციო შედეგი" value={summary?.operating_result_tetri} tone="emerald" strong hint="მოგება − დანაკარგები − ხარჯები" />
          )}
        </FinanceSection>

        {/* 4. Cash */}
        <FinanceSection title="ნაღდი ფული და ნისიები">
          <Stat label="ნაღდი გაყიდვებიდან" value={summary?.cash_collected_direct_tetri} tone="emerald" hint="მიღებული ნაღდი − ხურდა" />
          <Stat label="ნისიების დაფარვიდან" value={summary?.cash_collected_debts_tetri} tone="emerald"
            hint={`${summary?.repayments_count || 0} დაფარვა (გაყიდვად არ ითვლება)`} />
          <Stat label="კლიენტებს დაუბრუნდა ნაღდი" value={summary?.cash_refunded_tetri} tone="red"
            hint={(summary?.exchange_credit_used_tetri || 0) > 0 ? `გაცვლის კრედიტი ${formatTetri(summary?.exchange_credit_used_tetri)} ნაღდი არ არის` : 'დაბრუნებები და გაცვლები'} />
          <Stat label="წმინდა ნაღდი ნაკადი" value={summary?.net_cash_flow_tetri} tone="white" strong
            hint={`ხარჯების გამოკლებით: ${formatTetri(summary?.net_cash_after_expenses_tetri)}`} />
          <Stat label="ახალი ნისიები პერიოდში" value={summary?.total_new_debt_tetri} tone="amber" hint="გაყიდვებზე გაფორმებული ვალი" />
          <Stat label="კლიენტების დარჩენილი ვალი (ახლა)" value={summary?.outstanding_debt_tetri} tone="amber" strong
            hint={`${summary?.customers_with_debt_count || 0} კლიენტი`} />
        </FinanceSection>

        {discounts.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider mb-3">ფასდაკლებების ისტორია</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[560px]">
                <thead className="text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2 px-2">თარიღი</th>
                    <th className="py-2 px-2">ჩეკი</th>
                    <th className="py-2 px-2 text-right">ფასდაკლებამდე</th>
                    <th className="py-2 px-2 text-right">ფასდაკლება</th>
                    <th className="py-2 px-2 text-right">გადახდილი</th>
                    <th className="py-2 px-2">მიზეზი</th>
                    <th className="py-2 px-2">დაამტკიცა</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {discounts.map((d) => (
                    <tr key={d.id}>
                      <td className="py-2 px-2 font-mono text-[11px] text-slate-400 whitespace-nowrap">{new Date(d.created_at).toLocaleString('ka-GE')}</td>
                      <td className="py-2 px-2 font-mono text-slate-300">#{d.receipt_number}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-slate-300">{formatTetri(d.subtotal_tetri)}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-amber-400 font-bold">−{formatTetri(d.discount_tetri)}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-white">{formatTetri(d.total_tetri)}</td>
                      <td className="py-2 px-2 text-slate-300 max-w-[220px] truncate">{d.discount_reason || '-'}</td>
                      <td className="py-2 px-2 text-slate-400">{d.authorized_by_name || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

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
