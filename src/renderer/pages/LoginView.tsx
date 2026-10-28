/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Login & User Switching Screen.
 * Handles initial owner setup (first run) and PIN keypad authentication.
 */

import React, { useState, useEffect } from 'react';
import { User, UserSession } from '../../shared/types.ts';
import { invokeIpc, setClientToken } from '../api/ipcClient.ts';
import { ShieldCheck, User as UserIcon, Delete, KeyRound, AlertCircle } from 'lucide-react';

interface LoginViewProps {
  onLoginSuccess: (session: UserSession) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [hasOwner, setHasOwner] = useState<boolean | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');

  // Initial Owner Onboarding state
  const [ownerName, setOwnerName] = useState<string>('');
  const [ownerPin, setOwnerPin] = useState<string>('');
  const [ownerPinConfirm, setOwnerPinConfirm] = useState<string>('');

  // User Selection & PIN Keypad state
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [pinInput, setPinInput] = useState<string>('');

  const checkInitialStatus = async () => {
    try {
      setLoading(true);
      setError('');
      const ownerExists = await invokeIpc<boolean>('auth:hasOwner');
      setHasOwner(ownerExists);

      if (ownerExists) {
        const activeUsers = await invokeIpc<User[]>('auth:getActiveUsers');
        setUsers(activeUsers);
        if (activeUsers.length === 1) {
          setSelectedUser(activeUsers[0]);
        }
      }
    } catch (err: any) {
      setError(err.message || 'სისტემური შეცდომა მონაცემების ჩატვირთვისას');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkInitialStatus();
  }, []);

  // Physical keyboard listener for PIN input
  useEffect(() => {
    if (!selectedUser) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        if (pinInput.length < 6) {
          setPinInput(prev => prev + e.key);
        }
      } else if (e.key === 'Backspace') {
        setPinInput(prev => prev.slice(0, -1));
      } else if (e.key === 'Enter') {
        submitPin();
      } else if (e.key === 'Escape') {
        setPinInput('');
        setSelectedUser(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedUser, pinInput]);

  const handleOwnerSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!ownerName.trim()) {
      setError('გთხოვთ შეიყვანოთ მფლობელის სახელი');
      return;
    }
    if (!/^\d{4,6}$/.test(ownerPin)) {
      setError('PIN კოდი უნდა შედგებოდეს 4-დან 6 ციფრისგან');
      return;
    }
    if (ownerPin !== ownerPinConfirm) {
      setError('შეყვანილი PIN კოდები არ ემთხვევა ერთმანეთს');
      return;
    }

    try {
      setLoading(true);
      const session = await invokeIpc<UserSession>('auth:setupOwner', {
        name: ownerName.trim(),
        pin: ownerPin,
      });
      setClientToken(session.token);
      onLoginSuccess(session);
    } catch (err: any) {
      setError(err.message || 'მფლობელის რეგისტრაცია ვერ მოხერხდა');
    } finally {
      setLoading(false);
    }
  };

  const submitPin = async () => {
    if (!selectedUser) return;
    if (pinInput.length < 4) {
      setError('PIN კოდი უნდა იყოს მინიმუმ 4 ციფრი');
      return;
    }

    try {
      setError('');
      setLoading(true);
      const session = await invokeIpc<UserSession>('auth:login', {
        userId: selectedUser.id,
        pin: pinInput,
      });
      setClientToken(session.token);
      onLoginSuccess(session);
    } catch (err: any) {
      setError(err.message === 'არასწორი PIN კოდი' ? 'არასწორი PIN კოდი. (საწყისი PIN: 1234)' : (err.message || 'არასწორი PIN კოდი'));
      setPinInput('');
    } finally {
      setLoading(false);
    }
  };

  const handleKeypadPress = (digit: string) => {
    if (pinInput.length < 6) {
      setPinInput(prev => prev + digit);
    }
  };

  const handleBackspace = () => {
    setPinInput(prev => prev.slice(0, -1));
  };

  const handleClear = () => {
    setPinInput('');
  };

  if (loading && hasOwner === null) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center text-slate-300">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm font-medium">სისტემის ინიციალიზაცია...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 select-none">
      
      {/* Brand Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-900/40 mb-3">
          <ShieldCheck className="w-9 h-9" />
        </div>
        <h1 className="text-2xl font-bold text-white tracking-wide">StorePOS Windows Desktop</h1>
        <p className="text-sm text-slate-400 mt-1">ოფლაინ მაღაზიის მართვა და სალარო სისტემა</p>
      </div>

      {error && (
        <div className="max-w-md w-full mb-6 p-4 rounded-xl bg-red-950/60 border border-red-800 text-red-200 text-sm flex items-start space-x-3">
          <AlertCircle className="w-5 h-5 flex-shrink-0 text-red-400 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Case 1: Initial Owner Setup (First Run) */}
      {hasOwner === false && (
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="border-b border-slate-800 pb-4 mb-6">
            <h2 className="text-lg font-bold text-white">პირველი გაშვება: მფლობელის რეგისტრაცია</h2>
            <p className="text-xs text-slate-400 mt-1">
              სისტემა მუშაობს სრულიად ლოკალურად. პირველ ეტაპზე შექმენით მაღაზიის მფლობელის ანგარიში.
            </p>
          </div>

          <form onSubmit={handleOwnerSetupSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                მფლობელის სახელი
              </label>
              <input
                type="text"
                required
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="მაგ. გიორგი ბერიძე"
                className="w-full px-4 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                PIN კოდი (4-6 ციფრი)
              </label>
              <input
                type="password"
                maxLength={6}
                required
                value={ownerPin}
                onChange={(e) => setOwnerPin(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                className="w-full px-4 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm tracking-widest"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                გაიმეორეთ PIN კოდი
              </label>
              <input
                type="password"
                maxLength={6}
                required
                value={ownerPinConfirm}
                onChange={(e) => setOwnerPinConfirm(e.target.value.replace(/\D/g, ''))}
                placeholder="••••"
                className="w-full px-4 py-2.5 rounded-lg bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-sm tracking-widest"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 mt-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-sm transition-colors shadow-lg shadow-emerald-900/40 disabled:opacity-50"
            >
              {loading ? 'ინახება...' : 'მფლობელის შექმნა და შესვლა'}
            </button>
          </form>
        </div>
      )}

      {/* Case 2: User Selection & PIN Keypad */}
      {hasOwner === true && (
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          
          {/* User selector tab */}
          {!selectedUser ? (
            <div>
              <h2 className="text-base font-bold text-white mb-4 text-center">აირჩიეთ მომხმარებელი</h2>
              <div className="space-y-3">
                {users.map((u) => (
                  <button
                    key={u.id}
                    onClick={() => {
                      setSelectedUser(u);
                      setPinInput('');
                      setError('');
                    }}
                    className="w-full flex items-center justify-between p-4 rounded-xl bg-slate-950 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 transition-all text-left group"
                  >
                    <div className="flex items-center space-x-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
                        u.role === 'owner' ? 'bg-amber-600/20 text-amber-400 border border-amber-600/40' : 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/40'
                      }`}>
                        <UserIcon className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-white group-hover:text-emerald-400 transition-colors">{u.name}</div>
                        <div className="text-xs text-slate-400">{u.role === 'owner' ? 'მფლობელი (Admin)' : 'გამყიდველი (Seller)'}</div>
                      </div>
                    </div>
                    <KeyRound className="w-4 h-4 text-slate-500 group-hover:text-slate-300" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-6">
                <div className="flex items-center space-x-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                    selectedUser.role === 'owner' ? 'bg-amber-600/20 text-amber-400' : 'bg-emerald-600/20 text-emerald-400'
                  }`}>
                    <UserIcon className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-white">{selectedUser.name}</div>
                    <div className="text-[11px] text-slate-400">{selectedUser.role === 'owner' ? 'მფლობელი' : 'გამყიდველი'}</div>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setSelectedUser(null);
                    setPinInput('');
                  }}
                  className="text-xs text-slate-400 hover:text-white underline transition-colors"
                >
                  შეცვლა
                </button>
              </div>

              {/* PIN circles display */}
              <div className="flex justify-center space-x-4 mb-3">
                {[0, 1, 2, 3].map((index) => (
                  <div
                    key={index}
                    className={`w-4 h-4 rounded-full border-2 transition-all ${
                      pinInput.length > index
                        ? 'bg-emerald-500 border-emerald-400 scale-110 shadow-md shadow-emerald-500/50'
                        : 'border-slate-700 bg-slate-950'
                    }`}
                  />
                ))}
              </div>

              {/* Quick Helper for initial PIN */}
              <div className="text-center mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setPinInput('1234');
                    setError('');
                  }}
                  className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-slate-950 hover:bg-slate-800 border border-emerald-600/40 text-emerald-400 text-xs font-semibold cursor-pointer transition-colors"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>საწყისი PIN: 1234 (დააკლიკეთ ჩასასმელად)</span>
                </button>
              </div>

              {/* Virtual Keypad (3x4) */}
              <div className="grid grid-cols-3 gap-3">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                  <button
                    key={digit}
                    onClick={() => handleKeypadPress(digit)}
                    className="py-3.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-white font-bold text-xl rounded-xl transition-all shadow-sm cursor-pointer"
                  >
                    {digit}
                  </button>
                ))}
                
                <button
                  onClick={handleClear}
                  className="py-3.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-400 hover:text-white font-bold text-sm rounded-xl transition-all cursor-pointer"
                >
                  გასუფთავება
                </button>

                <button
                  onClick={() => handleKeypadPress('0')}
                  className="py-3.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-white font-bold text-xl rounded-xl transition-all shadow-sm cursor-pointer"
                >
                  0
                </button>

                <button
                  onClick={handleBackspace}
                  className="py-3.5 bg-slate-950 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 active:scale-95 text-slate-400 hover:text-white flex items-center justify-center rounded-xl transition-all cursor-pointer"
                >
                  <Delete className="w-5 h-5" />
                </button>
              </div>

              {/* Confirm submit button */}
              <button
                onClick={submitPin}
                disabled={pinInput.length < 4 || loading}
                className="w-full mt-5 py-3.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-base transition-colors shadow-lg shadow-emerald-900/40 disabled:opacity-40 disabled:hover:bg-emerald-600 cursor-pointer"
              >
                {loading ? 'შემოწმება...' : 'შესვლა (Enter)'}
              </button>

              {/* Reset / Clean onboarding option */}
              <div className="mt-4 text-center">
                <button
                  type="button"
                  onClick={async () => {
                    if (confirm('ნამდვილად გსურთ ბაზის განულება და თავიდან რეგისტრაცია?')) {
                      await invokeIpc('auth:resetStoreDatabase');
                      window.location.reload();
                    }
                  }}
                  className="text-xs text-slate-500 hover:text-red-400 underline transition-colors cursor-pointer"
                >
                  ბაზის განულება / ახალი მფლობელის რეგისტრაცია
                </button>
              </div>
            </div>
          )}

        </div>
      )}

      {/* Footer info */}
      <div className="mt-8 text-center text-xs text-slate-400">
        100% ლოკალური შენახვა (SQLite) &bull; კლავიატურის მხარდაჭერა &bull; ქართული ინტერფეისი
      </div>

    </div>
  );
};
