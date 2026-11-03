/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Writes one simulated camera picture per test condition, to look at what the benchmark feeds
 * the OCR. Usage: npx tsx scripts/ocr/render-samples.ts <datasets dir> <output dir> [width height]
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadPenDigits } from './lib/datasets.ts';
import { encodePng } from './lib/png.ts';
import { Rng } from './lib/rng.ts';
import { GlyphBank, makeScene, penGlyph, renderScene, type Condition } from './lib/synth.ts';

const [dataDir, outDir, w, h] = process.argv.slice(2);
if (!dataDir || !outDir) {
  console.error('usage: render-samples.ts <datasets dir> <output dir> [width height]');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const bank = new GlyphBank();
for (const d of loadPenDigits(path.join(dataDir, 'pendigits', 'pendigits-orig.tra'))) bank.add(d.writer, penGlyph(d));

const conditions: Condition[] = [
  'random', 'center', 'left', 'right', 'top', 'bottom', 'user-case', 'wide-spacing', 'tight-spacing', 'touching',
  'slanted', 'rotated', 'ruled', 'grid', 'uneven-light', 'shadow', 'low-contrast', 'blue-pen', 'thick-marker',
  'thin-pen', 'small', 'blurry', 'label-on-desk',
];
const rng = new Rng(20261103);
for (const condition of conditions) {
  const scene = makeScene(bank, rng, { condition, width: w ? Number(w) : undefined, height: h ? Number(h) : undefined });
  const r = renderScene(scene);
  const file = path.join(outDir, `${condition}-${r.code}.png`);
  fs.writeFileSync(file, encodePng(r.rgba, r.width, r.height));
  console.log(file);
}
