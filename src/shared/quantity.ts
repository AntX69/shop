/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Quantity and Weight utilities for StorePOS.
 * Standard base units:
 * - Piece products: integer pieces (1 piece = 1)
 * - KG products: integer grams (1.000 kg = 1000 grams)
 * Internal storage is ALWAYS integer base units.
 */

export type UnitType = 'piece' | 'kg';

/**
 * Converts a KG string or number (e.g. "1.250", "0.5", 2.5) to integer grams.
 * Accepts comma (,) or dot (.) as decimal separator.
 * Maximum precision: 3 decimal places (1 gram = 0.001 kg).
 */
export function kgToGrams(kg: number | string): number {
  if (typeof kg === 'number') {
    if (isNaN(kg) || !isFinite(kg) || kg < 0) {
      throw new Error('არასწორი წონა (Invalid weight number)');
    }
    return Math.round(kg * 1000);
  }

  const trimmed = kg.trim().replace(',', '.');
  if (!trimmed) {
    return 0;
  }

  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) {
    throw new Error(`არასწორი წონის ფორმატი: "${kg}" (სწორია მაგ. 1.250 ან 0.500 კგ)`);
  }

  const parts = trimmed.split('.');
  const whole = parseInt(parts[0], 10);
  let fraction = 0;
  if (parts.length > 1) {
    const fracStr = (parts[1] + '000').slice(0, 3);
    fraction = parseInt(fracStr, 10);
  }

  return whole * 1000 + fraction;
}

/**
 * Converts integer grams to a KG display string with up to 3 decimals (e.g. 1250 -> "1.250" or "1.25").
 * If `fixedDecimals` is true, always returns 3 decimals ("1.250").
 */
export function gramsToKg(grams: number | null | undefined, fixedDecimals: boolean = true): string {
  if (grams === null || grams === undefined || isNaN(grams) || grams <= 0) {
    return fixedDecimals ? '0.000' : '0';
  }
  const whole = Math.floor(grams / 1000);
  const frac = grams % 1000;
  const fracStr = String(frac).padStart(3, '0');
  if (fixedDecimals) {
    return `${whole}.${fracStr}`;
  }
  // Trim trailing zeroes for compact view (e.g. 1.5 instead of 1.500)
  const trimmedFrac = fracStr.replace(/0+$/, '');
  return trimmedFrac.length > 0 ? `${whole}.${trimmedFrac}` : `${whole}`;
}

/**
 * Safely parses weight input from UI to integer grams. Returns null if invalid or empty.
 */
export function safeParseGrams(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') {
    return null;
  }
  try {
    return kgToGrams(input);
  } catch {
    return null;
  }
}

/**
 * Formats a quantity in its unit for user display.
 * e.g. (15, 'piece') -> "15 ცალი"
 * e.g. (1250, 'kg') -> "1.250 კგ"
 */
export function formatUnitQuantity(quantity: number | null | undefined, unit: UnitType = 'piece', includeUnitName: boolean = true): string {
  if (quantity === null || quantity === undefined || isNaN(quantity)) {
    return unit === 'kg' ? (includeUnitName ? '0.000 კგ' : '0.000') : (includeUnitName ? '0 ცალი' : '0');
  }
  if (unit === 'kg') {
    const kgStr = gramsToKg(quantity, true);
    return includeUnitName ? `${kgStr} კგ` : kgStr;
  }
  const qtyStr = String(Math.round(quantity));
  return includeUnitName ? `${qtyStr} ცალი` : qtyStr;
}

/**
 * Price of a sale line in integer tetri, the single place this is calculated (POS screen and
 * server use the same function).
 * - piece: unit price × quantity.
 * - kg: price per kg × grams / 1000, rounded to the nearest tetri, halves up
 *   (12.50 ₾/kg × 0.375 kg = 4.6875 ₾ -> 4.69 ₾; 1.00 ₾/kg × 0.005 kg = 0.5 tetri -> 1 tetri).
 * Integer (BigInt) arithmetic, so large prices and weights never lose precision.
 */
export function lineTotalTetri(unitPriceTetri: number, quantity: number, unit: UnitType = 'piece'): number {
  if (!Number.isInteger(unitPriceTetri) || !Number.isInteger(quantity) || unitPriceTetri < 0 || quantity < 0) {
    throw new Error('არასწორი ფასი ან რაოდენობა');
  }
  if (unit !== 'kg') return unitPriceTetri * quantity;
  return Number((BigInt(unitPriceTetri) * BigInt(quantity) + 500n) / 1000n);
}

/**
 * Unit label in Georgian.
 */
export function unitLabel(unit: UnitType): string {
  return unit === 'kg' ? 'კილოგრამი (კგ)' : 'ცალი';
}

/**
 * Short unit label in Georgian.
 */
export function unitShortLabel(unit: UnitType): string {
  return unit === 'kg' ? 'კგ' : 'ც';
}
