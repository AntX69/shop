/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The translation catalogs stay complete: every Georgian text in the program (screens, messages
 * from the main process, record descriptions) has an English, Russian and Spanish translation
 * with the same placeholders, and no screen shows Georgian text that bypasses tr().
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalogFor, Lang, LANGUAGES, trIn, trServer } from './index.ts';
import { formatMoney } from '../currency.ts';

const SRC = path.resolve(import.meta.dirname, '..', '..');
const GEORGIAN = /[Ⴀ-ჿ]/;

/** Georgian texts that are never shown to a user. */
const NOT_SHOWN = new Set([
  // Lockout and log-level detection (substrings of messages, never displayed alone).
  'დაბლოკილ', 'დაიბლოკა',
  'მარაგი', 'ფორმატი', 'ნაკლებია', 'სავალდებულოა', 'არასწორია', 'უფლება', 'აღემატება', 'მთელი რიცხვი', 'ვერ მოიძებნა', 'უკვე',
  // The language switcher's label names every language itself.
  'ენა / Language / Язык / Idioma',
]);

interface Literal {
  text: string; // cooked text; templates with {} for each ${...}
  template: boolean;
  file: string;
  line: number;
}

/** A small JS/TS lexer: string and template literals outside comments and regular expressions. */
function scan(src: string, file: string): { literals: Literal[]; code: string } {
  const literals: Literal[] = [];
  let code = '';
  let i = 0;
  let last = '';
  let braceDepth = 0;
  const templates: Array<{ text: string; depth: number; start: number }> = [];
  const lineAt = (pos: number) => src.slice(0, pos).split('\n').length;
  const readEscape = (j: number): [string, number] => {
    const e = src[j + 1];
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '`': '`', $: '$', '0': '\0' };
    if (e === 'u') {
      if (src[j + 2] === '{') {
        const end = src.indexOf('}', j);
        return [String.fromCodePoint(parseInt(src.slice(j + 3, end), 16)), end + 1];
      }
      return [String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)), j + 6];
    }
    if (e === '\n') return ['', j + 2];
    return [map[e] ?? e, j + 2];
  };
  const readTemplateChunk = (j: number, tpl: { text: string; depth: number; start: number }): number => {
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') {
        const [s, next] = readEscape(j);
        tpl.text += s;
        j = next;
      } else if (c === '`') {
        literals.push({ text: tpl.text, template: tpl.text.includes('\u0000{}'), file, line: lineAt(tpl.start) });
        return j + 1;
      } else if (c === '$' && src[j + 1] === '{') {
        tpl.text += '\u0000{}';
        tpl.depth = braceDepth;
        templates.push(tpl);
        braceDepth++;
        return j + 2;
      } else {
        tpl.text += c;
        j++;
      }
    }
    return j;
  };
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          const [s, next] = readEscape(j);
          text += s;
          j = next;
        } else {
          text += src[j];
          j++;
        }
      }
      literals.push({ text, template: false, file, line: lineAt(i) });
      code += ' 0 ';
      last = '0';
      i = j + 1;
      continue;
    }
    if (c === '`') {
      code += ' 0 ';
      last = '0';
      i = readTemplateChunk(i + 1, { text: '', depth: 0, start: i });
      continue;
    }
    if (c === '}' && templates.length && braceDepth - 1 === templates[templates.length - 1].depth) {
      braceDepth--;
      const tpl = templates.pop()!;
      i = readTemplateChunk(i + 1, tpl);
      continue;
    }
    if (c === '/' && src[i - 1] !== '<' && d !== '>' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last))) {
      // regular expression literal
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
        j++;
      }
      j++;
      while (/[a-z]/i.test(src[j] || '')) j++;
      code += ' /re/ ';
      last = '0';
      i = j;
      continue;
    }
    if (c === '{') braceDepth++;
    if (c === '}') braceDepth--;
    if (!/\s/.test(c)) last = c;
    code += c;
    i++;
  }
  return { literals, code };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p === path.join(SRC, 'shared', 'i18n')) continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const shape = (s: string) => s.replace(/\u0000\{\}/g, '{}').replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, '{}');
const placeholders = (s: string) => [...s.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]).sort().join(',');
const forms = (v: unknown): string[] => (typeof v === 'string' ? [v] : Object.values(v as Record<string, string>));

const files = sourceFiles(SRC);
const scanned = files.map((f) => ({ file: path.relative(SRC, f).split(path.sep).join('/'), ...scan(fs.readFileSync(f, 'utf8'), path.relative(SRC, f).split(path.sep).join('/')) }));
const OTHER: Exclude<Lang, 'ka'>[] = ['en', 'ru', 'es'];

test('catalogs: the same texts in English, Russian and Spanish, with the same placeholders, no Georgian left', () => {
  const en = catalogFor('en');
  const keys = Object.keys(en).sort();
  assert.ok(keys.length > 1200, `catalog has ${keys.length} texts`);
  for (const lang of OTHER) {
    const cat = catalogFor(lang);
    assert.deepEqual(Object.keys(cat).sort(), keys, `${lang} has a different set of texts`);
    for (const k of keys) {
      for (const f of forms(cat[k])) {
        assert.equal(placeholders(f), placeholders(k), `${lang}: placeholders of "${k}"`);
        assert.ok(!GEORGIAN.test(f), `${lang}: Georgian left in the translation of "${k}"`);
        assert.ok(f.trim().length > 0 || k.trim().length === 0, `${lang}: empty translation of "${k}"`);
      }
      if (typeof cat[k] !== 'string') assert.ok((cat[k] as any).other, `${lang}: plural forms of "${k}" need "other"`);
    }
  }
});

test('every Georgian text in the code has a translation (screens, main-process messages, records)', () => {
  const exact = new Set(Object.keys(catalogFor('en')));
  const shapes = new Set([...exact].map(shape));
  const missing: string[] = [];
  let checked = 0;
  for (const s of scanned) {
    for (const lit of s.literals) {
      if (!GEORGIAN.test(lit.text)) continue;
      if (NOT_SHOWN.has(lit.text) || /\b(INSERT|VALUES|SELECT)\b/.test(lit.text)) continue;
      checked++;
      const ok = lit.template ? shapes.has(shape(lit.text)) : exact.has(lit.text);
      if (!ok) missing.push(`${lit.file}:${lit.line}  ${lit.text.replace(/\u0000\{\}/g, '${…}').slice(0, 100)}`);
    }
  }
  assert.ok(checked > 1000, `only ${checked} Georgian texts found: the scanner is broken`);
  assert.deepEqual(missing, [], `texts without translation:\n${missing.join('\n')}`);
});

test('screens: no Georgian text outside tr() (JSX text) and no Georgian template literals', () => {
  const problems: string[] = [];
  for (const s of scanned) {
    if (!(s.file.startsWith('renderer/') || s.file === 'App.tsx')) continue;
    const lines = s.code.split('\n');
    lines.forEach((l, i) => { if (GEORGIAN.test(l)) problems.push(`${s.file}: JSX text near "${l.trim().slice(0, 80)}"`); });
    for (const lit of s.literals) if (lit.template && GEORGIAN.test(lit.text)) problems.push(`${s.file}:${lit.line} template ${lit.text.slice(0, 60)}`);
  }
  assert.deepEqual(problems, []);
});

test('tr: Georgian is the source; plural forms; missing text falls back to Georgian', () => {
  assert.equal(trIn('ka', 'სალარო'), 'სალარო');
  assert.equal(trIn('en', 'სალარო'), 'Checkout');
  assert.equal(trIn('ru', 'სალარო'), 'Касса');
  assert.equal(trIn('es', 'სალარო'), 'Caja');
  assert.equal(trIn('es', 'ფასი: {amount}', { amount: '2,50 €' }), 'Precio: 2,50 €');
  assert.equal(trIn('ru', '{value} კლიენტი', { value: 1 }), '1 клиент');
  assert.equal(trIn('ru', '{value} კლიენტი', { value: 3 }), '3 клиента');
  assert.equal(trIn('ru', '{value} კლიენტი', { value: 11 }), '11 клиентов');
  assert.equal(trIn('en', '{value} კლიენტი', { value: 1 }), '1 customer');
  assert.equal(trIn('en', '{value} კლიენტი', { value: 2 }), '2 customers');
  assert.equal(trIn('en', 'ეს ტექსტი კატალოგში არ არის'), 'ეს ტექსტი კატალოგში არ არის');
});

test('trServer: main-process messages with values, nested field names and joined pieces', () => {
  // values filled in
  assert.equal(
    trServer('შეტანილი თანხა (12.50 €) აღემატება მიმდინარე დავალიანებას (10.00 €)', 'en'),
    'The amount paid (12.50 €) exceeds the current debt (10.00 €)',
  );
  // a field name inside a generic message is translated, a product name is not
  assert.equal(trServer('ხარჯის კატეგორია სავალდებულოა', 'es'), 'Categoría del gasto es obligatorio');
  assert.equal(trServer('"ვაშლი" (წითელი) დაარქივებულია და აღარ იყიდება', 'ru'), '"ვაშლი" (წითელი) в архиве и больше не продаётся');
  // two pieces joined in one message
  assert.equal(
    trServer('გამყიდველს ფასის შეცვლის ან ფასდაკლების უფლება არ აქვს. "ჩაი"-ის აქტუალური ფასია: 3.00 ₾ (გაგზავნილი: 2.00 ₾)', 'en'),
    'The seller is not allowed to change prices or give discounts. The current price of "ჩაი" is 3.00 ₾ (sent: 2.00 ₾)',
  );
  assert.equal(
    trServer('არასაკმარისი მარაგი: "ჩაი" (სტანდარტული). ხელმისაწვდომია: 2, მოთხოვნილია: 5', 'es'),
    // the program's own default variant name is a known text; the product name is the user's
    'Stock insuficiente: "ჩაი" (Estándar). Disponible: 2, solicitado: 5',
  );
  // the restore message with its optional middle sentence
  assert.equal(
    trServer('ბაზა შემოწმდა (PRAGMA integrity_check: OK) და წარმატებით აღდგა. 2 ფოტო ასლში დაზიანებული იყო და არ აღდგა (ხელახლა დაამატეთ). გთხოვთ ხელახლა შეხვიდეთ.', 'en'),
    'The database was checked (PRAGMA integrity_check: OK) and restored successfully. 2 photo(s) in the backup were damaged and were not restored (add them again). Please sign in again.',
  );
  // lockout message with the waiting time inside
  assert.equal(
    trServer('ბევრი არასწორი PIN მცდელობა. ანგარიში დროებით დაბლოკილია — სცადეთ ხელახლა 30 წამში', 'en'),
    'Too many wrong PIN attempts. The account is temporarily locked — try again in 30 s',
  );
  // Georgian stays Georgian; unknown text is returned unchanged
  assert.equal(trServer('კალათა ცარიელია', 'ka'), 'კალათა ცარიელია');
  assert.equal(trServer('Disk full', 'es'), 'Disk full');
  assert.equal(trServer(undefined, 'en'), '');
});

test('formatMoney: the shop currency in each language', () => {
  assert.equal(formatMoney(2550, { currency: 'GEL', lang: 'ka' }), '25.50 ₾');
  assert.equal(formatMoney(2550, { currency: 'EUR', lang: 'ka' }), '25.50 €');
  assert.equal(formatMoney(-705, { currency: 'GEL', lang: 'ka' }), '-7.05 ₾');
  assert.equal(formatMoney(2550, { currency: 'EUR', lang: 'es' }).replace(/\s/g, ' '), '25,50 €');
  assert.equal(formatMoney(123456, { currency: 'EUR', lang: 'es' }).replace(/\s/g, ' '), '1234,56 €');
  assert.equal(formatMoney(2550, { currency: 'USD', lang: 'en' }), '$25.50');
  assert.equal(formatMoney(2550, { currency: 'EUR', lang: 'ru' }).replace(/\s/g, ' '), '25,50 €');
  assert.equal(formatMoney(2550, { currency: 'GEL', lang: 'en' }), '₾25.50');
  assert.equal(formatMoney(2550, { currency: 'EUR', lang: 'es', symbol: false }), '25.50');
  for (const lang of LANGUAGES) assert.ok(formatMoney(0, { currency: 'USD', lang }).includes('0'), lang);
});
