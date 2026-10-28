/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Offline OCR Domain Service (M6).
 * Executes real ONNX neural network inference for 5-digit handwritten codes (MNIST-trained).
 * 100% offline, local execution without Cloud, API, or external network requests.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';

import { fileURLToPath } from 'node:url';

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

export interface OcrServiceResult {
  code: string;
  confidence: number;
  digits: DigitRecognitionResult[];
  isFiveDigits: boolean;
  modelUsed: string;
}

export class OcrService {
  private static session: ort.InferenceSession | null = null;
  private static sessionPromise: Promise<ort.InferenceSession | null> | null = null;

  /**
   * Resolves the local path of mnist.onnx across dev, production, and Electron packaging.
   */
  public static getModelPath(): string {
    let currentDir = '';
    try {
      if (typeof import.meta !== 'undefined' && import.meta.url) {
        currentDir = path.dirname(fileURLToPath(import.meta.url));
      }
    } catch {
      // fallback
    }

    const candidates = [
      path.join(process.cwd(), 'public', 'models', 'mnist.onnx'),
      path.join(process.cwd(), 'dist', 'models', 'mnist.onnx'),
      path.join((process as any).resourcesPath || '', 'models', 'mnist.onnx'),
      currentDir ? path.join(currentDir, '..', '..', '..', 'public', 'models', 'mnist.onnx') : '',
    ];

    for (const p of candidates) {
      if (p && fs.existsSync(p)) {
        return p;
      }
    }

    return path.join(process.cwd(), 'public', 'models', 'mnist.onnx');
  }

  /**
   * Initializes and caches the ONNX Inference Session.
   */
  public static async getSession(): Promise<ort.InferenceSession | null> {
    if (OcrService.session) return OcrService.session;
    if (OcrService.sessionPromise) return OcrService.sessionPromise;

    OcrService.sessionPromise = (async () => {
      try {
        const modelPath = OcrService.getModelPath();
        if (!fs.existsSync(modelPath)) {
          console.warn(`[OCR] ONNX model not found at ${modelPath}`);
          return null;
        }

        const modelBuffer = fs.readFileSync(modelPath);
        const session = await ort.InferenceSession.create(modelBuffer.buffer);
        OcrService.session = session;
        return session;
      } catch (err) {
        console.error('[OCR] Failed to initialize ONNX session:', err);
        return null;
      } finally {
        OcrService.sessionPromise = null;
      }
    })();

    return OcrService.sessionPromise;
  }

  /**
   * Runs ONNX neural network inference on a 28x28 Float32 tensor.
   * Background: 0.0, Ink stroke: 1.0.
   */
  public static async predictDigit(data28: Float32Array): Promise<{ digit: number; confidence: number }> {
    const session = await OcrService.getSession();
    if (!session) {
      throw new Error('ONNX InferenceSession ვერ ინიციალიზდა');
    }

    const inputName = session.inputNames[0];
    const tensor = new ort.Tensor('float32', data28, [1, 1, 28, 28]);
    const results = await session.run({ [inputName]: tensor });
    const outputName = session.outputNames[0];
    const outputTensor = results[outputName];
    const logits = Array.from(outputTensor.data as Float32Array);

    // Numerically stable Softmax calculation
    const maxLogit = Math.max(...logits);
    const expScores = logits.map((l) => Math.exp(l - maxLogit));
    const sumExp = expScores.reduce((acc, val) => acc + val, 0);
    const probs = expScores.map((e) => e / (sumExp || 1));

    let bestDigit = 0;
    let maxProb = 0;
    for (let d = 0; d < 10; d++) {
      if (probs[d] > maxProb) {
        maxProb = probs[d];
        bestDigit = d;
      }
    }

    const confidence = Math.max(1, Math.min(100, Math.round(maxProb * 100)));
    return { digit: bestDigit, confidence };
  }

  /**
   * Binarizes RGBA pixel buffer using Otsu's optimal thresholding.
   */
  public binarize(pixels: Uint8Array | number[], width: number, height: number): Uint8Array {
    const total = width * height;
    const gray = new Uint8Array(total);
    const histogram = new Int32Array(256);

    for (let i = 0; i < total; i++) {
      const idx = i * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[i] = v;
      histogram[v]++;
    }

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

    const adjustedThreshold = Math.min(220, Math.max(50, threshold - 10));
    const binary = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      binary[i] = gray[i] < adjustedThreshold ? 1 : 0;
    }

    return binary;
  }

  /**
   * Segments the binary image into 5 distinct digit bounding boxes.
   */
  public find5Boxes(binary: Uint8Array, width: number, height: number): BoundingBox[] {
    const colSum = new Int32Array(width);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = 0; y < height; y++) {
        if (binary[y * width + x] === 1) sum++;
      }
      colSum[x] = sum;
    }

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

    const boxes: BoundingBox[] = [];

    if (segments.length === 5) {
      for (const seg of segments) {
        const b = this.getVerticalBounds(binary, width, height, seg.startX, seg.endX);
        if (b) boxes.push(b);
      }
    }

    // If natural segmentation did not yield 5 boxes, partition into 5 uniform guide slots
    if (boxes.length !== 5) {
      boxes.length = 0;
      const slotWidth = width / 5;
      for (let i = 0; i < 5; i++) {
        const x0 = Math.floor(i * slotWidth + slotWidth * 0.05);
        const x1 = Math.floor((i + 1) * slotWidth - slotWidth * 0.05);
        const b = this.getVerticalBounds(binary, width, height, x0, x1);
        if (b) {
          boxes.push(b);
        } else {
          boxes.push({
            x: x0,
            y: Math.floor(height * 0.1),
            width: Math.max(1, x1 - x0),
            height: Math.floor(height * 0.8),
          });
        }
      }
    }

    return boxes.slice(0, 5);
  }

  private getVerticalBounds(
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

    if (!found || maxY <= minY) return null;

    return {
      x: Math.max(0, actualMinX - 1),
      y: Math.max(0, minY - 1),
      width: Math.min(width - actualMinX, actualMaxX - actualMinX + 3),
      height: Math.min(height - minY, maxY - minY + 3),
    };
  }

  /**
   * Resamples and centers digit into a standard 28x28 normalized Float32Array (MNIST format).
   */
  public normalizeTo28x28Float(
    binary: Uint8Array,
    fullWidth: number,
    box: BoundingBox
  ): Float32Array {
    const target = new Float32Array(28 * 28);
    if (box.width <= 0 || box.height <= 0) return target;

    // Center digit within 20x20 area with 4px border (standard MNIST bounding)
    const scaleX = box.width / 20;
    const scaleY = box.height / 20;
    const offsetX = 4;
    const offsetY = 4;

    for (let ty = 0; ty < 20; ty++) {
      const srcY = Math.min(box.y + box.height - 1, Math.floor(box.y + ty * scaleY));
      for (let tx = 0; tx < 20; tx++) {
        const srcX = Math.min(box.x + box.width - 1, Math.floor(box.x + tx * scaleX));
        const val = binary[srcY * fullWidth + srcX];
        target[(offsetY + ty) * 28 + (offsetX + tx)] = val === 1 ? 1.0 : 0.0;
      }
    }

    return target;
  }

  /**
   * End-to-end 5-digit handwritten recognition.
   * Processes raw RGBA pixels from webcam/canvas ROI.
   */
  public async recognize5Digits(
    rgbaPixels: Uint8Array | number[],
    width: number,
    height: number
  ): Promise<OcrServiceResult> {
    const binary = this.binarize(rgbaPixels, width, height);
    const boxes = this.find5Boxes(binary, width, height);
    const digits: DigitRecognitionResult[] = [];
    let totalConf = 0;

    for (let i = 0; i < 5; i++) {
      const box = boxes[i] || { x: (i * width) / 5, y: 0, width: width / 5, height };
      const float28 = this.normalizeTo28x28Float(binary, width, box);
      const prediction = await OcrService.predictDigit(float28);

      digits.push({
        digit: String(prediction.digit),
        confidence: prediction.confidence,
        box,
      });
      totalConf += prediction.confidence;
    }

    const code = digits.map((d) => d.digit).join('');
    const avgConfidence = Math.round(totalConf / 5);
    const isFiveDigits = /^\d{5}$/.test(code);

    return {
      code,
      confidence: avgConfidence,
      digits,
      isFiveDigits,
      modelUsed: 'mnist.onnx',
    };
  }
}
