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
import { can } from '../utils/access.ts';
import { kgText } from '../../shared/quantity.ts';
import { EditableMoneyInput } from '../components/inputs/NumericInputs.tsx';
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
import { getLanguage, tr, trServer } from '../../shared/i18n/index.ts';
import { currencySymbol } from '../../shared/currency.ts';
import { getStoreTimeZone } from '../../shared/time.ts';
import { fmtDateTime } from '../../shared/i18n/format.ts';

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
  // Parts of this screen follow separate permissions; the main process filters the data itself.
  const canReport = can(currentUser, 'reports.financial');
  const canProfit = canReport && can(currentUser, 'reports.profit');
  const canExport = can(currentUser, 'reports.export');
  const canExpense = can(currentUser, 'expenses.manage');
  const [summary, setSummary] = useState<FinancialSummary | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Period Filter (computed in the main process in the shop's local days)
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
    if (!canReport) { setLoading(false); return; }
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
      setLoadError(trServer(err.message) || tr('ფინანსური მონაცემების ჩატვირთვა ვერ მოხერხდა'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [periodPreset, customFrom, customTo]);

  const handleExportCSV = async () => {
    try {
      const csvString = await invokeIpc<string>('finance:exportSalesCSV', { lang: getLanguage() });
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `storepos_sales_${new Date().toISOString().split('T')[0]}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      alert(trServer(err.message) || tr('CSV ექსპორტი ვერ მოხერხდა'));
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    setExpenseError('');

    if (!expenseDesc.trim()) {
      setExpenseError(tr('ხარჯის აღწერა სავალდებულოა'));
      return;
    }

    let tetri = 0;
    try {
      tetri = gelToTetri(expenseAmount);
      if (tetri <= 0) {
        setExpenseError(tr('თანხა უნდა აღემატებოდეს 0-ს'));
        return;
      }
    } catch (err: any) {
      setExpenseError(trServer(err.message));
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
      setExpenseError(trServer(err.message) || tr('ხარჯის დამატება ვერ მოხერხდა'));
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-3 sm:p-4 lg:p-6 overflow-hidden min-h-0 select-none">
      
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 lg:mb-4 shrink-0">
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-white flex items-center space-x-2">
            <TrendingUp className="w-5 h-5 lg:w-6 lg:h-6 text-emerald-400" />
            <span>{tr('ფინანსები, მოგება და ხარჯები')}</span>
          </h1>
          <p className="text-[11px] lg:text-xs text-slate-400 mt-0.5">{tr('შემოსავალი, რეალურად მიღებული ნაღდი, თვითღირებულება და მოგების ანალიზი')}</p>
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
                {tr(title)}
              </button>
            ))}
          </div>
          {periodPreset === 'custom' && (
            <div className="flex items-center gap-1.5 text-xs text-slate-400">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs [color-scheme:dark]" aria-label={tr('საწყისი თარიღი')} />
              <span>—</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                className="px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs [color-scheme:dark]" aria-label={tr('საბოლოო თარიღი')} />
            </div>
          )}

          {canExpense && <button
            onClick={() => setIsExpenseModalOpen(true)}
            className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center space-x-1.5 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{tr('ხარჯის დამატება')}</span>
          </button>}

          {canExport && <button
            onClick={handleExportCSV}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{tr('CSV ექსპორტი')}</span>
          </button>}
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
            <span>{tr('პერიოდი ({timeZone} დროით): {period_start} — {period_end}{value}', { timeZone: getStoreTimeZone(), period_start: summary.period_start, period_end: summary.period_end, value: loading ? tr(' • იტვირთება...') : '' })}</span>
          </div>
        )}

        {!canReport && (
          <div className="p-3 bg-slate-900 border border-slate-800 rounded-xl text-slate-300 text-xs">{tr('ფინანსური ანგარიშის ნახვის უფლება არ გაქვთ. ამ ეკრანზე ხელმისაწვდომია მხოლოდ ზემოთ მოცემული ღილაკები.')}</div>
        )}

        {canProfit && summary?.has_unknown_costs && (
          <div className="p-3 bg-amber-950/40 border border-amber-800/60 rounded-xl text-amber-200 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{tr('{value}{value2}{value3}{value4}შესყიდვის ფასი უცნობია. თვითღირებულება 0-ად არ ითვლება, ამიტომ ზუსტი მოგება ვერ დაითვლება — ქვემოთ ნაჩვენებია მხოლოდ ცნობილი ფასების მიხედვით (არასრული).', { value: summary.unknown_cost_items_count > 0 && tr('{unknown_cost_items_count} გაყიდულ ერთეულს ', { unknown_cost_items_count: summary.unknown_cost_items_count }), value2: (summary.unknown_cost_returned_items_count || 0) > 0 && tr('{unknown_cost_returned_items_count} დაბრუნებულ ერთეულს ', { unknown_cost_returned_items_count: summary.unknown_cost_returned_items_count }), value3: (summary.unknown_cost_grams || 0) > 0 && tr('{gramsToKg} კგ გაყიდულ წონას ', { gramsToKg: kgText(summary.unknown_cost_grams) }), value4: (summary.unknown_cost_returned_grams || 0) > 0 && tr('{gramsToKg} კგ დაბრუნებულ წონას ', { gramsToKg: kgText(summary.unknown_cost_returned_grams) }) })}</span>
          </div>
        )}

        {/* 1. Sales */}
        {canReport && <FinanceSection title={tr('გაყიდვები')}>
          <Stat label={tr('მთლიანი გაყიდვები')} value={summary?.total_sales_revenue_tetri}
            hint={tr('{value} გაყიდვა{value2}', { value: summary?.total_sales_count || 0, value2: (summary?.exchange_sales_count || 0) > 0 ? tr(', მათ შორის {exchange_sales_count} გაცვლა', { exchange_sales_count: summary?.exchange_sales_count }) : '' })} />
          <Stat label={tr('ფასდაკლებები')} value={summary?.total_discounts_tetri} tone="amber"
            hint={tr('ფასდაკლებამდე: {amount}', { amount: formatTetri(summary?.sales_before_discount_tetri) })} />
          <Stat label={tr('დაბრუნებული საქონელი')} value={summary?.total_returns_amount_tetri} tone="red"
            hint={tr('{value} დაბრუნება/გაცვლა, გადახდილი ფასით', { value: summary?.total_returns_count || 0 })} />
          <Stat label={tr('წმინდა გაყიდვები')} value={summary?.net_sales_tetri} tone="white" strong
            hint={tr('მთლიანი გაყიდვები − დაბრუნებები')} />
        </FinanceSection>}

        {/* 2. Cost and gross profit (reports.profit) */}
        {canProfit && <FinanceSection title={tr('თვითღირებულება (FIFO) და მთლიანი მოგება')}>
          <Stat label={tr('გაყიდულის თვითღირებულება')} value={summary?.cost_of_goods_sold_tetri} hint={tr('შესყიდვის ფასი პარტიების მიხედვით')} />
          <Stat label={tr('დაბრუნებით უკუგატარებული')} value={summary?.cogs_reversed_by_returns_tetri} tone="cyan" hint={tr('დაბრუნებული ნივთების თავდაპირველი თვითღირებულება')} />
          <Stat label={tr('წმინდა თვითღირებულება')} value={summary?.net_cogs_tetri} hint={tr('გაყიდული − უკუგატარებული')} />
          {summary?.estimated_gross_profit_tetri === null ? (
            <Stat label={tr('მთლიანი მოგება (არასრული)')} value={summary?.gross_profit_partial_tetri} tone="amber" strong hint={tr('ზოგიერთი ფასი უცნობია')} />
          ) : (
            <Stat label={tr('მთლიანი მოგება')} value={summary?.estimated_gross_profit_tetri} tone="emerald" strong hint={tr('წმინდა გაყიდვები − წმინდა თვითღირებულება')} />
          )}
        </FinanceSection>}

        {/* Stock value now (reports.profit): what is on the shelf at its FIFO cost */}
        {canProfit && summary && (
          <FinanceSection title={tr('მარაგის ღირებულება ახლა (FIFO, შესყიდვის ფასით)')}>
            {summary.inventory_value_tetri === null || summary.inventory_value_tetri === undefined ? (
              <Stat label={tr('მარაგის ღირებულება (არასრული)')} value={summary.inventory_value_known_tetri} tone="amber" strong
                hint={tr('უცნობი ფასით: {value} ცალი{value2}', { value: summary.inventory_unknown_cost_units || 0, value2: (summary.inventory_unknown_cost_grams || 0) > 0 ? tr(', {gramsToKg} კგ', { gramsToKg: kgText(summary.inventory_unknown_cost_grams) }) : '' })} />
            ) : (
              <Stat label={tr('მარაგის ღირებულება')} value={summary.inventory_value_tetri} tone="cyan" strong hint={tr('თაროზე დარჩენილი საქონელი, პარტიების შესყიდვის ფასით')} />
            )}
          </FinanceSection>
        )}

        {/* 3. Operating result */}
        {canReport && <FinanceSection title={tr('საოპერაციო შედეგი')}>
          {canProfit && <Stat label={tr('დაზიანებული საქონელი')} value={summary?.damaged_goods_writeoff_tetri} tone="red"
            hint={tr('{value} ერთეული{value2} ჩამოიწერა (თვითღირებულებით)', { value: summary?.damaged_goods_units || 0, value2: (summary?.damaged_goods_grams || 0) > 0 ? tr(' და {gramsToKg} კგ', { gramsToKg: kgText(summary?.damaged_goods_grams) }) : '' })} />}
          <Stat label={tr('ჩამოწერილი ნისია')} value={summary?.debt_written_off_tetri} tone="red" hint={tr('მფლობელის მიერ ჩამოწერილი ვალი')} />
          <Stat label={tr('საოპერაციო ხარჯები')} value={summary?.total_expenses_tetri} tone="red" hint={tr('ქირა, კომუნალური, ტრანსპორტი და სხვა')} />
          {!canProfit ? null : summary?.operating_result_tetri === null ? (
            <Stat label={tr('საოპერაციო შედეგი (არასრული)')} value={summary?.operating_result_partial_tetri} tone="amber" strong hint={tr('ზოგიერთი ფასი უცნობია')} />
          ) : (
            <Stat label={tr('საოპერაციო შედეგი')} value={summary?.operating_result_tetri} tone="emerald" strong hint={tr('მოგება − დანაკარგები − ხარჯები')} />
          )}
        </FinanceSection>}

        {/* 4. Cash */}
        {canReport && <FinanceSection title={tr('ნაღდი ფული და ნისიები')}>
          <Stat label={tr('ნაღდი გაყიდვებიდან')} value={summary?.cash_collected_direct_tetri} tone="emerald" hint={tr('მიღებული ნაღდი − ხურდა')} />
          <Stat label={tr('ნისიების დაფარვიდან')} value={summary?.cash_collected_debts_tetri} tone="emerald"
            hint={tr('{value} დაფარვა (გაყიდვად არ ითვლება)', { value: summary?.repayments_count || 0 })} />
          <Stat label={tr('კლიენტებს დაუბრუნდა ნაღდი')} value={summary?.cash_refunded_tetri} tone="red"
            hint={(summary?.exchange_credit_used_tetri || 0) > 0 ? tr('გაცვლის კრედიტი {amount} ნაღდი არ არის', { amount: formatTetri(summary?.exchange_credit_used_tetri) }) : tr('დაბრუნებები და გაცვლები')} />
          <Stat label={tr('წმინდა ნაღდი ნაკადი')} value={summary?.net_cash_flow_tetri} tone="white" strong
            hint={tr('ხარჯების გამოკლებით: {amount}', { amount: formatTetri(summary?.net_cash_after_expenses_tetri) })} />
          <Stat label={tr('ახალი ნისიები პერიოდში')} value={summary?.total_new_debt_tetri} tone="amber" hint={tr('გაყიდვებზე გაფორმებული ვალი')} />
          <Stat label={tr('კლიენტების დარჩენილი ვალი (ახლა)')} value={summary?.outstanding_debt_tetri} tone="amber" strong
            hint={tr('{value} კლიენტი', { value: summary?.customers_with_debt_count || 0 })} />
        </FinanceSection>}

        {discounts.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider mb-3">{tr('ფასდაკლებების ისტორია')}</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs min-w-[560px]">
                <thead className="text-slate-400 border-b border-slate-800">
                  <tr>
                    <th className="py-2 px-2">{tr('თარიღი')}</th>
                    <th className="py-2 px-2">{tr('ჩეკი')}</th>
                    <th className="py-2 px-2 text-right">{tr('ფასდაკლებამდე')}</th>
                    <th className="py-2 px-2 text-right">{tr('ფასდაკლება')}</th>
                    <th className="py-2 px-2 text-right">{tr('გადახდილი')}</th>
                    <th className="py-2 px-2">{tr('მიზეზი')}</th>
                    <th className="py-2 px-2">{tr('დაამტკიცა')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {discounts.map((d) => (
                    <tr key={d.id}>
                      <td className="py-2 px-2 font-mono text-[11px] text-slate-400 whitespace-nowrap">{fmtDateTime(d.created_at)}</td>
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

        {/* Expenses List (part of the financial report) */}
        {canReport && <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
          <div className="flex flex-wrap justify-between items-center gap-2 mb-3 sm:mb-4">
            <h2 className="text-xs sm:text-sm font-bold text-white uppercase tracking-wider">{tr('მაღაზიის დაფიქსირებული ხარჯები')}</h2>
            {canExpense && <button
              onClick={() => setIsExpenseModalOpen(true)}
              className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center space-x-1"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{tr('+ ახალი ხარჯი')}</span>
            </button>}
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto min-h-0">
            <table className="w-full text-left text-xs min-w-[500px]">
              <thead className="bg-slate-900 text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="py-2.5 px-3">{tr('თარიღი')}</th>
                  <th className="py-2.5 px-3">{tr('კატეგორია')}</th>
                  <th className="py-2.5 px-3">{tr('აღწერა')}</th>
                  <th className="py-2.5 px-3 text-right">{tr('თანხა')}</th>
                  <th className="py-2.5 px-3">{tr('ჩაწერა')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {expenses.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">{tr('ხარჯები არ ფიქსირდება')}</td>
                  </tr>
                ) : (
                  expenses.map(e => (
                    <tr key={e.id} className="hover:bg-slate-900/40">
                      <td className="py-2.5 px-3 font-mono text-slate-400 whitespace-nowrap">{e.expense_date}</td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium text-[11px]">
                          {tr(e.category)}
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
        </div>}

      </div>

      {/* --- MODAL: Add Expense --- */}
      {isExpenseModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white">{tr('მაღაზიის ხარჯის დამატება')}</h3>
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
                  <label className="block text-xs font-semibold text-slate-300 mb-1">{tr('კატეგორია')}</label>
                  <select
                    value={expenseCat}
                    onChange={(e) => setExpenseCat(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                  >
                    <option value="ქირა">{tr('ქირა')}</option>
                    <option value="კომუნალური">{tr('კომუნალური')}</option>
                    <option value="ტრანსპორტი">{tr('ტრანსპორტი / მიწოდება')}</option>
                    <option value="ხელფასი">{tr('ხელფასი')}</option>
                    <option value="სხვა">{tr('სხვა ხარჯი')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">{tr('აღწერა *')}</label>
                  <input
                    type="text"
                    required
                    value={expenseDesc}
                    onChange={(e) => setExpenseDesc(e.target.value)}
                    placeholder={tr('მაგ. მაღაზიის ქირა (ოქტომბერი)')}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">{tr('თანხა ({currency}) *', { currency: currencySymbol() })}</label>
                  <EditableMoneyInput
                    required
                    value={expenseAmount}
                    onChange={(val) => setExpenseAmount(val)}
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
              >{tr('გაუქმება')}</button>
              <button
                type="submit"
                form="expense-form"
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40"
              >{tr('დამატება')}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
