/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Classification accuracy with correct segmentation: every digit is photographed on its own
 * (simulated camera), goes through the app's ink mask and MNIST normalisation, and the whole
 * ink is the digit. What remains wrong is the model's (or the normalisation's) error.
 *
 *   npx tsx scripts/ocr/eval-model.ts --data <datasets dir> --writers val|test [--model <onnx>] [--out <dir>]
 *
 * val  = pendigits training-file writers 24-29 (blocks of 250 samples), never used for training
 * test = the 14 pendigits test writers: final report only
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { loadPenDigits, loadMnist } from './lib/datasets.ts';
import { encodePng } from './lib/png.ts';
import { Rng } from './lib/rng.ts';
import { bitmapGlyph, GlyphBank, makeScene, penGlyph, renderScene, type Glyph } from './lib/synth.ts';
import { inkMask } from '../../src/main/ocr/engine.ts';
import { connectedComponents } from '../../src/main/ocr/imageOps.ts';
import { maskToMnist } from '../../src/main/ocr/normalize.ts';

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
const dataDir = args.get('data')!;
const writers = args.get('writers') || 'val';
const modelFile = args.get('model') || path.join('public', 'models', 'handwriting-digits.onnx');
const outDir = args.get('out');
const limit = Number(args.get('n') || 0);
const withMnist = args.get('mnist') !== 'no';

ort.env.wasm.numThreads = 1;
const buf = fs.readFileSync(modelFile);
const session = await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
async function probs(input: Float32Array): Promise<Float32Array> {
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 1, 28, 28]) });
  const logits = out[session.outputNames[0]].data as Float32Array;
  const m = Math.max(...logits);
  const e = Array.from(logits.slice(0, 10), (v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return Float32Array.from(e, (v) => v / s);
}

const pen = loadPenDigits(path.join(dataDir, 'pendigits', writers === 'test' ? 'pendigits-orig.tes' : 'pendigits-orig.tra'));
const samples: Array<{ glyph: Glyph; source: string; writer: number }> = pen
  .filter((d) => writers === 'test' || d.writer >= 24)
  .map((d) => ({ glyph: penGlyph(d), source: 'pen', writer: d.writer }));
if (withMnist) {
  // MNIST: the last 2000 test images for 'test', the last 2000 training images for 'val'.
  const m = loadMnist(path.join(dataDir, 'mnist'), writers === 'test' ? 'test' : 'train');
  for (let i = m.count - 2000; i < m.count; i++) samples.push({ glyph: bitmapGlyph(m.images, i, m.labels[i]), source: 'mnist', writer: -1 });
}
const list = limit ? samples.slice(0, limit) : samples;

const dummy = new GlyphBank();
for (const s of list.slice(0, 50)) dummy.add(0, s.glyph);
const rng = new Rng(writers === 'test' ? 4242 : 99);
const confusion = Array.from({ length: 10 }, () => new Array(10).fill(0));
const bins = Array.from({ length: 10 }, () => ({ n: 0, right: 0 }));
const errors: Array<{ input: Float32Array; label: number; pred: number; p: number; source: string }> = [];
let right = 0;
const bySource = new Map<string, { n: number; right: number }>();

for (const s of list) {
  const label = s.glyph.label;
  const scene = makeScene(dummy, rng, { code: String(label), width: 320, height: 200, digitHeightRange: [0.2, 0.62] });
  scene.glyphs = [s.glyph];
  scene.ruling = 'plain';
  scene.sheet = null;
  scene.centerX = 0.5;
  scene.centerY = 0.5;
  scene.rotationDeg = rng.normal() * 3;
  const pic = renderScene(scene);
  const ink = inkMask(pic.rgba, pic.width, pic.height);
  const { labels, components } = connectedComponents(ink.mask, pic.width, pic.height);
  const keep = new Set(components.filter((c) => c.area >= 6).map((c) => c.id));
  const m = new Uint8Array(pic.width * pic.height);
  for (let i = 0; i < m.length; i++) if (keep.has(labels[i])) m[i] = 1;
  const input = maskToMnist(m, pic.width, pic.height);
  const p = await probs(input);
  let pred = 0;
  for (let k = 1; k < 10; k++) if (p[k] > p[pred]) pred = k;
  confusion[label][pred]++;
  const bin = Math.min(9, Math.floor(p[pred] * 10));
  bins[bin].n++;
  if (pred === label) { right++; bins[bin].right++; } else errors.push({ input, label, pred, p: p[pred], source: s.source });
  const b = bySource.get(s.source) || { n: 0, right: 0 };
  b.n++;
  if (pred === label) b.right++;
  bySource.set(s.source, b);
}

console.log(`model ${path.basename(modelFile)}, writers ${writers}: ${((100 * right) / list.length).toFixed(2)}% of ${list.length}`);
for (const [k, v] of bySource) console.log(`  ${k}: ${((100 * v.right) / v.n).toFixed(2)}% of ${v.n}`);
console.log('per digit (recall):', confusion.map((row, d) => `${d}:${((100 * row[d]) / Math.max(1, row.reduce((a, b) => a + b, 0))).toFixed(1)}`).join(' '));
const pairs: string[] = [];
for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) if (a !== b && confusion[a][b] > 0) pairs.push(`${a}->${b}:${confusion[a][b]}`);
console.log('confusions:', pairs.sort((x, y) => Number(y.split(':')[1]) - Number(x.split(':')[1])).slice(0, 20).join(' '));
console.log('calibration (confidence bin: accuracy, count):', bins.map((b, i) => `${i * 10}-${i * 10 + 10}%: ${b.n ? ((100 * b.right) / b.n).toFixed(0) : '-'} (${b.n})`).join(' | '));
const high = errors.filter((e) => e.p >= 0.85).length;
console.log(`wrong with confidence >= 85%: ${high} (${((100 * high) / list.length).toFixed(2)}% of all)`);

if (outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const shown = errors.slice(0, 120);
  const cols = 20;
  const rows = Math.ceil(shown.length / cols) || 1;
  const W = cols * 30;
  const H = rows * 30;
  const img = new Uint8Array(W * H).fill(255);
  shown.forEach((e, k) => {
    const ox = (k % cols) * 30 + 1;
    const oy = Math.floor(k / cols) * 30 + 1;
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) img[(oy + y) * W + ox + x] = 255 - Math.round(e.input[y * 28 + x] * 255);
  });
  fs.writeFileSync(path.join(outDir, `errors-${writers}.png`), encodePng(img, W, H, 1));
  fs.writeFileSync(path.join(outDir, `errors-${writers}.txt`), shown.map((e, k) => `${k}: ${e.label} -> ${e.pred} (${Math.round(e.p * 100)}%, ${e.source})`).join('\n'));
}
