/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dates and numbers in the current interface language, in the shop's time zone.
 */

import { getLanguage, LANGUAGE_LOCALES } from './index.ts';
import { getStoreTimeZone } from '../time.ts';

type DateInput = string | number | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const cache = new Map<string, Intl.DateTimeFormat>();
function dateFormat(kind: 'datetime' | 'date', timeZone: string): Intl.DateTimeFormat {
  const locale = LANGUAGE_LOCALES[getLanguage()];
  const key = `${locale}|${kind}|${timeZone}`;
  let f = cache.get(key);
  if (!f) {
    f =
      kind === 'datetime'
        ? new Intl.DateTimeFormat(locale, {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
          })
        : new Intl.DateTimeFormat(locale, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    cache.set(key, f);
  }
  return f;
}

/** Date and time of an instant, e.g. "21.11.2026, 20:31:52" (Georgian) or "21/11/2026, 20:31:52". */
export function fmtDateTime(value: DateInput): string {
  const d = toDate(value);
  return d ? dateFormat('datetime', getStoreTimeZone()).format(d) : '';
}

/** Calendar date of an instant in the shop's time zone. */
export function fmtDate(value: DateInput): string {
  const d = toDate(value);
  return d ? dateFormat('date', getStoreTimeZone()).format(d) : '';
}

/** A plain number with the language's decimal separator (quantities, percentages). */
export function fmtNumber(value: number, maxFractionDigits = 3): string {
  return new Intl.NumberFormat(LANGUAGE_LOCALES[getLanguage()], { maximumFractionDigits: maxFractionDigits, useGrouping: false }).format(value);
}
