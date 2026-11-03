/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveOcrSample } from './samples.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)]);

test('an OCR sample is saved only into the folder the seller chose, with the true code in the name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storepos-ocr-sample-'));
  let asked = 0;
  const choose = async () => { asked++; return dir; };
  const saved = await saveOcrSample({ regionPng: PNG, diagnosticPng: PNG, report: '{"code":"12345"}', expectedCode: '12345' }, choose);
  assert.ok(saved);
  assert.equal(saved.files.length, 3);
  assert.ok(saved.files.every((f) => path.dirname(f) === dir && fs.existsSync(f)));
  assert.match(path.basename(saved.files[0]), /^ocr-12345-\d{8}-\d{6}-\d{3}\.png$/);
  await saveOcrSample({ regionPng: PNG, report: '{}' }, choose);
  assert.equal(asked, 1, 'the folder is asked once per session');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('ocr-unknown-')).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an OCR sample is refused unless it is a PNG, a JSON report and a 5-digit true code', async () => {
  const choose = async () => os.tmpdir();
  await assert.rejects(saveOcrSample({ regionPng: new Uint8Array(40), report: '{}' }, choose), /PNG/);
  await assert.rejects(saveOcrSample({ regionPng: 'C:/Windows/x.png', report: '{}' }, choose), /არასწორია/);
  await assert.rejects(saveOcrSample({ regionPng: PNG, report: 'not json' }, choose));
  await assert.rejects(saveOcrSample({ regionPng: PNG, report: '{}', expectedCode: '12a45' }, choose), /5 ციფრი/);
  assert.equal(await saveOcrSample({ regionPng: PNG, report: '{}', changeFolder: true }, async () => null), null, 'cancelled folder choice saves nothing');
});
