/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Reusable Numeric Input Components for StorePOS V1.1.
 * Resolves the friction of sticky zeros:
 * - Selects entire text on focus so a single keystroke immediately replaces it.
 * - Allows clearing the field without automatically reinserting '0'.
 * - Normalizes on blur.
 * - Preserves standard keyboard navigation (Ctrl+A, Backspace, Delete, Arrows, Tab).
 * - Avoids cursor jumping.
 */

import React, { useState, useEffect, useRef } from 'react';

// --- 1. EditableIntegerInput ---
export interface EditableIntegerInputProps {
  value: number | '' | undefined;
  onChange: (val: number | '') => void;
  min?: number;
  max?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  required?: boolean;
}

export const EditableIntegerInput: React.FC<EditableIntegerInputProps> = ({
  value,
  onChange,
  min = 0,
  max,
  placeholder = '0',
  className = '',
  autoFocus,
  disabled,
  id,
  name,
  onBlur,
  onKeyDown,
  required
}) => {
  const [text, setText] = useState<string>(value === undefined || value === '' ? '' : String(value));
  const isFocusedRef = useRef(false);

  // Sync external value changes when not actively typing/focused
  useEffect(() => {
    if (!isFocusedRef.current) {
      setText(value === undefined || value === '' ? '' : String(value));
    }
  }, [value]);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = true;
    e.currentTarget.select();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') {
      setText('');
      onChange('');
      return;
    }

    // Only allow whole positive integers (digits only)
    if (/^\d+$/.test(raw)) {
      let num = parseInt(raw, 10);
      if (max !== undefined && num > max) {
        num = max;
      }
      setText(String(num));
      onChange(num);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = false;
    if (text === '') {
      if (required) {
        const fallback = min;
        setText(String(fallback));
        onChange(fallback);
      } else {
        onChange('');
      }
    } else {
      let num = parseInt(text, 10);
      if (isNaN(num)) {
        num = min;
      } else if (num < min) {
        num = min;
      } else if (max !== undefined && num > max) {
        num = max;
      }
      setText(String(num));
      onChange(num);
    }
    onBlur?.();
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      id={id}
      name={name}
      value={text}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
      autoFocus={autoFocus}
      disabled={disabled}
      required={required}
    />
  );
};

// --- 2. EditableMoneyInput ---
export interface EditableMoneyInputProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  required?: boolean;
}

export const EditableMoneyInput: React.FC<EditableMoneyInputProps> = ({
  value,
  onChange,
  placeholder = '0.00',
  className = '',
  autoFocus,
  disabled,
  id,
  name,
  onBlur,
  onKeyDown,
  required
}) => {
  const [text, setText] = useState<string>(value ?? '');
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setText(value ?? '');
    }
  }, [value]);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = true;
    e.currentTarget.select();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value.replace(',', '.');
    // Allow empty string so user can clear without 0 sticking
    if (raw === '') {
      setText('');
      onChange('');
      return;
    }

    // Accept valid money typing: optional decimal with up to 2 decimal places
    // Examples: "1", "1.", "1.2", "1.25", ".5", "0.50"
    if (/^\d*\.?\d{0,2}$/.test(raw)) {
      setText(raw);
      onChange(raw);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = false;
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '' || trimmed === '.') {
      if (required) {
        setText('0.00');
        onChange('0.00');
      } else {
        setText('');
        onChange('');
      }
    } else {
      const num = parseFloat(trimmed);
      if (!isNaN(num) && isFinite(num) && num >= 0) {
        const formatted = num.toFixed(2);
        setText(formatted);
        onChange(formatted);
      } else {
        setText('');
        onChange('');
      }
    }
    onBlur?.();
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      id={id}
      name={name}
      value={text}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
      autoFocus={autoFocus}
      disabled={disabled}
      required={required}
    />
  );
};

// --- 3. EditableWeightInput ---
export interface EditableWeightInputProps {
  value: string;
  onChange: (val: string) => void;
  maxGrams?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  required?: boolean;
}

export const EditableWeightInput: React.FC<EditableWeightInputProps> = ({
  value,
  onChange,
  maxGrams,
  placeholder = '0.000',
  className = '',
  autoFocus,
  disabled,
  id,
  name,
  onBlur,
  onKeyDown,
  required
}) => {
  const [text, setText] = useState<string>(value ?? '');
  const isFocusedRef = useRef(false);

  useEffect(() => {
    if (!isFocusedRef.current) {
      setText(value ?? '');
    }
  }, [value]);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = true;
    e.currentTarget.select();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value.replace(',', '.');
    if (raw === '') {
      setText('');
      onChange('');
      return;
    }

    // Accept valid weight typing: up to 3 decimal places (grams)
    // Examples: "1", "1.", "1.2", "1.25", "1.250", ".5", "0.500"
    if (/^\d*\.?\d{0,3}$/.test(raw)) {
      if (maxGrams !== undefined && raw !== '.' && !raw.endsWith('.')) {
        const num = parseFloat(raw);
        if (!isNaN(num) && Math.round(num * 1000) > maxGrams) {
          const maxStr = (maxGrams / 1000).toFixed(3);
          setText(maxStr);
          onChange(maxStr);
          return;
        }
      }
      setText(raw);
      onChange(raw);
    }
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    isFocusedRef.current = false;
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '' || trimmed === '.') {
      if (required) {
        setText('0.000');
        onChange('0.000');
      } else {
        setText('');
        onChange('');
      }
    } else {
      let num = parseFloat(trimmed);
      if (!isNaN(num) && isFinite(num) && num >= 0) {
        if (maxGrams !== undefined && Math.round(num * 1000) > maxGrams) {
          num = maxGrams / 1000;
        }
        const formatted = num.toFixed(3);
        setText(formatted);
        onChange(formatted);
      } else {
        setText('');
        onChange('');
      }
    }
    onBlur?.();
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      id={id}
      name={name}
      value={text}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
      autoFocus={autoFocus}
      disabled={disabled}
      required={required}
    />
  );
};
