/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The local ONNX digit model (onnxruntime-web, WASM, one thread; no network).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-web';

export const MODEL_FILE = 'handwriting-digits.onnx';

let session: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession | null> | null = null;
let fixedPath = '';
/** Whether the model takes a batch of digits in one run (dynamic first dimension). */
let batched: boolean | null = null;

/** Model path chosen by the main process (the OCR worker thread has no Electron APIs). */
export function setModelPath(file: string): void {
  fixedPath = file;
}

/** Local path of the model in development, in the packaged app (resources/models) and in tests. */
export function modelPath(): string {
  if (fixedPath) return fixedPath;
  let currentDir = '';
  try {
    if (typeof import.meta !== 'undefined' && import.meta.url) currentDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // bundled as CommonJS: import.meta is not available
  }
  const candidates = [
    path.join(process.cwd(), 'public', 'models', MODEL_FILE),
    path.join(process.cwd(), 'dist', 'models', MODEL_FILE),
    path.join((process as any).resourcesPath || '', 'models', MODEL_FILE),
    currentDir ? path.join(currentDir, '..', '..', '..', 'public', 'models', MODEL_FILE) : '',
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  return path.join(process.cwd(), 'public', 'models', MODEL_FILE);
}

export async function getSession(): Promise<ort.InferenceSession | null> {
  if (session) return session;
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      const file = modelPath();
      if (!fs.existsSync(file)) {
        console.warn(`[OCR] ONNX model not found at ${file}`);
        return null;
      }
      // Single-threaded WASM: no worker threads to spawn from inside the packaged app.
      ort.env.wasm.numThreads = 1;
      const buf = fs.readFileSync(file);
      // Pass exactly the file's bytes. Buffer.buffer is Node's shared allocation pool
      // (64 KB in Electron), so passing it made protobuf parsing of the model fail.
      session = await ort.InferenceSession.create(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      return session;
    } catch (err) {
      console.error('[OCR] Failed to initialize ONNX session:', err);
      return null;
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

/** Softmax probabilities of the ten digits for each 28x28 input (0 = paper, 1 = ink). */
export async function classifyDigits(inputs: Float32Array[]): Promise<Float32Array[]> {
  const s = await getSession();
  if (!s) throw new Error('ONNX InferenceSession ვერ ინიციალიზდა');
  const inputName = s.inputNames[0];
  const outputName = s.outputNames[0];
  if (!inputs.length) return [];
  // One run for all digits when the model allows it, else one run per digit.
  if (batched !== false && inputs.length > 1) {
    const data = new Float32Array(inputs.length * 784);
    inputs.forEach((input, i) => data.set(input, i * 784));
    try {
      const result = await s.run({ [inputName]: new ort.Tensor('float32', data, [inputs.length, 1, 28, 28]) });
      const logits = result[outputName].data as Float32Array;
      if (logits.length === inputs.length * 10) {
        batched = true;
        return inputs.map((_, i) => softmax(logits.subarray(i * 10, i * 10 + 10)));
      }
    } catch {
      // fixed batch size of 1
    }
    batched = false;
  }
  const out: Float32Array[] = [];
  for (const input of inputs) {
    const result = await s.run({ [inputName]: new ort.Tensor('float32', input, [1, 1, 28, 28]) });
    out.push(softmax(result[outputName].data as Float32Array));
  }
  return out;
}

function softmax(logits: Float32Array): Float32Array {
  let max = -Infinity;
  for (let i = 0; i < 10; i++) if (logits[i] > max) max = logits[i];
  const probs = new Float32Array(10);
  let sum = 0;
  for (let i = 0; i < 10; i++) { probs[i] = Math.exp(logits[i] - max); sum += probs[i]; }
  for (let i = 0; i < 10; i++) probs[i] /= sum || 1;
  return probs;
}
