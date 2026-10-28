/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Staff & User Management View (Owner Only).
 * Allows owner to register new sellers, toggle active/blocked accounts,
 * and reset PINs.
 */

import React, { useState, useEffect } from 'react';
import { User } from '../../shared/types.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  UserCheck, 
  UserPlus, 
  KeyRound, 
  ShieldAlert, 
  UserX, 
  CheckCircle2, 
  X,
  AlertCircle
} from 'lucide-react';

interface StaffViewProps {
  currentUser: User;
}

export const StaffView: React.FC<StaffViewProps> = ({ currentUser }) => {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  // New Seller Modal
  const [isAddUserOpen, setIsAddUserOpen] = useState<boolean>(false);
  const [newUserName, setNewUserName] = useState<string>('');
  const [newUserPin, setNewUserPin] = useState<string>('');
  const [newUserRole, setNewUserRole] = useState<'seller' | 'owner'>('seller');
  const [addError, setAddError] = useState<string>('');

  // Reset PIN Modal
  const [resetTargetUser, setResetTargetUser] = useState<User | null>(null);
  const [resetPinValue, setResetPinValue] = useState<string>('');
  const [resetError, setResetError] = useState<string>('');

  const loadUsers = async () => {
    try {
      setLoading(true);
      const data = await invokeIpc<User[]>('auth:getAllUsers');
      setUsers(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleAddUserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError('');

    if (!newUserName.trim()) {
      setAddError('თანამშრომლის სახელი სავალდებულოა');
      return;
    }
    if (!/^\d{4,6}$/.test(newUserPin)) {
      setAddError('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
      return;
    }

    try {
      await invokeIpc('auth:addUser', {
        name: newUserName.trim(),
        pin: newUserPin,
        role: newUserRole
      });

      setIsAddUserOpen(false);
      setNewUserName('');
      setNewUserPin('');
      loadUsers();
    } catch (err: any) {
      setAddError(err.message || 'თანამშრომლის დამატება ვერ მოხერხდა');
    }
  };

  const handleToggleActive = async (targetUser: User) => {
    const newStatus = targetUser.is_active === 1 ? false : true;
    const confirmMsg = newStatus 
      ? `ნამდვილად გსურთ ${targetUser.name}-ის ანგარიშის გააქტიურება?`
      : `ნამდვილად გსურთ ${targetUser.name}-ის ანგარიშის დაბლოკვა?`;

    if (!confirm(confirmMsg)) return;

    try {
      await invokeIpc('auth:setUserActive', {
        userId: targetUser.id,
        isActive: newStatus
      });
      loadUsers();
    } catch (err: any) {
      alert(err.message || 'სტატუსის შეცვლა ვერ მოხერხდა');
    }
  };

  const handleResetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');

    if (!resetTargetUser) return;
    if (!/^\d{4,6}$/.test(resetPinValue)) {
      setResetError('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
      return;
    }

    try {
      await invokeIpc('auth:resetPin', {
        userId: resetTargetUser.id,
        newPin: resetPinValue
      });

      alert(`PIN კოდი წარმატებით შეიცვალა (${resetTargetUser.name})`);
      setResetTargetUser(null);
      setResetPinValue('');
    } catch (err: any) {
      setResetError(err.message || 'PIN-ის შეცვლა ვერ მოხერხდა');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-4rem)] bg-slate-950 p-6 overflow-hidden select-none">
      
      {/* Top Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center space-x-2">
            <UserCheck className="w-6 h-6 text-emerald-400" />
            <span>თანამშრომლები და უფლებები</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">მფლობელისა და გამყიდველების ანგარიშები, PIN კოდების მართვა</p>
        </div>

        <button
          onClick={() => {
            setIsAddUserOpen(true);
            setAddError('');
          }}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
        >
          <UserPlus className="w-4 h-4" />
          <span>+ ახალი თანამშრომელი</span>
        </button>
      </div>

      {/* Users List Table */}
      <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-xl">
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold tracking-wider sticky top-0 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4">სახელი</th>
                <th className="py-3 px-4">როლი</th>
                <th className="py-3 px-4">სტატუსი</th>
                <th className="py-3 px-4">რეგისტრაციის თარიღი</th>
                <th className="py-3 px-4 text-right">მოქმედებები</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {users.map((u) => {
                const isSelf = u.id === currentUser.id;
                return (
                  <tr key={u.id} className="hover:bg-slate-800/40 transition-colors">
                    <td className="py-3 px-4 font-bold text-white text-sm">
                      {u.name} {isSelf && <span className="text-emerald-400 text-xs font-normal">(თქვენ)</span>}
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                        u.role === 'owner' ? 'bg-amber-950/60 text-amber-400 border border-amber-800/40' : 'bg-slate-800 text-slate-300'
                      }`}>
                        {u.role === 'owner' ? 'მფლობელი' : 'გამყიდველი'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        u.is_active === 1 ? 'bg-emerald-950/60 text-emerald-400' : 'bg-red-950/60 text-red-400'
                      }`}>
                        {u.is_active === 1 ? 'აქტიური' : 'დაბლოკილი'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                      {new Date(u.created_at).toLocaleDateString('ka-GE')}
                    </td>
                    <td className="py-3 px-4 text-right space-x-2">
                      <button
                        onClick={() => {
                          setResetTargetUser(u);
                          setResetPinValue('');
                          setResetError('');
                        }}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg transition-colors cursor-pointer"
                      >
                        PIN შეცვლა
                      </button>

                      {!isSelf && (
                        <button
                          onClick={() => handleToggleActive(u)}
                          className={`px-2.5 py-1 text-xs rounded-lg transition-colors cursor-pointer ${
                            u.is_active === 1
                              ? 'bg-red-950/40 hover:bg-red-900/60 text-red-400'
                              : 'bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-400'
                          }`}
                        >
                          {u.is_active === 1 ? 'დაბლოკვა' : 'გააქტიურება'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- MODAL: Add User --- */}
      {isAddUserOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-base font-bold text-white">ახალი თანამშრომელი</h3>
              <button onClick={() => setIsAddUserOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {addError && (
              <div className="mb-3 p-2 bg-red-950/60 border border-red-800 rounded-lg text-red-200 text-xs">
                {addError}
              </div>
            )}

            <form onSubmit={handleAddUserSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">სახელი *</label>
                <input
                  type="text"
                  required
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="მაგ. ნინო გამყიდველი"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">როლი</label>
                <select
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value as any)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                >
                  <option value="seller">გამყიდველი (მხოლოდ სალარო & დაბრუნება)</option>
                  <option value="owner">მფლობელი (სრული წვდომა)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">PIN კოდი (4-6 ციფრი) *</label>
                <input
                  type="password"
                  maxLength={6}
                  required
                  value={newUserPin}
                  onChange={(e) => setNewUserPin(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm font-bold tracking-widest"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddUserOpen(false)}
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

      {/* --- MODAL: Reset PIN --- */}
      {resetTargetUser && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-base font-bold text-white">PIN კოდის შეცვლა</h3>
              <button onClick={() => setResetTargetUser(null)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {resetError && (
              <div className="mb-3 p-2 bg-red-950/60 border border-red-800 rounded-lg text-red-200 text-xs">
                {resetError}
              </div>
            )}

            <form onSubmit={handleResetPinSubmit} className="space-y-3">
              <div className="text-xs text-slate-400">
                მომხმარებელი: <span className="font-bold text-white">{resetTargetUser.name}</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">ახალი PIN კოდი (4-6 ციფრი) *</label>
                <input
                  type="password"
                  maxLength={6}
                  required
                  value={resetPinValue}
                  onChange={(e) => setResetPinValue(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm font-bold tracking-widest"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResetTargetUser(null)}
                  className="flex-1 py-2 bg-slate-800 text-slate-300 font-bold rounded-xl text-xs"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 text-white font-bold rounded-xl text-xs"
                >
                  შეცვლა
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  );
};
