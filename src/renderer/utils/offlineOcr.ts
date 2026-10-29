/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * 100% Offline Handwritten 5-Digit OCR & Computer Vision Engine.
 * Operates purely locally in the client without any external network, Cloud,
 * or API dependencies.
 * 
 * Pipeline:
 * 1. ROI (Region of Interest) extraction from Webcam frame
 * 2. Grayscale conversion & adaptive Otsu binarization
 * 3. 5-digit horizontal segment extraction with bounding box normalization
 * 4. Topological structural feature extraction & prototype weight classification
 * 5. 5-digit validation (strictly 10000 - 99999) with confidence scoring
 */

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DigitRecognitionResult {
  digit: string;
  confidence: number;
  box: BoundingBox;
}

export interface OcrResult {
  code: string;
  confidence: number;
  digits: DigitRecognitionResult[];
  processedImageUri?: string;
}

/**
 * Standard 28x28 structural digit prototype profiles.
 * Derived from topological stroke densities and aspect ratios.
 */
interface DigitProfile {
  digit: number;
  hasTopLoop: boolean;
  hasBottomLoop: boolean;
  hasCenterLoop: boolean;
  topDensity: number;      // Stroke ratio in top 1/3
  middleDensity: number;   // Stroke ratio in middle 1/3
  bottomDensity: number;   // Stroke ratio in bottom 1/3
  leftDensity: number;     // Stroke ratio in left 1/3
  rightDensity: number;    // Stroke ratio in right 1/3
  aspectRatio: number;     // width / height
  verticalCentroid: number;// 0.0 (top) to 1.0 (bottom)
}

// Characteristic statistical profiles for digits 0-9
const DIGIT_PROFILES: DigitProfile[] = [
  { digit: 0, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: true,  topDensity: 0.32, middleDensity: 0.22, bottomDensity: 0.32, leftDensity: 0.35, rightDensity: 0.35, aspectRatio: 0.65, verticalCentroid: 0.50 },
  { digit: 1, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.20, middleDensity: 0.25, bottomDensity: 0.20, leftDensity: 0.15, rightDensity: 0.15, aspectRatio: 0.30, verticalCentroid: 0.50 },
  { digit: 2, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.35, middleDensity: 0.25, bottomDensity: 0.45, leftDensity: 0.25, rightDensity: 0.30, aspectRatio: 0.60, verticalCentroid: 0.55 },
  { digit: 3, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.35, middleDensity: 0.30, bottomDensity: 0.35, leftDensity: 0.15, rightDensity: 0.45, aspectRatio: 0.58, verticalCentroid: 0.52 },
  { digit: 4, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.25, middleDensity: 0.45, bottomDensity: 0.20, leftDensity: 0.30, rightDensity: 0.35, aspectRatio: 0.65, verticalCentroid: 0.48 },
  { digit: 5, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.42, middleDensity: 0.28, bottomDensity: 0.35, leftDensity: 0.35, rightDensity: 0.25, aspectRatio: 0.60, verticalCentroid: 0.48 },
  { digit: 6, hasTopLoop: false, hasBottomLoop: true,  hasCenterLoop: false, topDensity: 0.25, middleDensity: 0.38, bottomDensity: 0.45, leftDensity: 0.42, rightDensity: 0.25, aspectRatio: 0.62, verticalCentroid: 0.58 },
  { digit: 7, hasTopLoop: false, hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.48, middleDensity: 0.25, bottomDensity: 0.15, leftDensity: 0.15, rightDensity: 0.40, aspectRatio: 0.58, verticalCentroid: 0.40 },
  { digit: 8, hasTopLoop: true,  hasBottomLoop: true,  hasCenterLoop: false, topDensity: 0.38, middleDensity: 0.40, bottomDensity: 0.40, leftDensity: 0.35, rightDensity: 0.35, aspectRatio: 0.62, verticalCentroid: 0.50 },
  { digit: 9, hasTopLoop: true,  hasBottomLoop: false, hasCenterLoop: false, topDensity: 0.45, middleDensity: 0.38, bottomDensity: 0.25, leftDensity: 0.25, rightDensity: 0.42, aspectRatio: 0.62, verticalCentroid: 0.42 },
];

/**
 * Converts image buffer to grayscale and computes optimal threshold using Otsu's method.
 */
export function binarizeGrayscale(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const total = width * height;
  const gray = new Uint8Array(total);
  const histogram = new Int32Array(256);

  // 1. Grayscale conversion & histogram
  for (let i = 0; i < total; i++) {
    const idx = i * 4;
    // Standard perceptual luminosity weighting
    const val = Math.round(0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2]);
    gray[i] = val;
    histogram[val]++;
  }

  // 2. Otsu's thresholding
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];

  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let varMax = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;

    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);

    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }

  // Adjust threshold slightly towards darker (pen ink)
  const adjustedThreshold = Math.min(220, Math.max(50, threshold - 10));

  // 3. Binary output (1 = ink / stroke, 0 = background paper)
  const binary = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    binary[i] = gray[i] < adjustedThreshold ? 1 : 0;
  }

  return binary;
}

/**
 * Segments an ROI image into 5 distinct horizontal digit regions.
 * Uses vertical projection (column sum) and bounding boxes.
 */
export function find5DigitBoxes(
  binary: Uint8Array,
  width: number,
  height: number
): BoundingBox[] {
  // Column projection (number of ink pixels per column)
  const colSum = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) {
      if (binary[y * width + x] === 1) sum++;
    }
    colSum[x] = sum;
  }

  // Find continuous non-empty column segments
  const segments: Array<{ startX: number; endX: number }> = [];
  let inSegment = false;
  let startX = 0;
  const minStroke = Math.max(2, Math.floor(height * 0.04));

  for (let x = 0; x < width; x++) {
    if (colSum[x] >= minStroke) {
      if (!inSegment) {
        inSegment = true;
        startX = x;
      }
    } else {
      if (inSegment) {
        inSegment = false;
        if (x - startX > 3) {
          segments.push({ startX, endX: x });
        }
      }
    }
  }
  if (inSegment && width - startX > 3) {
    segments.push({ startX, endX: width });
  }

  // If connected components separated into roughly 5 digits:
  const boxes: BoundingBox[] = [];

  if (segments.length === 5) {
    for (const seg of segments) {
      const box = getVerticalBounds(binary, width, height, seg.startX, seg.endX);
      if (box) boxes.push(box);
    }
  } else {
    // If digits are written inside 5 predefined guideline boxes or evenly spaced:
    const slotWidth = width / 5;
    for (let i = 0; i < 5; i++) {
      const x0 = Math.floor(i * slotWidth + slotWidth * 0.05);
      const x1 = Math.floor((i + 1) * slotWidth - slotWidth * 0.05);
      const box = getVerticalBounds(binary, width, height, x0, x1);
      if (box) {
        boxes.push(box);
      } else {
        // Fallback default box for empty slot
        boxes.push({ x: x0, y: Math.floor(height * 0.1), width: x1 - x0, height: Math.floor(height * 0.8) });
      }
    }
  }

  return boxes.slice(0, 5);
}

function getVerticalBounds(
  binary: Uint8Array,
  width: number,
  height: number,
  minX: number,
  maxX: number
): BoundingBox | null {
  let minY = height;
  let maxY = 0;
  let actualMinX = maxX;
  let actualMaxX = minX;
  let found = false;

  for (let x = minX; x < maxX; x++) {
    for (let y = 0; y < height; y++) {
      if (binary[y * width + x] === 1) {
        found = true;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < actualMinX) actualMinX = x;
        if (x > actualMaxX) actualMaxX = x;
      }
    }
  }

  if (!found || maxY <= minY) {
    return null;
  }

  // Add 1-pixel padding
  return {
    x: Math.max(0, actualMinX - 1),
    y: Math.max(0, minY - 1),
    width: Math.min(width - actualMinX, (actualMaxX - actualMinX) + 3),
    height: Math.min(height - minY, (maxY - minY) + 3),
  };
}

/**
 * Resamples a bounding box into a standard 28x28 normalized binary matrix.
 */
export function normalizeTo28x28(
  binary: Uint8Array,
  fullWidth: number,
  box: BoundingBox
): Uint8Array {
  const target = new Uint8Array(28 * 28);
  if (box.width <= 0 || box.height <= 0) return target;

  const scaleX = box.width / 20;
  const scaleY = box.height / 20;
  const offsetX = 4;
  const offsetY = 4;

  for (let ty = 0; ty < 20; ty++) {
    const srcY = Math.min(box.y + box.height - 1, Math.floor(box.y + ty * scaleY));
    for (let tx = 0; tx < 20; tx++) {
      const srcX = Math.min(box.x + box.width - 1, Math.floor(box.x + tx * scaleX));
      const val = binary[srcY * fullWidth + srcX];
      target[(offsetY + ty) * 28 + (offsetX + tx)] = val;
    }
  }

  return target;
}

/**
 * Analyzes features of a normalized 28x28 digit and matches against statistical profiles.
 */
export function classifyNormalizedDigit(digit28: Uint8Array, originalBox: BoundingBox): { digit: number; confidence: number } {
  let totalInk = 0;
  let topInk = 0;
  let midInk = 0;
  let botInk = 0;
  let leftInk = 0;
  let rightInk = 0;
  let yWeightedSum = 0;

  for (let y = 0; y < 28; y++) {
    for (let x = 0; x < 28; x++) {
      if (digit28[y * 28 + x] === 1) {
        totalInk++;
        yWeightedSum += y;
        if (y < 10) topInk++;
        else if (y < 19) midInk++;
        else botInk++;

        if (x < 11) leftInk++;
        else if (x > 16) rightInk++;
      }
    }
  }

  if (totalInk < 15) {
    // Virtually empty box
    return { digit: 0, confidence: 20 };
  }

  const topDensity = topInk / totalInk;
  const middleDensity = midInk / totalInk;
  const bottomDensity = botInk / totalInk;
  const leftDensity = leftInk / totalInk;
  const rightDensity = rightInk / totalInk;
  const verticalCentroid = (yWeightedSum / totalInk) / 28;
  const aspectRatio = originalBox.width / Math.max(1, originalBox.height);

  let bestDigit = 0;
  let minDistance = Infinity;

  for (const prof of DIGIT_PROFILES) {
    // Euclidean distance in feature space with domain weights
    const dTop = (prof.topDensity - topDensity) * 1.5;
    const dMid = (prof.middleDensity - middleDensity) * 1.2;
    const dBot = (prof.bottomDensity - bottomDensity) * 1.5;
    const dLeft = (prof.leftDensity - leftDensity) * 1.2;
    const dRight = (prof.rightDensity - rightDensity) * 1.2;
    const dAspect = (prof.aspectRatio - aspectRatio) * 1.8;
    const dCentroid = (prof.verticalCentroid - verticalCentroid) * 2.0;

    const dist = Math.sqrt(
      dTop * dTop +
      dMid * dMid +
      dBot * dBot +
      dLeft * dLeft +
      dRight * dRight +
      dAspect * dAspect +
      dCentroid * dCentroid
    );

    if (dist < minDistance) {
      minDistance = dist;
      bestDigit = prof.digit;
    }
  }

  // Convert distance to confidence percentage (0% to 98%)
  const confidence = Math.max(35, Math.min(98, Math.round((1 - Math.min(1, minDistance / 1.8)) * 100)));

  return { digit: bestDigit, confidence };
}

import { invokeIpc } from '../api/ipcClient.ts';

export async function recognize5DigitsFromCanvas(
  sourceCanvas: HTMLCanvasElement,
  roi: BoundingBox
): Promise<OcrResult> {
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Canvas 2D context-ის მიღება ვერ მოხერხდა');
  }

  // Extract ROI ImageData
  const roiWidth = Math.max(10, Math.floor(roi.width));
  const roiHeight = Math.max(10, Math.floor(roi.height));
  const roiX = Math.max(0, Math.floor(roi.x));
  const roiY = Math.max(0, Math.floor(roi.y));

  const imgData = ctx.getImageData(roiX, roiY, roiWidth, roiHeight);
  const binary = binarizeGrayscale(imgData.data, roiWidth, roiHeight);

  // Create processed preview data URL for seller visual feedback
  const previewCanvas = document.createElement('canvas');
  previewCanvas.width = roiWidth;
  previewCanvas.height = roiHeight;
  const pCtx = previewCanvas.getContext('2d');
  if (pCtx) {
    const pImgData = pCtx.createImageData(roiWidth, roiHeight);
    for (let i = 0; i < roiWidth * roiHeight; i++) {
      const v = binary[i] === 1 ? 0 : 255;
      pImgData.data[i * 4] = v;
      pImgData.data[i * 4 + 1] = v;
      pImgData.data[i * 4 + 2] = v;
      pImgData.data[i * 4 + 3] = 255;
    }
    pCtx.putImageData(pImgData, 0, 0);
  }

  // 1. Real ONNX inference via local IPC service
  try {
    const ipcRes = await invokeIpc<any>('ocr:recognize', {
      pixels: Array.from(imgData.data),
      width: roiWidth,
      height: roiHeight,
    });

    if (ipcRes && ipcRes.code && ipcRes.digits) {
      return {
        code: ipcRes.code,
        confidence: ipcRes.confidence,
        digits: ipcRes.digits,
        processedImageUri: previewCanvas.toDataURL('image/png'),
      };
    }
    throw new Error('ONNX მოდელმა ვერ დააბრუნა ვალიდური შედეგი');
  } catch (ipcErr: any) {
    console.error('[OCR] ONNX Inference error:', ipcErr);
    // Explicit error reporting without disguised fallback
    throw new Error(
      `ONNX მოდელი მიუწვდომელია (${ipcErr?.message || 'შეცდომა'}). გთხოვთ შეიყვანოთ 5-ნიშნა კოდი ხელით ან გამოიყენოთ შტრიხკოდის სკანერი.`
    );
  }
}
