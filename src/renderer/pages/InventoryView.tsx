/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Inventory & Stock Management View.
 * Implements:
 * - Stock overview with filters (all, in stock, 0, low stock <= threshold)
 * - Restock ("მარაგის შევსება" - Owner only) with lot FIFO cost attribution
 * - Stock Correction ("მარაგის კორექცია" - Owner only) with mandatory audit reason
 * - Real-time stock movement history ledger.
 */

import React, { useState, useEffect } from 'react';
import { Product, ProductVariant, User } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Boxes, 
  PlusCircle, 
  CheckCircle, 
  Sliders, 
  History, 
  AlertTriangle, 
  Search,
  X,
  ArrowDownRight,
  ArrowUpRight
} from 'lucide-react';

interface InventoryViewProps {
  currentUser: User;
}

export const InventoryView: React.FC<InventoryViewProps> = ({ currentUser }) => {
  const isOwner = currentUser.role === 'owner';

  const [activeTab, setActiveTab] = useState<'stock' | 'movements'>('stock');
  const [products, setProducts] = useState<Product[]>([]);
  const [movements, setMovements] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // Filters
  const [stockFilter, setStockFilter] = useState<'all' | 'in_stock' | 'zero' | 'low'>('all');
  const [lowThreshold, setLowThreshold] = useState<number>(5);
  const [searchTerm, setSearchTerm] = useState<string>('');

  // Restock Modal
  const [isRestockOpen, setIsRestockOpen] = useState<boolean>(false);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [restockQty, setRestockQty] = useState<string>('5');
  const [restockUnitCost, setRestockUnitCost] = useState<string>('');
  const [restockNotes, setRestockNotes] = useState<string>('');

  // Stock Correction Modal
  const [isCorrectionOpen, setIsCorrectionOpen] = useState<boolean>(false);
  const [correctionVariantId, setCorrectionVariantId] = useState<number | null>(null);
  const [countedQty, setCountedQty] = useState<string>('');
  const [correctionReason, setCorrectionReason] = useState<string>('');

  const [modalError, setModalError] = useState<string>('');

  const loadData = async () => {
    try {
      setLoading(true);
      const [prods, moves] = await Promise.all([
        invokeIpc<Product[]>('products:list', {
          searchTerm: searchTerm || undefined,
          stockFilter,
          lowStockThreshold: lowThreshold
        }),
        invokeIpc<any[]>('inventory:getMovements', { limit: 100 })
      ]);
      setProducts(prods);
      setMovements(moves);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [stockFilter, lowThreshold, searchTerm]);

  // Flatten variants list for selection modals
  const allVariants = products.flatMap(p => 
    (p.variants || []).map(v => ({
      ...v,
      product_name: p.name,
      category_name: p.category_name
    }))
  );

  const handleRestockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');

    if (!selectedVariantId) {
      setModalError('გთხოვთ აირჩიოთ პროდუქტის ვარიანტი');
      return;
    }
    const qty = parseInt(restockQty, 10);
    if (isNaN(qty) || qty <= 0) {
      setModalError('რაოდენობა უნდა იყოს 1 ან მეტი');
      return;
    }

    let unitCostTetri: number | null = null;
    if (restockUnitCost.trim()) {
      try {
        unitCostTetri = gelToTetri(restockUnitCost);
      } catch (err: any) {
        setModalError(err.message);
        return;
      }
    }

    try {
      await invokeIpc('inventory:restock', {
        variant_id: selectedVariantId,
        added_quantity: qty,
        unit_cost_tetri: unitCostTetri,
        notes: restockNotes.trim() || undefined
      });

      setIsRestockOpen(false);
      setRestockQty('5');
      setRestockUnitCost('');
      setRestockNotes('');
      loadData();
    } catch (err: any) {
      setModalError(err.message || 'მარაგის შევსება ვერ მოხერხდა');
    }
  };

  const handleCorrectionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');

    if (!correctionVariantId) {
      setModalError('გთხოვთ აირჩიოთ პროდუქტის ვარიანტი');
      return;
    }
    const counted = parseInt(countedQty, 10);
    if (isNaN(counted) || counted < 0) {
      setModalError('დათვლილი მარაგი არ შეიძლება იყოს უარყოფითი');
      return;
    }

    if (!correctionReason.trim()) {
      setModalError('კორექტირების მიზეზის მითითება სავალდებულოა');
      return;
    }

    try {
      await invokeIpc('inventory:correct', {
        variant_id: correctionVariantId,
        counted_quantity: counted,
        reason: correctionReason.trim()
      });

      setIsCorrectionOpen(false);
      setCountedQty('');
      setCorrectionReason('');
      loadData();
    } catch (err: any) {
      setModalError(err.message || 'კორექტირება ვერ შესრულდა');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-4rem)] bg-slate-950 p-6 overflow-hidden select-none">
      
      {/* Top Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center space-x-2">
            <Boxes className="w-6 h-6 text-emerald-400" />
            <span>მარაგების აღრიცხვა და მოძრაობა</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">ინვენტარიზაცია, მარაგის შევსება და კორექტირების ისტორია</p>
        </div>

        <div className="flex items-center space-x-3">
          {/* Tabs: Stock vs Movements */}
          <div className="bg-slate-900 border border-slate-800 p-1 rounded-xl flex items-center space-x-1">
            <button
              onClick={() => setActiveTab('stock')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                activeTab === 'stock' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              მარაგების ნაშთი
            </button>
            <button
              onClick={() => setActiveTab('movements')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${
                activeTab === 'movements' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'
              }`}
            >
              მოძრაობის ისტორია
            </button>
          </div>

          {isOwner && (
            <>
              <button
                onClick={() => {
                  setIsRestockOpen(true);
                  setModalError('');
                }}
                className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                <span>მარაგის შევსება</span>
              </button>

              <button
                onClick={() => {
                  setIsCorrectionOpen(true);
                  setModalError('');
                }}
                className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-amber-400 text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors cursor-pointer"
              >
                <Sliders className="w-3.5 h-3.5" />
                <span>მარაგის კორექცია</span>
              </button>
            </>
          )}
        </div>
      </div>

      {activeTab === 'stock' ? (
        <>
          {/* Stock Filters Bar */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-2">
              <div className="relative w-64">
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="ძებნა პროდუქტით / კოდით..."
                  className="w-full pl-8 pr-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
              </div>

              {/* Status Filters */}
              {(['all', 'in_stock', 'zero', 'low'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setStockFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                    stockFilter === f
                      ? 'bg-slate-800 text-white border-slate-700 font-bold'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                  }`}
                >
                  {f === 'all' ? 'ყველა' : f === 'in_stock' ? 'მარაგშია (>0)' : f === 'zero' ? 'ამოწურული (0)' : `მცირე მარაგი (≤${lowThreshold})`}
                </button>
              ))}
            </div>

            {stockFilter === 'low' && (
              <div className="flex items-center space-x-1 text-xs text-slate-400">
                <span>ზღვარი:</span>
                <select
                  value={lowThreshold}
                  onChange={(e) => setLowThreshold(parseInt(e.target.value, 10))}
                  className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-white text-xs"
                >
                  <option value={2}>2</option>
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                </select>
              </div>
            )}
          </div>

          {/* Stock Table */}
          <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-xl">
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold tracking-wider sticky top-0 border-b border-slate-800">
                  <tr>
                    <th className="py-3 px-4">პროდუქტი</th>
                    <th className="py-3 px-4">ვარიანტი (ზომა / ფერი)</th>
                    <th className="py-3 px-4">კოდი</th>
                    <th className="py-3 px-4 text-right">გასაყიდი ფასი</th>
                    <th className="py-3 px-4 text-right">ნაშთი</th>
                    <th className="py-3 px-4 text-center">სტატუსი</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {allVariants.map((v) => {
                    const isZero = v.stock_quantity <= 0;
                    const isLow = v.stock_quantity > 0 && v.stock_quantity <= lowThreshold;
                    const primaryCode = v.codes?.[0]?.code_value || '-';
                    const price = v.effective_price_tetri ?? 0;

                    return (
                      <tr key={v.id} className="hover:bg-slate-800/40 transition-colors">
                        <td className="py-3 px-4 font-bold text-white text-sm">
                          {v.product_name}
                        </td>
                        <td className="py-3 px-4 text-slate-300 font-medium">
                          {v.variant_name}
                        </td>
                        <td className="py-3 px-4 font-mono text-emerald-400">
                          {primaryCode}
                        </td>
                        <td className="py-3 px-4 text-right font-extrabold text-white text-sm">
                          {formatTetri(price)}
                        </td>
                        <td className="py-3 px-4 text-right font-extrabold text-base">
                          <span className={isZero ? 'text-red-400' : isLow ? 'text-amber-400' : 'text-slate-100'}>
                            {v.stock_quantity}
                          </span> <span className="text-xs text-slate-400 font-normal">ც</span>
                        </td>
                        <td className="py-3 px-4 text-center">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            isZero
                              ? 'bg-red-950/60 text-red-400 border border-red-800/50'
                              : isLow
                              ? 'bg-amber-950/60 text-amber-400 border border-amber-800/50'
                              : 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/50'
                          }`}>
                            {isZero ? 'ამოწურულია' : isLow ? 'მცირე მარაგი' : 'მარაგშია'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
        /* Movements Ledger Table */
        <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-xl">
          <div className="overflow-y-auto flex-1">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold tracking-wider sticky top-0 border-b border-slate-800">
                <tr>
                  <th className="py-3 px-4">თარიღი</th>
                  <th className="py-3 px-4">ტიპი</th>
                  <th className="py-3 px-4">პროდუქტი / ვარიანტი</th>
                  <th className="py-3 px-4 text-right">ცვლილება</th>
                  <th className="py-3 px-4 text-right">ნაშთი ოპერაციის შემდეგ</th>
                  <th className="py-3 px-4">მიზეზი / დოკუმენტი</th>
                  <th className="py-3 px-4">ავტორი</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {movements.map((m) => {
                  const isPositive = m.quantity_change > 0;
                  const typeLabel = 
                    m.movement_type === 'initial' ? 'საწყისი' :
                    m.movement_type === 'restock' ? 'შევსება' :
                    m.movement_type === 'sale' ? 'გაყიდვა' :
                    m.movement_type === 'return' ? 'დაბრუნება' : 'კორექცია';

                  return (
                    <tr key={m.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 px-4 text-slate-400 font-mono text-[11px]">
                        {new Date(m.created_at).toLocaleString('ka-GE')}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 font-medium text-[11px]">
                          {typeLabel}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 font-semibold text-white">
                        {m.product_name} ({m.variant_name})
                      </td>
                      <td className="py-2.5 px-4 text-right font-bold text-sm">
                        <span className={isPositive ? 'text-emerald-400' : 'text-red-400'}>
                          {isPositive ? `+${m.quantity_change}` : m.quantity_change}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono text-slate-200">
                        {m.resulting_stock} ც
                      </td>
                      <td className="py-2.5 px-4 text-slate-300">
                        {m.reason} {m.reference_id ? `(#${m.reference_id})` : ''}
                      </td>
                      <td className="py-2.5 px-4 text-slate-400">
                        {m.user_name || '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- MODAL: Restock (Owner Only) --- */}
      {isRestockOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <PlusCircle className="w-5 h-5 text-emerald-400" />
                <span>მარაგის შევსება</span>
              </h3>
              <button onClick={() => setIsRestockOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mb-4 p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-xs">
                {modalError}
              </div>
            )}

            <form onSubmit={handleRestockSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">აირჩიეთ პროდუქტი / ვარიანტი *</label>
                <select
                  required
                  value={selectedVariantId || ''}
                  onChange={(e) => setSelectedVariantId(parseInt(e.target.value, 10))}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                >
                  <option value="">-- აირჩიეთ --</option>
                  {allVariants.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.product_name} - {v.variant_name} (მიმდინარე ნაშთი: {v.stock_quantity})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">დამატებული რაოდენობა (ცალი) *</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={restockQty}
                  onChange={(e) => setRestockQty(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">შესყიდვის ერთეულის ფასი (₾, არასავალდებულო FIFO-სთვის)</label>
                <input
                  type="number"
                  step="0.01"
                  value={restockUnitCost}
                  onChange={(e) => setRestockUnitCost(e.target.value)}
                  placeholder="თუ უცნობია დატოვეთ ცარიელი"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">შენიშვნა</label>
                <input
                  type="text"
                  value={restockNotes}
                  onChange={(e) => setRestockNotes(e.target.value)}
                  placeholder="მაგ. ახალი პარტია"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsRestockOpen(false)}
                  className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40"
                >
                  მარაგის შევსება
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: Stock Correction (Owner Only) --- */}
      {isCorrectionOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <Sliders className="w-5 h-5 text-amber-400" />
                <span>მარაგის კორექცია</span>
              </h3>
              <button onClick={() => setIsCorrectionOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {modalError && (
              <div className="mb-4 p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-xs">
                {modalError}
              </div>
            )}

            <form onSubmit={handleCorrectionSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">აირჩიეთ პროდუქტი / ვარიანტი *</label>
                <select
                  required
                  value={correctionVariantId || ''}
                  onChange={(e) => {
                    const id = parseInt(e.target.value, 10);
                    setCorrectionVariantId(id);
                    const v = allVariants.find(it => it.id === id);
                    if (v) setCountedQty(String(v.stock_quantity));
                  }}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                >
                  <option value="">-- აირჩიეთ --</option>
                  {allVariants.map(v => (
                    <option key={v.id} value={v.id}>
                      {v.product_name} - {v.variant_name} (ბაზაში: {v.stock_quantity} ცალი)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ფაქტობრივად დათვლილი ახალი მარაგი *</label>
                <input
                  type="number"
                  min="0"
                  required
                  value={countedQty}
                  onChange={(e) => setCountedQty(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-base font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">კორექტირების მიზეზი * (აუცილებელია Audit-ისთვის)</label>
                <textarea
                  required
                  rows={2}
                  value={correctionReason}
                  onChange={(e) => setCorrectionReason(e.target.value)}
                  placeholder="მაგ. ინვენტარიზაციის გადამოწმება, დაზიანებული ნივთის ჩამოწერა..."
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCorrectionOpen(false)}
                  className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-amber-900/40"
                >
                  კორექტირების შენახვა
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
