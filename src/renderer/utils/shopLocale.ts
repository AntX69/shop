/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Choices offered when a shop is set up: currency names and time zones.
 */

import { Currency } from '../../shared/currency.ts';
import { tr } from '../../shared/i18n/index.ts';
import { isValidTimeZone } from '../../shared/time.ts';

/** Georgian source names; shown with tr() so they follow the language. */
const CURRENCY_NAMES: Record<Currency, string> = {
  GEL: 'ქართული ლარი (₾, GEL)',
  EUR: 'ევრო (€, EUR)',
  USD: 'აშშ დოლარი ($, USD)',
};

export function currencyName(currency: Currency): string {
  return tr(CURRENCY_NAMES[currency]);
}

const COMMON_TIME_ZONES = [
  'Asia/Tbilisi',
  'Europe/Madrid',
  'Atlantic/Canary',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Rome',
  'Europe/Warsaw',
  'Europe/Kyiv',
  'Europe/Istanbul',
  'Europe/Moscow',
  'Asia/Yerevan',
  'Asia/Baku',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'UTC',
];

/** The time zone Windows is set to, e.g. "Europe/Madrid". */
export function systemTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(tz) ? tz : 'Asia/Tbilisi';
  } catch {
    return 'Asia/Tbilisi';
  }
}

export function timeZoneOptions(current?: string): string[] {
  const list = [current, systemTimeZone(), ...COMMON_TIME_ZONES].filter((z): z is string => !!z && isValidTimeZone(z));
  return Array.from(new Set(list));
}

/** A first guess for a new shop's currency from its time zone (the owner can change it). */
export function suggestedCurrency(timeZone: string): Currency {
  if (timeZone === 'Asia/Tbilisi') return 'GEL';
  if (timeZone.startsWith('America/')) return 'USD';
  if (timeZone.startsWith('Europe/') || timeZone === 'Atlantic/Canary' || timeZone === 'Atlantic/Madeira') return 'EUR';
  return 'GEL';
}
