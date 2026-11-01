/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Customers & Debts (ნისიები და კლიენტები) View.
 * Tracks client balances, receivables, and cash debt repayments.
 * Includes complete chronological Ledger (Sales creating debt, Cash Repayments, Returns reducing debt)
 * and active sales breakdown.
 */

import React, { useState, useEffect } from 'react';
import { Customer, DebtRepayment, CustomerLedgerEntry, Sale, User } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Users, 
  Search, 
  UserPlus, 
  Banknote, 
  Phone, 
  History, 
  X,
  CreditCard,
  Receipt,
  RotateCcw,
  Clock,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';

interface DebtsViewProps {
  currentUser: User;
}

type DetailTab = 'ledger' | 'active_sales' | 'repayments';

export const DebtsView: React.FC<DebtsViewProps> = ({ currentUser }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  
  // Detail tabs & data
  const [detailTab, setDetailTab] = useState<DetailTab>('ledger');
  const [ledgerEntries, setLedgerEntries] = useState<CustomerLedgerEntry[]>([]);
  const [activeSales, setActiveSales] = useState<Sale[]>([]);
  const [repayments, setRepayments] = useState<DebtRepayment[]>([]);
  const [loadingDetails, setLoadingDetails] = useState<boolean>(false);

  // Repayment Modal
  const [isRepayOpen, setIsRepayOpen] = useState<boolean>(false);
  const [repayAmountInput, setRepayAmountInput] = useState<string>('');
  const [repayNotes, setRepayNotes] = useState<string>('');
  const [repayError, setRepayError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // New Customer Modal
  const [isNewCustOpen, setIsNewCustOpen] = useState<boolean>(false);
  const [firstName, setFirstName] = useState<string>('');
  const [lastName, setLastName] = useState<string>('');
  const [phone, setPhone] = useState<string>('');
  const [address, setAddress] = useState<string>('');
  const [notes, setNotes] = useState<string>('');

  const loadCustomers = async () => {
    try {
      setLoading(true);
      const custs = await invokeIpc<Customer[]>('customers:list', { searchTerm: searchTerm || undefined });
      setCustomers(custs);
      if (custs.length > 0 && !selectedCustomerId) {
        setSelectedCustomerId(custs[0].id);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCustomers();
  }, [searchTerm]);

  const selectedCustomer = customers.find(c => c.id === selectedCustomerId) || null;

  // Load details whenever selected customer changes or refresh requested
  const loadCustomerDetails = async (custId: number) => {
    try {
      setLoadingDetails(true);
      const [led, act, reps] = await Promise.all([
        invokeIpc<CustomerLedgerEntry[]>('customers:getLedger', { customerId: custId }),
        invokeIpc<Sale[]>('customers:getActiveSales', { customerId: custId }),
        invokeIpc<DebtRepayment[]>('customers:getRepayments', { customerId: custId })
      ]);
      setLedgerEntries(led);
      setActiveSales(act);
      setRepayments(reps);
    } catch (err) {
      console.error('Error loading customer details:', err);
    } finally {
      setLoadingDetails(false);
    }
  };

  useEffect(() => {
    if (selectedCustomerId) {
      loadCustomerDetails(selectedCustomerId);
    } else {
      setLedgerEntries([]);
      setActiveSales([]);
      setRepayments([]);
    }
  }, [selectedCustomerId]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;

    try {
      const created = await invokeIpc<Customer>('customers:create', {
        first_name: firstName.trim(),
        last_name: lastName.trim() || undefined,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        notes: notes.trim() || undefined
      });
      setCustomers(prev => [...prev, created]);
      setSelectedCustomerId(created.id);
      setIsNewCustOpen(false);
      setFirstName('');
      setLastName('');
      setPhone('');
      setAddress('');
      setNotes('');
    } catch (err: any) {
      alert(err.message || 'კლიენტის დამატება ვერ მოხერხდა');
    }
  };

  const handleRepaySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRepayError('');

    if (!selectedCustomer) return;

    let amountTetri = 0;
    try {
      amountTetri = gelToTetri(repayAmountInput);
      if (amountTetri <= 0) {
        setRepayError('თანხა უნდა აღემატებოდეს 0-ს');
        return;
      }
    } catch (err: any) {
      setRepayError(err.message);
      return;
    }

    const currentDebt = selectedCustomer.total_debt_tetri || 0;
    if (amountTetri > currentDebt) {
      setRepayError(`შეტანილი თანხა (${formatTetri(amountTetri)}) აღემატება მიმდინარე დავალიანებას (${formatTetri(currentDebt)})`);
      return;
    }

    try {
      setIsSubmitting(true);
      const idempotencyKey = crypto.randomUUID();
      await invokeIpc('customers:repay', {
        customer_id: selectedCustomer.id,
        amount_tetri: amountTetri,
        notes: repayNotes.trim() || undefined,
        idempotency_key: idempotencyKey
      });

      setIsRepayOpen(false);
      setRepayAmountInput('');
      setRepayNotes('');
      await loadCustomers();
      if (selectedCustomerId) {
        await loadCustomerDetails(selectedCustomerId);
      }
    } catch (err: any) {
      setRepayError(err.message || 'დაფარვის შენახვა ვერ მოხერხდა');
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalStoreDebtTetri = customers.reduce((sum, c) => sum + (c.total_debt_tetri || 0), 0);

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-3 sm:p-4 lg:p-6 overflow-hidden min-h-0 select-none">
      
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 lg:mb-4 shrink-0">
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-white flex items-center space-x-2">
            <Users className="w-5 h-5 lg:w-6 lg:h-6 text-emerald-400" />
            <span>ნისიები და კლიენტების აღრიცხვა</span>
          </h1>
          <p className="text-[11px] lg:text-xs text-slate-400 mt-0.5">აქტიური დავალიანებები, სრული ქრონოლოგიური Ledger და თანხის დაფარვა</p>
        </div>

        <div className="flex items-center space-x-3 sm:space-x-4">
          <div className="bg-slate-900 border border-slate-800 px-3 py-1.5 sm:px-4 sm:py-2 rounded-xl flex items-center space-x-2 sm:space-x-3">
            <div className="text-right">
              <div className="text-[9px] sm:text-[10px] text-slate-400 uppercase font-semibold">ჯამური ნისია მაღაზიაში</div>
              <div className="text-base sm:text-lg font-black text-amber-400 tabular-nums">{formatTetri(totalStoreDebtTetri)}</div>
            </div>
          </div>

          <button
            onClick={() => setIsNewCustOpen(true)}
            className="px-3.5 py-2 sm:px-4 sm:py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            <span className="hidden sm:inline">ახალი კლიენტის დამატება</span>
            <span className="sm:hidden">+ კლიენტი</span>
          </button>
        </div>
      </div>

      {/* Main 2-column layout */}
      <div className="flex-1 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden min-h-0">
        
        {/* Left Column: Customers List */}
        <div className="w-full lg:w-4/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden min-h-0 max-h-[38vh] lg:max-h-none shrink-0 lg:shrink">
          
          {/* Search Box */}
          <div className="p-2.5 sm:p-3 border-b border-slate-800 shrink-0">
            <div className="relative">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="კლიენტის ძებნა სახელით / ტელეფონით..."
                className="w-full pl-8 pr-3 py-1.5 sm:py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2 sm:top-2.5" />
            </div>
          </div>

          {/* List items */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60 min-h-0">
            {customers.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">კლიენტები არ მოიძებნა</div>
            ) : (
              customers.map((c) => {
                const isSelected = c.id === selectedCustomerId;
                const hasDebt = (c.total_debt_tetri || 0) > 0;

                return (
                  <div
                    key={c.id}
                    onClick={() => setSelectedCustomerId(c.id)}
                    className={`p-3 transition-all cursor-pointer flex items-center justify-between ${
                      isSelected ? 'bg-slate-800/90 border-l-4 border-emerald-500' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <div className="font-bold text-xs sm:text-sm text-white">{c.first_name} {c.last_name || ''}</div>
                      {c.phone && (
                        <div className="text-[11px] text-slate-400 flex items-center space-x-1 mt-0.5">
                          <Phone className="w-3 h-3 text-slate-500" />
                          <span>{c.phone}</span>
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className={`text-xs sm:text-sm font-black tabular-nums ${hasDebt ? 'text-amber-400' : 'text-slate-400'}`}>
                        {formatTetri(c.total_debt_tetri)}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {hasDebt ? 'დავალიანება' : 'ვალი არ აქვს'}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

        </div>

        {/* Right Column: Customer Details, Ledger & Tabs */}
        <div className="w-full lg:w-8/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden p-3 sm:p-4 min-h-0 flex-1">
          {selectedCustomer ? (
            <div className="flex-1 flex flex-col overflow-hidden min-h-0">
              
              {/* Header profile */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3 mb-3 shrink-0">
                <div>
                  <h2 className="text-base sm:text-lg font-extrabold text-white">
                    {selectedCustomer.first_name} {selectedCustomer.last_name || ''}
                  </h2>
                  <div className="text-xs text-slate-400 mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
                    {selectedCustomer.phone && <span>ტელ: {selectedCustomer.phone}</span>}
                    {selectedCustomer.address && <span>მისამართი: {selectedCustomer.address}</span>}
                  </div>
                </div>

                <div className="flex items-center space-x-2 sm:space-x-3">
                  <div className="bg-slate-950 px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl border border-slate-800 text-right">
                    <div className="text-[9px] sm:text-[10px] text-slate-400 uppercase font-semibold">მიმდინარე ვალი</div>
                    <div className="text-base sm:text-lg font-black text-amber-400 tabular-nums">
                      {formatTetri(selectedCustomer.total_debt_tetri)}
                    </div>
                  </div>

                  {(selectedCustomer.total_debt_tetri || 0) > 0 && (
                    <button
                      onClick={() => {
                        setIsRepayOpen(true);
                        setRepayAmountInput((((selectedCustomer.total_debt_tetri || 0)) / 100).toFixed(2));
                        setRepayError('');
                      }}
                      className="px-3.5 py-2 sm:px-4 sm:py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
                    >
                      <Banknote className="w-4 h-4" />
                      <span>ნისიის დაფარვა</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Navigation Tabs for Customer: Ledger, Active Sales, Repayments */}
              <div className="flex items-center space-x-1 sm:space-x-2 border-b border-slate-800 pb-2 mb-3 shrink-0">
                <button
                  onClick={() => setDetailTab('ledger')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center space-x-1.5 ${
                    detailTab === 'ledger'
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <History className="w-3.5 h-3.5" />
                  <span>სრული Ledger (ქრონოლოგია)</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-950/50 text-slate-300 ml-1">
                    {ledgerEntries.length}
                  </span>
                </button>

                <button
                  onClick={() => setDetailTab('active_sales')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center space-x-1.5 ${
                    detailTab === 'active_sales'
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  <span>აქტიური ნისიები (გაყიდვები)</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-950/50 text-slate-300 ml-1">
                    {activeSales.length}
                  </span>
                </button>

                <button
                  onClick={() => setDetailTab('repayments')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer flex items-center space-x-1.5 ${
                    detailTab === 'repayments'
                      ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  }`}
                >
                  <Receipt className="w-3.5 h-3.5" />
                  <span>თანხის შემოტანები</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-slate-950/50 text-slate-300 ml-1">
                    {repayments.length}
                  </span>
                </button>
              </div>

              {/* Tab Content */}
              <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto overflow-y-auto min-h-0">
                {loadingDetails ? (
                  <div className="p-8 text-center text-xs text-slate-400">იტვირთება მონაცემები...</div>
                ) : detailTab === 'ledger' ? (
                  /* --- 1. FULL LEDGER TIMELINE --- */
                  ledgerEntries.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      ამ კლიენტზე ფინანსური მოძრაობის ისტორია არ ფიქსირდება
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs min-w-[550px]">
                      <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">თარიღი</th>
                          <th className="py-2.5 px-3">ოპერაცია</th>
                          <th className="py-2.5 px-3">აღწერა</th>
                          <th className="py-2.5 px-3 text-right">ცვლილება</th>
                          <th className="py-2.5 px-3 text-right">მიმდინარე ბალანსი</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {ledgerEntries.map((e) => {
                          const isDebtIncrease = e.type === 'sale_debt';
                          const isRepay = e.type === 'repayment';
                          const isReturn = e.type === 'return_credit';

                          return (
                            <tr key={e.id} className="hover:bg-slate-900/40">
                              <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                                {new Date(e.date).toLocaleString('ka-GE')}
                              </td>
                              <td className="py-2.5 px-3 whitespace-nowrap">
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold ${
                                  isDebtIncrease
                                    ? 'bg-amber-950/70 text-amber-300 border border-amber-800/70'
                                    : isRepay
                                    ? 'bg-emerald-950/70 text-emerald-300 border border-emerald-800/70'
                                    : 'bg-cyan-950/70 text-cyan-300 border border-cyan-800/70'
                                }`}>
                                  {isDebtIncrease && <CreditCard className="w-3 h-3" />}
                                  {isRepay && <CheckCircle2 className="w-3 h-3" />}
                                  {isReturn && <RotateCcw className="w-3 h-3" />}
                                  <span>{e.title}</span>
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-slate-300 max-w-xs truncate">
                                <div>{e.description}</div>
                                {e.receipt_number && (
                                  <div className="text-[10px] text-slate-500 font-mono">ქვითარი: #{e.receipt_number}</div>
                                )}
                              </td>
                              <td className={`py-2.5 px-3 font-black tabular-nums text-right whitespace-nowrap text-xs sm:text-sm ${
                                isDebtIncrease ? 'text-amber-400' : 'text-emerald-400'
                              }`}>
                                {isDebtIncrease ? `+${formatTetri(e.change_tetri || 0)}` : `-${formatTetri(Math.abs(e.change_tetri || 0))}`}
                              </td>
                              <td className="py-2.5 px-3 font-bold text-slate-200 tabular-nums text-right whitespace-nowrap text-xs sm:text-sm">
                                {formatTetri(e.running_balance_tetri)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )
                ) : detailTab === 'active_sales' ? (
                  /* --- 2. ACTIVE SALES (WITH UNPAID DEBT) --- */
                  activeSales.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      აქტიური დაუფარავი გაყიდვები არ არის
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs min-w-[550px]">
                      <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">თარიღი / ქვითარი</th>
                          <th className="py-2.5 px-3">ჯამური თანხა</th>
                          <th className="py-2.5 px-3">გადახდილი ნაღდი</th>
                          <th className="py-2.5 px-3">დარჩენილი ვალი</th>
                          <th className="py-2.5 px-3">სტატუსი</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {activeSales.map((s) => (
                          <tr key={s.id} className="hover:bg-slate-900/40">
                            <td className="py-2.5 px-3">
                              <div className="font-mono text-slate-200 font-bold">#{s.receipt_number}</div>
                              <div className="text-[10px] text-slate-400 font-mono">
                                {new Date(s.created_at).toLocaleString('ka-GE')}
                              </div>
                            </td>
                            <td className="py-2.5 px-3 font-bold text-slate-300 tabular-nums">
                              {formatTetri(s.total_tetri)}
                            </td>
                            <td className="py-2.5 px-3 text-slate-400 tabular-nums">
                              {formatTetri(s.cash_received_tetri)}
                            </td>
                            <td className="py-2.5 px-3 font-black text-amber-400 text-xs sm:text-sm tabular-nums">
                              {formatTetri(s.debt_amount_tetri)}
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/70 text-amber-300 border border-amber-800">
                                დაუფარავი
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                ) : (
                  /* --- 3. REPAYMENTS LIST --- */
                  repayments.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      ნისიის დაფარვის ჩანაწერები ჯერ არ ფიქსირდება
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs min-w-[480px]">
                      <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                        <tr>
                          <th className="py-2.5 px-3">თარიღი</th>
                          <th className="py-2.5 px-3">მიღებული თანხა</th>
                          <th className="py-2.5 px-3">შენიშვნა</th>
                          <th className="py-2.5 px-3">მიიღო თანამშრომელმა</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {repayments.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-900/40">
                            <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                              {new Date(r.created_at).toLocaleString('ka-GE')}
                            </td>
                            <td className="py-2.5 px-3 font-bold text-emerald-400 text-xs sm:text-sm tabular-nums whitespace-nowrap">
                              +{formatTetri(r.amount_tetri)}
                            </td>
                            <td className="py-2.5 px-3 text-slate-300">
                              {r.notes || '-'}
                            </td>
                            <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">
                              {r.user_name || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )
                )}
              </div>

            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-xs">
              აირჩიეთ კლიენტი სიიდან დეტალების სანახავად
            </div>
          )}
        </div>

      </div>

      {/* --- MODAL: Record Debt Repayment --- */}
      {isRepayOpen && selectedCustomer && (
        <div 
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setIsRepayOpen(false);
            e.stopPropagation();
          }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <Banknote className="w-5 h-5 text-emerald-400" />
                <span>ნისიის დაფარვა</span>
              </h3>
              <button onClick={() => setIsRepayOpen(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0">
              {repayError && (
                <div className="mb-3 p-2.5 bg-red-950/60 border border-red-800 rounded-lg text-red-200 text-xs flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{repayError}</span>
                </div>
              )}

              <form id="repay-form" onSubmit={handleRepaySubmit} className="space-y-3">
                <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-xs">
                  <div className="flex justify-between items-center mb-1">
                    <span className="text-slate-400">კლიენტი:</span>
                    <span className="font-bold text-white">{selectedCustomer.first_name} {selectedCustomer.last_name || ''}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">მიმდინარე ვალი:</span>
                    <span className="font-black text-amber-400 tabular-nums text-sm">
                      {formatTetri(selectedCustomer.total_debt_tetri)}
                    </span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    შემოტანილი თანხა (₾) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    autoFocus
                    value={repayAmountInput}
                    onChange={(e) => setRepayAmountInput(e.target.value)}
                    className="w-full px-3 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white text-lg font-bold tabular-nums focus:border-emerald-500 focus:outline-none"
                  />
                  {/* Quick amount buttons */}
                  <div className="flex items-center gap-1.5 mt-2">
                    <button
                      type="button"
                      onClick={() => setRepayAmountInput((((selectedCustomer.total_debt_tetri || 0)) / 100).toFixed(2))}
                      className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-semibold cursor-pointer"
                    >
                      სრული დაფარვა
                    </button>
                    {[10, 20, 50, 100].map(amt => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setRepayAmountInput(amt.toFixed(2))}
                        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded text-[11px] font-semibold cursor-pointer"
                      >
                        {amt} ₾
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">შენიშვნა</label>
                  <input
                    type="text"
                    value={repayNotes}
                    onChange={(e) => setRepayNotes(e.target.value)}
                    placeholder="მაგ. ნაწილობრივი გადახდა"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </form>
            </div>

            <div className="flex space-x-2 p-4 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsRepayOpen(false)}
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700 cursor-pointer"
              >
                გაუქმება
              </button>
              <button
                type="submit"
                form="repay-form"
                disabled={isSubmitting}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40 disabled:opacity-50 cursor-pointer"
              >
                {isSubmitting ? 'ინახება...' : 'დაფარვა'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL: Add Customer --- */}
      {isNewCustOpen && (
        <div 
          className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setIsNewCustOpen(false);
            e.stopPropagation();
          }}
        >
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex justify-between items-center border-b border-slate-800 p-4 shrink-0">
              <h3 className="text-base font-bold text-white">ახალი კლიენტის რეგისტრაცია</h3>
              <button onClick={() => setIsNewCustOpen(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0">
              <form id="new-cust-form" onSubmit={handleCreateCustomer} className="space-y-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">სახელი *</label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="მაგ. დავით"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">გვარი</label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="მაგ. ბერიძე"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">ტელეფონი</label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="მაგ. 599 12 34 56"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">მისამართი</label>
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="მაგ. რუსთაველის 15"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">შენიშვნა</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="სურვილისამებრ"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </form>
            </div>

            <div className="flex space-x-2 p-4 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsNewCustOpen(false)}
                className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs hover:bg-slate-700 cursor-pointer"
              >
                გაუქმება
              </button>
              <button
                type="submit"
                form="new-cust-form"
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40 cursor-pointer"
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
