/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Interface languages of StorePOS (Georgian, English, Russian, Spanish).
 *
 * The Georgian text is the source and the key: `tr('სალარო')` returns "Checkout" in English
 * and the Georgian text itself in Georgian. Placeholders are written as `{name}` and filled from
 * the params object. A translation may give plural forms ({ one, few, many, other }); the form is
 * chosen from the `count` param (or the first numeric param) with Intl.PluralRules.
 *
 * The main process keeps producing Georgian messages (errors, notices). The renderer translates
 * them with `trServer`, which also understands messages with values filled in
 * ("ჩამოსაწერი თანხა (12.50 €) აღემატება…") by matching them against the catalog's templates.
 *
 * A missing translation falls back to the Georgian text; the catalog tests check that every
 * text used in the code has a translation in every language.
 */

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';

export type Lang = 'ka' | 'en' | 'ru' | 'es';

export const LANGUAGES: readonly Lang[] = ['ka', 'en', 'ru', 'es'];

/** Each language written in itself, so a user who does not read the current one finds theirs. */
export const LANGUAGE_NAMES: Record<Lang, string> = {
  ka: 'ქართული',
  en: 'English',
  ru: 'Русский',
  es: 'Español',
};

/** Locale for dates and numbers. */
export const LANGUAGE_LOCALES: Record<Lang, string> = {
  ka: 'ka-GE',
  en: 'en-GB',
  ru: 'ru-RU',
  es: 'es-ES',
};

/** Windows language ids written by the installer's language selector. */
export const LCID_LANGUAGES: Record<string, Lang> = {
  '1079': 'ka',
  '1033': 'en',
  '2057': 'en',
  '1049': 'ru',
  '3082': 'es',
  '1034': 'es',
};

export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}
export type Translation = string | PluralForms;
export type Catalog = Readonly<Record<string, Translation>>;
export type Params = Record<string, unknown>;

const CATALOGS: Record<Exclude<Lang, 'ka'>, Catalog> = { en, ru, es };

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function catalogFor(lang: Exclude<Lang, 'ka'>): Catalog {
  return CATALOGS[lang];
}

let current: Lang = 'ka';
const listeners = new Set<(lang: Lang) => void>();

export function getLanguage(): Lang {
  return current;
}

/** Changes the language of this process (the renderer: the screen language). */
export function setLanguage(lang: Lang): void {
  if (!isLang(lang) || lang === current) return;
  current = lang;
  for (const fn of listeners) {
    try {
      fn(lang);
    } catch {
      // a listener must not stop the others
    }
  }
}

export function onLanguageChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const pluralRulesCache = new Map<Lang, Intl.PluralRules>();
function pluralRules(lang: Lang): Intl.PluralRules {
  let r = pluralRulesCache.get(lang);
  if (!r) {
    r = new Intl.PluralRules(LANGUAGE_LOCALES[lang]);
    pluralRulesCache.set(lang, r);
  }
  return r;
}

function pluralCount(params?: Params): number | null {
  if (!params) return null;
  if (typeof params.count === 'number') return params.count;
  for (const v of Object.values(params)) if (typeof v === 'number' && Number.isFinite(v)) return v;
  for (const v of Object.values(params)) {
    if (typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v.trim())) return Number(v.trim().replace(',', '.'));
  }
  return null;
}

function pickForm(entry: PluralForms, lang: Lang, params?: Params): string {
  const n = pluralCount(params);
  if (n === null) return entry.other;
  const form = pluralRules(lang).select(n) as keyof PluralForms;
  return entry[form] ?? entry.other;
}

function paramText(v: unknown): string {
  if (v === null || v === undefined || typeof v === 'boolean') return '';
  return String(v);
}

export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? paramText(params[name]) : whole,
  );
}

/** Translation of a Georgian source text into the given language (no fallback marker). */
export function trIn(lang: Lang, source: string, params?: Params): string {
  const entry = lang === 'ka' ? undefined : CATALOGS[lang][source];
  let text: string;
  if (entry === undefined) text = source;
  else if (typeof entry === 'string') text = entry;
  else text = pickForm(entry, lang, params);
  return interpolate(text, params);
}

/** Translation of a Georgian source text into the current language. */
export function tr(source: string, params?: Params): string {
  return trIn(current, source, params);
}

// ---------------------------------------------------------------------------------------------
// Messages from the main process (Georgian, possibly with values filled in)
// ---------------------------------------------------------------------------------------------

interface Template {
  source: string;
  names: string[];
  /** Whole message. */
  re: RegExp;
  /** Beginning of a message made of several known pieces (only for pieces ending in fixed text). */
  prefix: RegExp | null;
  literalLength: number;
}

let templates: Template[] | null = null;
let pieces: Template[] | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const HAS_PLACEHOLDER = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
const GEORGIAN = /[\u10A0-\u10FF]/;

function compile(source: string): Template | null {
  const names: string[] = [];
  let pattern = '';
  let last = 0;
  let literalLength = 0;
  for (const m of source.matchAll(PLACEHOLDER)) {
    const lit = source.slice(last, m.index);
    pattern += escapeRe(lit);
    literalLength += lit.length;
    pattern += '([\\s\\S]*?)';
    names.push(m[1]);
    last = (m.index ?? 0) + m[0].length;
  }
  const tail = source.slice(last);
  pattern += escapeRe(tail);
  literalLength += tail.length;
  // A text that is (almost) only placeholders would match anything.
  if (literalLength < 3) return null;
  return {
    source,
    names,
    re: new RegExp(`^${pattern}$`),
    prefix: tail.length > 0 ? new RegExp(`^${pattern}`) : null,
    literalLength,
  };
}

function buildTemplates(): void {
  const all = new Set<string>();
  for (const cat of Object.values(CATALOGS)) for (const k of Object.keys(cat)) all.add(k);
  const full: Template[] = [];
  const parts: Template[] = [];
  for (const source of all) {
    const t = compile(source);
    if (!t) continue;
    if (HAS_PLACEHOLDER.test(source)) full.push(t);
    if (t.prefix) parts.push(t);
  }
  // The most specific text (most fixed characters) wins.
  full.sort((a, b) => b.literalLength - a.literalLength);
  parts.sort((a, b) => b.literalLength - a.literalLength);
  templates = full;
  pieces = parts;
}

function translateValue(value: string, lang: Lang, depth: number): string {
  if (!value || !GEORGIAN.test(value)) return value;
  // A value is translated only when it is itself a known text (a field name, a reason);
  // product and customer names stay as they were entered.
  const cat = CATALOGS[lang as Exclude<Lang, 'ka'>];
  if (cat && Object.prototype.hasOwnProperty.call(cat, value)) return trIn(lang, value);
  if (depth < 2) {
    const nested = matchTemplate(value, lang, depth + 1);
    if (nested !== null) return nested;
  }
  return value;
}

function fill(t: Template, m: RegExpExecArray, lang: Lang, depth: number): string {
  const params: Params = {};
  t.names.forEach((name, i) => {
    params[name] = translateValue(m[i + 1], lang, depth);
  });
  return trIn(lang, t.source, params);
}

function matchTemplate(message: string, lang: Lang, depth: number): string | null {
  if (!templates) buildTemplates();
  for (const t of templates!) {
    const m = t.re.exec(message);
    if (m) return fill(t, m, lang, depth);
  }
  return null;
}

function matchWhole(message: string, lang: Lang): string | null {
  const cat = CATALOGS[lang as Exclude<Lang, 'ka'>];
  if (Object.prototype.hasOwnProperty.call(cat, message)) return trIn(lang, message);
  return matchTemplate(message, lang, 0);
}

/** A message made of several known pieces in a row ("… არ აქვს. " + "„X“-ის ფასია …"). */
function decompose(message: string, lang: Lang, depth: number): string | null {
  const whole = matchWhole(message, lang);
  if (whole !== null) return whole;
  if (depth >= 4) return null;
  if (!pieces) buildTemplates();
  for (const t of pieces!) {
    const m = t.prefix!.exec(message);
    if (!m || m[0].length === 0 || m[0].length >= message.length) continue;
    const rest = decompose(message.slice(m[0].length), lang, depth + 1);
    if (rest !== null) return fill(t, m, lang, 0) + rest;
  }
  return null;
}

/**
 * Translates a message produced by the main process (or by shared validation code) into the
 * given language. Unknown messages are returned unchanged.
 */
export function trServer(message: string | null | undefined, lang: Lang = current): string {
  if (typeof message !== 'string') return '';
  if (!message || lang === 'ka') return message;
  if (!GEORGIAN.test(message)) return message;
  const whole = matchWhole(message, lang);
  if (whole !== null) return whole;
  // Several messages joined by line breaks (e.g. a list of problems).
  if (message.includes('\n')) {
    return message.split('\n').map((p) => trServer(p, lang)).join('\n');
  }
  return decompose(message, lang, 0) ?? message;
}
