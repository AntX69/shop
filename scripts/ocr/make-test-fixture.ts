/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Writes src/main/ocr/__fixtures__/pen-digits.json: a few real pen-written digits (training
 * writers 3 and 11 of the pendigits dataset, CC BY 4.0) for the OCR regression tests, so the
 * tests do not need the full dataset.
 * Usage: npx tsx scripts/ocr/make-test-fixture.ts <datasets dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadPenDigits } from './lib/datasets.ts';

const dir = process.argv[2];
const pen = loadPenDigits(path.join(dir, 'pendigits', 'pendigits-orig.tra'));
const samples: Array<{ label: number; writer: number; strokes: number[][][] }> = [];
for (const writer of [3, 11]) {
  for (let d = 0; d < 10; d++) {
    for (const s of pen.filter((p) => p.writer === writer && p.label === d).slice(0, 2)) {
      samples.push({ label: d, writer, strokes: s.strokes.map((st) => st.map(([x, y]) => [x, y])) });
    }
  }
}
const out = path.join('src', 'main', 'ocr', '__fixtures__', 'pen-digits.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
  source: 'Pen-Based Recognition of Handwritten Digits, original version (E. Alpaydin, F. Alimoglu, Bogazici University, 1998), UCI Machine Learning Repository, doi:10.24432/C5MG6K. License: CC BY 4.0. Training writers 3 and 11 (blocks of 250 samples of pendigits-orig.tra); y flipped to point down.',
  samples,
}));
console.log(`${samples.length} samples -> ${out} (${fs.statSync(out).size} bytes)`);
