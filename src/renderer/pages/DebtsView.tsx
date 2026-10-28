/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Customers & Debts (ნისიები და კლიენტები) View.
 * Tracks client balances, receivables, and cash debt repayments.
 * Cash repayment is recorded as a cash collection and NEVER double-counts sales revenue.
 */

import React, { useState, useEffect } from 'react';
import { Customer, DebtRepayment, User } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Users, 
  Search, 
  UserPlus, 
  Banknote, 
  Phone, 
  AlertCircle, 
  History, 
  X,
  CreditCard
} from 'lucide-react';

interface DebtsViewProps {
  currentUser: User;
}

export const DebtsView: React.FC<DebtsViewProps> = ({ currentUser }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [repayments, setRepayments] = useState<DebtRepayment[]>([]);

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

  useEffect(() => {
    if (selectedCustomerId) {
      invokeIpc<DebtRepayment[]>('customers:getRepayments', { customerId: selectedCustomerId })
        .then(setRepayments)
        .catch(console.error);
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
      await invokeIpc('customers:repay', {
        customer_id: selectedCustomer.id,
        amount_tetri: amountTetri,
        notes: repayNotes.trim() || undefined
      });

      setIsRepayOpen(false);
      setRepayAmountInput('');
      setRepayNotes('');
      loadCustomers();
      if (selectedCustomerId) {
        const reps = await invokeIpc<DebtRepayment[]>('customers:getRepayments', { customerId: selectedCustomerId });
        setRepayments(reps);
      }
    } catch (err: any) {
      setRepayError(err.message || 'დაფარვის შენახვა ვერ მოხერხდა');
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalStoreDebtTetri = customers.reduce((sum, c) => sum + (c.total_debt_tetri || 0), 0);

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-4rem)] bg-slate-950 p-6 overflow-hidden select-none">
      
      {/* Top Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center space-x-2">
            <Users className="w-6 h-6 text-emerald-400" />
            <span>ნისიები და კლიენტების აღრიცხვა</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">აქტიური დავალიანებები და თანხის დაფარვა (Cash Collection)</p>
        </div>

        <div className="flex items-center space-x-4">
          <div className="bg-slate-900 border border-slate-800 px-4 py-2 rounded-xl flex items-center space-x-3">
            <div className="text-right">
              <div className="text-[10px] text-slate-400 uppercase font-semibold">ჯამური ნისია (მაღაზიის)</div>
              <div className="text-lg font-black text-amber-400">{formatTetri(totalStoreDebtTetri)}</div>
            </div>
          </div>

          <button
            onClick={() => setIsNewCustOpen(true)}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
          >
            <UserPlus className="w-4 h-4" />
            <span>ახალი კლიენტის დამატება</span>
          </button>
        </div>
      </div>

      {/* Main 2-column layout */}
      <div className="flex-1 flex space-x-4 overflow-hidden">
        
        {/* Left Column: Customers List */}
        <div className="w-5/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden">
          
          {/* Search Box */}
          <div className="p-3 border-b border-slate-800">
            <div className="relative">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="კლიენტის ძებნა სახელით / ტელეფონით..."
                className="w-full pl-8 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-2.5" />
            </div>
          </div>

          {/* List items */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-800/60">
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
                    className={`p-3.5 transition-all cursor-pointer flex items-center justify-between ${
                      isSelected ? 'bg-slate-800/90 border-l-4 border-emerald-500' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <div>
                      <div className="font-bold text-sm text-white">{c.first_name} {c.last_name || ''}</div>
                      {c.phone && (
                        <div className="text-xs text-slate-400 flex items-center space-x-1 mt-0.5">
                          <Phone className="w-3 h-3 text-slate-500" />
                          <span>{c.phone}</span>
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <div className={`text-sm font-black ${hasDebt ? 'text-amber-400' : 'text-slate-400'}`}>
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

        {/* Right Column: Customer Details & Repayments Ledger */}
        <div className="w-7/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden p-5">
          {selectedCustomer ? (
            <div className="flex-1 flex flex-col overflow-hidden">
              
              {/* Header profile */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
                <div>
                  <h2 className="text-lg font-extrabold text-white">
                    {selectedCustomer.first_name} {selectedCustomer.last_name || ''}
                  </h2>
                  <div className="text-xs text-slate-400 mt-0.5 space-x-3">
                    {selectedCustomer.phone && <span>ტელ: {selectedCustomer.phone}</span>}
                    {selectedCustomer.address && <span>მისამართი: {selectedCustomer.address}</span>}
                  </div>
                </div>

                <div className="flex items-center space-x-3">
                  <div className="bg-slate-950 px-3.5 py-2 rounded-xl border border-slate-800 text-right">
                    <div className="text-[10px] text-slate-400 uppercase font-semibold">მიმდინარე ვალი</div>
                    <div className="text-lg font-black text-amber-400">
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
                      className="px-4 py-3 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
                    >
                      <Banknote className="w-4 h-4" />
                      <span>ნისიის დაფარვა (ნაღდი)</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Repayments History */}
              <div className="flex-1 flex flex-col overflow-hidden">
                <div className="flex items-center space-x-2 text-xs font-bold text-slate-300 uppercase tracking-wider mb-2">
                  <History className="w-4 h-4 text-emerald-400" />
                  <span>თანხის შემოტანის ისტორია (Repayments Ledger)</span>
                </div>

                <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-y-auto">
                  {repayments.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400">
                      ამ კლიენტზე ნისიის დაფარვის ჩანაწერები ჯერ არ ფიქსირდება
                    </div>
                  ) : (
                    <table className="w-full text-left text-xs">
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
                            <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400">
                              {new Date(r.created_at).toLocaleString('ka-GE')}
                            </td>
                            <td className="py-2.5 px-3 font-bold text-emerald-400 text-sm">
                              +{formatTetri(r.amount_tetri)}
                            </td>
                            <td className="py-2.5 px-3 text-slate-300">
                              {r.notes || '-'}
                            </td>
                            <td className="py-2.5 px-3 text-slate-400">
                              {r.user_name || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
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
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-base font-bold text-white flex items-center space-x-2">
                <Banknote className="w-5 h-5 text-emerald-400" />
                <span>ნისიის დაფარვა</span>
              </h3>
              <button onClick={() => setIsRepayOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {repayError && (
              <div className="mb-3 p-2.5 bg-red-950/60 border border-red-800 rounded-lg text-red-200 text-xs">
                {repayError}
              </div>
            )}

            <form onSubmit={handleRepaySubmit} className="space-y-3">
              <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 text-xs">
                <span className="text-slate-400">კლიენტი:</span> <span className="font-bold text-white">{selectedCustomer.first_name} {selectedCustomer.last_name || ''}</span>
                <div className="mt-1">
                  <span className="text-slate-400">მიმდინარე ვალი:</span> <span className="font-bold text-amber-400">{formatTetri(selectedCustomer.total_debt_tetri)}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  შემოტანილი ნაღდი თანხა (₾) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={repayAmountInput}
                  onChange={(e) => setRepayAmountInput(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white text-lg font-bold"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">შენიშვნა</label>
                <input
                  type="text"
                  value={repayNotes}
                  onChange={(e) => setRepayNotes(e.target.value)}
                  placeholder="მაგ. ნაწილობრივი გადახდა"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsRepayOpen(false)}
                  className="flex-1 py-2.5 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40 disabled:opacity-50"
                >
                  {isSubmitting ? 'ინახება...' : 'დაფარვის რეგისტრაცია'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: Add Customer --- */}
      {isNewCustOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white mb-3">ახალი კლიენტის რეგისტრაცია</h3>
            <form onSubmit={handleCreateCustomer} className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">სახელი *</label>
                <input
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="მაგ. დავით"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">გვარი</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="მაგ. ბერიძე"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">ტელეფონი</label>
                <input
                  type="text"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="მაგ. 599 12 34 56"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">მისამართი</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="მაგ. რუსთაველის 15"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>
              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewCustOpen(false)}
                  className="flex-1 py-2 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 text-white font-bold rounded-xl text-xs"
                >
                  დამატება
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
