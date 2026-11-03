/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Downloads the public handwriting datasets used to TEST and TRAIN the OCR (never shipped with the
 * app, never committed) and checks their SHA-256:
 *
 * - MNIST (Y. LeCun, C. Cortes, C. J. C. Burges), CC BY-SA 3.0, from the PyTorch mirror
 * - Pen-Based Recognition of Handwritten Digits (E. Alpaydin, F. Alimoglu), UCI ML Repository,
 *   doi:10.24432/C5MG6K, CC BY 4.0; the .Z files are unpacked with `gzip -d` (Git Bash)
 *
 * Usage: node scripts/ocr/fetch-datasets.mjs <datasets dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: fetch-datasets.mjs <datasets dir>');
  process.exit(2);
}

const FILES = [
  ['mnist/train-images-idx3-ubyte.gz', 'https://ossci-datasets.s3.amazonaws.com/mnist/train-images-idx3-ubyte.gz', '440fcabf73cc546fa21475e81ea370265605f56be210a4024d2ca8f203523609'],
  ['mnist/train-labels-idx1-ubyte.gz', 'https://ossci-datasets.s3.amazonaws.com/mnist/train-labels-idx1-ubyte.gz', '3552534a0a558bbed6aed32b30c495cca23d567ec52cac8be1a0730e8010255c'],
  ['mnist/t10k-images-idx3-ubyte.gz', 'https://ossci-datasets.s3.amazonaws.com/mnist/t10k-images-idx3-ubyte.gz', '8d422c7b0a1c1c79245a5bcf07fe86e33eeafee792b84584aec276f5a2dbc4e6'],
  ['mnist/t10k-labels-idx1-ubyte.gz', 'https://ossci-datasets.s3.amazonaws.com/mnist/t10k-labels-idx1-ubyte.gz', 'f7ae60f92e00ec6debd23a6088c31dbd2371eca3ffa0defaefb259924204aec6'],
  ['pendigits/pendigits.zip', 'https://archive.ics.uci.edu/static/public/81/pen+based+recognition+of+handwritten+digits.zip', '1e02bea023613c2b11c9492f6f34caf975420455934f3527d270cee9a1f03b64'],
];

for (const [rel, url, sha] of FILES) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (got !== sha) throw new Error(`${rel}: SHA-256 ${got}, expected ${sha}`);
  console.log(`ok ${rel}`);
}
const pen = path.join(dir, 'pendigits');
execFileSync('tar', ['-xf', 'pendigits.zip'], { cwd: pen });
for (const part of ['tra', 'tes']) {
  fs.writeFileSync(path.join(pen, `pendigits-orig.${part}`), execFileSync('gzip', ['-dc', `pendigits-orig.${part}.Z`], { cwd: pen, maxBuffer: 64 * 1024 * 1024 }));
}
console.log('datasets ready in', dir);
