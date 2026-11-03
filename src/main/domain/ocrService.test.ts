/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OcrService } from './ocrService.ts';
import { recognizeOcr } from '../ocr/workerClient.ts';

describe('OcrService (Offline ONNX Handwritten Recognition)', () => {
  test('model file path exists and session can be initialized', async () => {
    const session = await OcrService.getSession();
    assert.ok(session, 'ONNX InferenceSession should initialize from the local model');
    assert.ok(session.inputNames.length > 0, 'Session should have inputs');
    assert.ok(session.outputNames.length > 0, 'Session should have outputs');
    assert.equal(await OcrService.warmup(), true);
  });

  test('predictDigit identifies 1 from a vertical stroke and 0 from an oval', async () => {
    const one = new Float32Array(28 * 28);
    for (let y = 4; y < 24; y++) { one[y * 28 + 14] = 1.0; one[y * 28 + 13] = 0.8; }
    const p1 = await OcrService.predictDigit(one);
    assert.equal(p1.digit, 1);
    assert.ok(p1.confidence >= 80, `confidence ${p1.confidence}`);
    const zero = new Float32Array(28 * 28);
    for (let a = 0; a < Math.PI * 2; a += 0.05) {
      for (const r of [0, 0.7]) zero[Math.round(14 + (9 - r) * Math.sin(a)) * 28 + Math.round(14 + (6 - r) * Math.cos(a))] = 1.0;
    }
    assert.equal((await OcrService.predictDigit(zero)).digit, 0);
  });

  test('recognize5Digits reads 11111 and 10101 drawn as strokes and loops, wherever they are', async () => {
    const width = 300;
    const height = 90;
    const draw = (shapes: string, offsetX: number) => {
      const rgba = new Uint8Array(width * height * 4).fill(255);
      const set = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        const i = (y * width + x) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 20;
      };
      [...shapes].forEach((s, slot) => {
        const cx = offsetX + slot * 32;
        if (s === '1') for (let y = 25; y < 65; y++) for (let x = cx - 2; x <= cx + 2; x++) set(x, y);
        else for (let a = 0; a < Math.PI * 2; a += 0.01) for (let r = 0; r < 4; r++) set(Math.round(cx + (11 - r * 0.5) * Math.cos(a)), Math.round(45 + (19 - r * 0.5) * Math.sin(a)));
      });
      return rgba;
    };
    const ocr = new OcrService();
    // Left part of the region, then the right part: no fixed cells.
    assert.equal((await ocr.recognize5Digits(draw('11111', 30), width, height)).code, '11111');
    assert.equal((await ocr.recognize5Digits(draw('10101', 120), width, height)).code, '10101');
  });

  test('the worker client runs the same recognition in this thread when no worker is configured', async () => {
    const width = 200;
    const height = 60;
    const rgba = new Uint8Array(width * height * 4).fill(255);
    const r = await recognizeOcr(rgba, width, height, false);
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'no_ink');
  });
});

describe('OcrService checks its input', () => {
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
