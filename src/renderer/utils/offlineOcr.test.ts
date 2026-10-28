import test from 'node:test';
import assert from 'node:assert/strict';
import { binarizeGrayscale, normalizeTo28x28, classifyNormalizedDigit, find5DigitBoxes } from './offlineOcr.ts';

test('binarizeGrayscale separates dark strokes from light background using Otsu threshold', () => {
  const width = 10;
  const height = 10;
  const pixels = new Uint8ClampedArray(width * height * 4);

  // Fill with white paper background (255)
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = 250;
    pixels[i * 4 + 1] = 250;
    pixels[i * 4 + 2] = 250;
    pixels[i * 4 + 3] = 255;
  }

  // Draw a dark vertical stroke (black ink = 20) down column 5
  for (let y = 1; y < 9; y++) {
    const idx = (y * width + 5) * 4;
    pixels[idx] = 20;
    pixels[idx + 1] = 20;
    pixels[idx + 2] = 20;
  }

  const binary = binarizeGrayscale(pixels, width, height);

  // Stroke pixel at (5, 5) must be 1 (ink)
  assert.equal(binary[5 * width + 5], 1);
  // Background pixel at (1, 1) must be 0 (paper)
  assert.equal(binary[1 * width + 1], 0);
});

test('find5DigitBoxes extracts 5 bounded slots across the image width', () => {
  const width = 100;
  const height = 30;
  const binary = new Uint8Array(width * height);

  // Draw 5 vertical lines representing 5 digits
  const xPositions = [10, 30, 50, 70, 90];
  for (const x of xPositions) {
    for (let y = 5; y < 25; y++) {
      binary[y * width + x] = 1;
    }
  }

  const boxes = find5DigitBoxes(binary, width, height);
  assert.equal(boxes.length, 5);
  for (const b of boxes) {
    assert.ok(b.width > 0);
    assert.ok(b.height > 0);
  }
});

test('classifyNormalizedDigit returns a valid digit from 0 to 9 with confidence score', () => {
  const digit28 = new Uint8Array(28 * 28);
  // Draw vertical bar for digit '1'
  for (let y = 4; y < 24; y++) {
    digit28[y * 28 + 14] = 1;
  }

  const res = classifyNormalizedDigit(digit28, { x: 10, y: 5, width: 6, height: 20 });
  assert.equal(typeof res.digit, 'number');
  assert.ok(res.digit >= 0 && res.digit <= 9);
  assert.ok(res.confidence >= 0 && res.confidence <= 100);
});
