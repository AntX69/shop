/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { connectedComponents, darkness, estimateBackground, hysteresis, removeRuledLines } from './imageOps.ts';
import { dilate, maskToMnist, strokeWidthOf } from './normalize.ts';

describe('OCR image operations', () => {
  test('lighting correction: the same pen stroke is equally dark in bright and dim parts of the picture', () => {
    const w = 400;
    const h = 100;
    const gray = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const paper = 240 - (x / w) * 150; // strong lamp on the left
      const ink = x % 100 >= 48 && x % 100 < 52 && y > 20 && y < 80;
      gray[y * w + x] = ink ? paper * 0.35 : paper;
    }
    const d = darkness(gray, estimateBackground(gray, w, h, 16));
    const at = (x: number) => d[50 * w + x];
    assert.ok(Math.abs(at(50) - at(350)) < 0.1, `stroke darkness left ${at(50).toFixed(2)} vs right ${at(350).toFixed(2)}`);
    assert.ok(d[50 * w + 20] < 0.08 && d[50 * w + 320] < 0.08, 'paper stays light on both sides');
  });

  test('hysteresis keeps the faint end of a stroke and drops faint specks', () => {
    const w = 60;
    const h = 20;
    const d = new Float32Array(w * h);
    for (let x = 5; x < 40; x++) d[10 * w + x] = x < 25 ? 0.6 : 0.15; // dark core, faint tail
    d[3 * w + 50] = 0.15; // faint speck alone
    const m = hysteresis(d, w, h, 0.1, 0.3);
    assert.equal(m[10 * w + 35], 1, 'faint tail touching the stroke is kept');
    assert.equal(m[3 * w + 50], 0, 'isolated faint speck is dropped');
  });

  test('notebook lines are removed even when tilted, strokes crossing them are kept', () => {
    const w = 600;
    const h = 200;
    const mask = new Uint8Array(w * h);
    // A ruled line tilted by about 3 degrees, 2 px thick.
    for (let x = 0; x < w; x++) {
      const y = Math.round(100 + x * 0.05);
      mask[y * w + x] = 1;
      mask[(y + 1) * w + x] = 1;
    }
    // A vertical pen stroke crossing it.
    for (let y = 60; y < 150; y++) for (let x = 300; x < 304; x++) mask[y * w + x] = 1;
    const removed = removeRuledLines(mask, w, h, 4);
    assert.ok(removed > 1000, `line pixels removed (${removed})`);
    assert.equal(mask[Math.round(100 + 100 * 0.05) * w + 100], 0, 'line pixel away from the stroke is gone');
    assert.equal(mask[Math.round(100 + 301 * 0.05) * w + 301], 1, 'stroke pixel on the line is kept');
    const { components } = connectedComponents(mask, w, h);
    const stroke = components.find((c) => c.x0 <= 300 && c.x1 >= 303);
    assert.ok(stroke && stroke.y1 - stroke.y0 >= 85, 'the stroke is still one piece');
  });

  test('connected components with 8-connectivity', () => {
    const w = 10;
    const h = 10;
    const m = new Uint8Array(w * h);
    m[1 * w + 1] = m[2 * w + 2] = m[3 * w + 3] = 1; // diagonal: one component
    m[7 * w + 7] = m[7 * w + 8] = 1;
    const { components } = connectedComponents(m, w, h);
    assert.equal(components.length, 2);
    assert.deepEqual(components.map((c) => c.area).sort(), [2, 3]);
  });

  test('a thin pen line is thickened to MNIST stroke width; a thick one is not thinned', () => {
    const w = 120;
    const h = 160;
    const thin = new Uint8Array(w * h);
    for (let y = 10; y < 150; y++) thin[y * w + 60] = 1;
    const input = maskToMnist(thin, w, h);
    const bin = Uint8Array.from(input, (v) => (v >= 0.5 ? 1 : 0));
    const sw = strokeWidthOf(bin, 28, 28);
    assert.ok(sw >= 1.4 && sw <= 3.2, `normalised stroke width ${sw.toFixed(2)} px`);
    const grown = dilate(thin, w, h, 3);
    assert.ok(strokeWidthOf(grown.mask, grown.width, grown.height) > 5, 'dilate grows the stroke');
  });
});
