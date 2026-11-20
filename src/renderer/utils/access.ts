/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which screens and buttons the signed-in user sees. This is only presentation: every action is
 * authorised again by the main process (handlers.ts and the services), so hiding a button is never
 * the protection itself.
 */

import { userCan } from '../../shared/permissions.ts';

export type AppTab = 'pos' | 'products' | 'inventory' | 'debts' | 'history' | 'finance' | 'staff' | 'settings';

type Viewer = { role?: string; permissions?: string[] | null } | null | undefined;

/** Any one of the listed permissions opens the screen; 'owner' = owner only. */
export const TAB_ACCESS: Record<AppTab, readonly string[] | 'owner'> = {
  pos: ['pos.access'],
  products: ['products.view'],
  inventory: ['inventory.view'],
  debts: ['debts.view', 'debts.collect', 'debts.history'],
  history: ['sales.history'],
  // Profit alone shows nothing (it is a part of the financial report).
  finance: ['reports.financial', 'reports.export', 'expenses.manage'],
  staff: 'owner',
  // Settings hold staff, restore and store options (owner only); a seller allowed to make
  // backups gets just the backup section there.
  settings: ['backups.create'],
};

export const TAB_ORDER: AppTab[] = ['pos', 'products', 'inventory', 'debts', 'history', 'finance', 'staff', 'settings'];

export function canOpenTab(user: Viewer, tab: AppTab): boolean {
  if (!user) return false;
  const rule = TAB_ACCESS[tab];
  if (rule === 'owner') return user.role === 'owner';
  return userCan(user, rule);
}

/** The first screen this user may open (the POS for most), or null when none. */
export function firstAllowedTab(user: Viewer): AppTab | null {
  return TAB_ORDER.find((t) => canOpenTab(user, t)) ?? null;
}

/** Shorthand for components: can(user, 'sales.discount'). */
export const can = (user: Viewer, permission: string | readonly string[]): boolean => userCan(user, permission);

/** Stock number for UI limits: unknown (hidden by permission) means "no limit here"; the main process still checks. */
export function stockLimit(stock: number | null | undefined): number {
  return typeof stock === 'number' && Number.isFinite(stock) ? stock : Number.MAX_SAFE_INTEGER;
}

/** True when the response carried stock numbers (the user has "inventory.quantities"). */
export const hasStockNumber = (stock: unknown): stock is number => typeof stock === 'number' && Number.isFinite(stock);
