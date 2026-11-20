/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rules of the numeric fields (quantities, money, weight), separate from React so they are
 * tested directly. A field never shows a zero the seller did not type: an empty field stays
 * empty ('' = no value, which the form rejects where a value is required), 0 stays 0 where 0
 * is allowed, and a typed value replaces the old one in one keystroke. Comma and point are the
 * same decimal separator. Money goes to the server in integer tetri and weight in integer
 * grams, converted with string arithmetic (no floating point).
 *
 * Not for identifiers: 5-digit product codes, barcodes and PINs keep their own inputs (leading
 * zeros matter there).
 */

import { gelToTetri, formatTetri } from '../../shared/money.ts';
import { gramsToKg, kgToGrams } from '../../shared/quantity.ts';

/** Text typed into a whole-number field, or null to keep the previous text (character rejected). */
export function typingInteger(raw: string, max?: number): string | null {
  if (raw === '') return '';
  if (!/^\d+$/.test(raw)) return null;
  const trimmed = raw.replace(/^0+(?=\d)/, '');
  if (max !== undefined && Number(trimmed) > max) return String(max);
  return trimmed;
}

/** Text typed into a decimal field (money: 2 places, weight: 3), comma accepted as the point. */
export function typingDecimal(raw: string, decimals: 2 | 3): string | null {
  const text = raw.replace(/,/g, '.');
  if (text === '') return '';
  const pattern = decimals === 2 ? /^\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,3}$/;
  if (!pattern.test(text)) return null;
  return text.replace(/^0+(?=\d)/, '');
}

/** Whole number when the field is left: '' stays '' (never a silent 0); out of range is clamped. */
export function finishInteger(text: string, min: number, max?: number): number | '' {
  const t = text.trim();
  if (t === '' || !/^\d+$/.test(t)) return '';
  let n = Number(t);
  if (n < min) n = min;
  if (max !== undefined && n > max) n = max;
  return n;
}

/** Money when the field is left: "12.5" -> "12.50", '' stays ''. Invalid text becomes ''. */
export function finishMoney(text: string): string {
  const tetri = moneyToTetri(text);
  return tetri === null ? '' : formatTetri(tetri, false);
}

/** Weight when the field is left: "1.25" -> "1.250", '' stays ''. Invalid text becomes ''. */
export function finishWeight(text: string): string {
  const grams = weightToGrams(text);
  return grams === null ? '' : gramsToKg(grams, true);
}

/** "12," / ".5" / "12.5" -> "12" / "0.5" / "12.5"; null when not a plain decimal with at most `decimals` places. */
function normalizeDecimal(text: string, decimals: 2 | 3): string | null {
  let t = text.trim().replace(/,/g, '.');
  if (t === '' || t === '.') return null;
  const pattern = decimals === 2 ? /^\d*\.?\d{0,2}$/ : /^\d*\.?\d{0,3}$/;
  if (!pattern.test(t)) return null;
  if (t.endsWith('.')) t = t.slice(0, -1);
  if (t.startsWith('.')) t = `0${t}`;
  return t;
}

/** Money text to integer tetri; null when empty or invalid. */
export function moneyToTetri(text: string): number | null {
  const t = normalizeDecimal(text, 2);
  if (t === null) return null;
  try {
    return gelToTetri(t);
  } catch {
    return null;
  }
}

/** Weight text (kg) to integer grams; null when empty or invalid. */
export function weightToGrams(text: string): number | null {
  const t = normalizeDecimal(text, 3);
  if (t === null) return null;
  try {
    return kgToGrams(t);
  } catch {
    return null;
  }
}

export type NumericKind = 'integer' | 'money' | 'weight';

/**
 * True when two field texts mean the same amount ("0.30" and "0.3", "07" and "7"; an empty field
 * counts as 0 here). A focused field uses this to tell its own value coming back from the form
 * (keep the text being typed, e.g. "0.30" on the way to "0.305") from a real change made
 * elsewhere, such as a second scan raising the quantity (show the new value at once).
 */
export function sameFieldValue(a: string, b: string, kind: NumericKind): boolean {
  const measure = (t: string): number | null => {
    if (kind === 'integer') return t.trim() === '' ? 0 : /^\d+$/.test(t.trim()) ? Number(t.trim()) : null;
    if (t.trim() === '' || t.trim() === '.') return 0;
    return kind === 'money' ? moneyToTetri(t) : weightToGrams(t);
  };
  const x = measure(a);
  const y = measure(b);
  return x !== null && y !== null ? x === y : a === b;
}

/** Grams to the text a weight field shows ('' for no value, e.g. "0.375"). */
export function gramsToField(grams: number | null | undefined): string {
  if (grams === null || grams === undefined || !Number.isFinite(grams)) return '';
  return gramsToKg(grams, false);
}
