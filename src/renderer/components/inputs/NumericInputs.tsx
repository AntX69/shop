/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Numeric input components (whole numbers, money, weight).
 * - Focus selects the whole text, so one keystroke replaces the old value.
 * - The field can be cleared; it never refills itself with 0 or a minimum. An empty field
 *   reports '' and the form decides whether that is allowed (e.g. "enter an amount").
 * - Comma and point both work as the decimal separator.
 * - Backspace, Delete, arrows, Ctrl+A and Tab keep their normal behaviour (plain text input).
 * The rules themselves live in utils/numericInput.ts and are unit-tested there.
 */

import React, { useState, useEffect, useRef } from 'react';
import { typingInteger, typingDecimal, finishInteger, finishMoney, finishWeight, weightToGrams, sameFieldValue, NumericKind } from '../../utils/numericInput.ts';
import { gramsToKg } from '../../../shared/quantity.ts';

interface BaseProps {
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Marks the field as mandatory for the browser form; an empty value is still reported as ''. */
  required?: boolean;
  ariaLabel?: string;
}

/**
 * Field text: follows the parent's value, except that while the field has focus its own value
 * coming back from the form does not overwrite what is being typed ("0.30" stays "0.30").
 * A real change from elsewhere (a second scan, +/- buttons) is shown at once, focused or not.
 */
function useFieldText(external: string, kind: NumericKind) {
  const [text, setText] = useState<string>(external);
  const focused = useRef(false);
  const reported = useRef(external);
  useEffect(() => {
    if (!focused.current || !sameFieldValue(external, reported.current, kind)) {
      setText(external);
      reported.current = external;
    }
  }, [external]);
  /** Shows `t` and remembers it as the field's own value before it is passed to the form. */
  const show = (t: string) => {
    setText(t);
    reported.current = t;
  };
  return { text, show, focused };
}

// --- 1. EditableIntegerInput ---
export interface EditableIntegerInputProps extends BaseProps {
  value: number | '' | undefined;
  onChange: (val: number | '') => void;
  min?: number;
  max?: number;
}

export const EditableIntegerInput: React.FC<EditableIntegerInputProps> = ({
  value, onChange, min = 0, max, placeholder = '0', className = '', autoFocus, disabled, id, name, onBlur, onKeyDown, required, ariaLabel,
}) => {
  const { text, show, focused } = useFieldText(value === undefined || value === '' ? '' : String(value), 'integer');

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      id={id}
      name={name}
      aria-label={ariaLabel}
      value={text}
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onChange={(e) => {
        const next = typingInteger(e.target.value, max);
        if (next === null) return;
        show(next);
        onChange(next === '' ? '' : Number(next));
      }}
      onBlur={() => {
        focused.current = false;
        const n = finishInteger(text, min, max);
        show(n === '' ? '' : String(n));
        onChange(n);
        onBlur?.();
      }}
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
export interface EditableMoneyInputProps extends BaseProps {
  /** GEL as text ("12.50"), '' = no amount. Convert with moneyToTetri() before sending. */
  value: string;
  onChange: (val: string) => void;
}

export const EditableMoneyInput: React.FC<EditableMoneyInputProps> = ({
  value, onChange, placeholder = '0.00', className = '', autoFocus, disabled, id, name, onBlur, onKeyDown, required, ariaLabel,
}) => {
  const { text, show, focused } = useFieldText(value ?? '', 'money');

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      id={id}
      name={name}
      aria-label={ariaLabel}
      value={text}
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onChange={(e) => {
        const next = typingDecimal(e.target.value, 2);
        if (next === null) return;
        show(next);
        onChange(next);
      }}
      onBlur={() => {
        focused.current = false;
        const finished = finishMoney(text);
        show(finished);
        onChange(finished);
        onBlur?.();
      }}
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
export interface EditableWeightInputProps extends BaseProps {
  /** Kilograms as text ("0.375"), '' = no weight. Convert with weightToGrams() before sending. */
  value: string;
  onChange: (val: string) => void;
  /** Upper limit in grams (e.g. stock on hand, or what is left to return). */
  maxGrams?: number;
}

export const EditableWeightInput: React.FC<EditableWeightInputProps> = ({
  value, onChange, maxGrams, placeholder = '0.000', className = '', autoFocus, disabled, id, name, onBlur, onKeyDown, required, ariaLabel,
}) => {
  const { text, show, focused } = useFieldText(value ?? '', 'weight');
  const capped = (t: string): string => {
    if (maxGrams === undefined) return t;
    const grams = weightToGrams(t);
    return grams !== null && grams > maxGrams ? gramsToKg(Math.max(0, maxGrams), true) : t;
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      id={id}
      name={name}
      aria-label={ariaLabel}
      value={text}
      onFocus={(e) => { focused.current = true; e.currentTarget.select(); }}
      onChange={(e) => {
        const next = typingDecimal(e.target.value, 3);
        if (next === null) return;
        const shown = capped(next);
        show(shown);
        onChange(shown);
      }}
      onBlur={() => {
        focused.current = false;
        const finished = capped(finishWeight(text));
        show(finished);
        onChange(finished);
        onBlur?.();
      }}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
      autoFocus={autoFocus}
      disabled={disabled}
      required={required}
    />
  );
};
