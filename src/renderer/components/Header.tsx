/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Main Top Navigation Header with Georgian UI.
 * Displays store brand, active user badge (მფლობელი / გამყიდველი), navigation tabs,
 * and quick session lock. Responsive across 1280x720, 1366x768, 1920x1080, and 2560x1440.
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

  const navItems: Array<{ 
    id: NavTab; 
    label: string; 
    icon: React.ReactNode; 
    hotkey: string; 
    ownerOnly?: boolean 
  }> = [
    { id: 'pos', label: 'სალარო', icon: <ShoppingCart className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F1' },
    { id: 'products', label: 'პროდუქცია', icon: <Package className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F2' },
    { id: 'inventory', label: 'მარაგები', icon: <Boxes className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F3' },
    { id: 'debts', label: 'ნისიები', icon: <Users className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F4' },
    { id: 'history', label: 'ისტორია', icon: <History className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F5' },
    { id: 'finance', label: 'ფინანსები', icon: <TrendingUp className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F6', ownerOnly: true },
    { id: 'staff', label: 'პერსონალი', icon: <UserCheck className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F7', ownerOnly: true },
    { id: 'settings', label: 'პარამეტრები', icon: <Settings className="w-3.5 h-3.5 shrink-0" />, hotkey: 'F8', ownerOnly: true },
  ];

  return (
    <header className="bg-slate-900 border-b border-slate-800 text-white select-none shrink-0 z-30">
      <div className="w-full px-2 sm:px-3 xl:px-4 flex items-center justify-between h-14 lg:h-16 gap-1.5 sm:gap-2">
        
        {/* Brand & Store Name (always strictly visible, never pushed out) */}
        <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
          <div className="bg-emerald-600 p-1.5 rounded-xl flex items-center justify-center text-white shadow-md shadow-emerald-950/40">
            <Store className="w-4 h-4 lg:w-4.5 lg:h-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[9px] sm:text-[10px] uppercase tracking-wider text-emerald-400 font-extrabold leading-tight">StorePOS</div>
            <div className="text-[11px] sm:text-xs lg:text-sm font-bold text-slate-100 truncate max-w-[80px] sm:max-w-[120px] lg:max-w-[150px] xl:max-w-[200px]" title={storeName || 'ჩემი მაღაზია'}>
              {storeName || 'ჩემი მაღაზია'}
            </div>
          </div>
        </div>

        {/* Navigation Tabs - Centered safely with mx-auto, never clips left */}
        <nav className="flex-1 min-w-0 flex items-center overflow-x-auto scrollbar-none py-1 px-0.5">
          <div className="flex items-center gap-0.5 sm:gap-1 2xl:gap-1.5 mx-auto shrink-0">
            {navItems.map((item) => {
              if (item.ownerOnly && !isOwner) return null;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectTab(item.id)}
                  title={`${item.label} (${item.hotkey})`}
                  className={`flex items-center space-x-1 sm:space-x-1.5 px-1.5 sm:px-2 2xl:px-2.5 py-1.5 rounded-lg text-[11px] xl:text-xs transition-all shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-emerald-600 text-white font-bold shadow-md shadow-emerald-950/40'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white font-medium'
                  }`}
                >
                  {item.icon}
                  <span className="whitespace-nowrap">{item.label}</span>
                  <span className={`hidden 2xl:inline-block text-[9px] px-1 py-0.5 rounded font-mono font-bold leading-none ${
                    isActive ? 'bg-emerald-700/90 text-emerald-100' : 'bg-slate-800 text-slate-400 border border-slate-700/60'
                  }`}>
                    {item.hotkey}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* User Info & Quick Lock */}
        <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
          {currentUser && (
            <div className="hidden md:flex items-center space-x-2 bg-slate-800/80 py-1 px-2 rounded-lg border border-slate-700/70">
              <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0"></div>
              <div className="text-left min-w-0">
                <div className="text-[11px] sm:text-xs font-semibold text-slate-200 truncate max-w-[70px] xl:max-w-[90px]">{currentUser.name}</div>
                <div className="text-[9px] text-slate-400 leading-none">
                  {currentUser.role === 'owner' ? 'მფლობელი' : 'გამყიდველი'}
                </div>
              </div>
            </div>
          )}

          <button
            onClick={onLockSession}
            title="სესიის დაბლოკვა (F12)"
            className="flex items-center space-x-1 sm:space-x-1.5 px-2 py-1.5 bg-slate-800 hover:bg-red-950/60 hover:text-red-300 hover:border-red-800 text-slate-300 rounded-lg border border-slate-700 transition-colors text-xs font-medium cursor-pointer shrink-0"
          >
            <Lock className="w-3.5 h-3.5 shrink-0" />
            <span className="hidden 2xl:inline text-xs">ჩაკეტვა</span>
            <span className="text-[9px] sm:text-[10px] px-1 py-0.5 rounded bg-slate-900 font-mono text-slate-400 border border-slate-800 leading-none">F12</span>
          </button>
        </div>

      </div>
    </header>
  );
};
