/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Loaders for the public handwriting datasets used to test the OCR (never shipped with the app):
 *
 * - MNIST (Y. LeCun, C. Cortes, C. Burges), CC BY-SA 3.0: 28x28 scanned digits.
 * - Pen-Based Recognition of Handwritten Digits, original version (E. Alpaydin, F. Alimoglu,
 *   Bogazici University, 1998; UCI ML Repository, doi:10.24432/C5MG6K), CC BY 4.0: pen
 *   trajectories of 44 writers; the test file holds 14 writers absent from the training file.
 *
 * `scripts/ocr/fetch-datasets.mjs` downloads both and checks their hashes.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface MnistSet {
  images: Uint8Array; // n x 784, 0 = background, 255 = ink
  labels: Uint8Array;
  count: number;
}

function readIdx(file: string): Buffer {
  const raw = fs.readFileSync(file);
  return file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
}

export function loadMnist(dir: string, part: 'train' | 'test'): MnistSet {
  const prefix = part === 'train' ? 'train' : 't10k';
  const img = readIdx(path.join(dir, `${prefix}-images-idx3-ubyte.gz`));
  const lab = readIdx(path.join(dir, `${prefix}-labels-idx1-ubyte.gz`));
  if (img.readUInt32BE(0) !== 2051 || lab.readUInt32BE(0) !== 2049) throw new Error('not an MNIST idx file');
  const count = img.readUInt32BE(4);
  return {
    images: new Uint8Array(img.buffer, img.byteOffset + 16, count * 784),
    labels: new Uint8Array(lab.buffer, lab.byteOffset + 8, count),
    count,
  };
}

/** One pen-written digit: strokes of (x, y) points, y pointing down, writer = block of ~250 samples. */
export interface PenDigit {
  label: number;
  strokes: Array<Array<[number, number]>>;
  writer: number;
  index: number;
}

/**
 * Parses pendigits-orig (UNIPEN). Tablet y points up and is flipped here. The files hold each
 * writer's samples consecutively (~250 per writer; the dataset does not store writer ids), so
 * `writer` is the sample's block of 250, which is what separates writers for train/validation.
 */
export function loadPenDigits(file: string): PenDigit[] {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out: PenDigit[] = [];
  let current: PenDigit | null = null;
  let stroke: Array<[number, number]> | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('.SEGMENT')) {
      const m = t.match(/"(\d)"/);
      current = { label: m ? Number(m[1]) : -1, strokes: [], writer: Math.floor(out.length / 250), index: out.length };
      out.push(current);
    } else if (t === '.PEN_DOWN') {
      stroke = [];
    } else if (t === '.PEN_UP') {
      if (current && stroke && stroke.length > 0) current.strokes.push(stroke);
      stroke = null;
    } else if (stroke && /^\d+\s+\d+$/.test(t)) {
      const [x, y] = t.split(/\s+/).map(Number);
      stroke.push([x, -y]);
    }
  }
  return out.filter((d) => d.label >= 0 && d.strokes.length > 0);
}
