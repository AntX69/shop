/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shop currency (Georgian lari, euro, US dollar).
 *
 * The whole shop works in one currency: prices, costs, sales, debts, expenses and reports.
 * Amounts are stored as integers in the currency's minor unit (tetri or cents; the database
 * columns keep their historical "_tetri" names). All three currencies have 100 minor units,
 * so arithmetic and rounding are the same for each.
 *
 * The currency is chosen when the shop is set up and can be changed only while the shop has
 * no money records yet: an amount is never converted, because a past sale happened in the
 * currency it was recorded in.
 */

import { getLanguage, Lang, LANGUAGE_LOCALES } from './i18n/index.ts';

export type Currency = 'GEL' | 'EUR' | 'USD';

export const CURRENCIES: readonly Currency[] = ['GEL', 'EUR', 'USD'];

export const CURRENCY_SYMBOLS: Record<Currency, string> = {
  GEL: '₾',
  EUR: '€',
  USD: '$',
};

/** Banknotes offered as quick "cash received" buttons at the till. */
export const CASH_BILLS: Record<Currency, readonly number[]> = {
  GEL: [10, 20, 50, 100, 200],
  EUR: [10, 20, 50, 100, 200],
  USD: [5, 10, 20, 50, 100],
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

let current: Currency = 'GEL';

export function getCurrency(): Currency {
  return current;
}

/** Sets the currency this process formats amounts in (the shop's currency). */
export function setCurrency(currency: unknown): void {
  if (isCurrency(currency)) current = currency;
}

export function currencySymbol(currency: Currency = current): string {
  return CURRENCY_SYMBOLS[currency];
}

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(lang: Lang, currency: Currency): Intl.NumberFormat {
  const key = `${lang}:${currency}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LANGUAGE_LOCALES[lang], {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
  }
  return f;
}

/** "25.50" for an amount of 2550 minor units (no grouping, point as decimal separator). */
export function plainAmount(minor: number | null | undefined): string {
  if (minor === null || minor === undefined || Number.isNaN(minor)) return '0.00';
  const n = Math.round(minor);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return `${sign}${whole}.${fraction < 10 ? `0${fraction}` : fraction}`;
}

export interface FormatMoneyOptions {
  currency?: Currency;
  lang?: Lang;
  /** false: the plain number "25.50" (used to fill input fields). */
  symbol?: boolean;
}

/**
 * Formats an amount in minor units for display.
 * Georgian keeps the established form "25.50 ₾"; the other languages use their own
 * conventions ("€25.50", "25,50 €").
 */
export function formatMoney(minor: number | null | undefined, options: FormatMoneyOptions = {}): string {
  const currency = options.currency ?? current;
  const lang = options.lang ?? getLanguage();
  if (options.symbol === false) return plainAmount(minor);
  if (lang === 'ka') return `${plainAmount(minor)} ${CURRENCY_SYMBOLS[currency]}`;
  const n = minor === null || minor === undefined || Number.isNaN(minor) ? 0 : Math.round(minor);
  return formatter(lang, currency).format(n / 100);
}
