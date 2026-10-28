/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Main Top Navigation Header with Georgian UI.
 * Displays store brand, active user badge (მფლობელი / გამყიდველი), navigation tabs,
 * and quick session lock.
 */

import React from 'react';
import { User } from '../../shared/types.ts';
import { 
  ShoppingCart, 
  Package, 
  Boxes, 
  Users, 
  History, 
  TrendingUp, 
  UserCheck, 
  Settings, 
  Lock,
  Store
} from 'lucide-react';

export type NavTab = 
  | 'pos' 
  | 'products' 
  | 'inventory' 
  | 'debts' 
  | 'history' 
  | 'finance' 
  | 'staff' 
  | 'settings';

interface HeaderProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  currentUser: User | null;
  storeName: string;
  onLockSession: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onSelectTab,
  currentUser,
  storeName,
  onLockSession,
}) => {
  const isOwner = currentUser?.role === 'owner';

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode; hotkey: string; ownerOnly?: boolean }> = [
    { id: 'pos', label: 'სალარო', icon: <ShoppingCart className="w-4 h-4" />, hotkey: 'F1' },
    { id: 'products', label: 'პროდუქცია', icon: <Package className="w-4 h-4" />, hotkey: 'F2' },
    { id: 'inventory', label: 'მარაგები', icon: <Boxes className="w-4 h-4" />, hotkey: 'F3' },
    { id: 'debts', label: 'ნისიები და კლიენტები', icon: <Users className="w-4 h-4" />, hotkey: 'F4' },
    { id: 'history', label: 'ისტორია და დაბრუნება', icon: <History className="w-4 h-4" />, hotkey: 'F5' },
    { id: 'finance', label: 'ფინანსები', icon: <TrendingUp className="w-4 h-4" />, hotkey: 'F6', ownerOnly: true },
    { id: 'staff', label: 'თანამშრომლები', icon: <UserCheck className="w-4 h-4" />, hotkey: 'F7', ownerOnly: true },
    { id: 'settings', label: 'პარამეტრები / Backup', icon: <Settings className="w-4 h-4" />, hotkey: 'F8', ownerOnly: true },
  ];

  return (
    <header className="bg-slate-900 border-b border-slate-800 text-white select-none">
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-16">
        
        {/* Brand & Store Name */}
        <div className="flex items-center space-x-3">
          <div className="bg-emerald-600 p-2 rounded-lg flex items-center justify-center text-white shadow-md">
            <Store className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">StorePOS Desktop</div>
            <div className="text-base font-bold text-slate-100">{storeName || 'ჩემი მაღაზია'}</div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center space-x-1">
          {navItems.map((item) => {
            if (item.ownerOnly && !isOwner) return null;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onSelectTab(item.id)}
                className={`flex items-center space-x-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
                <span className={`text-[10px] px-1 py-0.2 rounded font-mono ${isActive ? 'bg-emerald-700/80 text-emerald-100' : 'bg-slate-800 text-slate-400'}`}>
                  {item.hotkey}
                </span>
              </button>
            );
          })}
        </nav>

        {/* User Info & Quick Lock */}
        <div className="flex items-center space-x-3">
          {currentUser && (
            <div className="flex items-center space-x-2 bg-slate-800 py-1.5 px-3 rounded-lg border border-slate-700">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400"></div>
              <div className="text-left">
                <div className="text-xs font-medium text-slate-200">{currentUser.name}</div>
                <div className="text-[10px] text-slate-400">
                  {currentUser.role === 'owner' ? 'მფლობელი' : 'გამყიდველი'}
                </div>
              </div>
            </div>
          )}

          <button
            onClick={onLockSession}
            title="სესიის დაბლოკვა (F12)"
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-slate-800 hover:bg-red-950/40 hover:text-red-400 text-slate-300 rounded-lg border border-slate-700 transition-colors text-xs font-medium cursor-pointer"
          >
            <Lock className="w-3.5 h-3.5" />
            <span>ჩაკეტვა</span>
            <span className="text-[10px] px-1 rounded bg-slate-900 font-mono text-slate-400">F12</span>
          </button>
        </div>

      </div>
    </header>
  );
};
