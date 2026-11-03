/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Offline OCR Domain Service: the IPC-facing side of handwritten 5-digit code recognition.
 * The recognition itself (src/main/ocr) runs on a worker thread when the app configured one,
 * 100% offline, with a local ONNX model: no Cloud, API or network request.
 */

import { classifyDigits, getSession, MODEL_FILE, modelPath } from '../ocr/model.ts';
import { OcrEngine } from '../ocr/engine.ts';
import { recognizeOcr, warmupOcr } from '../ocr/workerClient.ts';
import type { OcrResult } from '../../shared/ocr.ts';

/** Matches MAX_OCR_PIXELS in the renderer (which scales larger photos down) with headroom. */
export const OCR_MAX_PIXELS = 4_000_000;

export class OcrService {
  static readonly modelName = MODEL_FILE;

  static getModelPath(): string {
    return modelPath();
  }

  static getSession() {
    return getSession();
  }

  /** Loads the model (on the OCR thread) before the first recognition. */
  static warmup(): Promise<boolean> {
    return warmupOcr();
  }

  /** The most likely digit of one 28x28 input (0 = paper, 1 = ink), confidence 0-100. */
  static async predictDigit(data28: Float32Array): Promise<{ digit: number; confidence: number }> {
    const [probs] = await classifyDigits([data28]);
    let digit = 0;
    for (let d = 1; d < 10; d++) if (probs[d] > probs[digit]) digit = d;
    return { digit, confidence: Math.max(1, Math.min(100, Math.round(probs[digit] * 100))) };
  }

  /**
   * Checks an image sent for recognition: integer size within limits and exactly
   * width x height RGBA pixels (typed array from the desktop bridge, or a plain array).
   */
  public static validateImage(pixels: unknown, width: unknown, height: unknown): { pixels: Uint8Array | number[]; width: number; height: number } {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 10 || h < 10 || w > 8192 || h > 8192 || w * h > OCR_MAX_PIXELS) {
      throw new Error(`OCR: სურათის ზომა არასწორია (${width}x${height})`);
    }
    let data: Uint8Array | number[];
    if (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray) {
      data = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    } else if (Array.isArray(pixels)) {
      data = pixels as number[];
    } else {
      throw new Error('OCR: სურათის მონაცემები არასწორია');
    }
    if (data.length !== w * h * 4) {
      throw new Error('OCR: სურათის მონაცემები არ შეესაბამება ზომას');
    }
    return { pixels: data, width: w, height: h };
  }

  /** Recognition for the camera dialog (on the OCR thread when configured). */
  static recognize(rgba: Uint8Array | number[], width: number, height: number, options: { diagnostics?: boolean } = {}): Promise<OcrResult> {
    return recognizeOcr(rgba, width, height, !!options.diagnostics);
  }

  /** Recognition in this thread (tests and tools). */
  public recognize5Digits(rgba: Uint8Array | number[], width: number, height: number, options: { diagnostics?: boolean } = {}): Promise<OcrResult> {
    return new OcrEngine().recognize(rgba, width, height, options);
  }
}
