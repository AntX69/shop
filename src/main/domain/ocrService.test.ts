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

describe('OcrService preprocessing keeps digit proportions', () => {
  function drawCode(width: number, height: number, draw: (set: (x: number, y: number) => void, slot: number) => void) {
    const rgba = new Uint8Array(width * height * 4).fill(255);
    const set = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const i = (y * width + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
    };
    for (let slot = 0; slot < 5; slot++) draw(set, slot);
    return rgba;
  }

  test('a thin vertical stroke stays thin and centred (not stretched into a block)', () => {
    const ocr = new OcrService();
    const width = 40;
    const binary = new Uint8Array(width * 40);
    for (let y = 5; y < 35; y++) binary[y * width + 20] = 1;
    const out = ocr.normalizeTo28x28Float(binary, width, { x: 0, y: 0, width: 40, height: 40 });
    const inkColumns = new Set<number>();
    for (let i = 0; i < out.length; i++) if (out[i] > 0) inkColumns.add(i % 28);
    assert.ok(inkColumns.size <= 2, `a 1-px stroke must not fill the 20-px box (columns with ink: ${inkColumns.size})`);
    assert.ok([...inkColumns].every((c) => c >= 12 && c <= 15), 'stroke is centred');
  });

  test('recognize5Digits reads 11111 and 10101 drawn as strokes and loops', async () => {
    const ocr = new OcrService();
    const width = 200;
    const height = 60;
    const stroke = (set: (x: number, y: number) => void, cx: number) => {
      for (let y = 12; y < 48; y++) for (let x = cx - 2; x <= cx + 2; x++) set(x, y);
    };
    const loop = (set: (x: number, y: number) => void, cx: number) => {
      for (let a = 0; a < Math.PI * 2; a += 0.01) {
        for (let r = 0; r < 4; r++) set(Math.round(cx + (10 - r * 0.5) * Math.cos(a)), Math.round(30 + (17 - r * 0.5) * Math.sin(a)));
      }
    };
    const ones = drawCode(width, height, (set, slot) => stroke(set, slot * 40 + 20));
    assert.equal((await ocr.recognize5Digits(ones, width, height)).code, '11111');
    const mixed = drawCode(width, height, (set, slot) => (slot % 2 === 0 ? stroke(set, slot * 40 + 20) : loop(set, slot * 40 + 20)));
    assert.equal((await ocr.recognize5Digits(mixed, width, height)).code, '10101');
  });
});

describe('OcrService never invents a digit and checks its input', () => {
  test('a position without ink is returned empty with confidence 0', async () => {
    const width = 200;
    const height = 60;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    // strokes in positions 1, 2, 4 and 5; position 3 is blank
    for (const slot of [0, 1, 3, 4]) {
      const cx = slot * 40 + 20;
      for (let y = 12; y < 48; y++) for (let x = cx - 2; x <= cx + 2; x++) {
        const i = (y * width + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
      }
    }
    const result = await new OcrService().recognize5Digits(rgba, width, height);
    assert.equal(result.digits.length, 5);
    assert.equal(result.digits[2].digit, '', 'blank position stays empty');
    assert.equal(result.digits[2].confidence, 0);
    assert.equal(result.code, '1111', 'code holds only the recognised digits');
    assert.equal(result.isFiveDigits, false);
    assert.ok(result.confidence <= 80, `average includes the missing digit (got ${result.confidence})`);
  });

  test('validateImage accepts typed arrays and plain arrays of exactly width x height x 4', () => {
    const typed = OcrService.validateImage(new Uint8ClampedArray(20 * 10 * 4), 20, 10);
    assert.ok(typed.pixels instanceof Uint8Array);
    assert.equal(OcrService.validateImage(new Array(20 * 10 * 4).fill(0), 20, 10).width, 20);
  });

  test('validateImage refuses wrong sizes and oversized images before any memory is allocated', () => {
    assert.throws(() => OcrService.validateImage(new Uint8Array(10), 20, 10), /არ შეესაბამება/);
    assert.throws(() => OcrService.validateImage(new Uint8Array(0), 20.5, 10), /ზომა/);
    assert.throws(() => OcrService.validateImage(new Uint8Array(0), 5, 10), /ზომა/);
    assert.throws(() => OcrService.validateImage(new Uint8Array(0), 8000, 8000), /ზომა/);
    assert.throws(() => OcrService.validateImage('not pixels', 20, 10), /მონაცემები/);
    assert.throws(() => OcrService.validateImage({ length: 800 }, 20, 10), /მონაცემები/);
  });
});
