/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Accuracy on REAL pictures: a folder of samples saved from the camera dialog's diagnostics
 * panel ("ნიმუშის შენახვა"; files ocr-<true code>-<date-time>.png, the exact region the app
 * recognised). Photos from a phone are first imported in the same panel and saved as samples.
 * Each picture goes through exactly the app's pipeline and model.
 *
 *   npx tsx scripts/ocr/photo-benchmark.ts --dir <samples folder> [--out report.json] [--model <onnx>]
 *
 * Samples without a true code (ocr-unknown-...) are listed but not scored.
 */

import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './lib/png.ts';
import { OcrEngine } from '../../src/main/ocr/engine.ts';
import { setModelPath } from '../../src/main/ocr/model.ts';

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);
const dir = args.get('dir');
if (!dir) {
  console.error('usage: photo-benchmark.ts --dir <samples folder> [--out report.json] [--model <onnx>]');
  process.exit(2);
}
if (args.get('model')) setModelPath(path.resolve(args.get('model')!));

const files = fs.readdirSync(dir).filter((f) => /^ocr-(\d{5}|unknown)-[\d-]+\.png$/.test(f)).sort();
const engine = new OcrEngine();
const rows: Array<Record<string, unknown>> = [];
let scored = 0, exact = 0, digitsRight = 0, accepted = 0, falseHigh = 0, rejected = 0, flagged = 0;
const latencies: number[] = [];
for (const f of files) {
  const truth = f.split('-')[1];
  const img = decodePng(fs.readFileSync(path.join(dir, f)));
  const t0 = performance.now();
  const r = await engine.recognize(img.data, img.width, img.height);
  const ms = performance.now() - t0;
  latencies.push(ms);
  const read = r.digits.map((d) => d.digit || '?').join('');
  const row: Record<string, unknown> = { file: f, truth, read, status: r.status, reason: r.reason, confidence: r.confidence, ms: Math.round(ms) };
  if (/^\d{5}$/.test(truth)) {
    scored++;
    const ok = r.isFiveDigits && r.code === truth;
    if (ok) exact++;
    for (let k = 0; k < 5; k++) if (r.digits[k]?.digit === truth[k]) digitsRight++;
    if (r.status === 'rejected') rejected++;
    else if (r.status === 'check') flagged++;
    else {
      accepted++;
      if (!ok) falseHigh++;
    }
    row.exact = ok;
  }
  rows.push(row);
  console.log(`${f}: ${truth} -> ${read} ${r.status}${r.reason ? ' ' + r.reason : ''} ${r.confidence}% ${Math.round(ms)} ms`);
}
const pct = (k: number) => (scored ? Math.round((1000 * k) / scored) / 10 : null);
latencies.sort((a, b) => a - b);
const summary = {
  samples: files.length,
  scored,
  exactCode: pct(exact),
  digitAccuracy: scored ? Math.round((1000 * digitsRight) / (5 * scored)) / 10 : null,
  acceptedWithoutFlags: pct(accepted),
  falseHighConfidence: pct(falseHigh),
  flaggedForCheck: pct(flagged),
  rejected: pct(rejected),
  latencyMsP50: Math.round(latencies[Math.floor(latencies.length * 0.5)] || 0),
  latencyMsP95: Math.round(latencies[Math.floor(latencies.length * 0.95)] || 0),
};
console.log(JSON.stringify(summary, null, 2));
if (args.get('out')) fs.writeFileSync(args.get('out')!, JSON.stringify({ summary, rows }, null, 2));
