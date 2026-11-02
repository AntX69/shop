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
import { invokeIpc, setClientToken } from './renderer/api/ipcClient.ts';

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
    setActiveTab('pos');
  };

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

      if (e.key === 'F1') {
        e.preventDefault();
        setActiveTab('pos');
      } else if (e.key === 'F2') {
        e.preventDefault();
        setActiveTab('products');
      } else if (e.key === 'F3') {
        e.preventDefault();
        setActiveTab('inventory');
      } else if (e.key === 'F4') {
        e.preventDefault();
        setActiveTab('debts');
      } else if (e.key === 'F5') {
        e.preventDefault();
        setActiveTab('history');
      } else if (e.key === 'F6' && currentUser.role === 'owner') {
        e.preventDefault();
        setActiveTab('finance');
      } else if (e.key === 'F7' && currentUser.role === 'owner') {
        e.preventDefault();
        setActiveTab('staff');
      } else if (e.key === 'F8' && currentUser.role === 'owner') {
        e.preventDefault();
        setActiveTab('settings');
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
        {activeTab === 'pos' && <PosView currentUser={currentUser} />}
        {activeTab === 'products' && <ProductsView currentUser={currentUser} />}
        {activeTab === 'inventory' && <InventoryView currentUser={currentUser} />}
        {activeTab === 'debts' && <DebtsView currentUser={currentUser} />}
        {activeTab === 'history' && <SalesHistoryView currentUser={currentUser} />}
        {activeTab === 'finance' && currentUser.role === 'owner' && <FinanceView currentUser={currentUser} />}
        {activeTab === 'staff' && currentUser.role === 'owner' && <StaffView currentUser={currentUser} />}
        {activeTab === 'settings' && currentUser.role === 'owner' && (
          <SettingsView
            currentUser={currentUser}
            onStoreNameChanged={(name) => setStoreName(name)}
          />
        )}
      </main>
    </div>
  );
}
