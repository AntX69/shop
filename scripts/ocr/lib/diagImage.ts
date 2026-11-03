/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One PNG showing every pipeline stage of a recognition (for benchmark failures): the picture,
 * ink darkness, the ink mask with components coloured by what the segmenter made of them, and
 * the five 28x28 model inputs.
 */

import type { OcrResult } from '../../../src/shared/ocr.ts';

const KIND_COLOURS: Record<string, [number, number, number]> = {
  digit: [0, 200, 0],
  noise: [120, 120, 120],
  border: [230, 140, 0],
  large: [200, 0, 200],
  line: [0, 140, 230],
  outside: [230, 0, 0],
};

export function diagnosticImage(rgba: Uint8Array, width: number, height: number, result: OcrResult): { data: Uint8Array; width: number; height: number } {
  const d = result.diagnostics;
  if (!d) throw new Error('recognise with diagnostics: true');
  const pw = d.previewWidth;
  const ph = d.previewHeight;
  const W = pw * 2 + 30;
  const H = ph * 2 + 28 * 4 + 40;
  const out = new Uint8Array(W * H * 4).fill(255);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  };
  const plane = (src: Uint8Array, ox: number, oy: number) => {
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) { const v = src[y * pw + x]; put(ox + x, oy + y, v, v, v); }
  };
  const rect = (b: { x: number; y: number; width: number; height: number }, ox: number, oy: number, c: [number, number, number]) => {
    const s = d.previewScale;
    const x0 = Math.round(b.x * s) + ox, y0 = Math.round(b.y * s) + oy;
    const x1 = Math.round((b.x + b.width) * s) + ox, y1 = Math.round((b.y + b.height) * s) + oy;
    for (let x = x0; x <= x1; x++) { put(x, y0, ...c); put(x, y1, ...c); }
    for (let y = y0; y <= y1; y++) { put(x0, y, ...c); put(x1, y, ...c); }
  };
  // 1. picture (scaled)
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const sx = Math.min(width - 1, Math.floor(x / d.previewScale));
    const sy = Math.min(height - 1, Math.floor(y / d.previewScale));
    const i = (sy * width + sx) * 4;
    put(10 + x, 10 + y, rgba[i], rgba[i + 1], rgba[i + 2]);
  }
  if (d.codeBox) rect(d.codeBox, 10, 10, [0, 160, 255]);
  result.digits.forEach((g) => rect(g.box, 10, 10, g.doubtful ? [255, 150, 0] : [0, 200, 0]));
  // 2. darkness
  plane(d.contrast, 20 + pw, 10);
  // 3. mask + components
  plane(d.binary.map((v) => 255 - v), 10, 20 + ph);
  for (const c of d.components) rect(c.box, 10, 20 + ph, KIND_COLOURS[c.kind] || [0, 0, 0]);
  // 4. digit boxes on mask
  plane(d.binary.map((v) => 255 - v), 20 + pw, 20 + ph);
  result.digits.forEach((g) => rect(g.box, 20 + pw, 20 + ph, g.split ? [200, 0, 200] : [0, 200, 0]));
  // 5. model inputs, 4x
  d.digitInputs.forEach((inp, k) => {
    for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
      const v = 255 - inp[y * 28 + x];
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) put(10 + k * 120 + x * 4 + a, 30 + ph * 2 + y * 4 + b, v, v, v);
    }
  });
  return { data: out, width: W, height: H };
}
