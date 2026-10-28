/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OcrService } from './ocrService.ts';

describe('OcrService (Offline ONNX Handwritten Recognition)', () => {
  test('model file path exists and session can be initialized', async () => {
    const session = await OcrService.getSession();
    assert.ok(session, 'ONNX InferenceSession should initialize from local mnist.onnx');
    assert.ok(session.inputNames.length > 0, 'Session should have inputs');
    assert.ok(session.outputNames.length > 0, 'Session should have outputs');
  });

  test('predictDigit correctly identifies digit 1 from a vertical stroke pattern', async () => {
    const data = new Float32Array(28 * 28);
    // Draw vertical bar centered around column 14
    for (let y = 4; y < 24; y++) {
      data[y * 28 + 14] = 1.0;
      data[y * 28 + 13] = 0.8;
    }

    const prediction = await OcrService.predictDigit(data);
    assert.equal(prediction.digit, 1, 'Vertical line should be classified as digit 1');
    assert.ok(prediction.confidence >= 80, `Confidence should be high (got ${prediction.confidence})`);
  });

  test('predictDigit correctly identifies digit 0 from an oval loop pattern', async () => {
    const data = new Float32Array(28 * 28);
    // Draw oval loop
    for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
      const x = Math.round(14 + 6 * Math.cos(angle));
      const y = Math.round(14 + 9 * Math.sin(angle));
      if (x >= 0 && x < 28 && y >= 0 && y < 28) {
        data[y * 28 + x] = 1.0;
      }
    }

    const prediction = await OcrService.predictDigit(data);
    assert.equal(prediction.digit, 0, 'Oval loop should be classified as digit 0');
    assert.ok(prediction.confidence >= 80, `Confidence should be high (got ${prediction.confidence})`);
  });

  test('recognize5Digits processes 5 synthetic digits end-to-end and returns 5-digit code', async () => {
    const ocr = new OcrService();
    const width = 100;
    const height = 40;
    // White background (255, 255, 255, 255)
    const rgba = new Uint8Array(width * height * 4);
    rgba.fill(255);

    // Draw 5 vertical lines (representing 11111) in each slot
    for (let slot = 0; slot < 5; slot++) {
      const col = slot * 20 + 10;
      for (let y = 8; y < 32; y++) {
        for (let x = col - 1; x <= col + 1; x++) {
          const idx = (y * width + x) * 4;
          rgba[idx] = 0;     // R (black ink)
          rgba[idx + 1] = 0; // G
          rgba[idx + 2] = 0; // B
          rgba[idx + 3] = 255;
        }
      }
    }

    const result = await ocr.recognize5Digits(rgba, width, height);
    assert.equal(result.digits.length, 5, 'Should return exactly 5 digits');
    assert.equal(result.code.length, 5, 'Code should have exactly 5 digits');
    assert.match(result.code, /^\d{5}$/, 'Code must strictly match 5-digit pattern');
    assert.equal(result.isFiveDigits, true);
    assert.equal(result.modelUsed, 'mnist.onnx');
    assert.ok(result.confidence > 0, 'Confidence score must be positive');
  });
});
