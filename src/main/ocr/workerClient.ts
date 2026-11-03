/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs OCR jobs on one worker thread, started on first use. A job that takes longer than the
 * timeout ends the worker (the next job starts a fresh one); a worker that crashes rejects its
 * jobs with an error. Without a configured worker script (tests, development server) or when the
 * thread cannot start, the same engine runs in this thread instead.
 */

import { Worker } from 'node:worker_threads';
import { OcrEngine } from './engine.ts';
import { getSession } from './model.ts';
import type { OcrResult } from '../../shared/ocr.ts';

const JOB_TIMEOUT_MS = 15000;
const WORKER_FAILED = 'OCR worker:';

let script = '';
let modelFile = '';
let worker: Worker | null = null;
let unavailable = false;
/** The worker has answered at least once (it loads and runs in this installation). */
let workerProven = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let local: OcrEngine | null = null;

/** Called by the Electron main process with the bundled worker script and the model file. */
export function configureOcrWorker(workerScript: string, modelPath: string): void {
  script = workerScript;
  modelFile = modelPath;
}

function failAll(message: string): void {
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.reject(new Error(message));
    pending.delete(id);
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (!script || unavailable) return null;
  try {
    const w = new Worker(script, { workerData: { modelPath: modelFile } });
    w.on('message', (msg: { id: number; ok: boolean; result?: any; error?: string }) => {
      workerProven = true;
      const job = pending.get(msg.id);
      if (!job) return;
      clearTimeout(job.timer);
      pending.delete(msg.id);
      if (msg.ok) job.resolve(msg.result);
      else job.reject(new Error(msg.error || 'OCR შეცდომა'));
    });
    w.on('error', (err) => {
      console.error('[OCR] worker error:', err);
      // A worker that never ran (cannot load here) is not tried again: OCR runs in this thread.
      if (!workerProven) unavailable = true;
      failAll(`${WORKER_FAILED} ${err?.message || err}`);
    });
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (pending.size) failAll(`OCR worker stopped (${code})`);
    });
    w.unref();
    worker = w;
    return w;
  } catch (err) {
    console.error('[OCR] worker thread could not start, recognising in the main process:', err);
    unavailable = true;
    return null;
  }
}

function run<T>(job: { type: 'warmup' | 'recognize'; pixels?: ArrayBuffer; width?: number; height?: number; diagnostics?: boolean }, transfer: ArrayBuffer[] = []): Promise<T> | null {
  const w = ensureWorker();
  if (!w) return null;
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('OCR-მა დროში ვერ დაასრულა. სცადეთ თავიდან.'));
      if (worker === w) worker = null;
      void w.terminate();
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, ...job }, transfer);
  });
}

/** Loads the model ahead of the first recognition (the camera dialog opening). */
export async function warmupOcr(): Promise<boolean> {
  const viaWorker = run<{ ready: boolean }>({ type: 'warmup' });
  if (viaWorker) {
    try {
      return (await viaWorker).ready;
    } catch (err: any) {
      if (!String(err?.message).startsWith(WORKER_FAILED) || !unavailable) throw err;
    }
  }
  return !!(await getSession());
}

export async function recognizeOcr(pixels: Uint8Array | number[], width: number, height: number, diagnostics: boolean): Promise<OcrResult> {
  // A private copy is handed over to the worker (the caller's buffer may be a view of a larger one).
  const copy = pixels instanceof Uint8Array ? new Uint8Array(pixels) : Uint8Array.from(pixels);
  // Until the worker has run once, keep a second copy to recognise here if it cannot load.
  const spare = script && !unavailable && !workerProven ? new Uint8Array(copy) : null;
  const viaWorker = run<OcrResult>({ type: 'recognize', pixels: copy.buffer, width, height, diagnostics }, [copy.buffer]);
  if (viaWorker) {
    try {
      return { ...(await viaWorker), ranOn: 'worker' };
    } catch (err: any) {
      // The thread cannot run in this installation: the same recognition in this thread.
      if (!spare || !unavailable || !String(err?.message).startsWith(WORKER_FAILED)) throw err;
    }
  }
  local ??= new OcrEngine();
  return { ...(await local.recognize(viaWorker ? spare! : copy, width, height, { diagnostics })), ranOn: 'main' };
}

/** Ends the worker (application exit). */
export function stopOcrWorker(): void {
  failAll('OCR stopped');
  void worker?.terminate();
  worker = null;
}
