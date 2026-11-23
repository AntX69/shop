/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Sales History, Returns, Exchanges & Debts Hub (M11).
 * Features:
 * - 4 distinct tabs: გაყიდვები | დაბრუნებები | გაცვლები | ნისიები
 * - Clear visual indicators with icons and multi-dimensional status badges
 * - Return action with condition check and debt deduction priority
 * - Exchange action with live price difference calculation and linked receipts
 * - Detailed receipt inspector showing sold items, return history, and debt balances
 * - Accessible search by receipt #, customer, or product code
 */

import React, { useState, useEffect, useRef } from 'react';
import { Sale, User, ReturnRecord, Product, ProductVariant } from '../../shared/types.ts';
import { formatTetri, gelToTetri, proratedLineAmount, safeParseTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { EditableIntegerInput, EditableWeightInput } from '../components/inputs/NumericInputs.tsx';
import { formatUnitQuantity, lineTotalTetri, UnitType } from '../../shared/quantity.ts';
import { gramsToField, weightToGrams } from '../utils/numericInput.ts';
import { can, hasStockNumber, stockLimit } from '../utils/access.ts';

const unitOf = (u?: string | null): UnitType => (u === 'kg' ? 'kg' : 'piece');

/**
 * Quantity field for a return/exchange line, in the line's own unit: whole pieces, or kg with
 * up to 3 decimals (stored in grams). 0 = not returning this line; the limit is what is left.
 */
const ReturnQuantityField: React.FC<{
  unit: UnitType;
  value: number;
  max: number;
  onChange: (qty: number) => void;
  className: string;
}> = ({ unit, value, max, onChange, className }) =>
  unit === 'kg' ? (
    <EditableWeightInput
      maxGrams={max}
      value={value > 0 ? gramsToField(value) : ''}
      onChange={(val) => onChange(Math.min(max, weightToGrams(val) ?? 0))}
      className={className}
      ariaLabel={tr('დასაბრუნებელი წონა (კგ)')}
    />
  ) : (
    <EditableIntegerInput
      min={0}
      max={max}
      value={value > 0 ? value : ''}
      onChange={(val) => onChange(val === '' ? 0 : Math.min(max, val))}
      className={className}
      ariaLabel={tr('დასაბრუნებელი რაოდენობა')}
    />
  );
import { 
  History, 
  Search, 
  RotateCcw, 
  Repeat, 
  CheckCircle2, 
  AlertCircle, 
  X,
  Calendar,
  Receipt,
  Users,
  ArrowRightLeft,
  Filter,
  Check,
  Package,
  Layers,
  Banknote,
  Clock
} from 'lucide-react';
import { tr, trServer } from '../../shared/i18n/index.ts';
import { fmtDateTime } from '../../shared/i18n/format.ts';

interface SalesHistoryViewProps {
  currentUser: User;
}

type HistoryTab = 'all_sales' | 'returns' | 'exchanges' | 'debts';

export const SalesHistoryView: React.FC<SalesHistoryViewProps> = ({ currentUser }) => {
  // What this user may do here; the main process checks every action again.
  const canReturn = can(currentUser, 'returns.process');
  const canExchange = can(currentUser, 'returns.exchange');
  const canPayExchange = { cash: true, debt: can(currentUser, 'sales.debt'), mixed: can(currentUser, 'sales.mixed') };
  const [activeTab, setActiveTab] = useState<HistoryTab>('all_sales');
  const [sales, setSales] = useState<Sale[]>([]);
  const [returnsList, setReturnsList] = useState<ReturnRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);
  const [salesLimit, setSalesLimit] = useState<number>(50);

  // Stable Idempotency Keys across retries
  const returnIdempotencyKeyRef = useRef<string | null>(null);
  const exchangeIdempotencyKeyRef = useRef<string | null>(null);

  // Return Modal state
  const [isReturnModalOpen, setIsReturnModalOpen] = useState<boolean>(false);
  const [returnItemsState, setReturnItemsState] = useState<Record<number, { qty: number; condition: 'resellable' | 'damaged' }>>({});
  const [returnReason, setReturnReason] = useState<string>('');
  const [returnError, setReturnError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Exchange Modal state
  const [isExchangeModalOpen, setIsExchangeModalOpen] = useState<boolean>(false);
  const [exchangeReturnItems, setExchangeReturnItems] = useState<Record<number, { qty: number; condition: 'resellable' | 'damaged' }>>({});
  const [allProducts, setAllProducts] = useState<Product[]>([]);
  const [selectedNewVariant, setSelectedNewVariant] = useState<{ product: Product; variant: ProductVariant } | null>(null);
  const [newVariantQty, setNewVariantQty] = useState<number>(1);
  const [exchangeSearch, setExchangeSearch] = useState<string>('');
  const [exchangeError, setExchangeError] = useState<string>('');
  // How the customer pays when the new goods cost more than the returned ones
  const [exchangePayMethod, setExchangePayMethod] = useState<'cash' | 'debt' | 'mixed'>('cash');
  const [exchangeCashInput, setExchangeCashInput] = useState<string>('');

  const loadData = async (limitToUse = salesLimit) => {
    try {
      setLoading(true);
      const [salesData, returnsData] = await Promise.all([
        invokeIpc<Sale[]>('pos:searchSales', {
          searchTerm: searchTerm || undefined,
          limit: limitToUse
        }),
        invokeIpc<ReturnRecord[]>('returns:list', {
          searchTerm: searchTerm || undefined,
          limit: 100
        })
      ]);

      setSales(salesData);
      setReturnsList(returnsData);

      // Stale selection check: if selected sale is not in current dataset, reset to first or null
      if (salesData.length > 0) {
        if (!selectedSaleId || !salesData.some(s => s.id === selectedSaleId)) {
          setSelectedSaleId(salesData[0].id);
        }
      } else {
        setSelectedSaleId(null);
      }
    } catch (err) {
      console.error('Failed to load sales history data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSalesLimit(50);
    loadData(50);
  }, [searchTerm]);

  const handleLoadMore = () => {
    const newLimit = salesLimit + 50;
    setSalesLimit(newLimit);
    loadData(newLimit);
  };

  // Load products catalogue for exchange modal when opened
  const openExchangeModal = async () => {
    if (!selectedSale) return;
    exchangeIdempotencyKeyRef.current = crypto.randomUUID();
    setExchangeError('');
    setSelectedNewVariant(null);
    setNewVariantQty(1);
    setExchangePayMethod('cash');
    setExchangeCashInput('');

    const initial: Record<number, { qty: number; condition: 'resellable' | 'damaged' }> = {};
    for (const item of selectedSale.items || []) {
      const maxReturnable = item.quantity - item.returned_quantity;
      if (maxReturnable > 0) {
        initial[item.id] = { qty: 0, condition: 'resellable' };
      }
    }
    setExchangeReturnItems(initial);

    try {
      const prods = await invokeIpc<Product[]>('products:list', { stockFilter: 'in_stock' });
      setAllProducts(prods);
      setIsExchangeModalOpen(true);
    } catch (e: any) {
      alert(tr('პროდუქტების კატალოგის ჩატვირთვა ვერ მოხერხდა: ') + trServer(e.message));
    }
  };

  const selectedSale = sales.find(s => s.id === selectedSaleId) || null;

  // Same settlement rules as the main process: returned value (price actually paid) first pays
  // for the new goods; any excess reduces debt still open on this sale, the rest is cash back.
  const exchangePreview = (() => {
    if (!selectedSale || !selectedNewVariant) return null;
    const returned = (selectedSale.items || []).reduce((sum, it) => {
      const q = exchangeReturnItems[it.id]?.qty || 0;
      return sum + (q > 0 ? proratedLineAmount(it.total_price_tetri, it.quantity, it.returned_quantity, q) : 0);
    }, 0);
    const newValue = lineTotalTetri(
      selectedNewVariant.variant.price_override_tetri ?? selectedNewVariant.product.base_price_tetri,
      newVariantQty,
      unitOf(selectedNewVariant.product.unit_type)
    );
    const credit = Math.min(returned, newValue);
    const excess = returned - credit;
    const debtReduction = Math.min(excess, selectedSale.debt_remaining_tetri || 0);
    return { returned, newValue, credit, debtReduction, cashBack: excess - debtReduction, due: newValue - credit };
  })();

  const openReturnModal = () => {
    if (!selectedSale) return;
    returnIdempotencyKeyRef.current = crypto.randomUUID();
    setReturnError('');
    const initial: Record<number, { qty: number; condition: 'resellable' | 'damaged' }> = {};
    for (const item of selectedSale.items || []) {
      const maxReturnable = item.quantity - item.returned_quantity;
      if (maxReturnable > 0) {
        initial[item.id] = { qty: 0, condition: 'resellable' };
      }
    }
    setReturnItemsState(initial);
    setIsReturnModalOpen(true);
  };

  const handleReturnSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setReturnError('');

    if (!selectedSale) return;

    const payloadItems: any[] = [];
    for (const item of selectedSale.items || []) {
      const st = returnItemsState[item.id];
      if (st && st.qty > 0) {
        payloadItems.push({
          sale_item_id: item.id,
          variant_id: item.variant_id,
          quantity: st.qty,
          condition: st.condition
        });
      }
    }

    if (payloadItems.length === 0) {
      setReturnError(tr('გთხოვთ აირჩიოთ მინიმუმ 1 დასაბრუნებელი პროდუქტი (რაოდენობა > 0)'));
      return;
    }

    try {
      setIsSubmitting(true);
      const idempotencyKey = returnIdempotencyKeyRef.current || (returnIdempotencyKeyRef.current = crypto.randomUUID());
      const res = await invokeIpc('returns:process', {
        sale_id: selectedSale.id,
        items: payloadItems,
        reason: returnReason.trim() || undefined,
        idempotency_key: idempotencyKey
      });

      returnIdempotencyKeyRef.current = null;
      alert(
        tr('დაბრუნება წარმატებით გაფორმდა!\n') +
        tr('ჯამური დასაბრუნებელი თანხა: {amount}\n', { amount: formatTetri(res.total_refund_tetri) }) +
        tr('ჩამოწერილი ვალი: {amount}\n', { amount: formatTetri(res.debt_deduction_tetri) }) +
        tr('დაბრუნებული ნაღდი ფული: {amount}', { amount: formatTetri(res.cash_refund_tetri) })
      );

      setIsReturnModalOpen(false);
      setReturnReason('');
      await loadData();
    } catch (err: any) {
      setReturnError(trServer(err.message) || tr('დაბრუნების შეცდომა'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExchangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setExchangeError('');

    if (!selectedSale) return;
    if (!selectedNewVariant) {
      setExchangeError(tr('გთხოვთ აირჩიოთ ახალი პროდუქტი გასაცვლელად'));
      return;
    }
    if (newVariantQty < 1) {
      setExchangeError(unitOf(selectedNewVariant.product.unit_type) === 'kg'
        ? tr('მიუთითეთ ახალი პროდუქტის წონა (კგ)')
        : tr('მიუთითეთ ახალი პროდუქტის რაოდენობა'));
      return;
    }
    if (newVariantQty > stockLimit(selectedNewVariant.variant.stock_quantity)) {
      setExchangeError(tr('ახალი პროდუქტის მარაგი არ კმარა ({formatUnitQuantity})', { formatUnitQuantity: formatUnitQuantity(selectedNewVariant.variant.stock_quantity, unitOf(selectedNewVariant.product.unit_type)) }));
      return;
    }

    const payloadReturnItems: any[] = [];
    for (const item of selectedSale.items || []) {
      const st = exchangeReturnItems[item.id];
      if (st && st.qty > 0) {
        payloadReturnItems.push({
          sale_item_id: item.id,
          variant_id: item.variant_id,
          quantity: st.qty,
          condition: st.condition
        });
      }
    }

    if (payloadReturnItems.length === 0) {
      setExchangeError(tr('გთხოვთ აირჩიოთ მინიმუმ 1 დასაბრუნებელი ნივთი'));
      return;
    }

    const preview = exchangePreview;
    if (!preview) return;
    let cashReceived: number | undefined;
    if (preview.due > 0) {
      if ((exchangePayMethod === 'debt' || exchangePayMethod === 'mixed') && !selectedSale.customer_id) {
        setExchangeError(tr('ნისიით გადახდა შესაძლებელია მხოლოდ კლიენტზე გაფორმებული გაყიდვისთვის'));
        return;
      }
      if (exchangePayMethod !== 'debt') {
        const parsed = safeParseTetri(exchangeCashInput);
        if (parsed === null) {
          setExchangeError(tr('მიუთითეთ კლიენტისგან მიღებული ნაღდი თანხა'));
          return;
        }
        if (exchangePayMethod === 'cash' && parsed < preview.due) {
          setExchangeError(tr('მიღებული ნაღდი ნაკლებია გადასახდელზე ({amount})', { amount: formatTetri(preview.due) }));
          return;
        }
        if (exchangePayMethod === 'mixed' && (parsed <= 0 || parsed >= preview.due)) {
          setExchangeError(tr('შერეული გადახდისას ნაღდი უნდა იყოს 0-ზე მეტი და გადასახდელზე ნაკლები'));
          return;
        }
        cashReceived = parsed;
      }
    }

    try {
      setIsSubmitting(true);
      const idempotencyKey = exchangeIdempotencyKeyRef.current || (exchangeIdempotencyKeyRef.current = crypto.randomUUID());
      const res = await invokeIpc<any>('returns:exchange', {
        original_sale_id: selectedSale.id,
        return_items: payloadReturnItems,
        new_items: [{
          variant_id: selectedNewVariant.variant.id,
          quantity: newVariantQty
        }],
        payment_method: preview.due > 0 ? exchangePayMethod : 'cash',
        ...(cashReceived !== undefined ? { cash_received_tetri: cashReceived } : {}),
        idempotency_key: idempotencyKey
      });

      exchangeIdempotencyKeyRef.current = null;

      const lines = [
        tr('გაცვლა წარმატებით განხორციელდა!'),
        tr('დაბრუნებული ნივთ(ებ)ის ღირებულება: {amount}', { amount: formatTetri(res.returned_value_tetri) }),
        tr('ახალი ნივთის ღირებულება: {amount}', { amount: formatTetri(res.new_items_value_tetri) }),
      ];
      if (res.amount_due_tetri > 0) {
        lines.push(tr('კლიენტმა დაამატა: {amount} ({value})', { amount: formatTetri(res.amount_due_tetri), value: exchangePayMethod === 'cash' ? tr('ნაღდი') : exchangePayMethod === 'debt' ? tr('ნისიაზე') : tr('ნაღდი + ნისია') }));
        if (exchangePayMethod === 'cash' && res.new_sale?.change_given_tetri > 0) lines.push(tr('ხურდა: {amount}', { amount: formatTetri(res.new_sale.change_given_tetri) }));
      }
      if (res.debt_deduction_tetri > 0) lines.push(tr('ნისია შემცირდა: {amount}', { amount: formatTetri(res.debt_deduction_tetri) }));
      if (res.cash_refund_tetri > 0) lines.push(tr('კლიენტს დაუბრუნდა ნაღდი: {amount}', { amount: formatTetri(res.cash_refund_tetri) }));
      if (res.amount_due_tetri === 0 && res.cash_refund_tetri === 0 && res.debt_deduction_tetri === 0) lines.push(tr('თანაბარი გაცვლა — ფული არ მოძრაობს'));

      alert(lines.join('\n'));
      setIsExchangeModalOpen(false);
      await loadData();
    } catch (err: any) {
      setExchangeError(trServer(err.message) || tr('გაცვლის შეცდომა'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Filtered views based on tabs
  const displayedSales = sales.filter(s => {
    if (activeTab === 'all_sales') return true;
    if (activeTab === 'exchanges') return s.sale_type === 'exchange';
    if (activeTab === 'debts') return s.debt_amount_tetri > 0;
    return true;
  });

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-2.5 sm:p-4 lg:p-6 overflow-hidden min-h-0 select-none">
      
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 mb-3 lg:mb-4 shrink-0">
        <div>
          <h1 className="text-base sm:text-lg lg:text-xl font-bold text-white flex items-center space-x-2">
            <History className="w-5 h-5 lg:w-6 lg:h-6 text-emerald-400" />
            <span>{tr('გაყიდვების, დაბრუნებებისა და ნისიების ისტორია')}</span>
          </h1>
          <p className="text-[10px] sm:text-[11px] lg:text-xs text-slate-400 mt-0.5">{tr('ტრანზაქციების რეესტრი, დაბრუნების და გაცვლის სრული აღრიცხვა')}</p>
        </div>

        <div className="relative w-full sm:w-64 lg:w-80">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={tr('ძებნა ჩეკით / კლიენტით / კოდით...')}
            className="w-full pl-8 pr-3 py-1.5 sm:py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2 sm:top-2.5" />
        </div>
      </div>

      {/* 4 History Navigation Tabs */}
      <div className="flex items-center gap-1.5 sm:gap-2 mb-3 shrink-0 overflow-x-auto scrollbar-none pb-0.5">
        <button
          onClick={() => setActiveTab('all_sales')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'all_sales'
              ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <Receipt className="w-3.5 h-3.5" />
          <span>{tr('ყველა გაყიდვა ({length})', { length: sales.length })}</span>
        </button>

        <button
          onClick={() => setActiveTab('returns')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'returns'
              ? 'bg-amber-600 text-white shadow-md shadow-amber-950/40'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>{tr('დაბრუნებები ({length})', { length: returnsList.length })}</span>
        </button>

        <button
          onClick={() => setActiveTab('exchanges')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'exchanges'
              ? 'bg-blue-600 text-white shadow-md shadow-blue-950/40'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <ArrowRightLeft className="w-3.5 h-3.5" />
          <span>{tr('გაცვლები ({length})', { length: sales.filter(s => s.sale_type === 'exchange').length })}</span>
        </button>

        <button
          onClick={() => setActiveTab('debts')}
          className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
            activeTab === 'debts'
              ? 'bg-purple-600 text-white shadow-md shadow-purple-950/40'
              : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          <span>{tr('ნისიები ({length})', { length: sales.filter(s => s.debt_amount_tetri > 0).length })}</span>
        </button>
      </div>

      {/* Main 2-column layout */}
      <div className="flex-1 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden min-h-0">
        
        {/* Left Column: Transaction List */}
        <div className="w-full lg:w-5/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden min-h-0 max-h-[38vh] lg:max-h-none shrink-0 lg:shrink">
          
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 min-h-0">
            {activeTab === 'returns' ? (
              // Dedicated Returns listing tab
              returnsList.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">{tr('დაბრუნებები არ ფიქსირდება')}</div>
              ) : (
                returnsList.map((ret) => (
                  <div
                    key={ret.id}
                    onClick={() => {
                      setSelectedSaleId(ret.sale_id);
                    }}
                    className={`p-3 sm:p-3.5 transition-all cursor-pointer flex items-center justify-between hover:bg-slate-800/50 ${
                      selectedSaleId === ret.sale_id ? 'bg-slate-800/80 border-l-4 border-amber-500' : ''
                    }`}
                  >
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-mono font-bold text-xs text-amber-400">{tr('ჩეკი #{value}', { value: ret.receipt_number || ret.sale_id })}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 text-amber-300 border border-amber-800/60 flex items-center space-x-1">
                          <RotateCcw className="w-2.5 h-2.5" />
                          <span>{ret.return_type === 'exchange' ? tr('გაცვლა') : tr('დაბრუნება')}</span>
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {ret.condition === 'resellable' ? tr('✓ ვარგისი') : tr('⚠ დაზიანებული')}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1">{tr('{date} • მიიღო: {user_name}', { date: fmtDateTime(ret.created_at), user_name: ret.user_name })}</div>
                      {ret.customer_name && (
                        <div className="text-[11px] text-slate-300 mt-0.5 font-medium">{tr('კლიენტი: {customer_name}', { customer_name: ret.customer_name })}</div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className="text-sm sm:text-base font-extrabold text-amber-400 tabular-nums">
                        -{formatTetri(ret.total_refund_tetri)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {ret.debt_deduction_tetri > 0 ? tr('ვალი: -{amount}', { amount: formatTetri(ret.debt_deduction_tetri) }) : tr('ნაღდი: {amount}', { amount: formatTetri(ret.cash_refund_tetri) })}
                      </div>
                    </div>
                  </div>
                ))
              )
            ) : (
              // Sales, Exchanges, Debts listing
              displayedSales.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">{tr('ჩანაწერები არ მოიძებნა')}</div>
              ) : (
                displayedSales.map((s) => {
                  const isSelected = s.id === selectedSaleId;
                  const isExchange = s.sale_type === 'exchange';
                  const hasOpenDebt = (s.debt_remaining_tetri || 0) > 0;
                  const isFullyRepaidDebt = s.debt_amount_tetri > 0 && !hasOpenDebt;

                  return (
                    <div
                      key={s.id}
                      onClick={() => setSelectedSaleId(s.id)}
                      className={`p-3 sm:p-3.5 transition-all cursor-pointer flex items-center justify-between ${
                        isSelected ? 'bg-slate-800/90 border-l-4 border-emerald-500' : 'hover:bg-slate-800/40'
                      }`}
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center flex-wrap gap-1.5">
                          <span className="font-mono font-bold text-xs text-emerald-400">{s.receipt_number}</span>
                          
                          {/* Distinct status badge */}
                          {isExchange && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-950/70 text-blue-300 border border-blue-800 flex items-center space-x-1">
                              <ArrowRightLeft className="w-2.5 h-2.5" />
                              <span>{tr('გაცვლა')}</span>
                            </span>
                          )}

                          {s.status === 'completed' && !isExchange && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 flex items-center space-x-1">
                              <Check className="w-2.5 h-2.5" />
                              <span>{tr('დასრულებული')}</span>
                            </span>
                          )}

                          {s.status === 'partially_returned' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 text-amber-400 border border-amber-800/50 flex items-center space-x-1">
                              <RotateCcw className="w-2.5 h-2.5" />
                              <span>{tr('ნაწილ. დაბრუნებული')}</span>
                            </span>
                          )}

                          {s.status === 'returned' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950/60 text-red-400 border border-red-800/50 flex items-center space-x-1">
                              <RotateCcw className="w-2.5 h-2.5" />
                              <span>{tr('სრულად დაბრუნებული')}</span>
                            </span>
                          )}

                          {hasOpenDebt && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-950/60 text-purple-300 border border-purple-800 flex items-center space-x-1">
                              <Clock className="w-2.5 h-2.5" />
                              <span>{tr('აქტიური ნისია')}</span>
                            </span>
                          )}

                          {isFullyRepaidDebt && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">{tr('ნისია დაფარულია')}</span>
                          )}
                        </div>

                        <div className="text-[11px] text-slate-400 mt-1 truncate">
                          {fmtDateTime(s.created_at)} &bull; {s.user_name}
                        </div>

                        {s.customer_name && (
                          <div className="text-[11px] text-slate-300 font-medium mt-0.5 truncate">{tr('კლიენტი: {customer_name}', { customer_name: s.customer_name })}</div>
                        )}
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-sm sm:text-base font-extrabold text-white tabular-nums">
                          {formatTetri(s.total_tetri)}
                        </div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">
                          {s.payment_method === 'cash' ? tr('ნაღდი') : s.payment_method === 'debt' ? tr('ნისია') : tr('შერეული')}
                        </div>
                        {hasOpenDebt && (
                          <div className="text-[10px] font-bold text-amber-400 tabular-nums">{tr('ვალი: {amount}', { amount: formatTetri(s.debt_remaining_tetri) })}</div>
                        )}
                      </div>
                    </div>
                  );
                })
              )
            )}

            {activeTab !== 'returns' && sales.length >= salesLimit && (
              <div className="p-3 text-center border-t border-slate-800 shrink-0">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold rounded-xl transition-colors cursor-pointer w-full"
                >{tr('მაჩვენე მეტი (შემდეგი 50)')}</button>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Transaction Details, Receipts, Items & Actions */}
        <div className="w-full lg:w-7/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden p-3 sm:p-5 min-h-0 flex-1">
          {selectedSale ? (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              
              {/* Receipt Header & Action Buttons */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-800 pb-3 sm:pb-4 mb-3 sm:mb-4 shrink-0">
                <div>
                  <div className="flex items-center space-x-2">
                    <Receipt className="w-5 h-5 text-emerald-400" />
                    <h2 className="text-base sm:text-lg font-mono font-bold text-white">{selectedSale.receipt_number}</h2>
                    {selectedSale.sale_type === 'exchange' && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-900/60 text-blue-300 border border-blue-700">{tr('გაცვლითი გაყიდვა')}</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">{tr('თარიღი: {date} • გამყიდველი: {user_name}', { date: fmtDateTime(selectedSale.created_at), user_name: selectedSale.user_name })}</div>
                  {selectedSale.customer_name && (
                    <div className="text-xs text-slate-300 font-semibold mt-0.5">{tr('კლიენტი: {customer_name}', { customer_name: selectedSale.customer_name })}</div>
                  )}
                </div>

                {selectedSale.status !== 'returned' && (canReturn || canExchange) && (
                  <div className="flex items-center space-x-2">
                    {canReturn && <button
                      onClick={openReturnModal}
                      className="px-3 py-1.5 sm:px-3.5 sm:py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-md shadow-amber-950/40 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>{tr('დაბრუნება')}</span>
                    </button>}

                    {canExchange && <button
                      onClick={openExchangeModal}
                      className="px-3 py-1.5 sm:px-3.5 sm:py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-md shadow-blue-950/40 cursor-pointer"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                      <span>{tr('გაცვლა')}</span>
                    </button>}
                  </div>
                )}
              </div>

              {/* Payment Summary Box */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-950 p-2.5 sm:p-3 rounded-xl border border-slate-800 mb-3 sm:mb-4 text-xs shrink-0">
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">{tr('მეთოდი')}</div>
                  <div className="font-bold text-white mt-0.5">
                    {selectedSale.payment_method === 'cash' ? tr('ნაღდი') : selectedSale.payment_method === 'debt' ? tr('ნისია') : tr('შერეული')}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">{tr('ჯამური თანხა')}</div>
                  <div className="font-bold text-emerald-400 mt-0.5 text-xs sm:text-sm tabular-nums">{formatTetri(selectedSale.total_tetri)}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">{tr('ნაღდად მიღებული')}</div>
                  <div className="font-bold text-white mt-0.5 tabular-nums">{formatTetri(selectedSale.cash_received_tetri)}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">{tr('დარჩენილი ნისია')}</div>
                  <div className="font-bold text-amber-400 mt-0.5 tabular-nums">
                    {formatTetri(selectedSale.debt_remaining_tetri !== undefined ? selectedSale.debt_remaining_tetri : selectedSale.debt_amount_tetri)}
                  </div>
                </div>
              </div>

              {/* Items Table */}
              <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto overflow-y-auto min-h-0 mb-3">
                <table className="w-full text-left text-xs min-w-[500px]">
                  <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                    <tr>
                      <th className="py-2 px-3">{tr('პროდუქტი')}</th>
                      <th className="py-2 px-3">{tr('კოდი')}</th>
                      <th className="py-2 px-3 text-right">{tr('გაყიდული')}</th>
                      <th className="py-2 px-3 text-right">{tr('ფასი')}</th>
                      <th className="py-2 px-3 text-right">{tr('ჯამი')}</th>
                      <th className="py-2 px-3 text-center">{tr('დაბრუნებული')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {selectedSale.items?.map((it) => (
                      <tr key={it.id} className="hover:bg-slate-900/40">
                        <td className="py-2 px-3 font-semibold text-white">
                          {it.product_name_snap} {it.variant_name_snap ? `(${it.variant_name_snap})` : ''}
                        </td>
                        <td className="py-2 px-3 font-mono text-emerald-400 whitespace-nowrap">
                          {it.code_snap || '-'}
                        </td>
                        <td className="py-2 px-3 text-right font-bold text-white tabular-nums whitespace-nowrap">
                          {formatUnitQuantity(it.quantity, unitOf(it.unit_type))}
                        </td>
                        <td className="py-2 px-3 text-right text-slate-300 tabular-nums whitespace-nowrap">
                          {formatTetri(it.unit_price_tetri)}
                        </td>
                        <td className="py-2 px-3 text-right font-extrabold text-white tabular-nums whitespace-nowrap">
                          {formatTetri(it.total_price_tetri)}
                        </td>
                        <td className="py-2 px-3 text-center whitespace-nowrap">
                          {it.returned_quantity > 0 ? (
                            <span className="px-2 py-0.5 bg-red-950/60 text-red-400 rounded-full font-bold text-[10px]">
                              {formatUnitQuantity(it.returned_quantity, unitOf(it.unit_type))}
                            </span>
                          ) : (
                            <span className="text-slate-600">-</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Linked Returns section (if any return happened for this sale) */}
              {(selectedSale as any).returns && (selectedSale as any).returns.length > 0 && (
                <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 shrink-0">
                  <div className="text-xs font-bold text-amber-400 flex items-center space-x-1.5 mb-2">
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>{tr('ამ გაყიდვის დაბრუნების ჩანაწერები (Linked Returns):')}</span>
                  </div>
                  <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                    {(selectedSale as any).returns.map((ret: any) => (
                      <div key={ret.id} className="bg-slate-900 p-2 rounded-lg text-xs flex items-center justify-between border border-slate-800">
                        <div>
                          <span className="text-slate-300 font-medium">
                            {fmtDateTime(ret.created_at)}
                          </span>
                          <span className="text-slate-400 ml-2">
                            ({ret.condition === 'resellable' ? tr('ვარგისი/მარაგში') : tr('დაზიანებული')})
                          </span>
                          {ret.reason && <span className="text-slate-400 ml-2">&bull; {trServer(ret.reason)}</span>}
                        </div>
                        <div className="text-right tabular-nums">
                          <span className="font-bold text-amber-400">-{formatTetri(ret.total_refund_tetri)}</span>
                          {ret.debt_deduction_tetri > 0 && (
                            <span className="text-[10px] text-purple-300 ml-2">{tr('(ვალი: -{amount})', { amount: formatTetri(ret.debt_deduction_tetri) })}</span>
                          )}
                          {ret.cash_refund_tetri > 0 && (
                            <span className="text-[10px] text-emerald-300 ml-2">{tr('(ნაღდი: {amount})', { amount: formatTetri(ret.cash_refund_tetri) })}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs">{tr('აირჩიეთ ტრანზაქცია სიიდან დეტალების სანახავად')}</div>
          )}
        </div>

      </div>

      {/* --- MODAL 1: Process Return --- */}
      {isReturnModalOpen && selectedSale && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <RotateCcw className="w-5 h-5 text-amber-400" />
                <span>{tr('პროდუქტის დაბრუნება (ჩეკი #{receipt_number})', { receipt_number: selectedSale.receipt_number })}</span>
              </h3>
              <button onClick={() => setIsReturnModalOpen(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0">
              {returnError && (
                <div className="mb-4 p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-xs flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <span>{returnError}</span>
                </div>
              )}

              <form id="return-form" onSubmit={handleReturnSubmit} className="space-y-4">
                <div className="text-xs text-slate-300">{tr('აირჩიეთ დასაბრუნებელი რაოდენობა და ნივთის მდგომარეობა:')}</div>

                <div className="space-y-3">
                  {selectedSale.items?.map((item) => {
                    const maxReturnable = item.quantity - item.returned_quantity;
                    if (maxReturnable <= 0) return null;

                    const st = returnItemsState[item.id] || { qty: 0, condition: 'resellable' };

                    return (
                      <div key={item.id} className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2 text-xs">
                        <div className="flex justify-between font-bold text-white">
                          <span>{item.product_name_snap} ({item.variant_name_snap})</span>
                          <span className="tabular-nums">{formatTetri(item.unit_price_tetri)} / {unitOf(item.unit_type) === 'kg' ? tr('კგ') : tr('ც')}</span>
                        </div>

                        <div className="text-slate-400">{tr('დარჩენილი დაბრუნებადი:')}{' '}<span className="text-emerald-400 font-bold tabular-nums">{formatUnitQuantity(maxReturnable, unitOf(item.unit_type))}</span>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">
                              {unitOf(item.unit_type) === 'kg' ? tr('დასაბრუნებელი წონა (კგ)') : tr('დასაბრუნებელი რაოდენობა')}
                            </label>
                            <ReturnQuantityField
                              unit={unitOf(item.unit_type)}
                              max={maxReturnable}
                              value={st.qty}
                              onChange={(qty) => setReturnItemsState(prev => ({ ...prev, [item.id]: { ...st, qty } }))}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white font-bold tabular-nums"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">{tr('მდგომარეობა')}</label>
                            <select
                              value={st.condition}
                              onChange={(e) => {
                                setReturnItemsState(prev => ({
                                  ...prev,
                                  [item.id]: { ...st, condition: e.target.value as any }
                                }));
                              }}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs"
                            >
                              <option value="resellable">{tr('ვარგისი (დაემატება მარაგს)')}</option>
                              <option value="damaged">{tr('დაზიანებული (ჩამოიწერება)')}</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">{tr('დაბრუნების მიზეზი (სურვილისამებრ)')}</label>
                  <input
                    type="text"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    placeholder={tr('მაგ. ზომა არ მოერგო, დეფექტი...')}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                  />
                </div>
              </form>
            </div>

            <div className="flex space-x-2 p-4 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsReturnModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700 cursor-pointer"
              >{tr('გაუქმება')}</button>
              <button
                type="submit"
                form="return-form"
                disabled={isSubmitting}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-900/40 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? tr('სრულდება...') : tr('დაბრუნების დადასტურება')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL 2: Process Exchange (გაცვლა) --- */}
      {isExchangeModalOpen && selectedSale && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <ArrowRightLeft className="w-5 h-5 text-blue-400" />
                <span>{tr('პროდუქტის გაცვლა (ჩეკი #{receipt_number})', { receipt_number: selectedSale.receipt_number })}</span>
              </h3>
              <button onClick={() => setIsExchangeModalOpen(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0 space-y-4">
              {exchangeError && (
                <div className="p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-xs flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{exchangeError}</span>
                </div>
              )}

              {/* 1. Step: Select which sold items to return */}
              <div>
                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">{tr('1. აირჩიეთ დასაბრუნებელი ნივთი ამ ჩეკიდან:')}</h4>
                <div className="space-y-2">
                  {selectedSale.items?.map((item) => {
                    const maxReturnable = item.quantity - item.returned_quantity;
                    if (maxReturnable <= 0) return null;
                    const st = exchangeReturnItems[item.id] || { qty: 0, condition: 'resellable' };

                    return (
                      <div key={item.id} className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
                        <div>
                          <div className="font-semibold text-white">{item.product_name_snap} ({item.variant_name_snap})</div>
                          <div className="text-[11px] text-slate-400">{tr('ფასი: {amount}{value} • დარჩენილი: {formatUnitQuantity}', { amount: formatTetri(item.unit_price_tetri), value: unitOf(item.unit_type) === 'kg' ? tr(' / კგ') : '', formatUnitQuantity: formatUnitQuantity(maxReturnable, unitOf(item.unit_type)) })}</div>
                        </div>

                        <div className="flex items-center space-x-2">
                          <ReturnQuantityField
                            unit={unitOf(item.unit_type)}
                            max={maxReturnable}
                            value={st.qty}
                            onChange={(qty) => setExchangeReturnItems(prev => ({ ...prev, [item.id]: { ...st, qty } }))}
                            className="w-20 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-center text-white font-bold tabular-nums"
                          />
                          <span className="text-slate-400">{unitOf(item.unit_type) === 'kg' ? tr('კგ') : tr('ცალი')}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2. Step: Choose new replacement product */}
              <div>
                <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-2">{tr('2. აირჩიეთ ახალი პროდუქტი გასაცვლელად:')}</h4>
                <div className="relative mb-2">
                  <input
                    type="text"
                    value={exchangeSearch}
                    onChange={(e) => setExchangeSearch(e.target.value)}
                    placeholder={tr('მოძებნეთ პროდუქტი სახელით ან კოდით...')}
                    className="w-full pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-white"
                  />
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2" />
                </div>

                <div className="max-h-40 overflow-y-auto space-y-1.5 border border-slate-800 rounded-xl p-2 bg-slate-950">
                  {allProducts.flatMap(p => (p.variants || []).map(v => ({ product: p, variant: v })))
                    .filter(({ product, variant }) => {
                      if (!exchangeSearch.trim()) return true;
                      const term = exchangeSearch.toLowerCase();
                      const matchName = product.name.toLowerCase().includes(term);
                      const matchCode = variant.codes?.some(c => c.code_value.includes(term));
                      return matchName || matchCode;
                    })
                    .slice(0, 30)
                    .map(({ product, variant }) => {
                      const isChosen = selectedNewVariant?.variant.id === variant.id;
                      const effectivePrice = variant.price_override_tetri ?? product.base_price_tetri;

                      return (
                        <div
                          key={variant.id}
                          onClick={() => {
                            setSelectedNewVariant({ product, variant });
                            // Pieces start at 1; a weight must be entered (no invented default weight).
                            setNewVariantQty(unitOf(product.unit_type) === 'kg' ? 0 : 1);
                          }}
                          className={`p-2 rounded-lg cursor-pointer flex items-center justify-between text-xs transition-colors ${
                            isChosen ? 'bg-blue-900/60 border border-blue-600' : 'hover:bg-slate-900 border border-transparent'
                          }`}
                        >
                          <div>
                            <span className="font-bold text-white">{product.name}</span>
                            <span className="text-slate-400 ml-1.5">({variant.variant_name})</span>
                          </div>
                          <div className="text-right">
                            <span className="font-bold text-emerald-400">{formatTetri(effectivePrice)}</span>
                            {unitOf(product.unit_type) === 'kg' && <span className="text-[10px] text-slate-400">{' '}{tr('/ კგ')}</span>}
                            {hasStockNumber(variant.stock_quantity) && <span className="text-[10px] text-slate-400 ml-2">{tr('მარაგი: {formatUnitQuantity}', { formatUnitQuantity: formatUnitQuantity(variant.stock_quantity, unitOf(product.unit_type)) })}</span>}
                          </div>
                        </div>
                      );
                    })}
                </div>

                {selectedNewVariant && (
                  <div className="mt-2 flex items-center justify-between gap-3 bg-slate-950 p-2.5 rounded-xl border border-blue-900/50 text-xs">
                    <label className="text-slate-300 font-semibold">
                      {unitOf(selectedNewVariant.product.unit_type) === 'kg' ? tr('ახალი პროდუქტის წონა (კგ)') : tr('ახალი პროდუქტის რაოდენობა (ცალი)')}
                    </label>
                    {unitOf(selectedNewVariant.product.unit_type) === 'kg' ? (
                      <EditableWeightInput
                        maxGrams={stockLimit(selectedNewVariant.variant.stock_quantity)}
                        value={newVariantQty > 0 ? gramsToField(newVariantQty) : ''}
                        onChange={(val) => setNewVariantQty(weightToGrams(val) ?? 0)}
                        className="w-24 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-center text-white font-bold tabular-nums"
                        ariaLabel={tr('ახალი პროდუქტის წონა (კგ)')}
                      />
                    ) : (
                      <EditableIntegerInput
                        min={1}
                        max={stockLimit(selectedNewVariant.variant.stock_quantity)}
                        value={newVariantQty > 0 ? newVariantQty : ''}
                        onChange={(val) => setNewVariantQty(val === '' ? 0 : val)}
                        className="w-20 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-center text-white font-bold tabular-nums"
                        ariaLabel={tr('ახალი პროდუქტის რაოდენობა')}
                      />
                    )}
                  </div>
                )}
              </div>

              {/* 3. Settlement: credit pays the new goods; excess reduces debt, then cash back */}
              {selectedNewVariant && exchangePreview && (
                <div className="bg-slate-950 p-3 rounded-xl border border-blue-900/50 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>{tr('დაბრუნებული ნივთ(ებ)ის ღირებულება (გადახდილი ფასით):')}</span>
                    <span className="font-bold text-amber-400 tabular-nums">{formatTetri(exchangePreview.returned)}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>{tr('ახალი ნივთის ღირებულება:')}</span>
                    <span className="font-bold text-blue-400 tabular-nums">{formatTetri(exchangePreview.newValue)}</span>
                  </div>
                  {exchangePreview.debtReduction > 0 && (
                    <div className="flex justify-between text-slate-400">
                      <span>{tr('ნისია შემცირდება:')}</span>
                      <span className="font-bold text-amber-300 tabular-nums">{formatTetri(exchangePreview.debtReduction)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm font-extrabold pt-1 border-t border-slate-800">
                    {exchangePreview.due > 0 ? (
                      <><span className="text-white">{tr('კლიენტი ამატებს:')}</span><span className="text-emerald-400 tabular-nums">{formatTetri(exchangePreview.due)}</span></>
                    ) : exchangePreview.cashBack > 0 ? (
                      <><span className="text-white">{tr('მაღაზია უბრუნებს ნაღდს:')}</span><span className="text-amber-400 tabular-nums">{formatTetri(exchangePreview.cashBack)}</span></>
                    ) : (
                      <><span className="text-white">{tr('თანაბარი გაცვლა')}</span><span className="text-slate-300">{tr('ფული არ მოძრაობს')}</span></>
                    )}
                  </div>

                  {exchangePreview.due > 0 && (
                    <div className="pt-2 space-y-2">
                      <div className="flex gap-1.5">
                        {(['cash', 'debt', 'mixed'] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            disabled={(m !== 'cash' && !selectedSale.customer_id) || !canPayExchange[m]}
                            onClick={() => setExchangePayMethod(m)}
                            className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold border cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${exchangePayMethod === m ? 'bg-blue-600 border-blue-500 text-white' : 'bg-slate-900 border-slate-700 text-slate-300'}`}
                          >
                            {m === 'cash' ? tr('ნაღდი') : m === 'debt' ? tr('ნისია') : tr('ნაღდი + ნისია')}
                          </button>
                        ))}
                      </div>
                      {!selectedSale.customer_id && (
                        <p className="text-[10px] text-slate-500">{tr('ნისია ხელმისაწვდომია მხოლოდ კლიენტზე გაფორმებული გაყიდვისთვის.')}</p>
                      )}
                      {exchangePayMethod !== 'debt' && (
                        <input
                          inputMode="decimal"
                          value={exchangeCashInput}
                          onChange={(e) => setExchangeCashInput(e.target.value)}
                          placeholder={exchangePayMethod === 'cash' ? tr('მიღებული ნაღდი (მინ. {amount})', { amount: formatTetri(exchangePreview.due, false) }) : tr('ახლა გადახდილი ნაღდი')}
                          className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm font-bold tabular-nums focus:outline-none focus:border-blue-500"
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex space-x-2 p-4 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsExchangeModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700 cursor-pointer"
              >{tr('გაუქმება')}</button>
              <button
                type="button"
                onClick={handleExchangeSubmit}
                disabled={isSubmitting}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-blue-900/40 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? tr('სრულდება...') : tr('გაცვლის დადასტურება')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
