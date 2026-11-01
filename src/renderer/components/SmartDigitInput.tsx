/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * SmartDigitInput Component (M11).
 * Production multi-cell numeric input with automatic focus progression,
 * Backspace retreat, Arrow key navigation, Copy/Paste distribution,
 * instant digit overwriting, and hotkey event isolation.
 */

import React, { useRef, useEffect } from 'react';

export interface SmartDigitInputProps {
  length: number;
  value: string;
  onChange: (value: string) => void;
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

  // Pad or trim value to exact length array
  const rawClean = value.replace(/\D/g, '').slice(0, length);
  const slots: string[] = [];
  for (let i = 0; i < length; i++) {
    slots.push(rawClean[i] || '');
  }

  useEffect(() => {
    if (autoFocus && !disabled) {
      // Find first empty slot or first slot
      const firstEmpty = slots.findIndex(s => !s);
      const targetIndex = firstEmpty >= 0 ? firstEmpty : 0;
      inputRefs.current[targetIndex]?.focus();
    }
  }, [autoFocus, disabled]);

  const updateSlots = (newSlots: string[], focusIndex?: number) => {
    const fullCode = newSlots.join('');
    onChange(fullCode);
    if (fullCode.length === length && onComplete) {
      onComplete(fullCode);
    }
    if (focusIndex !== undefined && focusIndex >= 0 && focusIndex < length) {
      setTimeout(() => {
        inputRefs.current[focusIndex]?.focus();
        inputRefs.current[focusIndex]?.select();
      }, 10);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    // Isolate hotkey bubbling so global POS shortcuts don't accidentally fire
    e.stopPropagation();

    if (e.key === 'Backspace') {
      e.preventDefault();
      const nextSlots = [...slots];
      if (nextSlots[index]) {
        // Clear current cell
        nextSlots[index] = '';
        updateSlots(nextSlots, index);
      } else if (index > 0) {
        // Retreat to previous cell and clear it
        nextSlots[index - 1] = '';
        updateSlots(nextSlots, index - 1);
      }
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (index > 0) {
        inputRefs.current[index - 1]?.focus();
        inputRefs.current[index - 1]?.select();
      }
      return;
    }

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (index < length - 1) {
        inputRefs.current[index + 1]?.focus();
        inputRefs.current[index + 1]?.select();
      }
      return;
    }

    if (e.key === 'Delete') {
      e.preventDefault();
      const nextSlots = [...slots];
      nextSlots[index] = '';
      updateSlots(nextSlots, index);
      return;
    }

    // Single digit entry
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      const nextSlots = [...slots];
      nextSlots[index] = e.key; // Overwrite current slot
      const nextFocus = index < length - 1 ? index + 1 : index;
      updateSlots(nextSlots, nextFocus);
      return;
    }

    // Allow Tab, Escape, Enter without interference
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

    const pasted = e.clipboardData.getData('text');
    const digitsOnly = pasted.replace(/\D/g, '');
    if (!digitsOnly) return;

    const nextSlots = [...slots];
    let writeIdx = index;
    // If user is pasting from beginning or has full string, start at index 0 if length matches
    if (digitsOnly.length === length) {
      writeIdx = 0;
    }

    for (let i = 0; i < digitsOnly.length && writeIdx < length; i++) {
      nextSlots[writeIdx] = digitsOnly[i];
      writeIdx++;
    }

    const nextFocus = Math.min(length - 1, writeIdx);
    updateSlots(nextSlots, nextFocus);
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
          onChange={() => {}} // Controlled by onKeyDown & onPaste
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={(e) => handlePaste(idx, e)}
          aria-label={`ციფრი #${idx + 1}`}
          placeholder="0"
          className={
            slotClassName ||
            'w-10 h-12 sm:w-12 sm:h-14 text-center text-xl sm:text-2xl font-black bg-slate-900 border-2 border-slate-700 focus:border-emerald-500 rounded-xl text-white font-mono shadow-inner focus:outline-none transition-colors'
          }
        />
      ))}
    </div>
  );
};
