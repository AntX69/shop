/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Saves an OCR test sample, only when the seller presses "save sample" in the diagnostics panel:
 * the exact image that was recognised (PNG), the diagnostics picture (PNG) and the result (JSON),
 * in a folder the seller chooses. Nothing is saved or sent anywhere otherwise. Files written:
 * ocr-<true code or "unknown">-<date-time>.png / -diagnostic.png / .json, so a folder of samples
 * can be benchmarked with scripts/ocr/photo-benchmark.ts.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_PNG_BYTES = 12 * 1024 * 1024;
const MAX_REPORT_BYTES = 512 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let folder = '';

function png(value: unknown, what: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 16 || value.byteLength > MAX_PNG_BYTES) {
    throw new Error(`OCR ნიმუში: ${what} არასწორია`);
  }
  if (!PNG_SIGNATURE.every((b, i) => value[i] === b)) throw new Error(`OCR ნიმუში: ${what} PNG არ არის`);
  return value;
}

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export interface SaveSampleRequest {
  regionPng: unknown;
  diagnosticPng?: unknown;
  report: unknown;
  expectedCode?: unknown;
  changeFolder?: unknown;
}

/** Returns the written files, or null when the seller cancelled the folder choice. */
export async function saveOcrSample(req: SaveSampleRequest, chooseDirectory?: (title: string) => Promise<string | null>): Promise<{ folder: string; files: string[] } | null> {
  const region = png(req.regionPng, 'სურათი');
  const diagnostic = req.diagnosticPng === undefined || req.diagnosticPng === null ? null : png(req.diagnosticPng, 'დიაგნოსტიკის სურათი');
  if (typeof req.report !== 'string' || req.report.length > MAX_REPORT_BYTES) throw new Error('OCR ნიმუში: შედეგი არასწორია');
  JSON.parse(req.report);
  const expected = req.expectedCode === undefined || req.expectedCode === '' ? '' : String(req.expectedCode);
  if (expected && !/^\d{5}$/.test(expected)) throw new Error('სწორი კოდი უნდა იყოს 5 ციფრი');

  if (req.changeFolder === true || !folder || !fs.existsSync(folder)) {
    if (!chooseDirectory) throw new Error('საქაღალდის არჩევა შესაძლებელია მხოლოდ დესკტოპის პროგრამაში');
    const chosen = await chooseDirectory('აირჩიეთ საქაღალდე OCR ნიმუშებისთვის');
    if (!chosen) return null;
    folder = chosen;
  }
  const base = path.join(folder, `ocr-${expected || 'unknown'}-${stamp()}`);
  const files = [`${base}.png`, `${base}.json`];
  fs.writeFileSync(files[0], region);
  fs.writeFileSync(files[1], req.report, 'utf8');
  if (diagnostic) {
    files.push(`${base}-diagnostic.png`);
    fs.writeFileSync(files[2], diagnostic);
  }
  return { folder, files };
}
