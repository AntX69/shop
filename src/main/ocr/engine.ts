/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Offline recognition of a handwritten 5-digit code in a camera region:
 *
 *   luminance -> paper brightness (lighting correction) -> ink darkness -> hysteresis threshold
 *   -> notebook-line removal -> connected components -> code line and its five digits
 *   (segment.ts) -> MNIST normalisation (normalize.ts) -> ONNX model -> per-digit probability.
 *
 * Nothing depends on where in the region the code was written. A position the model is unsure
 * about is marked doubtful; one it cannot read is left empty for the seller; when five digits
 * cannot be found the result is a rejection with the reason, never a guessed code.
 */

import {
  connectedComponents,
  darkness,
  estimateBackground,
  hysteresis,
  luminance,
  previewPlane,
  quantile,
  removeRuledLines,
} from './imageOps.ts';
import { CODE_LENGTH, segmentDigits, splitRegions, type Cut, type DigitRegion, type LineSymbol, type SplitPlan } from './segment.ts';
import { maskToMnist, regionMask, strokeWidthOf } from './normalize.ts';
import { classifyDigits, MODEL_FILE } from './model.ts';
import type { OcrDiagnostics, OcrDigit, OcrRejectReason, OcrResult } from '../../shared/ocr.ts';

export interface DigitClassifier {
  readonly name: string;
  /** Ten probabilities per 28x28 input. */
  classify(inputs: Float32Array[]): Promise<Float32Array[]>;
}

export const onnxClassifier: DigitClassifier = { name: MODEL_FILE, classify: classifyDigits };

/**
 * Below this probability a digit is shown as doubtful. Chosen on the validation writers (never in
 * training or test): 0.98 leaves 0.7% of codes wrong without a mark (0.85 left 2.4%) at the cost
 * of asking the seller to check 15% of codes that were right (docs/release/RELEASE_READINESS.md).
 */
export const DOUBTFUL_BELOW = 0.98;
/** Below this probability a digit is not filled in at all: the seller types it. */
export const UNREADABLE_BELOW = 0.5;
/** Candidate cut combinations tried per symbol of touching digits (bounds the time). */
const MAX_CUT_COMBOS = 400;
/** Weight of the ink a cut crosses (in stroke widths) against the model's log-probabilities. */
const CUT_INK_WEIGHT = 0.1;

export const REJECT_MESSAGES: Record<OcrRejectReason, (found: number) => string> = {
  no_ink: () => 'ჩარჩოში ხელნაწერი კოდი ვერ მოიძებნა. მიიტანეთ ფურცელი ჩარჩოსთან და გადაიღეთ თავიდან.',
  low_contrast: () => 'კოდი ძალიან მკრთალად ჩანს. დაწერეთ მუქი კალმით ან გააუმჯობესეთ განათება და გადაიღეთ თავიდან.',
  too_few: (n) => `ჩარჩოში ${n} სიმბოლო ვიპოვე, საჭიროა 5. დაწერეთ ციფრები ცალ-ცალკე, ერთ ხაზზე, და გადაიღეთ თავიდან.`,
  too_many: (n) => `ჩარჩოში ${n} სიმბოლო ვიპოვე, საჭიროა 5. ჩარჩოში დატოვეთ მხოლოდ კოდი და გადაიღეთ თავიდან.`,
  too_small: () => 'ციფრები ძალიან პატარაა. მიიტანეთ ფურცელი კამერასთან ახლოს ან დაწერეთ უფრო მსხვილად.',
  border: () => 'კოდი ჩარჩოს კიდეს ეხება ან მის გარეთაა. მოათავსეთ მთელი კოდი ჩარჩოს შიგნით.',
};

export interface RecognizeOptions {
  diagnostics?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface InkMask {
  gray: Float32Array;
  /** Ink darkness 0-1 after lighting correction. */
  darkness: Float32Array;
  /** 1 = ink, after notebook-line removal. */
  mask: Uint8Array;
  low: number;
  high: number;
  ink: number;
  noise: number;
  ruledLinePixels: number;
}

/** Steps 1-2: lighting-corrected ink darkness and the ink mask without notebook lines. */
export function inkMask(rgba: ArrayLike<number>, width: number, height: number): InkMask {
  const gray = luminance(rgba, width, height);
  const block = clamp(Math.round(Math.min(width, height) / 16), 12, 48);
  const background = estimateBackground(gray, width, height, block);
  const d = darkness(gray, background);
  const median = quantile(d, 0.5);
  const deviation = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) deviation[i] = Math.abs(d[i] - median);
  const noise = 1.4826 * quantile(deviation, 0.5);
  // Darkest 0.1 %: the core of the pen strokes (they cover more than that of any code picture).
  const ink = quantile(d, 0.999);
  const high = clamp(0.5 * ink, 0.1, 0.3);
  const low = Math.max(0.45 * high, median + 4 * noise, 0.05);
  const mask = hysteresis(d, width, height, low, high);
  const maxThickness = Math.max(3, Math.round(Math.min(width, height) * 0.012));
  const ruledLinePixels = removeRuledLines(mask, width, height, maxThickness);
  return { gray, darkness: d, mask, low, high, ink, noise, ruledLinePixels };
}

export class OcrEngine {
  constructor(private readonly classifier: DigitClassifier = onnxClassifier) {}

  async recognize(rgba: ArrayLike<number>, width: number, height: number, options: RecognizeOptions = {}): Promise<OcrResult> {
    const t0 = performance.now();
    const { gray, darkness: d, mask, low, high, ink, noise, ruledLinePixels } = inkMask(rgba, width, height);
    const t1 = performance.now();

    // 3. Digits where they are.
    const { labels, components } = connectedComponents(mask, width, height);
    const strokeWidth = Math.max(1, strokeWidthOf(mask, width, height));
    const seg = segmentDigits(labels, components, width, height, strokeWidth);
    let reason = seg.reason;
    // Something is written but too faint to separate from the paper: say so (a blank sheet's
    // darkest pixels are paper texture and noise, well below this).
    if ((reason === 'no_ink' || reason === 'too_few') && ink >= 0.12 && ink < 0.2) reason = 'low_contrast';
    const toInput = (r: DigitRegion) => {
      const m = regionMask(labels, width, r);
      return maskToMnist(m.mask, m.width, m.height);
    };

    // 4. Model; touching digits are cut where the model reads the parts best (that search is
    //    timed as segmentation, the final reading of the five digits as classification).
    let regions: DigitRegion[] = [];
    let inputs: Float32Array[] = [];
    let probabilities: Float32Array[] = [];
    if (!reason) {
      const chosen = await this.readLine(seg.line, toInput, strokeWidth);
      if (chosen) {
        regions = chosen.regions;
        inputs = chosen.inputs;
      } else {
        reason = 'too_few';
      }
    }
    if (reason) {
      regions = [];
      inputs = [];
    }
    const t2 = performance.now();
    if (inputs.length) probabilities = await this.classifier.classify(inputs);
    const t3 = performance.now();

    const digits: OcrDigit[] = probabilities.map((probs, i) => {
      const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]);
      const p = probs[order[0]];
      const best = String(order[0]);
      // Codes run 10000-99999: a leading 0 is always a misreading. A digit at the edge of the
      // region may be cut off. A digit cut out of touching handwriting is always for the seller
      // to check: a wrong cut can still look like a confident digit to the model.
      const doubtful = p < DOUBTFUL_BELOW || (i === 0 && best === '0') || regions[i].edge || regions[i].split;
      return {
        digit: p < UNREADABLE_BELOW ? '' : best,
        confidence: Math.round(p * 100),
        doubtful,
        alternatives: order.slice(0, 3).map((k) => ({ digit: String(k), confidence: Math.round(probs[k] * 100) })),
        box: regions[i].box,
        split: regions[i].split,
      };
    });

    const isFiveDigits = digits.length === CODE_LENGTH && digits.every((x) => x.digit !== '');
    const status = reason ? 'rejected' : digits.some((x) => x.doubtful || !x.digit) ? 'check' : 'ok';
    const confidence = digits.length === CODE_LENGTH
      ? Math.round(100 * probabilities.reduce((acc, probs) => acc * Math.max(...probs), 1))
      : 0;
    const result: OcrResult = {
      status,
      reason,
      message: reason ? REJECT_MESSAGES[reason](seg.found) : undefined,
      code: digits.map((x) => x.digit).join(''),
      confidence,
      digits,
      isFiveDigits,
      found: seg.found,
      modelUsed: this.classifier.name,
      timings: {
        preprocessMs: Math.round(t1 - t0),
        segmentMs: Math.round(t2 - t1),
        classifyMs: Math.round(t3 - t2),
        totalMs: Math.round(performance.now() - t0),
      },
    };

    if (options.diagnostics) {
      const scale = Math.min(1, 720 / width, 360 / height);
      const inkScale = 255 / Math.max(0.05, ink);
      const diagnostics: OcrDiagnostics = {
        width,
        height,
        previewScale: scale,
        previewWidth: Math.max(1, Math.round(width * scale)),
        previewHeight: Math.max(1, Math.round(height * scale)),
        gray: previewPlane(gray, width, height, scale, (v) => v),
        contrast: previewPlane(d, width, height, scale, (v) => 255 - v * inkScale),
        binary: previewPlane(mask, width, height, scale, (v) => (v ? 255 : 0), 'max'),
        thresholds: { low: round3(low), high: round3(high), ink: round3(ink), noise: round3(noise) },
        components: components
          .filter((c) => seg.kinds.get(c.id) !== 'noise')
          .slice(0, 400)
          .map((c) => ({ box: { x: c.x0, y: c.y0, width: c.x1 - c.x0 + 1, height: c.y1 - c.y0 + 1 }, kind: seg.kinds.get(c.id) || 'outside' })),
        codeBox: regions.length ? unionBox(regions) : null,
        digitInputs: inputs.map((input) => Uint8Array.from(input, (v) => Math.round(v * 255))),
        strokeWidth: Math.round(strokeWidth * 10) / 10,
        digitHeight: Math.round(seg.digitHeight),
        ruledLinePixels,
      };
      result.diagnostics = diagnostics;
    }
    return result;
  }

  /**
   * Reads the code line as exactly five digits. With fewer symbols than five, some are touching
   * digits: every way of giving the symbols part counts that add up to five is tried, each
   * symbol cut where the model reads its parts best, and the reading with the highest total
   * log-probability wins. Null when no combination makes five digits.
   */
  private async readLine(line: LineSymbol[], toInput: (r: DigitRegion) => Float32Array, strokeWidth: number): Promise<{ regions: DigitRegion[]; inputs: Float32Array[] } | null> {
    const singleInputs = line.map((s) => toInput(s.single));
    if (line.length === CODE_LENGTH) return { regions: line.map((s) => s.single), inputs: singleInputs };
    const singleProbs = await this.classifier.classify(singleInputs);
    const cache = new Map<string, { regions: DigitRegion[]; inputs: Float32Array[]; score: number } | null>();
    const reading = async (i: number, parts: number) => {
      const key = `${i}:${parts}`;
      if (!cache.has(key)) {
        if (parts === 1) {
          cache.set(key, { regions: [line[i].single], inputs: [singleInputs[i]], score: Math.log(Math.max(1e-6, Math.max(...singleProbs[i]))) });
        } else {
          cache.set(key, await this.cutTouchingDigits(line[i].plan(parts), toInput, strokeWidth));
        }
      }
      return cache.get(key)!;
    };
    let best: { regions: DigitRegion[]; inputs: Float32Array[]; score: number } | null = null;
    const allocate = async (i: number, left: number, acc: { regions: DigitRegion[]; inputs: Float32Array[]; score: number }) => {
      if (i === line.length) {
        if (left === 0 && (!best || acc.score > best.score)) best = acc;
        return;
      }
      const after = line.length - i - 1; // every later symbol needs at least one digit
      for (const parts of line[i].options) {
        if (parts > left - after) continue;
        const r = await reading(i, parts);
        if (!r) continue;
        await allocate(i + 1, left - parts, { regions: [...acc.regions, ...r.regions], inputs: [...acc.inputs, ...r.inputs], score: acc.score + r.score });
      }
    };
    await allocate(0, CODE_LENGTH, { regions: [], inputs: [], score: 0 });
    return best;
  }

  /**
   * Chooses where to cut touching digits: left-to-right combinations of the candidate cuts that
   * give parts of plausible width are scored by how confidently the model reads the parts (sum
   * of log-probabilities) minus the ink the cuts cross. Each distinct part is normalised and
   * classified once, all in one model run.
   */
  private async cutTouchingDigits(plan: SplitPlan, toInput: (r: DigitRegion) => Float32Array, strokeWidth: number): Promise<{ regions: DigitRegion[]; inputs: Float32Array[]; score: number } | null> {
    const need = plan.parts - 1;
    const left = plan.box.x;
    const right = plan.box.x + plan.box.width - 1;
    const combos: Cut[][] = [];
    const pick = (from: number, chosen: Cut[], lastX: number) => {
      if (combos.length >= MAX_CUT_COMBOS) return;
      if (chosen.length === need) {
        const w = right - lastX;
        if (w >= plan.minWidth && w <= plan.maxWidth) combos.push(chosen);
        return;
      }
      for (let i = from; i < plan.cuts.length; i++) {
        const w = plan.cuts[i].x - lastX;
        if (w < plan.minWidth) continue;
        if (w > plan.maxWidth) break;
        pick(i + 1, [...chosen, plan.cuts[i]], plan.cuts[i].x);
      }
    };
    pick(0, [], left);
    const key = (c: Cut | null) => (c ? `${c.x},${c.slope}` : '-');
    const parts = new Map<string, { region: DigitRegion; input: Float32Array; score: number }>();
    const candidates: Array<{ cuts: Cut[]; regions: DigitRegion[] }> = [];
    for (const cuts of combos) {
      const regions = splitRegions(plan, cuts);
      if (!regions) continue;
      candidates.push({ cuts, regions });
      for (const r of regions) {
        const k = `${key(r.left)}|${key(r.right)}`;
        if (!parts.has(k)) parts.set(k, { region: r, input: toInput(r), score: 0 });
      }
    }
    if (!candidates.length) return null;
    const list = [...parts.values()];
    const probs = await this.classifier.classify(list.map((p) => p.input));
    list.forEach((p, i) => { p.score = Math.log(Math.max(1e-6, Math.max(...probs[i]))); });
    let best: { regions: DigitRegion[]; inputs: Float32Array[]; score: number } | null = null;
    for (const c of candidates) {
      let score = -CUT_INK_WEIGHT * c.cuts.reduce((a, cut) => a + cut.cost, 0) / strokeWidth;
      const chosen = c.regions.map((r) => parts.get(`${key(r.left)}|${key(r.right)}`)!);
      for (const p of chosen) score += p.score;
      if (!best || score > best.score) best = { regions: chosen.map((p) => p.region), inputs: chosen.map((p) => p.input), score };
    }
    return best;
  }
}

function unionBox(regions: DigitRegion[]) {
  const x0 = Math.min(...regions.map((r) => r.box.x));
  const y0 = Math.min(...regions.map((r) => r.box.y));
  const x1 = Math.max(...regions.map((r) => r.box.x + r.box.width));
  const y1 = Math.max(...regions.map((r) => r.box.y + r.box.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
