/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owner-only product editor: name, category, price, purchase cost, description, variants
 * (size, colour, own price/cost, 5-digit code, factory barcode), archiving. Every change is
 * checked again in the main process; already completed sales keep their old prices.
 * Stock is not edited here: it changes only through restock or stock correction.
 */

import React, { useEffect, useState } from 'react';
import { Category, Product, ProductVariant } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { SmartDigitInput } from './SmartDigitInput.tsx';
import { Archive, ArchiveRestore, CheckCircle, Info, Pencil, Plus, Save, X, AlertCircle } from 'lucide-react';

interface ProductEditModalProps {
  productId: number;
  categories: Category[];
  onClose: () => void;
  onChanged: () => void;
}

interface VariantDraft {
  variant_name: string;
  size: string;
  color: string;
  price: string;
  cost: string;
  manual: string;
  barcode: string;
  initial_stock?: string;
}

const toGel = (t: number | null | undefined) => (t === null || t === undefined ? '' : (t / 100).toFixed(2));
const codeOf = (v: ProductVariant, type: 'manual_5digit' | 'barcode') => v.codes?.find((c) => c.code_type === type)?.code_value || '';

function draftFrom(v: ProductVariant): VariantDraft {
  return {
    variant_name: v.variant_name || '',
    size: v.size || '',
    color: v.color || '',
    price: toGel(v.price_override_tetri),
    cost: toGel(v.cost_override_tetri),
    manual: codeOf(v, 'manual_5digit'),
    barcode: codeOf(v, 'barcode'),
  };
}

const emptyDraft = (): VariantDraft => ({ variant_name: '', size: '', color: '', price: '', cost: '', manual: '', barcode: '', initial_stock: '0' });

function parseOptionalGel(value: string, label: string): number | null {
  if (!value.trim()) return null;
  try {
    return gelToTetri(value);
  } catch {
    throw new Error(`${label}: არასწორი თანხა "${value}" (მაგ. 12.50)`);
  }
}

const input = 'w-full px-2.5 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500';
const label = 'block text-[11px] font-semibold text-slate-400 mb-1';

export const ProductEditModal: React.FC<ProductEditModalProps> = ({ productId, categories, onClose, onChanged }) => {
  const [product, setProduct] = useState<Product | null>(null);
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [drafts, setDrafts] = useState<Record<number, VariantDraft>>({});
  const [newVariant, setNewVariant] = useState<VariantDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const apply = (p: Product) => {
    setProduct(p);
    setName(p.name);
    setCategoryId(p.category_id || '');
    setDescription(p.description || '');
    setPrice(toGel(p.base_price_tetri));
    setCost(toGel(p.base_cost_tetri));
    setDrafts(Object.fromEntries((p.variants || []).map((v) => [v.id, draftFrom(v)])));
  };

  useEffect(() => {
    invokeIpc<Product>('products:getById', { productId, includeArchived: true })
      .then(apply)
      .catch((err) => setError(err.message || 'პროდუქტის ჩატვირთვა ვერ მოხერხდა'));
  }, [productId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (action: () => Promise<Product | void>, okMessage: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await action();
      if (updated) apply(updated);
      setNotice(okMessage);
      onChanged();
    } catch (err: any) {
      setError(err.message || 'შენახვა ვერ მოხერხდა');
    } finally {
      setBusy(false);
    }
  };

  const saveProduct = () => run(async () => {
    const basePrice = parseOptionalGel(price, 'გასაყიდი ფასი');
    if (basePrice === null || basePrice <= 0) throw new Error('გასაყიდი ფასი უნდა აღემატებოდეს 0-ს');
    return invokeIpc<Product>('products:update', {
      productId,
      name: name.trim(),
      category_id: categoryId === '' ? null : categoryId,
      description: description.trim() || null,
      base_price_tetri: basePrice,
      base_cost_tetri: parseOptionalGel(cost, 'თვითღირებულება'),
    });
  }, 'პროდუქტის მონაცემები შენახულია');

  const saveVariant = (v: ProductVariant) => run(async () => {
    const d = drafts[v.id];
    if (d.manual && !/^[1-9]\d{4}$/.test(d.manual)) throw new Error('5-ნიშნა კოდი უნდა იყოს 10000-დან 99999-მდე');
    return invokeIpc<Product>('products:updateVariant', {
      variantId: v.id,
      variant_name: d.variant_name,
      size: d.size || null,
      color: d.color || null,
      price_override_tetri: parseOptionalGel(d.price, 'ვარიანტის ფასი'),
      cost_override_tetri: parseOptionalGel(d.cost, 'ვარიანტის თვითღირებულება'),
      manual_code: d.manual,
      barcode: d.barcode,
    });
  }, `ვარიანტი "${drafts[v.id]?.variant_name || v.variant_name}" შენახულია`);

  const toggleVariant = (v: ProductVariant) => run(
    () => invokeIpc<Product>('products:setVariantActive', { variantId: v.id, isActive: v.is_active !== 1 }),
    v.is_active === 1 ? 'ვარიანტი დაარქივდა' : 'ვარიანტი აღდგა'
  );

  const addVariant = () => run(async () => {
    const d = newVariant!;
    if (!d.manual && !d.barcode) throw new Error('მიუთითეთ 5-ნიშნა კოდი ან ქარხნული შტრიხკოდი');
    if (d.manual && !/^[1-9]\d{4}$/.test(d.manual)) throw new Error('5-ნიშნა კოდი უნდა იყოს 10000-დან 99999-მდე');
    const stock = Number(d.initial_stock || '0');
    if (!Number.isInteger(stock) || stock < 0) throw new Error('საწყისი მარაგი უნდა იყოს მთელი, არაუარყოფითი რიცხვი');
    const codes = [
      ...(d.manual ? [{ code_type: 'manual_5digit', code_value: d.manual }] : []),
      ...(d.barcode ? [{ code_type: 'barcode', code_value: d.barcode.trim() }] : []),
    ];
    const updated = await invokeIpc<Product>('products:addVariant', {
      productId,
      variant: {
        variant_name: d.variant_name.trim() || [d.size, d.color].filter(Boolean).join(' / ') || 'ვარიანტი',
        size: d.size || undefined,
        color: d.color || undefined,
        price_override_tetri: parseOptionalGel(d.price, 'ვარიანტის ფასი'),
        cost_override_tetri: parseOptionalGel(d.cost, 'ვარიანტის თვითღირებულება'),
        initial_stock: stock,
        codes,
      },
    });
    setNewVariant(null);
    return updated;
  }, 'ახალი ვარიანტი დაემატა');

  const toggleProduct = () => {
    if (!product) return;
    const archiving = product.is_active === 1;
    if (archiving && !window.confirm(`"${product.name}" დაარქივდეს? გაყიდვაში აღარ გამოჩნდება, ისტორია შენარჩუნდება.`)) return;
    run(() => invokeIpc<Product>('products:setActive', { productId, isActive: !archiving }), archiving ? 'პროდუქტი დაარქივდა' : 'პროდუქტი აღდგა');
  };

  const setDraft = (id: number, patch: Partial<VariantDraft>) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4" role="dialog" aria-modal="true" aria-label="პროდუქტის რედაქტირება">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-5xl w-full max-h-[94vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="flex justify-between items-center border-b border-slate-800 px-4 sm:px-6 py-3 shrink-0">
          <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
            <Pencil className="w-4 h-4 text-emerald-400" />
            <span>პროდუქტის რედაქტირება</span>
            {product && product.is_active !== 1 && (
              <span className="px-2 py-0.5 rounded bg-amber-950/70 border border-amber-700/50 text-amber-300 text-[11px] font-semibold">დაარქივებული</span>
            )}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer" aria-label="დახურვა">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 sm:px-6 py-4 space-y-5 min-h-0">
          {error && (
            <div className="p-2.5 bg-red-950/60 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{error}</span>
            </div>
          )}
          {notice && !error && (
            <div className="p-2.5 bg-emerald-950/50 border border-emerald-800/50 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle className="w-4 h-4" /><span>{notice}</span>
            </div>
          )}

          {!product ? (
            <div className="py-10 text-center text-slate-400 text-sm">{error ? '' : 'იტვირთება...'}</div>
          ) : (
            <>
              <section className="bg-slate-950/40 border border-slate-800 rounded-xl p-3 sm:p-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-2">
                    <label className={label}>დასახელება</label>
                    <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
                  </div>
                  <div>
                    <label className={label}>კატეგორია</label>
                    <select className={input} value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')}>
                      <option value="">ზოგადი</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className={label}>ფასი (₾)</label>
                      <input className={input} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
                    </div>
                    <div>
                      <label className={label}>თვითღირ. (₾)</label>
                      <input className={input} value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="უცნობი" />
                    </div>
                  </div>
                  <div className="md:col-span-4">
                    <label className={label}>აღწერა</label>
                    <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
                  <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    ფასის ან თვითღირებულების შეცვლა უკვე შესრულებულ გაყიდვებს და არსებულ მარაგს არ ცვლის.
                  </p>
                  <button onClick={saveProduct} disabled={busy} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer">
                    <Save className="w-3.5 h-3.5" /> შენახვა
                  </button>
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-bold text-white">ვარიანტები (ზომა / ფერი / კოდები)</h4>
                  {!newVariant && (
                    <button onClick={() => setNewVariant(emptyDraft())} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1 cursor-pointer">
                      <Plus className="w-3.5 h-3.5" /> ვარიანტის დამატება
                    </button>
                  )}
                </div>
                <div className="space-y-2">
                  {(product.variants || []).map((v) => {
                    const d = drafts[v.id];
                    if (!d) return null;
                    const archived = v.is_active !== 1;
                    return (
                      <div key={v.id} className={`border rounded-xl p-3 ${archived ? 'border-amber-900/50 bg-amber-950/10 opacity-75' : 'border-slate-800 bg-slate-950/40'}`}>
                        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                          <div className="md:col-span-2">
                            <label className={label}>ვარიანტი</label>
                            <input className={input} value={d.variant_name} onChange={(e) => setDraft(v.id, { variant_name: e.target.value })} />
                          </div>
                          <div>
                            <label className={label}>ზომა</label>
                            <input className={input} value={d.size} onChange={(e) => setDraft(v.id, { size: e.target.value })} />
                          </div>
                          <div>
                            <label className={label}>ფერი</label>
                            <input className={input} value={d.color} onChange={(e) => setDraft(v.id, { color: e.target.value })} />
                          </div>
                          <div>
                            <label className={label}>საკუთარი ფასი (₾)</label>
                            <input className={input} value={d.price} onChange={(e) => setDraft(v.id, { price: e.target.value })} placeholder={formatTetri(product.base_price_tetri, false)} inputMode="decimal" />
                          </div>
                          <div>
                            <label className={label}>თვითღირ. (₾)</label>
                            <input className={input} value={d.cost} onChange={(e) => setDraft(v.id, { cost: e.target.value })} placeholder="პროდუქტის" inputMode="decimal" />
                          </div>
                          <div className="col-span-2">
                            <label className={label}>5-ნიშნა კოდი</label>
                            <SmartDigitInput length={5} value={d.manual} onChange={(code) => setDraft(v.id, { manual: code.replace(/\D/g, '') })} ariaLabel="5-ნიშნა კოდი" />
                          </div>
                          <div className="col-span-2">
                            <label className={label}>ქარხნული შტრიხკოდი</label>
                            <input className={`${input} font-mono`} value={d.barcode} onChange={(e) => setDraft(v.id, { barcode: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
                          </div>
                          <div className="text-[11px] text-slate-400">
                            მარაგი: <span className="font-bold text-white">{v.stock_quantity} ც</span>
                          </div>
                          <div className="flex gap-1.5 justify-end">
                            <button onClick={() => saveVariant(v)} disabled={busy} className="px-2.5 py-1.5 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white rounded-lg text-[11px] font-bold cursor-pointer" title="შენახვა">
                              <Save className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => toggleVariant(v)} disabled={busy} className="px-2.5 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 rounded-lg text-[11px] font-bold cursor-pointer" title={archived ? 'აღდგენა' : 'დაარქივება'}>
                              {archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {newVariant && (
                    <div className="border border-emerald-800/60 bg-emerald-950/10 rounded-xl p-3">
                      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                        <div className="md:col-span-2">
                          <label className={label}>ახალი ვარიანტი</label>
                          <input className={input} value={newVariant.variant_name} onChange={(e) => setNewVariant({ ...newVariant, variant_name: e.target.value })} placeholder="მაგ. შავი / 42" autoFocus />
                        </div>
                        <div>
                          <label className={label}>ზომა</label>
                          <input className={input} value={newVariant.size} onChange={(e) => setNewVariant({ ...newVariant, size: e.target.value })} />
                        </div>
                        <div>
                          <label className={label}>ფერი</label>
                          <input className={input} value={newVariant.color} onChange={(e) => setNewVariant({ ...newVariant, color: e.target.value })} />
                        </div>
                        <div>
                          <label className={label}>საკუთარი ფასი (₾)</label>
                          <input className={input} value={newVariant.price} onChange={(e) => setNewVariant({ ...newVariant, price: e.target.value })} inputMode="decimal" />
                        </div>
                        <div>
                          <label className={label}>საწყისი მარაგი</label>
                          <input className={input} value={newVariant.initial_stock} onChange={(e) => setNewVariant({ ...newVariant, initial_stock: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
                        </div>
                        <div className="col-span-2">
                          <label className={label}>5-ნიშნა კოდი</label>
                          <SmartDigitInput length={5} value={newVariant.manual} onChange={(code) => setNewVariant({ ...newVariant, manual: code.replace(/\D/g, '') })} ariaLabel="ახალი ვარიანტის 5-ნიშნა კოდი" />
                        </div>
                        <div className="col-span-2">
                          <label className={label}>ქარხნული შტრიხკოდი</label>
                          <input className={`${input} font-mono`} value={newVariant.barcode} onChange={(e) => setNewVariant({ ...newVariant, barcode: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
                        </div>
                        <div>
                          <label className={label}>თვითღირ. (₾)</label>
                          <input className={input} value={newVariant.cost} onChange={(e) => setNewVariant({ ...newVariant, cost: e.target.value })} placeholder="პროდუქტის" inputMode="decimal" />
                        </div>
                        <div className="flex gap-1.5 justify-end">
                          <button onClick={addVariant} disabled={busy} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-[11px] font-bold cursor-pointer">დამატება</button>
                          <button onClick={() => setNewVariant(null)} className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-[11px] font-bold cursor-pointer">გაუქმება</button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 mt-2 flex items-center gap-1.5">
                  <Info className="w-3.5 h-3.5" />
                  მარაგი იცვლება მხოლოდ „მარაგის“ გვერდიდან (შევსება ან კორექცია), რათა ყოველ ცვლილებას ჰქონდეს ისტორია.
                </p>
              </section>
            </>
          )}
        </div>

        <div className="flex justify-between items-center border-t border-slate-800 px-4 sm:px-6 py-3 shrink-0">
          {product ? (
            <button onClick={toggleProduct} disabled={busy} className={`px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${product.is_active === 1 ? 'bg-amber-950/60 border border-amber-800/60 text-amber-300 hover:bg-amber-900/50' : 'bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 hover:bg-emerald-900/50'}`}>
              {product.is_active === 1 ? <><Archive className="w-3.5 h-3.5" /> პროდუქტის დაარქივება</> : <><ArchiveRestore className="w-3.5 h-3.5" /> პროდუქტის აღდგენა</>}
            </button>
          ) : <span />}
          <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold cursor-pointer">დახურვა (Esc)</button>
        </div>
      </div>
    </div>
  );
};
