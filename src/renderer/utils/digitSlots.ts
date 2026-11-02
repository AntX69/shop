/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Slot logic of SmartDigitInput (PIN, 5-digit product codes, OCR correction), kept free of
 * React so the exact behaviour the component uses is unit tested:
 * - a digit overwrites its own cell only; clearing a cell never shifts the others;
 * - Backspace clears the current cell, or the previous one when the current cell is empty;
 * - Delete clears the current cell; arrows / Home / End move without changing anything;
 * - a pasted full-length code fills every cell, a shorter one fills from the focused cell.
 */

export interface SlotUpdate {
  slots: string[];
  /** Cell to focus afterwards. */
  focus: number;
  /** false when only the focus moves. */
  changed: boolean;
}

export function emptySlots(length: number): string[] {
  return Array(length).fill('');
}

/** Cells from a plain string value (non-digits dropped, filled from the left). */
export function slotsFromValue(value: string, length: number): string[] {
  const clean = String(value ?? '').replace(/\D/g, '').slice(0, length);
  const slots = emptySlots(length);
  for (let i = 0; i < clean.length; i++) slots[i] = clean[i];
  return slots;
}

/** Cells from explicit positions (keeps gaps where they are). */
export function normalizeSlots(values: readonly string[], length: number): string[] {
  const slots = emptySlots(length);
  for (let i = 0; i < length; i++) {
    const v = String(values[i] ?? '');
    slots[i] = /^\d$/.test(v) ? v : '';
  }
  return slots;
}

/** Comparable key of a cell array: '_' marks an empty cell. */
export function slotsKey(slots: readonly string[]): string {
  return slots.map((s) => s || '_').join('');
}

export function isComplete(slots: readonly string[]): boolean {
  return slots.length > 0 && slots.every((s) => /^\d$/.test(s));
}

/**
 * Applies one key press in cell `index`. Returns null for keys the input does not handle
 * (Tab, Enter, Escape, shortcuts), which are left to the surrounding screen.
 */
export function applyKey(slots: readonly string[], index: number, key: string): SlotUpdate | null {
  const length = slots.length;
  const next = [...slots];

  if (key === 'Backspace') {
    if (next[index]) {
      next[index] = '';
      return { slots: next, focus: index, changed: true };
    }
    if (index > 0) {
      next[index - 1] = '';
      return { slots: next, focus: index - 1, changed: true };
    }
    return { slots: next, focus: index, changed: false };
  }
  if (key === 'Delete') {
    const changed = next[index] !== '';
    next[index] = '';
    return { slots: next, focus: index, changed };
  }
  if (key === 'ArrowLeft') return { slots: next, focus: Math.max(0, index - 1), changed: false };
  if (key === 'ArrowRight') return { slots: next, focus: Math.min(length - 1, index + 1), changed: false };
  if (key === 'Home') return { slots: next, focus: 0, changed: false };
  if (key === 'End') return { slots: next, focus: length - 1, changed: false };
  if (/^\d$/.test(key)) {
    next[index] = key;
    return { slots: next, focus: index < length - 1 ? index + 1 : index, changed: true };
  }
  return null;
}

/** Distributes pasted text over the cells (only its digits are used). */
export function applyPaste(slots: readonly string[], index: number, text: string): SlotUpdate | null {
  const length = slots.length;
  const digits = String(text ?? '').replace(/\D/g, '');
  if (!digits) return null;
  const next = [...slots];
  let write = digits.length === length ? 0 : index;
  for (let i = 0; i < digits.length && write < length; i++) {
    next[write] = digits[i];
    write++;
  }
  return { slots: next, focus: Math.min(length - 1, write), changed: true };
}
