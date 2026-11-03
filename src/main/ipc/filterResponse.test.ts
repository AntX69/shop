/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterResponse } from './handlers.ts';
import type { User } from '../../shared/types.ts';

const seller = { id: 2, role: 'seller' } as User;
const owner = { id: 1, role: 'owner' } as User;

test('responses: PIN hashes never leave, costs only for the owner', () => {
  const value = { name: 'x', pin_hash: 'h', pin_salt: 's', base_cost_tetri: 100, rows: [{ profit_tetri: 5, qty: 2 }] };
  assert.deepEqual(filterResponse(value, seller), { name: 'x', rows: [{ qty: 2 }] });
  assert.deepEqual(filterResponse(value, owner), { name: 'x', base_cost_tetri: 100, rows: [{ profit_tetri: 5, qty: 2 }] });
});

test('responses: binary data (OCR diagnostics images) stays binary', () => {
  const image = new Uint8Array([0, 128, 255]);
  const out = filterResponse({ diagnostics: { binary: image, digitInputs: [new Uint8Array(784)] } }, seller);
  assert.ok(out.diagnostics.binary instanceof Uint8Array);
  assert.deepEqual([...out.diagnostics.binary], [0, 128, 255]);
  assert.ok(out.diagnostics.digitInputs[0] instanceof Uint8Array);
  assert.equal(out.diagnostics.digitInputs[0].length, 784);
});
