/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Builds the digit-model training and validation sets from the app's own preprocessing, so the
 * model learns exactly the inputs it will get: simulated camera picture -> ink mask -> digit
 * mask -> MNIST normalisation (28x28).
 *
 *   npx tsx scripts/ocr/make-training-set.ts --data <datasets dir> --out <dir> --kind iso|seg|val
 *       [--shard 0 --shards 1] [--repeat 6] [--codes 3000]
 *
 * iso  every training digit photographed on its own: pendigits writers 0-23 (`--repeat` pictures
 *      each) and MNIST training images 0-57999 (one picture each)
 * seg  digits as the segmenter cuts them out of whole 5-digit codes (same writers/images), matched
 *      to the true digit boxes, so the model also sees cut touching digits and neighbour pieces
 * val  validation: pendigits writers 24-29 and MNIST training images 58000-59999 (never trained on)
 *
 * The pendigits test file and MNIST test set are not read here: they are the final test only.
 * Output: <kind>-<shard>-x.u8 (n x 784, 0-255) and <kind>-<shard>-y.u8 (labels).
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadMnist, loadPenDigits } from './lib/datasets.ts';
import { Rng } from './lib/rng.ts';
import { bitmapGlyph, GlyphBank, makeScene, penGlyph, renderScene, type Condition, type Glyph } from './lib/synth.ts';
import { inkMask, OcrEngine } from '../../src/main/ocr/engine.ts';
import { connectedComponents } from '../../src/main/ocr/imageOps.ts';
import { maskToMnist } from '../../src/main/ocr/normalize.ts';

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
const dataDir = args.get('data')!;
const outDir = args.get('out')!;
const kind = args.get('kind') || 'iso';
const shard = Number(args.get('shard') || 0);
const shards = Number(args.get('shards') || 1);
const repeat = Number(args.get('repeat') || 6);
const codes = Number(args.get('codes') || 3000);
fs.mkdirSync(outDir, { recursive: true });

const pen = loadPenDigits(path.join(dataDir, 'pendigits', 'pendigits-orig.tra'));
const mnist = loadMnist(path.join(dataDir, 'mnist'), 'train');
const trainPen = pen.filter((d) => d.writer < 24);
const valPen = pen.filter((d) => d.writer >= 24);

const xs: Uint8Array[] = [];
const ys: number[] = [];
const rng = new Rng(1000 + shard * 7919 + (kind === 'val' ? 555 : kind === 'seg' ? 333 : 0));

function isolated(glyph: Glyph, bank: GlyphBank): void {
  const scene = makeScene(bank, rng, { code: String(glyph.label), width: 320, height: 200, digitHeightRange: [0.12, 0.62] });
  scene.glyphs = [glyph];
  scene.ruling = 'plain';
  scene.sheet = null;
  scene.centerX = rng.uniform(0.4, 0.6);
  scene.centerY = rng.uniform(0.4, 0.6);
  scene.rotationDeg = rng.normal() * 4;
  if (rng.chance(0.25)) scene.slant = rng.uniform(-0.35, 0.35);
  if (rng.chance(0.2)) scene.strokeFrac = rng.uniform(0.02, 0.2);
  const pic = renderScene(scene);
  const ink = inkMask(pic.rgba, pic.width, pic.height);
  const { labels, components } = connectedComponents(ink.mask, pic.width, pic.height);
  const keep = new Set(components.filter((c) => c.area >= 6).map((c) => c.id));
  if (!keep.size) return;
  const m = new Uint8Array(pic.width * pic.height);
  for (let i = 0; i < m.length; i++) if (keep.has(labels[i])) m[i] = 1;
  const input = maskToMnist(m, pic.width, pic.height);
  xs.push(Uint8Array.from(input, (v) => Math.round(v * 255)));
  ys.push(glyph.label);
}

const t0 = Date.now();
if (kind === 'iso' || kind === 'val') {
  const penList = kind === 'val' ? valPen : trainPen;
  const mnistRange = kind === 'val' ? [58000, 60000] : [0, 58000];
  // Layout only (the drawn glyph is replaced): one glyph of every digit.
  const dummy = new GlyphBank();
  for (let d = 0; d < 10; d++) dummy.add(0, penGlyph(penList.find((p) => p.label === d)!));
  const reps = kind === 'val' ? 1 : repeat;
  for (let i = shard; i < penList.length; i += shards) {
    const g = penGlyph(penList[i]);
    for (let r = 0; r < reps; r++) isolated(g, dummy);
  }
  // Pen digits come first in the output; the count separates them from MNIST in validation.
  fs.writeFileSync(path.join(outDir, `${kind}-${shard}-meta.json`), JSON.stringify({ pen: ys.length }));
  for (let i = mnistRange[0] + shard; i < mnistRange[1]; i += shards) isolated(bitmapGlyph(mnist.images, i, mnist.labels[i]), dummy);
} else {
  const bank = new GlyphBank();
  for (const d of trainPen) bank.add(d.writer, penGlyph(d));
  for (let i = 0; i < 58000; i++) bank.add(100000 + Math.floor(i / 500), bitmapGlyph(mnist.images, i, mnist.labels[i]));
  const engine = new OcrEngine();
  const conditions: Condition[] = ['random', 'random', 'user-case', 'touching', 'tight-spacing', 'slanted', 'rotated', 'ruled', 'grid', 'thin-pen', 'thick-marker', 'uneven-light', 'small', 'blurry'];
  const iou = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
    const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    return inter / (a.width * a.height + b.width * b.height - inter || 1);
  };
  for (let k = shard; k < codes; k += shards) {
    const condition = conditions[k % conditions.length];
    const pic = renderScene(makeScene(bank, rng, { condition, width: 1000, height: 340 }));
    const res = await engine.recognize(pic.rgba, pic.width, pic.height, { diagnostics: true });
    if (res.status === 'rejected' || !res.diagnostics) continue;
    res.digits.forEach((d, i) => {
      const truth = pic.digitBoxes.findIndex((b) => iou(b, d.box) >= 0.5);
      if (truth < 0) return;
      xs.push(res.diagnostics!.digitInputs[i]);
      ys.push(Number(pic.code[truth]));
    });
  }
}

const x = new Uint8Array(xs.length * 784);
xs.forEach((v, i) => x.set(v, i * 784));
fs.writeFileSync(path.join(outDir, `${kind}-${shard}-x.u8`), x);
fs.writeFileSync(path.join(outDir, `${kind}-${shard}-y.u8`), Uint8Array.from(ys));
console.log(`${kind} shard ${shard}/${shards}: ${ys.length} digits in ${Math.round((Date.now() - t0) / 1000)} s`);
