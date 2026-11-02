/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Money utility library for Georgian Lari (GEL) and Tetri.
 * All monetary amounts in the database and calculations MUST be stored
 * as non-negative or signed INTEGER Tetri (1 GEL = 100 Tetri).
 * Floating-point representation for money is strictly prohibited.
 */

/**
 * Converts a GEL amount (string or number) to integer tetri.
 * Examples:
 *   "25.50" -> 2550
 *   "25.5"  -> 2550
 *   "25"    -> 2500
 *   25.5    -> 2550
 */
export function gelToTetri(gel: number | string): number {
  if (typeof gel === 'number') {
    if (isNaN(gel) || !isFinite(gel)) {
      throw new Error('არასწორი თანხის ფორმატი (Invalid number)');
    }
    // Round to avoid IEEE 754 precision issues (e.g. 19.99 * 100 = 1998.9999999999998)
    return Math.round(gel * 100);
  }

  const trimmed = gel.trim().replace(',', '.');
  if (!trimmed) {
    return 0;
  }

  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(`არასწორი თანხის ფორმატი: "${gel}" (სწორია მაგ. 15.50 ან 20)`);
  }

  const parts = trimmed.split('.');
  const whole = parseInt(parts[0], 10);
  const sign = whole < 0 || Object.is(whole, -0) || trimmed.startsWith('-') ? -1 : 1;
  const absWhole = Math.abs(whole);
  
  let fraction = 0;
  if (parts.length > 1) {
    const fracStr = (parts[1] + '00').slice(0, 2);
    fraction = parseInt(fracStr, 10);
  }

  return sign * (absWhole * 100 + fraction);
}

/**
 * Formats tetri into a standard GEL display string (e.g. "25.50 ₾").
 */
export function formatTetri(tetri: number | null | undefined, includeSymbol: boolean = true): string {
  if (tetri === null || tetri === undefined || isNaN(tetri)) {
    return includeSymbol ? '0.00 ₾' : '0.00';
  }

  const sign = tetri < 0 ? '-' : '';
  const absTetri = Math.abs(Math.round(tetri));
  const whole = Math.floor(absTetri / 100);
  const fraction = absTetri % 100;
  const fracStr = fraction < 10 ? `0${fraction}` : `${fraction}`;

  const formatted = `${sign}${whole}.${fracStr}`;
  return includeSymbol ? `${formatted} ₾` : formatted;
}

/**
 * Splits an integer amount across weights (e.g. a cart discount across lines) so that the
 * parts are integers, proportional to the weights, and sum exactly to the amount
 * (largest-remainder method). Uses BigInt so large products never lose precision.
 */
export function allocateProportionally(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (amount <= 0 || total <= 0) return weights.map(() => 0);
  const A = BigInt(amount);
  const T = BigInt(total);
  const parts = weights.map((w) => (A * BigInt(w)) / T);
  const remainders = weights.map((w, i) => ({ i, r: (A * BigInt(w)) % T }));
  let left = amount - parts.reduce((s, p) => s + Number(p), 0);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  const result = parts.map(Number);
  for (let k = 0; left > 0; k++, left--) result[remainders[k % remainders.length].i]++;
  return result;
}

/**
 * Amount attributable to `count` more units of a line whose `quantity` units cost `lineTotal`
 * in total, after `alreadyCounted` units were handled earlier. Successive partial returns
 * therefore always add up to exactly `lineTotal`, without fractional tetri.
 */
export function proratedLineAmount(lineTotal: number, quantity: number, alreadyCounted: number, count: number): number {
  if (quantity <= 0) return 0;
  const T = BigInt(lineTotal);
  const Q = BigInt(quantity);
  const upper = (T * BigInt(alreadyCounted + count)) / Q;
  const lower = (T * BigInt(alreadyCounted)) / Q;
  return Number(upper - lower);
}

/**
 * Parses user input from UI (e.g. "12.50") safely to tetri. Returns null if empty/invalid.
 */
export function safeParseTetri(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }
  try {
    return gelToTetri(input);
  } catch {
    return null;
  }
}
