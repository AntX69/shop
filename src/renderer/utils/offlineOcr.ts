/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Camera dialog side of the offline handwriting OCR: cuts the recognised region out of a camera
 * frame or a photo and sends its pixels to the main process (src/main/ocr), where the code is
 * found and read by a local ONNX model. No network, Cloud or API is involved.
 */

import { invokeIpc } from '../api/ipcClient.ts';
import type { OcrResult } from '../../shared/ocr.ts';
import type { Rect } from './cameraRoi.ts';

export type BoundingBox = Rect;

/**
 * Largest region sent for recognition. The camera frame region is below it (1920x1080 gives about
 * 1690x565); larger photos are scaled down, so recognition never freezes the window or exhausts
 * memory on a 12-megapixel picture.
 */
export const MAX_OCR_PIXELS = 2_000_000;

/** Size a region is scaled to before recognition (unchanged when it is within MAX_OCR_PIXELS). */
export function ocrInputSize(width: number, height: number, maxPixels = MAX_OCR_PIXELS): { width: number; height: number } {
  const w = Math.max(10, Math.floor(width));
  const h = Math.max(10, Math.floor(height));
  if (w * h <= maxPixels) return { width: w, height: h };
  const scale = Math.sqrt(maxPixels / (w * h));
  return { width: Math.max(10, Math.floor(w * scale)), height: Math.max(10, Math.floor(h * scale)) };
}

/** The exact pixels that were recognised (kept for the diagnostics panel and test samples). */
export interface RegionImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Copies `roi` of the canvas (scaled down when larger than MAX_OCR_PIXELS) onto white paper. */
export function readRegion(sourceCanvas: HTMLCanvasElement, roi: BoundingBox): RegionImage {
  const roiWidth = Math.max(10, Math.floor(roi.width));
  const roiHeight = Math.max(10, Math.floor(roi.height));
  const roiX = Math.max(0, Math.floor(roi.x));
  const roiY = Math.max(0, Math.floor(roi.y));
  const target = ocrInputSize(roiWidth, roiHeight);
  const out = document.createElement('canvas');
  out.width = target.width;
  out.height = target.height;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D context-ის მიღება ვერ მოხერხდა');
  // Transparent parts of a PNG count as white paper, not as black ink.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, roiX, roiY, roiWidth, roiHeight, 0, 0, target.width, target.height);
  return { data: ctx.getImageData(0, 0, target.width, target.height).data, width: target.width, height: target.height };
}

/** Recognises the code in a region (in the main process, on the OCR worker thread). */
export async function recognizeRegion(region: RegionImage, diagnostics = false): Promise<OcrResult> {
  // The desktop bridge copies typed arrays directly; the web dev server needs plain JSON.
  const inElectron = typeof window !== 'undefined' && !!(window as any).electronAPI?.invoke;
  let result: OcrResult;
  try {
    result = await invokeIpc<OcrResult>('ocr:recognize', {
      pixels: inElectron ? new Uint8Array(region.data.buffer, region.data.byteOffset, region.data.byteLength) : Array.from(region.data),
      width: region.width,
      height: region.height,
      diagnostics,
    });
  } catch (ipcErr: any) {
    console.error('[OCR] recognition error:', ipcErr);
    throw new Error(
      `ამოცნობა ვერ შესრულდა (${ipcErr?.message || 'შეცდომა'}). გთხოვთ შეიყვანოთ 5-ნიშნა კოდი ხელით ან გამოიყენოთ შტრიხკოდის სკანერი.`
    );
  }
  if (!result || !Array.isArray(result.digits) || typeof result.status !== 'string') {
    throw new Error('ONNX მოდელმა ვერ დააბრუნა ვალიდური შედეგი. გთხოვთ შეიყვანოთ 5-ნიშნა კოდი ხელით.');
  }
  return result;
}

/** PNG bytes of a region (test samples). */
export async function regionPng(region: RegionImage): Promise<Uint8Array> {
  const c = document.createElement('canvas');
  c.width = region.width;
  c.height = region.height;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context-ის მიღება ვერ მოხერხდა');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(region.data), region.width, region.height), 0, 0);
  return canvasPng(c);
}

export async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG-ის შექმნა ვერ მოხერხდა');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Photo files accepted for OCR tests: PNG or JPEG, at most 15 MB and 40 megapixels. */
export const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const PHOTO_MAX_PIXELS = 40_000_000;

/** Checks a photo before decoding it: type, size and the file's own signature bytes. */
export async function checkPhotoFile(file: File): Promise<string | null> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') return 'მხოლოდ JPG ან PNG ფოტო';
  if (file.size > PHOTO_MAX_BYTES) return 'ფოტო 15 MB-ზე დიდია';
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b);
  const jpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (!png && !jpeg) return 'ფაილი JPG ან PNG ფოტო არ არის';
  return null;
}
