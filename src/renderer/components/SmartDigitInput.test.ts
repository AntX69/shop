/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SmartDigitInput slot editing: these tests run the same functions the component uses
 * (src/renderer/utils/digitSlots.ts), not a copy of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyKey, applyPaste, isComplete, normalizeSlots, slotsFromValue, slotsKey } from '../utils/digitSlots.ts';

test('SmartDigitInput: Backspace on a filled middle cell clears only that cell, nothing shifts', () => {
  const r = applyKey(['5', '0', '0', '0', '1'], 2, 'Backspace')!;
  assert.deepEqual(r.slots, ['5', '0', '', '0', '1'], 'cells 3 and 4 stay where they are');
  assert.equal(r.focus, 2, 'focus stays on the cleared cell');
  assert.equal(r.changed, true);
});

test('SmartDigitInput: Backspace on an empty cell clears the previous cell and moves there', () => {
  const r = applyKey(['5', '0', '', '0', '1'], 2, 'Backspace')!;
  assert.deepEqual(r.slots, ['5', '', '', '0', '1']);
  assert.equal(r.focus, 1);
});

test('SmartDigitInput: Backspace on the first empty cell changes nothing', () => {
  const r = applyKey(['', '2', '3', '4', '5'], 0, 'Backspace')!;
  assert.deepEqual(r.slots, ['', '2', '3', '4', '5']);
  assert.equal(r.changed, false);
});

test('SmartDigitInput: Delete clears the current cell without shifting or moving focus', () => {
  const r = applyKey(['5', '0', '0', '0', '1'], 2, 'Delete')!;
  assert.deepEqual(r.slots, ['5', '0', '', '0', '1']);
  assert.equal(r.focus, 2);
});

test('SmartDigitInput: a corrected middle digit overwrites only that cell', () => {
  // OCR read 12845, the seller fixes the third digit
  const r = applyKey(['1', '2', '8', '4', '5'], 2, '3')!;
  assert.deepEqual(r.slots, ['1', '2', '3', '4', '5']);
  assert.equal(r.focus, 3, 'focus moves to the next cell');
  const last = applyKey(r.slots, 4, '9')!;
  assert.equal(last.focus, 4, 'the last cell keeps focus');
});

test('SmartDigitInput: arrows, Home and End only move the focus', () => {
  const s = ['1', '2', '3', '4', '5'];
  assert.equal(applyKey(s, 2, 'ArrowLeft')!.focus, 1);
  assert.equal(applyKey(s, 2, 'ArrowRight')!.focus, 3);
  assert.equal(applyKey(s, 0, 'ArrowLeft')!.focus, 0);
  assert.equal(applyKey(s, 4, 'ArrowRight')!.focus, 4);
  assert.equal(applyKey(s, 3, 'Home')!.focus, 0);
  assert.equal(applyKey(s, 1, 'End')!.focus, 4);
  for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) assert.equal(applyKey(s, 2, k)!.changed, false);
});

test('SmartDigitInput: letters and symbols are not digits; Tab/Enter/Escape are left to the screen', () => {
  for (const k of ['a', 'ა', '!', ' ', '-', 'Tab', 'Enter', 'Escape', 'F2']) {
    assert.equal(applyKey(['', '', '', '', ''], 0, k), null, `key ${k}`);
  }
});

test('SmartDigitInput: a full-length paste fills every cell from the first', () => {
  const r = applyPaste(['', '', '', '', ''], 3, '54321')!;
  assert.deepEqual(r.slots, ['5', '4', '3', '2', '1']);
  assert.equal(r.focus, 4);
});

test('SmartDigitInput: a short paste fills from the focused cell; non-digits are dropped', () => {
  const r = applyPaste(['1', '', '', '', '5'], 1, '2-3')!;
  assert.deepEqual(r.slots, ['1', '2', '3', '', '5']);
  assert.equal(applyPaste(['', '', '', '', ''], 0, 'abc'), null);
});

test('SmartDigitInput: explicit cell values keep gaps; plain values fill from the left', () => {
  assert.deepEqual(normalizeSlots(['1', '', '3', '4', '5'], 5), ['1', '', '3', '4', '5']);
  assert.deepEqual(normalizeSlots(['1', 'x', '3'], 5), ['1', '', '3', '', '']);
  assert.deepEqual(slotsFromValue('1345', 5), ['1', '3', '4', '5', '']);
  assert.notEqual(slotsKey(['1', '', '3', '4', '5']), slotsKey(['1', '3', '4', '5', '']));
  assert.equal(isComplete(['1', '2', '3', '4', '5']), true);
  assert.equal(isComplete(['1', '', '3', '4', '5']), false);
});
