/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SmartDigitInput Component (M12 Production Hardened).
 * Bulletproof multi-cell numeric input:
 * - Local slot state guarantees middle cell deletion never shifts subsequent digits.
 * - Exact Backspace / Delete semantics (clear cell, retreat if already empty).
 * - Immediate synchronous focus progression for ultra-fast typing without dropped keystrokes.
 * - ArrowLeft / ArrowRight / Home / End keyboard navigation.
 * - Single-stroke full code paste distribution.
 * - Unified across PIN (isMasked), 5-digit product codes, and OCR confirmation.
 * The slot rules live in ../utils/digitSlots.ts (unit tested).
 */

import React, { useRef, useState, useEffect } from 'react';
import { applyKey, applyPaste, isComplete, normalizeSlots, slotsFromValue, slotsKey, SlotUpdate } from '../utils/digitSlots.ts';

export interface SmartDigitInputProps {
  length: number;
  value: string;
  /** Exact cells (with gaps), e.g. an OCR result with an unrecognised middle digit. Takes precedence over value. */
  slotValues?: string[];
  /** Cells to check (e.g. digits the OCR is unsure of), highlighted in amber. */
  flagged?: boolean[];
  onChange: (value: string, slots?: string[]) => void;
  onComplete?: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  isMasked?: boolean;
  className?: string;
  slotClassName?: string;
  ariaLabel?: string;
}

export const SmartDigitInput: React.FC<SmartDigitInputProps> = ({
  length,
  value,
  slotValues,
  flagged,
  onChange,
  onComplete,
  autoFocus = false,
  disabled = false,
  isMasked = false,
  className = '',
  slotClassName = '',
  ariaLabel = 'ციფრული კოდის შეყვანა'
}) => {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const fromProps = () => (slotValues ? normalizeSlots(slotValues, length) : slotsFromValue(value, length));
  const externalKey = slotValues ? slotsKey(normalizeSlots(slotValues, length)) : String(value ?? '');

  // Internal slots state of exact length
  const [slots, setSlots] = useState<string[]>(fromProps);

  // Track last value emitted from internal user interaction to avoid resetting slots on parent echo
  const lastEmittedValueRef = useRef<string | null>(null);

  // Sync with external prop only when changed externally (e.g. OCR scan result, reset)
  useEffect(() => {
    if (externalKey !== lastEmittedValueRef.current) {
      lastEmittedValueRef.current = externalKey;
      setSlots(fromProps());
    }
  }, [externalKey, length]);

  // Handle auto-focus
  useEffect(() => {
    if (autoFocus && !disabled) {
      const firstEmpty = slots.findIndex(s => !s);
      const targetIndex = firstEmpty >= 0 ? firstEmpty : 0;
      inputRefs.current[targetIndex]?.focus();
    }
  }, [autoFocus, disabled]);

  const focusCell = (index: number) => {
    if (index < 0 || index >= length) return;
    // Synchronous focus so rapid typing never drops a keystroke
    const el = inputRefs.current[index];
    if (el) {
      el.focus();
      el.select();
    }
  };

  const apply = (update: SlotUpdate) => {
    if (update.changed) {
      setSlots(update.slots);
      const fullCode = update.slots.join('');
      lastEmittedValueRef.current = slotValues ? slotsKey(update.slots) : fullCode;
      onChange(fullCode, update.slots);

      // If completely filled without blanks
      if (isComplete(update.slots) && onComplete) {
        onComplete(fullCode);
      }
    }
    focusCell(update.focus);
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    // Isolate hotkey bubbling so global POS shortcuts (F1-F12) don't accidentally fire
    e.stopPropagation();

    const update = e.ctrlKey || e.metaKey || e.altKey ? null : applyKey(slots, index, e.key);
    if (update) {
      e.preventDefault();
      apply(update);
      return;
    }

    // Allow Tab, Escape, Enter to propagate for form submission/dismissal
    if (['Tab', 'Escape', 'Enter'].includes(e.key)) {
      return;
    }

    // Disallow non-numeric characters
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
    }
  };

  const handlePaste = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const update = applyPaste(slots, index, e.clipboardData.getData('text'));
    if (update) apply(update);
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex items-center justify-center gap-2 sm:gap-2.5 ${className}`}
    >
      {slots.map((digit, idx) => (
        <input
          key={idx}
          ref={(el) => { inputRefs.current[idx] = el; }}
          type={isMasked ? 'password' : 'text'}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          disabled={disabled}
          value={digit}
          onFocus={(e) => e.target.select()}
          onChange={() => {}} // Controlled strictly by onKeyDown and onPaste
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={(e) => handlePaste(idx, e)}
          aria-label={`ციფრი #${idx + 1}`}
          data-flagged={flagged?.[idx] ? 'true' : undefined}
          title={flagged?.[idx] ? 'შეამოწმეთ ეს ციფრი' : undefined}
          placeholder="0"
          className={
            slotClassName ||
            `w-10 h-12 sm:w-12 sm:h-14 text-center text-xl sm:text-2xl font-black border-2 rounded-xl text-white font-mono shadow-inner focus:outline-none transition-colors ${
              flagged?.[idx] ? 'bg-amber-950/50 border-amber-500 focus:border-amber-300' : 'bg-slate-900 border-slate-700 focus:border-emerald-500'
            }`
          }
        />
      ))}
    </div>
  );
};
