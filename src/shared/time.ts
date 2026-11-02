/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Business calendar helpers for the store time zone (Asia/Tbilisi).
 * Timestamps are stored as UTC ISO strings; reporting periods, receipt dates and
 * expense dates are local calendar days, so "today" starts at Tbilisi midnight,
 * not at UTC midnight.
 */

export const STORE_TIME_ZONE = 'Asia/Tbilisi';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Offset of the zone from UTC at the given instant, in milliseconds (Tbilisi: +4 h). */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Local calendar day of an instant, as YYYY-MM-DD. */
export function localDate(date: Date = new Date(), timeZone: string = STORE_TIME_ZONE): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local wall-clock time of an instant, as YYYY-MM-DD HH:mm. */
export function localDateTime(date: Date = new Date(), timeZone: string = STORE_TIME_ZONE): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export function isValidLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function addDays(localDay: string, days: number): string {
  const [y, m, d] = localDay.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** UTC instant at which the given local calendar day begins. */
export function startOfLocalDayUtc(localDay: string, timeZone: string = STORE_TIME_ZONE): Date {
  const [y, m, d] = localDay.split('-').map(Number);
  const wallMidnight = Date.UTC(y, m - 1, d);
  let ts = wallMidnight - zoneOffsetMs(new Date(wallMidnight), timeZone);
  // Second pass settles zones whose offset differs at the real instant (DST changes).
  ts = wallMidnight - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

export type PeriodPreset = 'today' | 'yesterday' | 'week' | 'month' | 'last_month' | 'year' | 'all' | 'custom';

export interface PeriodInput {
  preset?: PeriodPreset;
  from?: string | null;
  to?: string | null;
}

export interface ResolvedPeriod {
  preset: PeriodPreset;
  /** First local day included (YYYY-MM-DD), or null for "from the beginning". */
  from: string | null;
  /** Last local day included (YYYY-MM-DD), or null for "up to now". */
  to: string | null;
  /** Inclusive UTC lower bound for created_at comparisons. */
  startUtc: string | null;
  /** Exclusive UTC upper bound for created_at comparisons. */
  endUtc: string | null;
}

/**
 * Resolves a reporting period to local days and UTC bounds.
 * Weeks start on Monday, as is customary in Georgia.
 */
export function resolvePeriod(input: PeriodInput = {}, now: Date = new Date(), timeZone: string = STORE_TIME_ZONE): ResolvedPeriod {
  const preset: PeriodPreset = input.preset || (input.from || input.to ? 'custom' : 'all');
  const today = localDate(now, timeZone);
  const [ty, tm] = today.split('-').map(Number);
  let from: string | null = null;
  let to: string | null = null;

  switch (preset) {
    case 'today':
      from = to = today;
      break;
    case 'yesterday':
      from = to = addDays(today, -1);
      break;
    case 'week': {
      const [y, m, d] = today.split('-').map(Number);
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
      from = addDays(today, -((dow + 6) % 7));
      to = today;
      break;
    }
    case 'month':
      from = `${pad(ty, 4)}-${pad(tm)}-01`;
      to = today;
      break;
    case 'last_month': {
      const firstThis = `${pad(ty, 4)}-${pad(tm)}-01`;
      to = addDays(firstThis, -1);
      from = `${to.slice(0, 7)}-01`;
      break;
    }
    case 'year':
      from = `${pad(ty, 4)}-01-01`;
      to = today;
      break;
    case 'custom':
      if (input.from != null && input.from !== '') {
        if (!isValidLocalDate(input.from)) throw new Error(`პერიოდის საწყისი თარიღი არასწორია: "${input.from}"`);
        from = input.from;
      }
      if (input.to != null && input.to !== '') {
        if (!isValidLocalDate(input.to)) throw new Error(`პერიოდის საბოლოო თარიღი არასწორია: "${input.to}"`);
        to = input.to;
      }
      if (from && to && from > to) [from, to] = [to, from];
      break;
    case 'all':
      break;
    default:
      throw new Error(`უცნობი პერიოდი: "${preset}"`);
  }

  return {
    preset,
    from,
    to,
    startUtc: from ? startOfLocalDayUtc(from, timeZone).toISOString() : null,
    endUtc: to ? startOfLocalDayUtc(addDays(to, 1), timeZone).toISOString() : null,
  };
}

/**
 * Converts a history filter bound that may be either a local day (YYYY-MM-DD) or an
 * ISO instant into a UTC ISO string. Local days map to the start of that day, or to
 * the start of the next day when used as an exclusive end bound.
 */
export function boundToUtc(value: string, kind: 'start' | 'end', timeZone: string = STORE_TIME_ZONE): string {
  if (isValidLocalDate(value)) {
    return startOfLocalDayUtc(kind === 'start' ? value : addDays(value, 1), timeZone).toISOString();
  }
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw new Error(`თარიღი არასწორია: "${value}"`);
  return t.toISOString();
}
