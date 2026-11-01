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

import React, { useState, useEffect } from 'react';
import { Sale, User, ReturnRecord, Product, ProductVariant } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
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

interface SalesHistoryViewProps {
  currentUser: User;
}

type HistoryTab = 'all_sales' | 'returns' | 'exchanges' | 'debts';

export const SalesHistoryView: React.FC<SalesHistoryViewProps> = ({ currentUser }) => {
  const [activeTab, setActiveTab] = useState<HistoryTab>('all_sales');
  const [sales, setSales] = useState<Sale[]>([]);
  const [returnsList, setReturnsList] = useState<ReturnRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);

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

  const loadData = async () => {
    try {
      setLoading(true);
      const [salesData, returnsData] = await Promise.all([
        invokeIpc<Sale[]>('pos:searchSales', {
          searchTerm: searchTerm || undefined,
          limit: 150
        }),
        invokeIpc<ReturnRecord[]>('returns:list', { limit: 100 })
      ]);

      setSales(salesData);
      setReturnsList(returnsData);

      if (salesData.length > 0 && !selectedSaleId) {
        setSelectedSaleId(salesData[0].id);
      }
    } catch (err) {
      console.error('Failed to load sales history data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [searchTerm]);

  // Load products catalogue for exchange modal when opened
  const openExchangeModal = async () => {
    if (!selectedSale) return;
    setExchangeError('');
    setSelectedNewVariant(null);
    setNewVariantQty(1);

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
      alert('პროდუქტების კატალოგის ჩატვირთვა ვერ მოხერხდა: ' + e.message);
    }
  };

  const selectedSale = sales.find(s => s.id === selectedSaleId) || null;

  const openReturnModal = () => {
    if (!selectedSale) return;
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
      setReturnError('გთხოვთ აირჩიოთ მინიმუმ 1 დასაბრუნებელი პროდუქტი (რაოდენობა > 0)');
      return;
    }

    try {
      setIsSubmitting(true);
      const res = await invokeIpc('returns:process', {
        sale_id: selectedSale.id,
        items: payloadItems,
        reason: returnReason.trim() || undefined,
        idempotency_key: `ret_${selectedSale.id}_${Date.now()}`
      });

      alert(
        `დაბრუნება წარმატებით გაფორმდა!\n` +
        `ჯამური დასაბრუნებელი თანხა: ${formatTetri(res.total_refund_tetri)}\n` +
        `ჩამოწერილი ვალი: ${formatTetri(res.debt_deduction_tetri)}\n` +
        `დაბრუნებული ნაღდი ფული: ${formatTetri(res.cash_refund_tetri)}`
      );

      setIsReturnModalOpen(false);
      setReturnReason('');
      await loadData();
    } catch (err: any) {
      setReturnError(err.message || 'დაბრუნების შეცდომა');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleExchangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setExchangeError('');

    if (!selectedSale) return;
    if (!selectedNewVariant) {
      setExchangeError('გთხოვთ აირჩიოთ ახალი პროდუქტი გასაცვლელად');
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
      setExchangeError('გთხოვთ აირჩიოთ მინიმუმ 1 დასაბრუნებელი ნივთი');
      return;
    }

    const newUnitPriceTetri = selectedNewVariant.variant.price_override_tetri ?? selectedNewVariant.product.base_price_tetri;

    try {
      setIsSubmitting(true);
      const res = await invokeIpc('returns:exchange', {
        original_sale_id: selectedSale.id,
        return_items: payloadReturnItems,
        new_items: [{
          variant_id: selectedNewVariant.variant.id,
          quantity: newVariantQty,
          unit_price_tetri: newUnitPriceTetri
        }],
        idempotency_key: `exch_${selectedSale.id}_${Date.now()}`
      });

      const diff = res.difference_tetri;
      let msg = 'გაცვლა წარმატებით განხორციელდა!\n';
      if (diff > 0) {
        msg += `კლიენტმა დაამატა ნაღდი: ${formatTetri(diff)}`;
      } else if (diff < 0) {
        msg += `კლიენტს დაუბრუნდა ნაღდი: ${formatTetri(-diff)}`;
      } else {
        msg += 'თანაბარი გაცვლა (სხვაობის გარეშე)';
      }

      alert(msg);
      setIsExchangeModalOpen(false);
      await loadData();
    } catch (err: any) {
      setExchangeError(err.message || 'გაცვლის შეცდომა');
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
            <span>გაყიდვების, დაბრუნებებისა და ნისიების ისტორია</span>
          </h1>
          <p className="text-[10px] sm:text-[11px] lg:text-xs text-slate-400 mt-0.5">
            ტრანზაქციების რეესტრი, დაბრუნების და გაცვლის სრული აღრიცხვა
          </p>
        </div>

        <div className="relative w-full sm:w-64 lg:w-80">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="ძებნა ჩეკით / კლიენტით / კოდით..."
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
          <span>ყველა გაყიდვა ({sales.length})</span>
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
          <span>დაბრუნებები ({returnsList.length})</span>
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
          <span>გაცვლები ({sales.filter(s => s.sale_type === 'exchange').length})</span>
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
          <span>ნისიები ({sales.filter(s => s.debt_amount_tetri > 0).length})</span>
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
                <div className="p-8 text-center text-xs text-slate-400">დაბრუნებები არ ფიქსირდება</div>
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
                        <span className="font-mono font-bold text-xs text-amber-400">ჩეკი #{ret.receipt_number || ret.sale_id}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 text-amber-300 border border-amber-800/60 flex items-center space-x-1">
                          <RotateCcw className="w-2.5 h-2.5" />
                          <span>{ret.return_type === 'exchange' ? 'გაცვლა' : 'დაბრუნება'}</span>
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {ret.condition === 'resellable' ? '✓ ვარგისი' : '⚠ დაზიანებული'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1">
                        {new Date(ret.created_at).toLocaleString('ka-GE')} &bull; მიიღო: {ret.user_name}
                      </div>
                      {ret.customer_name && (
                        <div className="text-[11px] text-slate-300 mt-0.5 font-medium">
                          კლიენტი: {ret.customer_name}
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className="text-sm sm:text-base font-extrabold text-amber-400 tabular-nums">
                        -{formatTetri(ret.total_refund_tetri)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {ret.debt_deduction_tetri > 0 ? `ვალი: -${formatTetri(ret.debt_deduction_tetri)}` : `ნაღდი: ${formatTetri(ret.cash_refund_tetri)}`}
                      </div>
                    </div>
                  </div>
                ))
              )
            ) : (
              // Sales, Exchanges, Debts listing
              displayedSales.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400">ჩანაწერები არ მოიძებნა</div>
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
                              <span>გაცვლა</span>
                            </span>
                          )}

                          {s.status === 'completed' && !isExchange && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 flex items-center space-x-1">
                              <Check className="w-2.5 h-2.5" />
                              <span>დასრულებული</span>
                            </span>
                          )}

                          {s.status === 'partially_returned' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 text-amber-400 border border-amber-800/50 flex items-center space-x-1">
                              <RotateCcw className="w-2.5 h-2.5" />
                              <span>ნაწილ. დაბრუნებული</span>
                            </span>
                          )}

                          {s.status === 'returned' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-950/60 text-red-400 border border-red-800/50 flex items-center space-x-1">
                              <RotateCcw className="w-2.5 h-2.5" />
                              <span>სრულად დაბრუნებული</span>
                            </span>
                          )}

                          {hasOpenDebt && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-950/60 text-purple-300 border border-purple-800 flex items-center space-x-1">
                              <Clock className="w-2.5 h-2.5" />
                              <span>აქტიური ნისია</span>
                            </span>
                          )}

                          {isFullyRepaidDebt && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              ნისია დაფარულია
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-slate-400 mt-1 truncate">
                          {new Date(s.created_at).toLocaleString('ka-GE')} &bull; {s.user_name}
                        </div>

                        {s.customer_name && (
                          <div className="text-[11px] text-slate-300 font-medium mt-0.5 truncate">
                            კლიენტი: {s.customer_name}
                          </div>
                        )}
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-sm sm:text-base font-extrabold text-white tabular-nums">
                          {formatTetri(s.total_tetri)}
                        </div>
                        <div className="text-[10px] sm:text-[11px] text-slate-400">
                          {s.payment_method === 'cash' ? 'ნაღდი' : s.payment_method === 'debt' ? 'ნისია' : 'შერეული'}
                        </div>
                        {hasOpenDebt && (
                          <div className="text-[10px] font-bold text-amber-400 tabular-nums">
                            ვალი: {formatTetri(s.debt_remaining_tetri)}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
              )
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
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-blue-900/60 text-blue-300 border border-blue-700">
                        გაცვლითი გაყიდვა
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    თარიღი: {new Date(selectedSale.created_at).toLocaleString('ka-GE')} &bull; გამყიდველი: {selectedSale.user_name}
                  </div>
                  {selectedSale.customer_name && (
                    <div className="text-xs text-slate-300 font-semibold mt-0.5">
                      კლიენტი: {selectedSale.customer_name}
                    </div>
                  )}
                </div>

                {selectedSale.status !== 'returned' && (
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={openReturnModal}
                      className="px-3 py-1.5 sm:px-3.5 sm:py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-md shadow-amber-950/40 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>დაბრუნება</span>
                    </button>

                    <button
                      onClick={openExchangeModal}
                      className="px-3 py-1.5 sm:px-3.5 sm:py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-md shadow-blue-950/40 cursor-pointer"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                      <span>გაცვლა</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Payment Summary Box */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-950 p-2.5 sm:p-3 rounded-xl border border-slate-800 mb-3 sm:mb-4 text-xs shrink-0">
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">მეთოდი</div>
                  <div className="font-bold text-white mt-0.5">
                    {selectedSale.payment_method === 'cash' ? 'ნაღდი' : selectedSale.payment_method === 'debt' ? 'ნისია' : 'შერეული'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">ჯამური თანხა</div>
                  <div className="font-bold text-emerald-400 mt-0.5 text-xs sm:text-sm tabular-nums">{formatTetri(selectedSale.total_tetri)}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">ნაღდად მიღებული</div>
                  <div className="font-bold text-white mt-0.5 tabular-nums">{formatTetri(selectedSale.cash_received_tetri)}</div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px] uppercase font-semibold">დარჩენილი ნისია</div>
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
                      <th className="py-2 px-3">პროდუქტი</th>
                      <th className="py-2 px-3">კოდი</th>
                      <th className="py-2 px-3 text-right">გაყიდული</th>
                      <th className="py-2 px-3 text-right">ფასი</th>
                      <th className="py-2 px-3 text-right">ჯამი</th>
                      <th className="py-2 px-3 text-center">დაბრუნებული</th>
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
                          {it.quantity} ც
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
                              {it.returned_quantity} ცალი
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
                    <span>ამ გაყიდვის დაბრუნების ჩანაწერები (Linked Returns):</span>
                  </div>
                  <div className="space-y-1.5 max-h-28 overflow-y-auto pr-1">
                    {(selectedSale as any).returns.map((ret: any) => (
                      <div key={ret.id} className="bg-slate-900 p-2 rounded-lg text-xs flex items-center justify-between border border-slate-800">
                        <div>
                          <span className="text-slate-300 font-medium">
                            {new Date(ret.created_at).toLocaleString('ka-GE')}
                          </span>
                          <span className="text-slate-400 ml-2">
                            ({ret.condition === 'resellable' ? 'ვარგისი/მარაგში' : 'დაზიანებული'})
                          </span>
                          {ret.reason && <span className="text-slate-400 ml-2">&bull; {ret.reason}</span>}
                        </div>
                        <div className="text-right tabular-nums">
                          <span className="font-bold text-amber-400">-{formatTetri(ret.total_refund_tetri)}</span>
                          {ret.debt_deduction_tetri > 0 && (
                            <span className="text-[10px] text-purple-300 ml-2">(ვალი: -{formatTetri(ret.debt_deduction_tetri)})</span>
                          )}
                          {ret.cash_refund_tetri > 0 && (
                            <span className="text-[10px] text-emerald-300 ml-2">(ნაღდი: {formatTetri(ret.cash_refund_tetri)})</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs">
              აირჩიეთ ტრანზაქცია სიიდან დეტალების სანახავად
            </div>
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
                <span>პროდუქტის დაბრუნება (ჩეკი #{selectedSale.receipt_number})</span>
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
                <div className="text-xs text-slate-300">
                  აირჩიეთ დასაბრუნებელი რაოდენობა და ნივთის მდგომარეობა:
                </div>

                <div className="space-y-3">
                  {selectedSale.items?.map((item) => {
                    const maxReturnable = item.quantity - item.returned_quantity;
                    if (maxReturnable <= 0) return null;

                    const st = returnItemsState[item.id] || { qty: 0, condition: 'resellable' };

                    return (
                      <div key={item.id} className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2 text-xs">
                        <div className="flex justify-between font-bold text-white">
                          <span>{item.product_name_snap} ({item.variant_name_snap})</span>
                          <span className="tabular-nums">{formatTetri(item.unit_price_tetri)} / ც</span>
                        </div>

                        <div className="text-slate-400">
                          დარჩენილი დაბრუნებადი: <span className="text-emerald-400 font-bold tabular-nums">{maxReturnable} ც</span>
                        </div>

                        <div className="grid grid-cols-2 gap-3 pt-1">
                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">დასაბრუნებელი რაოდენობა</label>
                            <input
                              type="number"
                              min="0"
                              max={maxReturnable}
                              value={st.qty}
                              onChange={(e) => {
                                const val = parseInt(e.target.value, 10) || 0;
                                setReturnItemsState(prev => ({
                                  ...prev,
                                  [item.id]: { ...st, qty: Math.min(maxReturnable, Math.max(0, val)) }
                                }));
                              }}
                              className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-white font-bold tabular-nums"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] text-slate-400 mb-1">მდგომარეობა</label>
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
                              <option value="resellable">ვარგისი (დაემატება მარაგს)</option>
                              <option value="damaged">დაზიანებული (ჩამოიწერება)</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">დაბრუნების მიზეზი (სურვილისამებრ)</label>
                  <input
                    type="text"
                    value={returnReason}
                    onChange={(e) => setReturnReason(e.target.value)}
                    placeholder="მაგ. ზომა არ მოერგო, დეფექტი..."
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
              >
                გაუქმება
              </button>
              <button
                type="submit"
                form="return-form"
                disabled={isSubmitting}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-900/40 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? 'სრულდება...' : 'დაბრუნების დადასტურება'}
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
                <span>პროდუქტის გაცვლა (ჩეკი #{selectedSale.receipt_number})</span>
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
                <h4 className="text-xs font-bold text-amber-400 uppercase tracking-wider mb-2">
                  1. აირჩიეთ დასაბრუნებელი ნივთი ამ ჩეკიდან:
                </h4>
                <div className="space-y-2">
                  {selectedSale.items?.map((item) => {
                    const maxReturnable = item.quantity - item.returned_quantity;
                    if (maxReturnable <= 0) return null;
                    const st = exchangeReturnItems[item.id] || { qty: 0, condition: 'resellable' };

                    return (
                      <div key={item.id} className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 flex items-center justify-between text-xs">
                        <div>
                          <div className="font-semibold text-white">{item.product_name_snap} ({item.variant_name_snap})</div>
                          <div className="text-[11px] text-slate-400">
                            ფასი: {formatTetri(item.unit_price_tetri)} &bull; დარჩენილი: {maxReturnable} ც
                          </div>
                        </div>

                        <div className="flex items-center space-x-2">
                          <input
                            type="number"
                            min="0"
                            max={maxReturnable}
                            value={st.qty}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || 0;
                              setExchangeReturnItems(prev => ({
                                ...prev,
                                [item.id]: { ...st, qty: Math.min(maxReturnable, Math.max(0, val)) }
                              }));
                            }}
                            className="w-16 px-2 py-1 bg-slate-900 border border-slate-700 rounded text-center text-white font-bold tabular-nums"
                          />
                          <span className="text-slate-400">ცალი</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 2. Step: Choose new replacement product */}
              <div>
                <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-2">
                  2. აირჩიეთ ახალი პროდუქტი გასაცვლელად:
                </h4>
                <div className="relative mb-2">
                  <input
                    type="text"
                    value={exchangeSearch}
                    onChange={(e) => setExchangeSearch(e.target.value)}
                    placeholder="მოძებნეთ პროდუქტი სახელით ან კოდით..."
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
                          onClick={() => setSelectedNewVariant({ product, variant })}
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
                            <span className="text-[10px] text-slate-400 ml-2">მარაგი: {variant.stock_quantity} ც</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

              {/* 3. Price Difference Calculation Summary */}
              {selectedNewVariant && (
                <div className="bg-slate-950 p-3 rounded-xl border border-blue-900/50 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>დაბრუნებული ნივთ(ებ)ის ღირებულება:</span>
                    <span className="font-bold text-amber-400 tabular-nums">
                      {formatTetri(
                        selectedSale.items?.reduce((sum, it) => sum + ((exchangeReturnItems[it.id]?.qty || 0) * it.unit_price_tetri), 0) || 0
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>ახალი ნივთის ღირებულება:</span>
                    <span className="font-bold text-blue-400 tabular-nums">
                      {formatTetri((selectedNewVariant.variant.price_override_tetri ?? selectedNewVariant.product.base_price_tetri) * newVariantQty)}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm font-extrabold pt-1 border-t border-slate-800">
                    <span className="text-white">ფასთა სხვაობა (კორექცია):</span>
                    {(() => {
                      const retVal = selectedSale.items?.reduce((sum, it) => sum + ((exchangeReturnItems[it.id]?.qty || 0) * it.unit_price_tetri), 0) || 0;
                      const newVal = (selectedNewVariant.variant.price_override_tetri ?? selectedNewVariant.product.base_price_tetri) * newVariantQty;
                      const diff = newVal - retVal;
                      if (diff > 0) return <span className="text-emerald-400">+კლიენტი ამატებს {formatTetri(diff)}</span>;
                      if (diff < 0) return <span className="text-amber-400">-მაღაზია უბრუნებს {formatTetri(-diff)}</span>;
                      return <span className="text-slate-300">0.00 ₾ (თანაბარი გაცვლა)</span>;
                    })()}
                  </div>
                </div>
              )}
            </div>

            <div className="flex space-x-2 p-4 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsExchangeModalOpen(false)}
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700 cursor-pointer"
              >
                გაუქმება
              </button>
              <button
                type="button"
                onClick={handleExchangeSubmit}
                disabled={isSubmitting}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-blue-900/40 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? 'სრულდება...' : 'გაცვლის დადასტურება'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
