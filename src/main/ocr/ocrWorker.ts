/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * OCR worker thread (bundled as dist-electron/ocrWorker.cjs): recognition runs here so neither
 * the window nor the main process (database, other IPC) waits for it.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { OcrEngine } from './engine.ts';
import { getSession, setModelPath } from './model.ts';
import type { OcrResult } from '../../shared/ocr.ts';

if (workerData?.modelPath) setModelPath(String(workerData.modelPath));
const engine = new OcrEngine();

interface Job {
  id: number;
  type: 'warmup' | 'recognize';
  pixels?: ArrayBuffer;
  width?: number;
  height?: number;
  diagnostics?: boolean;
}

function transferables(result: OcrResult): ArrayBuffer[] {
  const d = result.diagnostics;
  if (!d) return [];
  return [d.gray, d.contrast, d.binary, ...d.digitInputs].map((a) => a.buffer as ArrayBuffer);
}

parentPort?.on('message', async (job: Job) => {
  try {
    if (job.type === 'warmup') {
      parentPort!.postMessage({ id: job.id, ok: true, result: { ready: !!(await getSession()) } });
      return;
    }
    const result = await engine.recognize(new Uint8Array(job.pixels!), job.width!, job.height!, { diagnostics: !!job.diagnostics });
    parentPort!.postMessage({ id: job.id, ok: true, result }, transferables(result));
  } catch (err: any) {
    parentPort!.postMessage({ id: job.id, ok: false, error: String(err?.message || err) });
  }
});
