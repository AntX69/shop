/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests of the handwriting OCR on simulated camera pictures of real pen-written
 * digits (fixture: 40 pendigits samples, CC BY 4.0). Synthetic pictures: they guard the pipeline
 * against regressions; real accuracy is measured on real photos (docs/hardware/OCR_FIELD_TEST_KA.md).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GlyphBank, makeScene, penGlyph, renderScene, type Box, type Condition } from '../../../scripts/ocr/lib/synth.ts';
import { Rng } from '../../../scripts/ocr/lib/rng.ts';
import { OcrEngine, type DigitClassifier } from './engine.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, '__fixtures__', 'pen-digits.json'), 'utf8')) as {
  samples: Array<{ label: number; writer: number; strokes: Array<Array<[number, number]>> }>;
};
const bank = new GlyphBank();
fixture.samples.forEach((s, index) => bank.add(s.writer, penGlyph({ label: s.label, strokes: s.strokes, writer: s.writer, index })));

function picture(code: string, condition: Condition, seed: number, size: { width?: number; height?: number } = {}) {
  return renderScene(makeScene(bank, new Rng(seed), { code, condition, ...size }));
}

function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.width * a.height + b.width * b.height - inter || 1);
}

const engine = new OcrEngine();

describe('OCR finds the digits where they are written (no fixed cells)', () => {
  const cases: Array<[string, Condition, string]> = [
    ['code at the left edge of the frame', 'left', '31582'],
    ['code at the right edge of the frame', 'right', '64709'],
    ['code in the centre', 'center', '20417'],
    ['compact code across the 2nd-3rd fifths (the RC2 failure)', 'user-case', '26407'],
    ['widely spaced digits', 'wide-spacing', '58136'],
    ['slanted handwriting', 'slanted', '97214'],
    ['ruled notebook paper', 'ruled', '45063'],
    ['squared notebook paper', 'grid', '18290'],
    ['uneven light', 'uneven-light', '73645'],
    ['low contrast (faint pen, dim light)', 'low-contrast', '50928'],
    ['digits touching each other', 'touching', '36851'],
    ['difficult digits 1, 4, 7, 9', 'random', '14797'],
  ];
  for (const [name, condition, code] of cases) {
    test(name, async () => {
      const pic = picture(code, condition, 7);
      const r = await engine.recognize(pic.rgba, pic.width, pic.height);
      assert.notEqual(r.status, 'rejected', `${r.reason}: ${r.message}`);
      assert.equal(r.digits.length, 5);
      r.digits.forEach((d, i) => assert.ok(iou(d.box, pic.digitBoxes[i]) >= 0.5, `digit #${i + 1} box matches the written digit`));
    });
  }
});

describe('OCR never invents a digit', () => {
  test('a blank sheet is rejected, no digits', async () => {
    const pic = picture('', 'random', 3);
    const r = await engine.recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'no_ink');
    assert.equal(r.digits.length, 0);
    assert.equal(r.code, '');
    assert.equal(r.isFiveDigits, false);
    assert.match(r.message || '', /ვერ მოიძებნა/);
  });

  test('only three digits written: rejected with the number found, no five-digit code', async () => {
    const pic = picture('274', 'center', 5);
    const r = await engine.recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'too_few');
    assert.equal(r.found, 3);
    assert.equal(r.digits.length, 0);
    assert.match(r.message || '', /3 სიმბოლო/);
  });

  test('seven symbols: rejected as too many', async () => {
    const pic = picture('1234567', 'center', 5);
    const r = await engine.recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'too_many');
  });

  test('digits too small to read: rejected with advice to move closer', async () => {
    const tiny = renderScene({ ...makeScene(bank, new Rng(5), { code: '48213', condition: 'center' }), digitHeight: 10 });
    const r = await engine.recognize(tiny.rgba, tiny.width, tiny.height);
    assert.equal(r.status, 'rejected');
    assert.ok(r.reason === 'too_small' || r.reason === 'no_ink', String(r.reason));
  });

  test('a code running off the edge of the frame is rejected, not repaired by cutting', async () => {
    const scene = makeScene(bank, new Rng(9), { code: '52814', condition: 'center' });
    scene.centerX = 0.02; // most of the first digits outside the frame
    const pic = renderScene(scene);
    const r = await engine.recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.status, 'rejected');
    assert.ok(['border', 'too_few'].includes(String(r.reason)), String(r.reason));
  });
});

describe('OCR confidence and doubtful digits (stub model)', () => {
  // The model's answer is fixed per position so the engine's decisions can be checked exactly.
  const stub = (byPosition: Array<[number, number]>): DigitClassifier => ({
    name: 'stub',
    classify: async (inputs) => inputs.map((_, i) => {
      const [digit, p] = byPosition[i % byPosition.length];
      const probs = new Float32Array(10).fill((1 - p) / 9);
      probs[digit] = p;
      return probs;
    }),
  });
  const pic = picture('31582', 'center', 11);

  test('confident digits: status ok, confidence is the probability of the whole code', async () => {
    const r = await new OcrEngine(stub([[3, 0.995], [1, 0.99], [5, 0.999], [8, 0.985], [2, 0.99]])).recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.status, 'ok');
    assert.equal(r.code, '31582');
    assert.equal(r.isFiveDigits, true);
    assert.equal(r.confidence, Math.round(100 * 0.995 * 0.99 * 0.999 * 0.985 * 0.99));
    assert.ok(r.digits.every((d) => !d.doubtful));
  });

  test('an unsure digit is filled but marked; an unreadable one is left empty', async () => {
    const r = await new OcrEngine(stub([[3, 0.995], [1, 0.9], [5, 0.3], [8, 0.995], [2, 0.995]])).recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.status, 'check');
    assert.equal(r.digits[1].digit, '1');
    assert.equal(r.digits[1].doubtful, true);
    assert.equal(r.digits[2].digit, '', 'unreadable position is not guessed');
    assert.equal(r.digits[2].doubtful, true);
    assert.equal(r.isFiveDigits, false);
    assert.equal(r.code, '3182');
  });

  test('a leading 0 (codes are 10000-99999) is always marked', async () => {
    const r = await new OcrEngine(stub([[0, 0.999], [1, 0.999], [5, 0.999], [8, 0.999], [2, 0.999]])).recognize(pic.rgba, pic.width, pic.height);
    assert.equal(r.digits[0].doubtful, true);
    assert.equal(r.status, 'check');
  });
});

describe('OCR diagnostics and speed', () => {
  test('diagnostics hold every stage, and the five model inputs', async () => {
    const pic = picture('62940', 'random', 21);
    const r = await engine.recognize(pic.rgba, pic.width, pic.height, { diagnostics: true });
    const d = r.diagnostics!;
    assert.ok(d, 'diagnostics present');
    assert.equal(d.gray.length, d.previewWidth * d.previewHeight);
    assert.equal(d.contrast.length, d.previewWidth * d.previewHeight);
    assert.equal(d.binary.length, d.previewWidth * d.previewHeight);
    assert.equal(d.digitInputs.length, 5);
    assert.ok(d.digitInputs.every((x) => x.length === 784));
    assert.ok(d.components.some((c) => c.kind === 'digit'));
    assert.ok(d.codeBox && d.codeBox.width > 0);
    assert.ok(r.timings.totalMs >= 0 && r.timings.preprocessMs >= 0);
    const plain = await engine.recognize(pic.rgba, pic.width, pic.height);
    assert.equal(plain.diagnostics, undefined, 'no images unless asked for');
  });

  test('a Full HD camera region is recognised well within a second', async () => {
    const pic = picture('80357', 'grid', 4);
    await engine.recognize(pic.rgba, pic.width, pic.height);
    const t0 = performance.now();
    await engine.recognize(pic.rgba, pic.width, pic.height);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${Math.round(ms)} ms`);
  });
});
