/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Frozen copy of the RC2 (1.0.0-rc.2) recognition, kept only so the benchmark can compare the old
 * and new pipelines on the same pictures. Not used by the app.
 *
 * RC2: global Otsu threshold -> column projection; unless exactly 5 blocks are found, the region
 * is cut into 5 equal slots -> every slot's ink bounding box -> MNIST normalisation -> model.
 */

import { OcrService } from '../../../src/main/domain/ocrService.ts';

export interface EngineDigit {
  digit: string;
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface EngineResult {
  code: string;
  confidence: number;
  digits: EngineDigit[];
  status?: string;
  reason?: string;
}

type Box = EngineDigit['box'];

function binarize(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const total = width * height;
  const gray = new Uint8Array(total);
  const histogram = new Int32Array(256);
  for (let i = 0; i < total; i++) {
    const v = Math.round(0.299 * pixels[i * 4] + 0.587 * pixels[i * 4 + 1] + 0.114 * pixels[i * 4 + 2]);
    gray[i] = v;
    histogram[v]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumB = 0, wB = 0, varMax = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > varMax) { varMax = v; threshold = t; }
  }
  const adjusted = Math.min(220, Math.max(50, threshold - 10));
  const binary = new Uint8Array(total);
  for (let i = 0; i < total; i++) binary[i] = gray[i] < adjusted ? 1 : 0;
  return binary;
}

function verticalBounds(binary: Uint8Array, width: number, height: number, minX: number, maxX: number): Box | null {
  let minY = height, maxY = 0, ax0 = maxX, ax1 = minX, found = false;
  for (let x = minX; x < maxX; x++) for (let y = 0; y < height; y++) {
    if (binary[y * width + x] === 1) {
      found = true;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x < ax0) ax0 = x;
      if (x > ax1) ax1 = x;
    }
  }
  if (!found || maxY <= minY) return null;
  return { x: Math.max(0, ax0 - 1), y: Math.max(0, minY - 1), width: Math.min(width - ax0, ax1 - ax0 + 3), height: Math.min(height - minY, maxY - minY + 3) };
}

function find5Boxes(binary: Uint8Array, width: number, height: number): Box[] {
  const colSum = new Int32Array(width);
  for (let x = 0; x < width; x++) { let s = 0; for (let y = 0; y < height; y++) s += binary[y * width + x]; colSum[x] = s; }
  const segments: Array<{ startX: number; endX: number }> = [];
  let inSeg = false, startX = 0;
  const minStroke = Math.max(2, Math.floor(height * 0.04));
  for (let x = 0; x < width; x++) {
    if (colSum[x] >= minStroke) { if (!inSeg) { inSeg = true; startX = x; } }
    else if (inSeg) { inSeg = false; if (x - startX > 3) segments.push({ startX, endX: x }); }
  }
  if (inSeg && width - startX > 3) segments.push({ startX, endX: width });
  const boxes: Box[] = [];
  if (segments.length === 5) for (const s of segments) { const b = verticalBounds(binary, width, height, s.startX, s.endX); if (b) boxes.push(b); }
  if (boxes.length !== 5) {
    boxes.length = 0;
    const slot = width / 5;
    for (let i = 0; i < 5; i++) {
      const x0 = Math.floor(i * slot + slot * 0.05);
      const x1 = Math.floor((i + 1) * slot - slot * 0.05);
      boxes.push(verticalBounds(binary, width, height, x0, x1) || { x: x0, y: Math.floor(height * 0.1), width: Math.max(1, x1 - x0), height: Math.floor(height * 0.8) });
    }
  }
  return boxes.slice(0, 5);
}

function normalize(binary: Uint8Array, fullWidth: number, box: Box): Float32Array {
  const target = new Float32Array(784);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const fullHeight = Math.floor(binary.length / fullWidth);
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(fullWidth, Math.ceil(box.x + box.width)), y1 = Math.min(fullHeight, Math.ceil(box.y + box.height));
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (binary[y * fullWidth + x] === 1) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) return target;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const scale = 20 / Math.max(w, h);
  const tw = Math.max(1, Math.min(20, Math.round(w * scale))), th = Math.max(1, Math.min(20, Math.round(h * scale)));
  const SUB = 4;
  const small = new Float32Array(tw * th);
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    let ink = 0;
    for (let sy = 0; sy < SUB; sy++) {
      const iy = Math.min(maxY, Math.floor(minY + (ty + (sy + 0.5) / SUB) * (h / th)));
      for (let sx = 0; sx < SUB; sx++) ink += binary[iy * fullWidth + Math.min(maxX, Math.floor(minX + (tx + (sx + 0.5) / SUB) * (w / tw)))];
    }
    small[ty * tw + tx] = ink / (SUB * SUB);
  }
  let mass = 0, mx = 0, my = 0;
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) { const v = small[ty * tw + tx]; mass += v; mx += v * (tx + 0.5); my += v * (ty + 0.5); }
  const cx = mass > 0 ? mx / mass : tw / 2, cy = mass > 0 ? my / mass : th / 2;
  const ox = Math.min(28 - tw, Math.max(0, Math.round(14 - cx))), oy = Math.min(28 - th, Math.max(0, Math.round(14 - cy)));
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) target[(oy + ty) * 28 + ox + tx] = small[ty * tw + tx];
  return target;
}

export async function recognizeRc2(rgba: Uint8Array, width: number, height: number): Promise<EngineResult> {
  const binary = binarize(rgba, width, height);
  const boxes = find5Boxes(binary, width, height);
  const digits: EngineDigit[] = [];
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const box = boxes[i];
    const input = normalize(binary, width, box);
    if (!input.some((v) => v > 0)) { digits.push({ digit: '', confidence: 0, box }); continue; }
    const p = await OcrService.predictDigit(input);
    digits.push({ digit: String(p.digit), confidence: p.confidence, box });
    total += p.confidence;
  }
  return { code: digits.map((d) => d.digit).join(''), confidence: Math.round(total / 5), digits };
}
