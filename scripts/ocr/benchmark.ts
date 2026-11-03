/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * OCR benchmark on simulated camera pictures of real handwriting (see lib/synth.ts).
 *
 *   npx tsx scripts/ocr/benchmark.ts --data <datasets dir> --engine new|rc2 --set dev|test
 *       [--n 400] [--conditions random,user-case] [--source pen|mnist|both] [--width 1690 --height 565]
 *       [--seed 1] [--out <dir>] [--save-failures 20] [--model <onnx file>]
 *
 * --set dev  uses the training-file writers (pendigits-orig.tra, MNIST train 0-19999): for the
 *            pipeline's development (the model was trained on most of these writers).
 * --set val  uses only writers the model never saw: pendigits writers 24-29 and MNIST train
 *            58000-59999: for choosing thresholds.
 * --set test uses the 14 held-out writers (pendigits-orig.tes) and MNIST test: for the final
 *            report only, never for tuning.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadMnist, loadPenDigits } from './lib/datasets.ts';
import { encodePng } from './lib/png.ts';
import { Rng } from './lib/rng.ts';
import { bitmapGlyph, GlyphBank, makeScene, penGlyph, renderScene, type Box, type Condition } from './lib/synth.ts';
import { recognizeRc2, type EngineResult } from './lib/rc2Engine.ts';
import { diagnosticImage } from './lib/diagImage.ts';
import type { OcrResult } from '../../src/shared/ocr.ts';

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
const dataDir = args.get('data');
if (!dataDir) {
  console.error('usage: benchmark.ts --data <datasets dir> [--engine new|rc2] [--set dev|test] [--n 400] ...');
  process.exit(2);
}
const engineName = args.get('engine') || 'new';
const setName = args.get('set') || 'dev';
const n = Number(args.get('n') || 400);
const conditions = (args.get('conditions') || 'random').split(',') as Condition[];
const source = args.get('source') || 'both';
const width = Number(args.get('width') || 1690);
const height = Number(args.get('height') || 565);
const seed = Number(args.get('seed') || (setName === 'test' ? 777 : 1));
const outDir = args.get('out');
const saveFailures = Number(args.get('save-failures') || 0);
const flagBelow = Number(args.get('flag-below') || 70);
const heightRange = args.get('digit-height') ? (args.get('digit-height')!.split(',').map(Number) as [number, number]) : undefined;

// ---------- glyphs ----------
const bank = new GlyphBank();
if (source === 'pen' || source === 'both') {
  const file = path.join(dataDir, 'pendigits', setName === 'test' ? 'pendigits-orig.tes' : 'pendigits-orig.tra');
  for (const d of loadPenDigits(file)) if (setName !== 'val' || d.writer >= 24) bank.add(d.writer, penGlyph(d));
}
if (source === 'mnist' || source === 'both') {
  const m = loadMnist(path.join(dataDir, 'mnist'), setName === 'test' ? 'test' : 'train');
  // MNIST has no writer ids: each block of 500 images is treated as one "writer" pool.
  const [from, to] = setName === 'val' ? [58000, 60000] : [0, Math.min(m.count, 20000)];
  for (let i = from; i < to; i++) bank.add(100000 + Math.floor(i / 500), bitmapGlyph(m.images, i, m.labels[i]));
}

// ---------- engine ----------
type Engine = (rgba: Uint8Array, w: number, h: number, diagnostics: boolean) => Promise<EngineResult & { doubtful?: boolean[]; full?: OcrResult }>;
let engine: Engine;
if (engineName === 'rc2') {
  engine = recognizeRc2;
} else {
  if (args.get('model')) (await import('../../src/main/ocr/model.ts')).setModelPath(path.resolve(args.get('model')!));
  const mod = await import('../../src/main/ocr/engine.ts');
  const ocr = new mod.OcrEngine();
  engine = async (rgba, w, h, diagnostics) => {
    const r = await ocr.recognize(rgba, w, h, { diagnostics });
    return {
      code: r.code,
      confidence: r.confidence,
      digits: r.digits.map((d) => ({ digit: d.digit, confidence: d.confidence, box: d.box })),
      doubtful: r.digits.map((d) => d.doubtful),
      status: r.status,
      reason: r.reason,
      full: r,
    };
  };
}

function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
}

interface Row {
  condition: string;
  code: string;
  read: string;
  exact: boolean;
  digitsRight: number;
  fiveDigits: boolean;
  segmented: boolean;
  accepted: boolean;
  confidence: number;
  ms: number;
  status?: string;
  reason?: string;
  /** Per digit: model confidence (0-100) and whether it was marked for a reason other than it. */
  digitConf: number[];
  otherFlag: boolean[];
}

const rows: Row[] = [];
const rng = new Rng(seed);
let failuresSaved = 0;
if (outDir) fs.mkdirSync(outDir, { recursive: true });

for (let i = 0; i < n; i++) {
  const condition = conditions[i % conditions.length];
  const scene = makeScene(bank, rng, { condition, width, height, digitHeightRange: heightRange });
  const pic = renderScene(scene);
  const t0 = performance.now();
  const res = await engine(pic.rgba, pic.width, pic.height, !!outDir && failuresSaved < saveFailures);
  const ms = performance.now() - t0;
  const read = res.digits.map((d) => d.digit || '?').join('');
  const fiveDigits = res.digits.length === 5 && res.digits.every((d) => /^\d$/.test(d.digit));
  let digitsRight = 0;
  for (let k = 0; k < 5; k++) if (res.digits[k]?.digit === pic.code[k]) digitsRight++;
  const segmented = res.digits.length === 5 && pic.digitBoxes.length === 5 && res.digits.every((d, k) => iou(d.box, pic.digitBoxes[k]) >= 0.5);
  const doubtful = res.doubtful ?? res.digits.map((d) => d.confidence < flagBelow);
  const accepted = fiveDigits && !doubtful.some(Boolean);
  const row: Row = {
    condition, code: pic.code, read, exact: fiveDigits && res.code === pic.code, digitsRight, fiveDigits, segmented,
    accepted, confidence: res.confidence, ms, status: res.status, reason: res.reason,
    digitConf: res.digits.map((d) => d.confidence),
    otherFlag: res.digits.map((d, k) => !!res.full?.digits[k] && res.full.digits[k].doubtful && d.confidence >= 85),
  };
  rows.push(row);
  if (outDir && failuresSaved < saveFailures && !row.exact) {
    failuresSaved++;
    const name = `fail-${String(i).padStart(4, '0')}-${condition}-${pic.code}-read-${read.replace(/\?/g, '_')}${res.reason ? '-' + res.reason : ''}.png`;
    if (res.full?.diagnostics) {
      const dimg = diagnosticImage(pic.rgba, pic.width, pic.height, res.full);
      fs.writeFileSync(path.join(outDir, name), encodePng(dimg.data, dimg.width, dimg.height));
      continue;
    }
    const img = Uint8Array.from(pic.rgba);
    const mark = (b: Box, c: [number, number, number]) => {
      for (let x = Math.floor(b.x); x < b.x + b.width; x++) for (const y of [Math.floor(b.y), Math.floor(b.y + b.height - 1)]) paint(x, y, c);
      for (let y = Math.floor(b.y); y < b.y + b.height; y++) for (const x of [Math.floor(b.x), Math.floor(b.x + b.width - 1)]) paint(x, y, c);
    };
    const paint = (x: number, y: number, c: [number, number, number]) => {
      if (x < 0 || y < 0 || x >= pic.width || y >= pic.height) return;
      const p = (y * pic.width + x) * 4;
      img[p] = c[0]; img[p + 1] = c[1]; img[p + 2] = c[2];
    };
    pic.digitBoxes.forEach((b) => mark(b, [0, 170, 0]));
    res.digits.forEach((d) => mark(d.box, [220, 0, 0]));
    fs.writeFileSync(path.join(outDir, name), encodePng(img, pic.width, pic.height));
  }
}

// ---------- report ----------
function summarise(list: Row[]) {
  const count = list.length || 1;
  const pct = (k: number) => Math.round((1000 * k) / count) / 10;
  const accepted = list.filter((r) => r.accepted);
  const ms = list.map((r) => r.ms).sort((a, b) => a - b);
  return {
    samples: list.length,
    exactCode: pct(list.filter((r) => r.exact).length),
    digitAccuracy: Math.round((1000 * list.reduce((a, r) => a + r.digitsRight, 0)) / (5 * count)) / 10,
    fiveDigitsFound: pct(list.filter((r) => r.fiveDigits).length),
    segmentation: pct(list.filter((r) => r.segmented).length),
    acceptedWithoutFlags: pct(accepted.length),
    falseHighConfidence: pct(accepted.filter((r) => !r.exact).length),
    exactAmongAccepted: accepted.length ? Math.round((1000 * accepted.filter((r) => r.exact).length) / accepted.length) / 10 : null,
    flaggedOrRejected: pct(list.length - accepted.length),
    latencyMsP50: Math.round(ms[Math.floor(ms.length * 0.5)] || 0),
    latencyMsP95: Math.round(ms[Math.floor(ms.length * 0.95)] || 0),
  };
}

const byCondition: Record<string, ReturnType<typeof summarise>> = {};
for (const c of conditions) byCondition[c] = summarise(rows.filter((r) => r.condition === c));
const report = { engine: engineName, set: setName, source, frame: `${width}x${height}`, seed, overall: summarise(rows), byCondition };
console.log(JSON.stringify(report, null, 2));
const reasons = new Map<string, number>();
for (const r of rows) if (!r.exact) reasons.set(r.reason || (r.fiveDigits ? 'wrong digits' : 'incomplete'), (reasons.get(r.reason || (r.fiveDigits ? 'wrong digits' : 'incomplete')) || 0) + 1);
console.log('failures by reason:', Object.fromEntries(reasons));
console.log('examples:', rows.filter((r) => !r.exact).slice(0, 12).map((r) => `${r.condition}: ${r.code} -> ${r.read} (${r.confidence}%)`).join(' | '));
if (outDir) fs.writeFileSync(path.join(outDir, `report-${engineName}-${setName}.json`), JSON.stringify({ ...report, rows }, null, 2));
