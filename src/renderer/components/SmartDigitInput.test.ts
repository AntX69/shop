/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Milestone M12 Test Suite: SmartDigitInput In-Place Slot Editing & Deletion UX
 * 
 * Tests:
 * 1. Middle-cell deletion preserves trailing slots (deleting middle '0' from '50001' leaves ['5','0','','0','1'])
 * 2. Backspace on empty cell retreats and clears previous cell
 * 3. Delete key clears current cell without shifting digits
 * 4. Paste 5 digits fills all slots cleanly
 * 5. Non-digit input is strictly rejected
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pure slot state transition engine reflecting SmartDigitInput's logic
 */
class SmartSlotEngine {
  slots: string[];
  focusedIndex: number;

  constructor(initial = ['', '', '', '', '']) {
    this.slots = [...initial];
    this.focusedIndex = 0;
  }

  handleKeyDown(key: string, index: number): { nextFocus: number; value: string } {
    this.focusedIndex = index;
    const newSlots = [...this.slots];

    if (key === 'Backspace') {
      if (newSlots[index] !== '') {
        // Clear current slot in place without shifting
        newSlots[index] = '';
        this.slots = newSlots;
        return { nextFocus: Math.max(0, index - 1), value: newSlots.join('') };
      } else if (index > 0) {
        // Already empty, retreat to previous slot and clear it
        newSlots[index - 1] = '';
        this.slots = newSlots;
        return { nextFocus: index - 1, value: newSlots.join('') };
      }
    } else if (key === 'Delete') {
      // Clear cell in place, do not move focus, do not shift digits
      newSlots[index] = '';
      this.slots = newSlots;
      return { nextFocus: index, value: newSlots.join('') };
    } else if (key === 'ArrowLeft') {
      return { nextFocus: Math.max(0, index - 1), value: newSlots.join('') };
    } else if (key === 'ArrowRight') {
      return { nextFocus: Math.min(4, index + 1), value: newSlots.join('') };
    } else if (/^\d$/.test(key)) {
      // Type digit into slot
      newSlots[index] = key;
      this.slots = newSlots;
      return { nextFocus: Math.min(4, index + 1), value: newSlots.join('') };
    }

    return { nextFocus: index, value: newSlots.join('') };
  }

  handlePaste(pastedText: string, index: number): { nextFocus: number; value: string } {
    const digits = pastedText.replace(/\D/g, '').slice(0, 5);
    const newSlots = [...this.slots];

    if (digits.length >= 5) {
      for (let i = 0; i < 5; i++) {
        newSlots[i] = digits[i];
      }
      this.slots = newSlots;
      return { nextFocus: 4, value: newSlots.join('') };
    } else {
      let cur = index;
      for (const d of digits) {
        if (cur < 5) {
          newSlots[cur] = d;
          cur++;
        }
      }
      this.slots = newSlots;
      return { nextFocus: Math.min(4, cur), value: newSlots.join('') };
    }
  }
}

test('SmartDigitInput: Middle-cell Backspace clears cell without shifting trailing digits', () => {
  const engine = new SmartSlotEngine(['5', '0', '0', '0', '1']);
  
  // User hits backspace on index 2 (the middle 0)
  const res = engine.handleKeyDown('Backspace', 2);

  // Crucial M12 invariant: slots 3 and 4 MUST NOT shift left!
  assert.deepEqual(engine.slots, ['5', '0', '', '0', '1'], 'Slot 2 is cleared, slots 3 and 4 remain in place');
  assert.equal(res.nextFocus, 1, 'Focus retreats to slot 1');
});

test('SmartDigitInput: Backspace on already-empty cell retreats and clears previous cell', () => {
  const engine = new SmartSlotEngine(['5', '0', '', '0', '1']);

  // Focus is on index 2 (which is empty) and user hits backspace again
  const res = engine.handleKeyDown('Backspace', 2);

  // Must clear slot 1 and move focus to slot 1
  assert.deepEqual(engine.slots, ['5', '', '', '0', '1']);
  assert.equal(res.nextFocus, 1);
});

test('SmartDigitInput: Delete key clears current cell without shifting and without moving focus', () => {
  const engine = new SmartSlotEngine(['5', '0', '0', '0', '1']);

  // User hits Delete on index 2
  const res = engine.handleKeyDown('Delete', 2);

  assert.deepEqual(engine.slots, ['5', '0', '', '0', '1']);
  assert.equal(res.nextFocus, 2, 'Focus stays on deleted cell');
});

test('SmartDigitInput: 5-digit Paste fills all slots without displacement', () => {
  const engine = new SmartSlotEngine(['', '', '', '', '']);

  const res = engine.handlePaste('54321', 0);

  assert.deepEqual(engine.slots, ['5', '4', '3', '2', '1']);
  assert.equal(res.value, '54321');
  assert.equal(res.nextFocus, 4);
});

test('SmartDigitInput: Non-digit characters are rejected', () => {
  const engine = new SmartSlotEngine(['', '', '', '', '']);

  // Typing letters
  const res1 = engine.handleKeyDown('a', 0);
  assert.deepEqual(engine.slots, ['', '', '', '', '']);

  const res2 = engine.handleKeyDown('!', 0);
  assert.deepEqual(engine.slots, ['', '', '', '', '']);

  // Typing valid digit
  const res3 = engine.handleKeyDown('7', 0);
  assert.deepEqual(engine.slots, ['7', '', '', '', '']);
  assert.equal(res3.nextFocus, 1);
});
