/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Sales History, Returns & Exchanges View.
 * Allows searching past sales, inspecting receipt snapshots, and executing
 * returns or exchanges with debt deduction priority and stock condition handling.
 */

import React, { useState, useEffect } from 'react';
import { Sale, User, Product } from '../../shared/types.ts';
import { formatTetri } from '../../shared/money.ts';
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
  Receipt
} from 'lucide-react';

interface SalesHistoryViewProps {
  currentUser: User;
}

export const SalesHistoryView: React.FC<SalesHistoryViewProps> = ({ currentUser }) => {
  const [sales, setSales] = useState<Sale[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null);

  // Return Modal state
  const [isReturnModalOpen, setIsReturnModalOpen] = useState<boolean>(false);
  const [returnItemsState, setReturnItemsState] = useState<Record<number, { qty: number; condition: 'resellable' | 'damaged' }>>({});
  const [returnReason, setReturnReason] = useState<string>('');
  const [returnError, setReturnError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const loadSales = async () => {
    try {
      setLoading(true);
      const data = await invokeIpc<Sale[]>('pos:searchSales', {
        searchTerm: searchTerm || undefined,
        limit: 100
      });
      setSales(data);
      if (data.length > 0 && !selectedSaleId) {
        setSelectedSaleId(data[0].id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSales();
  }, [searchTerm]);

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
        reason: returnReason.trim() || undefined
      });

      alert(
        `დაბრუნება წარმატებით შესრულდა!\n` +
        `ჯამური თანხა: ${formatTetri(res.total_refund_tetri)}\n` +
        `ჩამოწერილი ვალი: ${formatTetri(res.debt_deduction_tetri)}\n` +
        `დაბრუნებული ნაღდი ფული: ${formatTetri(res.cash_refund_tetri)}`
      );

      setIsReturnModalOpen(false);
      loadSales();
    } catch (err: any) {
      setReturnError(err.message || 'დაბრუნების შეცდომა');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-3 sm:p-4 lg:p-6 overflow-hidden min-h-0 select-none">
      
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 lg:mb-4 shrink-0">
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-white flex items-center space-x-2">
            <History className="w-5 h-5 lg:w-6 lg:h-6 text-emerald-400" />
            <span>გაყიდვების ისტორია, დაბრუნება და გაცვლა</span>
          </h1>
          <p className="text-[11px] lg:text-xs text-slate-400 mt-0.5">ჩეკების არქივი, პროდუქციის დაბრუნება და ვალის/ნაღდის ავტომატური კორექცია</p>
        </div>

        <div className="relative w-full sm:w-72 lg:w-80">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="ძებნა ჩეკის # / კლიენტით / კოდით..."
            className="w-full pl-8 pr-3 py-1.5 sm:py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2 sm:top-2.5" />
        </div>
      </div>

      {/* Main 2-column layout */}
      <div className="flex-1 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden min-h-0">
        
        {/* Left Column: Sales list */}
        <div className="w-full lg:w-5/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden min-h-0 max-h-[38vh] lg:max-h-none shrink-0 lg:shrink">
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 min-h-0">
            {sales.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">გაყიდვები არ მოიძებნა</div>
            ) : (
              sales.map((s) => {
                const isSelected = s.id === selectedSaleId;
                const statusBadge = 
                  s.status === 'completed' ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/50' :
                  s.status === 'returned' ? 'bg-red-950/60 text-red-400 border-red-800/50' :
                  'bg-amber-950/60 text-amber-400 border-amber-800/50';

                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedSaleId(s.id)}
                    className={`p-3 sm:p-3.5 transition-all cursor-pointer flex items-center justify-between ${
                      isSelected ? 'bg-slate-800/90 border-l-4 border-emerald-500' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="font-mono font-bold text-xs text-emerald-400">{s.receipt_number}</span>
                        <span className={`px-1.5 py-0.2 rounded text-[10px] font-bold border ${statusBadge}`}>
                          {s.status === 'completed' ? 'დასრულებული' : s.status === 'returned' ? 'დაბრუნებული' : 'ნაწილობრივ'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1">
                        {new Date(s.created_at).toLocaleString('ka-GE')} &bull; {s.user_name}
                      </div>
                      {s.customer_name && (
                        <div className="text-[11px] text-slate-300 font-medium mt-0.5">
                          კლიენტი: {s.customer_name}
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className="text-sm sm:text-base font-extrabold text-white tabular-nums">
                        {formatTetri(s.total_tetri)}
                      </div>
                      <div className="text-[10px] sm:text-[11px] text-slate-400">
                        {s.payment_method === 'cash' ? 'ნაღდი' : s.payment_method === 'debt' ? 'ნისია' : 'შერეული'}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Receipt Snapshot & Actions */}
        <div className="w-full lg:w-7/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden p-3 sm:p-5 min-h-0 flex-1">
          {selectedSale ? (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              
              {/* Receipt Header */}
              <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-800 pb-3 sm:pb-4 mb-3 sm:mb-4 shrink-0">
                <div>
                  <div className="flex items-center space-x-2">
                    <Receipt className="w-5 h-5 text-emerald-400" />
                    <h2 className="text-base sm:text-lg font-mono font-bold text-white">{selectedSale.receipt_number}</h2>
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    თარიღი: {new Date(selectedSale.created_at).toLocaleString('ka-GE')} &bull; მოლარე: {selectedSale.user_name}
                  </div>
                </div>

                {selectedSale.status !== 'returned' && (
                  <button
                    onClick={openReturnModal}
                    className="px-3.5 py-2 sm:px-4 sm:py-2 bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-amber-900/30 cursor-pointer"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>პროდუქტის დაბრუნება</span>
                  </button>
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
                  <div className="font-bold text-amber-400 mt-0.5 tabular-nums">{formatTetri(selectedSale.debt_amount_tetri)}</div>
                </div>
              </div>

              {/* Items Table */}
              <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto overflow-y-auto min-h-0">
                <table className="w-full text-left text-xs min-w-[500px]">
                  <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3">პროდუქტი</th>
                      <th className="py-2.5 px-3">კოდი</th>
                      <th className="py-2.5 px-3 text-right">რაოდენობა</th>
                      <th className="py-2.5 px-3 text-right">ერთეულის ფასი</th>
                      <th className="py-2.5 px-3 text-right">ჯამი</th>
                      <th className="py-2.5 px-3 text-center">დაბრუნებული</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {selectedSale.items?.map((it) => (
                      <tr key={it.id} className="hover:bg-slate-900/40">
                        <td className="py-2.5 px-3 font-semibold text-white">
                          {it.product_name_snap} {it.variant_name_snap ? `(${it.variant_name_snap})` : ''}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-emerald-400 whitespace-nowrap">
                          {it.code_snap || '-'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-bold text-white tabular-nums whitespace-nowrap">
                          {it.quantity} ც
                        </td>
                        <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums whitespace-nowrap">
                          {formatTetri(it.unit_price_tetri)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-extrabold text-white tabular-nums whitespace-nowrap">
                          {formatTetri(it.total_price_tetri)}
                        </td>
                        <td className="py-2.5 px-3 text-center whitespace-nowrap">
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

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs">
              აირჩიეთ ჩეკი სიიდან დეტალების სანახავად
            </div>
          )}
        </div>

      </div>

      {/* --- MODAL: Process Return --- */}
      {isReturnModalOpen && selectedSale && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-xl w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <RotateCcw className="w-5 h-5 text-amber-400" />
                <span>პროდუქტის დაბრუნება (ჩეკი #{selectedSale.receipt_number})</span>
              </h3>
              <button onClick={() => setIsReturnModalOpen(false)} className="text-slate-400 hover:text-white">
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
                              <option value="resellable">ვარგისი (მარაგში)</option>
                              <option value="damaged">დაზიანებული</option>
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
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700"
              >
                გაუქმება
              </button>
              <button
                type="submit"
                form="return-form"
                disabled={isSubmitting}
                className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-900/40 disabled:opacity-50"
              >
                {isSubmitting ? 'სრულდება...' : 'დაბრუნების დადასტურება'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
