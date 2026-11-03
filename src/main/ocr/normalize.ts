/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Turns one found digit into the 28x28 input the MNIST model was trained on:
 * the digit's own ink only (never pixels of its neighbours), pen strokes thickened to the stroke
 * width of MNIST digits (a thin ballpoint line shrunk to 20 px would otherwise be a faint
 * 1-pixel trace the model has never seen), longer side scaled to 20 px with the aspect ratio
 * kept, area-averaged grey edges, and the centre of mass placed at the centre of the field.
 */

import { inRegion, type DigitRegion } from './segment.ts';

/**
 * Typical stroke width of MNIST digits in their 20-px box (median 1.95 px on 5000 training digits),
 * measured with the same estimator: scripts/ocr/measure-mnist-stroke.ts.
 */
export const MNIST_STROKE_WIDTH = 2.0;

/** Mean stroke width of a mask: 2 x area / boundary length (for strokes longer than wide). */
export function strokeWidthOf(mask: Uint8Array, width: number, height: number): number {
  let area = 0;
  let edges = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      area++;
      if (x === 0 || !mask[y * width + x - 1]) edges++;
      if (x === width - 1 || !mask[y * width + x + 1]) edges++;
      if (y === 0 || !mask[(y - 1) * width + x]) edges++;
      if (y === height - 1 || !mask[(y + 1) * width + x]) edges++;
    }
  }
  return edges ? (2 * area) / edges : 0;
}

/** The digit's own pixels, cropped to its box. */
export function regionMask(labels: Int32Array, width: number, region: DigitRegion): { mask: Uint8Array; width: number; height: number } {
  const { x: bx, y: by, width: bw, height: bh } = region.box;
  const ids = new Set(region.ids);
  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const l = labels[(by + y) * width + bx + x];
      if (l && inRegion(region, ids, l, bx + x, by + y)) mask[y * bw + x] = 1;
    }
  }
  return { mask, width: bw, height: bh };
}

/** Grows ink by `radius` pixels (chamfer distance), on a canvas padded by the radius. */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): { mask: Uint8Array; width: number; height: number } {
  const pad = Math.ceil(radius);
  const w = width + 2 * pad;
  const h = height + 2 * pad;
  const big = 1e9;
  const dist = new Float32Array(w * h).fill(big);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) dist[(y + pad) * w + x + pad] = 0;
  // Two-pass 3-4 chamfer transform (units of 1/3 pixel).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = dist[i];
      if (x > 0) v = Math.min(v, dist[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, dist[i - w] + 3);
        if (x > 0) v = Math.min(v, dist[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, dist[i - w + 1] + 4);
      }
      dist[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = dist[i];
      if (x < w - 1) v = Math.min(v, dist[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, dist[i + w] + 3);
        if (x < w - 1) v = Math.min(v, dist[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, dist[i + w - 1] + 4);
      }
      dist[i] = v;
    }
  }
  const out = new Uint8Array(w * h);
  const limit = radius * 3 + 0.01;
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= limit ? 1 : 0;
  return { mask: out, width: w, height: h };
}

/** MNIST-style 28x28 input (0 = paper, 1 = ink) from a digit mask. */
export function maskToMnist(mask: Uint8Array, width: number, height: number, targetStroke = MNIST_STROKE_WIDTH): Float32Array {
  const target = new Float32Array(28 * 28);
  // Tight box.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (mask[y * width + x]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return target;
  let w = maxX - minX + 1;
  let h = maxY - minY + 1;
  let m: Uint8Array = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = mask[(y + minY) * width + x + minX];

  // Stroke width at the 20-px scale, thickened to MNIST's.
  const stroke = strokeWidthOf(m, w, h);
  const scale = 20 / Math.max(w, h);
  if (stroke > 0 && stroke * scale < 0.8 * targetStroke) {
    const radius = Math.min(0.12 * Math.max(w, h), (targetStroke / scale - stroke) / 2);
    if (radius >= 0.5) {
      const grown = dilate(m, w, h, radius);
      m = grown.mask;
      w = grown.width;
      h = grown.height;
    }
  }

  const s = 20 / Math.max(w, h);
  const tw = Math.max(1, Math.min(20, Math.round(w * s)));
  const th = Math.max(1, Math.min(20, Math.round(h * s)));
  const small = new Float32Array(tw * th);
  if (Math.max(w, h) >= 20) {
    // Area average: every source pixel lands in one target cell.
    const count = new Float32Array(tw * th);
    for (let y = 0; y < h; y++) {
      const ty = Math.min(th - 1, Math.floor((y * th) / h));
      for (let x = 0; x < w; x++) {
        const tx = Math.min(tw - 1, Math.floor((x * tw) / w));
        small[ty * tw + tx] += m[y * w + x];
        count[ty * tw + tx]++;
      }
    }
    for (let i = 0; i < small.length; i++) small[i] = count[i] ? small[i] / count[i] : 0;
  } else {
    // Small digit: bilinear upsampling.
    for (let ty = 0; ty < th; ty++) {
      const sy = Math.min(h - 1, Math.max(0, ((ty + 0.5) * h) / th - 0.5));
      const y0 = Math.floor(sy);
      const y1 = Math.min(h - 1, y0 + 1);
      const fy = sy - y0;
      for (let tx = 0; tx < tw; tx++) {
        const sx = Math.min(w - 1, Math.max(0, ((tx + 0.5) * w) / tw - 0.5));
        const x0 = Math.floor(sx);
        const x1 = Math.min(w - 1, x0 + 1);
        const fx = sx - x0;
        small[ty * tw + tx] =
          (m[y0 * w + x0] * (1 - fx) + m[y0 * w + x1] * fx) * (1 - fy) + (m[y1 * w + x0] * (1 - fx) + m[y1 * w + x1] * fx) * fy;
      }
    }
  }

  let mass = 0;
  let mx = 0;
  let my = 0;
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    const v = small[ty * tw + tx];
    mass += v;
    mx += v * (tx + 0.5);
    my += v * (ty + 0.5);
  }
  const cx = mass > 0 ? mx / mass : tw / 2;
  const cy = mass > 0 ? my / mass : th / 2;
  const ox = Math.min(28 - tw, Math.max(0, Math.round(14 - cx)));
  const oy = Math.min(28 - th, Math.max(0, Math.round(14 - cy)));
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) target[(oy + ty) * 28 + ox + tx] = small[ty * tw + tx];
  return target;
}
