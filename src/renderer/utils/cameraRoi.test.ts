/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { frameInVideo, OCR_FRAME } from './cameraRoi.ts';

test('the recognised area is exactly the green frame: 16:9 camera in the wide preview box', () => {
  // Preview 620x240 (camera dialog at full width), Full HD camera: the video is scaled to the box
  // width (0.3229) and its top and bottom are cut off.
  const roi = frameInVideo({ width: 620, height: 240 }, { width: 1920, height: 1080 });
  const scale = 620 / 1920;
  const hiddenTop = (1080 * scale - 240) / 2;
  assert.equal(roi.x, Math.round((OCR_FRAME.left * 620) / scale));
  assert.equal(roi.y, Math.round((OCR_FRAME.top * 240 + hiddenTop) / scale));
  assert.equal(roi.width, Math.round((OCR_FRAME.width * 620) / scale));
  assert.equal(roi.height, Math.round((OCR_FRAME.height * 240) / scale));
  // Inside the visible part of the picture.
  assert.ok(roi.y >= hiddenTop / scale - 1 && roi.y + roi.height <= (hiddenTop + 240) / scale + 1);
});

test('4:3 camera and a narrow window: same frame, still inside the picture', () => {
  for (const box of [{ width: 620, height: 240 }, { width: 360, height: 176 }, { width: 480, height: 224 }]) {
    for (const video of [{ width: 640, height: 480 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
      const roi = frameInVideo(box, video);
      assert.ok(roi.x >= 0 && roi.y >= 0 && roi.x + roi.width <= video.width && roi.y + roi.height <= video.height, JSON.stringify({ box, video, roi }));
      // The frame covers the same share of what the seller sees, whatever the aspect ratios.
      const scale = Math.max(box.width / video.width, box.height / video.height);
      assert.ok(Math.abs(roi.width * scale - OCR_FRAME.width * box.width) <= 1.5);
      assert.ok(Math.abs(roi.height * scale - OCR_FRAME.height * box.height) <= 1.5);
    }
  }
});
