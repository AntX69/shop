/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Which screens a user sees (presentation only; the main process authorises every action).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenTab, firstAllowedTab, stockLimit, hasStockNumber, TAB_ORDER } from './access.ts';
import { DEFAULT_SELLER_PERMISSIONS } from '../../shared/permissions.ts';

const owner = { role: 'owner', permissions: [] };
const seller = (permissions: string[]) => ({ role: 'seller', permissions });

test('owner sees every screen', () => {
  for (const t of TAB_ORDER) assert.equal(canOpenTab(owner, t), true, t);
});

test('a default seller sees what an RC3 seller saw (no finance, staff or settings)', () => {
  const s = seller(DEFAULT_SELLER_PERMISSIONS);
  assert.deepEqual(TAB_ORDER.filter((t) => canOpenTab(s, t)), ['pos', 'products', 'inventory', 'debts', 'history']);
});

test('screens follow single permissions; staff is never shown to a seller', () => {
  assert.deepEqual(TAB_ORDER.filter((t) => canOpenTab(seller(['sales.history']), t)), ['history']);
  assert.deepEqual(TAB_ORDER.filter((t) => canOpenTab(seller(['reports.profit']), t)), [], 'profit alone opens no screen');
  assert.deepEqual(TAB_ORDER.filter((t) => canOpenTab(seller(['reports.export']), t)), ['finance']);
  assert.deepEqual(TAB_ORDER.filter((t) => canOpenTab(seller(['backups.create']), t)), ['settings']);
  assert.equal(canOpenTab(seller(['categories.manage', 'reports.financial', 'backups.create']), 'staff'), false);
  assert.equal(canOpenTab(null, 'pos'), false);
});

test('first screen after login', () => {
  assert.equal(firstAllowedTab(owner), 'pos');
  assert.equal(firstAllowedTab(seller(['debts.collect'])), 'debts');
  assert.equal(firstAllowedTab(seller([])), null);
});

test('hidden stock is not a limit in the UI (the main process still checks it)', () => {
  assert.equal(stockLimit(7), 7);
  assert.equal(stockLimit(0), 0);
  assert.equal(stockLimit(undefined), Number.MAX_SAFE_INTEGER);
  assert.equal(hasStockNumber(undefined), false);
  assert.equal(hasStockNumber(0), true);
});
