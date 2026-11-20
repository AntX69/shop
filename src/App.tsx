/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Main Application Shell for StorePOS Desktop.
 * Manages active user session, navigation tabs, inactivity lock,
 * and global keyboard shortcuts.
 */

import React, { useState, useEffect } from 'react';
import { User, UserSession } from './shared/types.ts';
import { Header, NavTab } from './renderer/components/Header.tsx';
import { LoginView } from './renderer/pages/LoginView.tsx';
import { PosView } from './renderer/pages/PosView.tsx';
import { ProductsView } from './renderer/pages/ProductsView.tsx';
import { InventoryView } from './renderer/pages/InventoryView.tsx';
import { DebtsView } from './renderer/pages/DebtsView.tsx';
import { SalesHistoryView } from './renderer/pages/SalesHistoryView.tsx';
import { FinanceView } from './renderer/pages/FinanceView.tsx';
import { StaffView } from './renderer/pages/StaffView.tsx';
import { SettingsView } from './renderer/pages/SettingsView.tsx';
import { SellerBackupView } from './renderer/pages/SellerBackupView.tsx';
import { invokeIpc, setClientToken } from './renderer/api/ipcClient.ts';
import { AppTab, canOpenTab, firstAllowedTab } from './renderer/utils/access.ts';

const HOTKEY_TABS: Record<string, AppTab> = {
  F1: 'pos', F2: 'products', F3: 'inventory', F4: 'debts', F5: 'history', F6: 'finance', F7: 'staff', F8: 'settings',
};

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('pos');
  const [storeName, setStoreName] = useState<string>('ჩემი მაღაზია');
  const [lockMinutes, setLockMinutes] = useState<number>(15);

  // Store name and auto-lock interval (owner-configurable, readable before login)
  useEffect(() => {
    invokeIpc<Record<string, string>>('settings:getPublic')
      .then((s) => {
        if (s.store_name) setStoreName(s.store_name);
        const minutes = parseInt(s.inactivity_lock_minutes || '', 10);
        if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 240) setLockMinutes(minutes);
      })
      .catch(() => {});
  }, [currentUser]);

  // Handle Login
  const handleLoginSuccess = (session: UserSession) => {
    setCurrentUser(session.user);
    setActiveTab(firstAllowedTab(session.user) ?? 'pos');
  };

  // The owner may change a seller's permissions at any time. The main process applies the change
  // to the very next request; here the screen list is refreshed whenever the user switches screens
  // or comes back to the window. A revoked session locks the screen.
  const refreshUser = () => {
    invokeIpc<User>('auth:me')
      .then((me) => setCurrentUser((prev) => (prev && prev.id === me.id ? me : prev)))
      .catch(() => handleLockSession());
  };
  useEffect(() => {
    if (currentUser) refreshUser();
  }, [activeTab]);
  useEffect(() => {
    const onFocus = () => { if (currentUser) refreshUser(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [currentUser?.id]);
  // If the current screen is no longer allowed, move to the first allowed one.
  useEffect(() => {
    if (currentUser && !canOpenTab(currentUser, activeTab)) {
      const next = firstAllowedTab(currentUser);
      if (next) setActiveTab(next);
    }
  }, [currentUser, activeTab]);

  // Lock session: the session is revoked in the main process, not only forgotten here
  const handleLockSession = () => {
    invokeIpc('auth:logout').catch(() => {});
    setCurrentUser(null);
    setClientToken('');
  };

  // Inactivity auto-lock (configurable, 15 minutes by default)
  useEffect(() => {
    if (!currentUser) return;

    let timeoutId: any;
    const resetTimer = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        handleLockSession();
      }, lockMinutes * 60 * 1000);
    };

    window.addEventListener('mousemove', resetTimer);
    window.addEventListener('keydown', resetTimer);
    window.addEventListener('click', resetTimer);
    resetTimer();

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener('mousemove', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('click', resetTimer);
    };
  }, [currentUser, lockMinutes]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleGlobalShortcuts = (e: KeyboardEvent) => {
      if (!currentUser) return;

      const tab = HOTKEY_TABS[e.key];
      if (tab) {
        e.preventDefault();
        if (canOpenTab(currentUser, tab)) setActiveTab(tab);
      } else if (e.key === 'F12') {
        e.preventDefault();
        handleLockSession();
      }
    };

    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, [currentUser]);

  // If locked or not authenticated, render Login Screen
  if (!currentUser) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="h-screen w-screen max-h-screen overflow-hidden bg-slate-950 flex flex-col font-sans text-slate-100 antialiased select-none">
      <Header
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        currentUser={currentUser}
        storeName={storeName}
        onLockSession={handleLockSession}
      />

      <main className="flex-1 flex flex-col overflow-hidden min-h-0">
        {!firstAllowedTab(currentUser) && (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div className="max-w-md space-y-2">
              <div className="text-lg font-bold text-white">ამ ანგარიშს ჯერ არცერთი უფლება არ აქვს</div>
              <div className="text-sm text-slate-400">მიმართეთ მფლობელს: უფლებებს ის ანიჭებს „პერსონალის“ ეკრანზე.</div>
            </div>
          </div>
        )}
        {activeTab === 'pos' && canOpenTab(currentUser, 'pos') && <PosView currentUser={currentUser} />}
        {activeTab === 'products' && canOpenTab(currentUser, 'products') && <ProductsView currentUser={currentUser} />}
        {activeTab === 'inventory' && canOpenTab(currentUser, 'inventory') && <InventoryView currentUser={currentUser} />}
        {activeTab === 'debts' && canOpenTab(currentUser, 'debts') && <DebtsView currentUser={currentUser} />}
        {activeTab === 'history' && canOpenTab(currentUser, 'history') && <SalesHistoryView currentUser={currentUser} />}
        {activeTab === 'finance' && canOpenTab(currentUser, 'finance') && <FinanceView currentUser={currentUser} />}
        {activeTab === 'staff' && canOpenTab(currentUser, 'staff') && <StaffView currentUser={currentUser} />}
        {activeTab === 'settings' && canOpenTab(currentUser, 'settings') && (currentUser.role === 'owner' ? (
          <SettingsView
            currentUser={currentUser}
            onStoreNameChanged={(name) => setStoreName(name)}
          />
        ) : (
          <SellerBackupView currentUser={currentUser} />
        ))}
      </main>
    </div>
  );
}
