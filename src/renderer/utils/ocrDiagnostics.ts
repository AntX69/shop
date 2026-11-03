/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Drawing for the OCR diagnostics panel: pipeline images from the main process, boxes of what the
 * segmenter found, and one composite picture of everything for a saved test sample.
 */

import type { OcrBox, OcrComponentKind, OcrResult } from '../../shared/ocr.ts';
import type { RegionImage } from './offlineOcr.ts';
import type { Rect } from './cameraRoi.ts';

export const KIND_COLOURS: Record<OcrComponentKind, string> = {
  digit: '#22c55e',
  noise: '#94a3b8',
  border: '#f59e0b',
  large: '#d946ef',
  line: '#38bdf8',
  outside: '#ef4444',
};

export const KIND_LABELS: Record<OcrComponentKind, string> = {
  digit: 'ციფრი',
  noise: 'ხმაური',
  border: 'კიდესთან',
  large: 'დიდი ლაქა',
  line: 'ხაზი',
  outside: 'კოდის გარეთ',
};

export function planeCanvas(plane: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < plane.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = plane[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function regionCanvas(region: RegionImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = region.width;
  c.height = region.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(region.data), region.width, region.height), 0, 0);
  return c;
}

/** 28x28 model input, 0 = paper (shown white), 255 = ink (shown black). */
export function inputCanvas(input: Uint8Array, zoom = 3): HTMLCanvasElement {
  const small = planeCanvas(input.map((v) => 255 - v), 28, 28);
  const c = document.createElement('canvas');
  c.width = 28 * zoom;
  c.height = 28 * zoom;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, c.width, c.height);
  return c;
}

export function strokeBox(ctx: CanvasRenderingContext2D, b: OcrBox | Rect, scale: number, colour: string, width = 2): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.strokeRect(b.x * scale + 0.5, b.y * scale + 0.5, Math.max(1, b.width * scale), Math.max(1, b.height * scale));
}

/** Draws `source` scaled into `target` (width fixed, height kept in proportion). */
export function drawScaled(target: HTMLCanvasElement, source: CanvasImageSource & { width: number; height: number }, width: number): number {
  const scale = width / source.width;
  target.width = Math.max(1, Math.round(width));
  target.height = Math.max(1, Math.round(source.height * scale));
  target.getContext('2d')!.drawImage(source, 0, 0, target.width, target.height);
  return scale;
}

/** The region with the code box (blue) and the digits (green; amber when doubtful). */
export function drawRegionWithDigits(target: HTMLCanvasElement, region: RegionImage, result: OcrResult, width: number): void {
  const scale = drawScaled(target, regionCanvas(region), width);
  const ctx = target.getContext('2d')!;
  if (result.diagnostics?.codeBox) strokeBox(ctx, result.diagnostics.codeBox, scale, '#3b82f6', 1);
  result.digits.forEach((d, i) => {
    const colour = d.doubtful || !d.digit ? '#f59e0b' : '#22c55e';
    strokeBox(ctx, d.box, scale, colour);
    ctx.fillStyle = colour;
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(`#${i + 1} ${d.digit || '?'}`, d.box.x * scale + 2, Math.max(11, d.box.y * scale - 3));
  });
}

/** The ink mask with every component coloured by what the segmenter made of it. */
export function drawMaskWithComponents(target: HTMLCanvasElement, result: OcrResult, width: number): void {
  const d = result.diagnostics!;
  const mask = planeCanvas(d.binary.map((v) => 255 - v), d.previewWidth, d.previewHeight);
  const scale = drawScaled(target, mask, width);
  const ctx = target.getContext('2d')!;
  for (const c of d.components) strokeBox(ctx, c.box, scale * d.previewScale, KIND_COLOURS[c.kind], 1);
}

/** Everything in one picture (saved with a test sample). */
export function compositeCanvas(result: OcrResult, region: RegionImage, frame: { canvas: HTMLCanvasElement; roi: Rect } | null, title: string): HTMLCanvasElement {
  const d = result.diagnostics;
  const W = 760;
  const half = (W - 30) / 2;
  const parts: Array<{ label: string; canvas: HTMLCanvasElement }> = [];
  if (frame) {
    const c = document.createElement('canvas');
    const s = drawScaled(c, frame.canvas, half);
    strokeBox(c.getContext('2d')!, frame.roi, s, '#22c55e');
    parts.push({ label: 'კამერის კადრი და დამუშავებული არე', canvas: c });
  }
  const r = document.createElement('canvas');
  drawRegionWithDigits(r, region, result, half);
  parts.push({ label: 'აღმოჩენილი კოდი და ციფრები', canvas: r });
  if (d) {
    const g = document.createElement('canvas');
    drawScaled(g, planeCanvas(d.gray, d.previewWidth, d.previewHeight), half);
    parts.push({ label: 'ნაცრისფერი', canvas: g });
    const k = document.createElement('canvas');
    drawScaled(k, planeCanvas(d.contrast, d.previewWidth, d.previewHeight), half);
    parts.push({ label: 'კონტრასტი (განათების კორექციით)', canvas: k });
    const m = document.createElement('canvas');
    drawMaskWithComponents(m, result, half);
    parts.push({ label: 'მელანი და ნაპოვნი ნაწილები', canvas: m });
  }
  const rowHeights: number[] = [];
  for (let i = 0; i < parts.length; i += 2) rowHeights.push(Math.max(parts[i].canvas.height, parts[i + 1]?.canvas.height || 0) + 22);
  const inputsH = d && d.digitInputs.length ? 28 * 3 + 40 : 0;
  const out = document.createElement('canvas');
  out.width = W;
  out.height = 40 + rowHeights.reduce((a, b) => a + b, 0) + inputsH + 20;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText(title, 10, 22);
  let y = 40;
  for (let i = 0; i < parts.length; i += 2) {
    for (let j = 0; j < 2 && parts[i + j]; j++) {
      const p = parts[i + j];
      const x = 10 + j * (half + 10);
      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#334155';
      ctx.fillText(p.label, x, y + 12);
      ctx.drawImage(p.canvas, x, y + 18);
    }
    y += rowHeights[i / 2];
  }
  if (d) {
    d.digitInputs.forEach((inp, i) => {
      const x = 10 + i * 140;
      ctx.drawImage(inputCanvas(inp), x, y);
      const dg = result.digits[i];
      ctx.fillStyle = dg?.doubtful || !dg?.digit ? '#b45309' : '#15803d';
      ctx.font = 'bold 12px sans-serif';
      ctx.fillText(`#${i + 1}: ${dg?.digit || '?'} ${dg?.confidence ?? 0}%`, x, y + 28 * 3 + 14);
      ctx.fillStyle = '#475569';
      ctx.font = '11px sans-serif';
      ctx.fillText((dg?.alternatives || []).map((a) => `${a.digit}:${a.confidence}`).join(' '), x, y + 28 * 3 + 28);
    });
  }
  return out;
}

/** The code area of the region (around the digits), `height` px tall, with the digit boxes. */
export function drawCodeCrop(target: HTMLCanvasElement, region: RegionImage, result: OcrResult, height: number): void {
  if (!result.digits.length) return;
  const x0 = Math.min(...result.digits.map((d) => d.box.x));
  const y0 = Math.min(...result.digits.map((d) => d.box.y));
  const x1 = Math.max(...result.digits.map((d) => d.box.x + d.box.width));
  const y1 = Math.max(...result.digits.map((d) => d.box.y + d.box.height));
  const pad = Math.round(0.15 * (y1 - y0));
  const cx = Math.max(0, x0 - pad);
  const cy = Math.max(0, y0 - pad);
  const cw = Math.min(region.width, x1 + pad) - cx;
  const ch = Math.min(region.height, y1 + pad) - cy;
  const scale = height / ch;
  target.width = Math.max(1, Math.round(cw * scale));
  target.height = height;
  const ctx = target.getContext('2d')!;
  ctx.drawImage(regionCanvas(region), cx, cy, cw, ch, 0, 0, target.width, target.height);
  result.digits.forEach((d) => {
    strokeBox(ctx, { x: d.box.x - cx, y: d.box.y - cy, width: d.box.width, height: d.box.height }, scale, d.doubtful || !d.digit ? '#f59e0b' : '#22c55e');
  });
}
