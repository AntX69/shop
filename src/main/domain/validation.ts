/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Input validation helpers for IPC payloads. Every amount is integer tetri and every
 * quantity is a whole number of pieces; fractional or non-numeric values are rejected
 * before they can reach stock or money columns.
 */

export const MAX_QUANTITY = 100_000;
/** 100 million GEL in tetri: far above any single operation, well inside Number.MAX_SAFE_INTEGER. */
export const MAX_AMOUNT_TETRI = 10_000_000_000;

export function requireObject<T = Record<string, unknown>>(value: unknown, label = 'მოთხოვნა'): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: მონაცემები არასწორია`);
  }
  return value as T;
}

export function requireId(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} არასწორია`);
  }
  return value;
}

export function optionalId(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  return requireId(value, label);
}

/** Whole number of pieces, at least 1. */
export function requireQuantity(value: unknown, label = 'რაოდენობა'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} უნდა იყოს მთელი რიცხვი, მინიმუმ 1 (მიღებულია: ${String(value)})`);
  }
  if (value > MAX_QUANTITY) {
    throw new Error(`${label} ძალიან დიდია (მაქსიმუმ ${MAX_QUANTITY})`);
  }
  return value;
}

/** Whole number of pieces, zero allowed (stock counts). */
export function requireCount(value: unknown, label = 'რაოდენობა'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} უნდა იყოს მთელი, არაუარყოფითი რიცხვი (მიღებულია: ${String(value)})`);
  }
  if (value > MAX_QUANTITY) {
    throw new Error(`${label} ძალიან დიდია (მაქსიმუმ ${MAX_QUANTITY})`);
  }
  return value;
}

/** Integer tetri, zero allowed. */
export function requireAmount(value: unknown, label = 'თანხა'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} უნდა იყოს მთელი რიცხვი თეთრებში (მიღებულია: ${String(value)})`);
  }
  if (value > MAX_AMOUNT_TETRI) {
    throw new Error(`${label} ძალიან დიდია`);
  }
  return value;
}

/** Integer tetri, strictly positive. */
export function requirePositiveAmount(value: unknown, label = 'თანხა'): number {
  const v = requireAmount(value, label);
  if (v === 0) throw new Error(`${label} უნდა იყოს 0-ზე მეტი`);
  return v;
}

/** Integer tetri or null (unknown, e.g. purchase cost). */
export function optionalAmount(value: unknown, label = 'თანხა'): number | null {
  if (value === undefined || value === null) return null;
  return requireAmount(value, label);
}

export function optionalString(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${label} არასწორია`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) throw new Error(`${label} ძალიან გრძელია (მაქსიმუმ ${maxLength} სიმბოლო)`);
  return trimmed || null;
}

export function requireString(value: unknown, maxLength: number, label: string): string {
  const v = optionalString(value, maxLength, label);
  if (!v) throw new Error(`${label} სავალდებულოა`);
  return v;
}

export function optionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) {
    throw new Error('იდემპოტენტურობის გასაღები არასწორია');
  }
  return value;
}

export function requireArray<T = unknown>(value: unknown, label: string, maxItems = 500): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: სია ცარიელია`);
  }
  if (value.length > maxItems) {
    throw new Error(`${label}: ძალიან ბევრი ჩანაწერი (მაქსიმუმ ${maxItems})`);
  }
  return value as T[];
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} არასწორია`);
  }
  return value as T;
}
