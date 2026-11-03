/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Handwritten 5-digit code recognition: result and diagnostics shared by the main process
 * (src/main/ocr) and the camera dialog.
 */

export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * ok       five digits, none doubtful
 * check    five positions found, at least one doubtful or unreadable (left empty for the seller)
 * rejected no usable code (nothing written, not exactly five symbols, too small/faint, ...)
 */
export type OcrStatus = 'ok' | 'check' | 'rejected';

export type OcrRejectReason = 'no_ink' | 'low_contrast' | 'too_few' | 'too_many' | 'too_small' | 'border';

export interface OcrDigit {
  /** '' when the symbol could not be read reliably: the seller types it. */
  digit: string;
  /** Model probability of `digit` (or of the best guess when `digit` is ''), 0-100. */
  confidence: number;
  /** Shown to the seller as "check this digit". */
  doubtful: boolean;
  /** Best guesses, most likely first (diagnostics). */
  alternatives: Array<{ digit: string; confidence: number }>;
  /** Where the digit is, in the pixels of the image that was recognised. */
  box: OcrBox;
  /** The digit was cut out of touching handwriting. */
  split: boolean;
}

export interface OcrTimings {
  preprocessMs: number;
  segmentMs: number;
  classifyMs: number;
  totalMs: number;
}

export type OcrComponentKind = 'digit' | 'noise' | 'border' | 'large' | 'line' | 'outside';

export interface OcrDiagnostics {
  width: number;
  height: number;
  /** Preview images: the recognised region scaled by `previewScale` (grey 0-255 per pixel). */
  previewWidth: number;
  previewHeight: number;
  previewScale: number;
  gray: Uint8Array;
  /** Ink darkness after lighting correction (255 = darkest). */
  contrast: Uint8Array;
  /** Pixels taken as ink (255), after noise and ruled-line removal. */
  binary: Uint8Array;
  thresholds: { low: number; high: number; ink: number; noise: number };
  components: Array<{ box: OcrBox; kind: OcrComponentKind }>;
  codeBox: OcrBox | null;
  /** Exactly what the model received for each digit: 28x28, 0-255. */
  digitInputs: Uint8Array[];
  strokeWidth: number;
  digitHeight: number;
  ruledLinePixels: number;
}

export interface OcrResult {
  status: OcrStatus;
  reason?: OcrRejectReason;
  /** Plain-language explanation for the seller when status is not 'ok'. */
  message?: string;
  /** Recognised digits joined ('' positions omitted); five digits only when isFiveDigits. */
  code: string;
  /** Probability that the whole code is right (product of the five digits), 0-100. */
  confidence: number;
  digits: OcrDigit[];
  isFiveDigits: boolean;
  /** Number of symbols found on the line (diagnostics, also used in messages). */
  found: number;
  modelUsed: string;
  /** Where the recognition ran: the OCR worker thread, or the main process (fallback, tests). */
  ranOn?: 'worker' | 'main';
  timings: OcrTimings;
  diagnostics?: OcrDiagnostics;
}
