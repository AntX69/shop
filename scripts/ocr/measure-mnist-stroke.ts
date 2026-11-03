/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Measures the typical stroke width of MNIST training digits (in their 20-px box) with the
 * estimator the OCR uses, and checks the existing model on MNIST test digits as they are.
 * Usage: npx tsx scripts/ocr/measure-mnist-stroke.ts <datasets dir>
 */

import path from 'node:path';
import { loadMnist } from './lib/datasets.ts';
import { strokeWidthOf } from '../../src/main/ocr/normalize.ts';
import { classifyDigits } from '../../src/main/ocr/model.ts';

const dir = process.argv[2];
const train = loadMnist(path.join(dir, 'mnist'), 'train');
const widths: number[] = [];
for (let i = 0; i < 5000; i++) {
  const m = new Uint8Array(784);
  for (let k = 0; k < 784; k++) m[k] = train.images[i * 784 + k] >= 128 ? 1 : 0;
  widths.push(strokeWidthOf(m, 28, 28));
}
widths.sort((a, b) => a - b);
console.log('MNIST stroke width (20-px box): p10 %s, median %s, p90 %s',
  widths[500].toFixed(2), widths[2500].toFixed(2), widths[4500].toFixed(2));

const test = loadMnist(path.join(dir, 'mnist'), 'test');
let right = 0;
const n = 10000;
for (let i = 0; i < n; i++) {
  const input = Float32Array.from(test.images.subarray(i * 784, (i + 1) * 784), (v) => v / 255);
  const [p] = await classifyDigits([input]);
  let best = 0;
  for (let k = 1; k < 10; k++) if (p[k] > p[best]) best = k;
  if (best === test.labels[i]) right++;
}
console.log(`mnist.onnx on MNIST test (inputs 0..1): ${((100 * right) / n).toFixed(2)}% of ${n}`);
