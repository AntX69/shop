/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Finds the handwritten digits where they really are (no fixed cells):
 *
 * 1. ink components that cannot be digits are set aside: specks, very large blobs (a finger,
 *    a shadow edge), leftover line pieces;
 * 2. pieces of one digit are joined (a "5" whose flag was written separately, a "7" crossbar);
 * 3. the code line is the row of similar-height symbols side by side; other marks are ignored;
 * 4. the line must hold exactly five digits: cut-off and small marks are dropped and
 *    overlapping pieces joined when there are more; when there are fewer, symbols clearly wider
 *    than one digit (touching digits) get a split plan: candidate cuts along the emptiest,
 *    possibly slanted, paths, from which the engine keeps the combination the model reads best.
 *    If five cannot be made honestly, the code is rejected with the number of symbols actually
 *    found; a digit is never invented.
 */

import { componentStrokeWidths, type Component } from './imageOps.ts';
import type { OcrBox, OcrComponentKind, OcrRejectReason } from '../../shared/ocr.ts';

export const CODE_LENGTH = 5;

/** A cut between touching digits: the line x = x + (y - cy) * slope; cost = ink it crosses. */
export interface Cut {
  x: number;
  cy: number;
  slope: number;
  cost: number;
}

export interface DigitRegion {
  /** Component labels whose pixels make up the digit. */
  ids: number[];
  /** Only pixels right of `left` and left of `right` belong to it (digits cut apart). */
  left: Cut | null;
  right: Cut | null;
  box: OcrBox;
  split: boolean;
  /** Touches the edge of the region (may be cut off). */
  edge: boolean;
}

/**
 * Touching digits to be cut into `parts` digits: `cuts` are the candidate cuts (left to right)
 * and every part must be between `minWidth` and `maxWidth` pixels wide.
 */
export interface SplitPlan {
  ids: number[];
  box: OcrBox;
  edge: boolean;
  parts: number;
  cuts: Cut[];
  minWidth: number;
  maxWidth: number;
  xs: Int32Array;
  ys: Int32Array;
}

/**
 * One symbol of the code line: read as one digit, or (touching digits) cut into one of the part
 * counts in `options` with the cut candidates of `plan(parts)`.
 */
export interface LineSymbol {
  single: DigitRegion;
  options: number[];
  plan: (parts: number) => SplitPlan;
}

export interface SegmentResult {
  /** The code line left to right. The part counts chosen must add up to five digits. */
  line: LineSymbol[];
  /** Symbols found on the code line before joining/cutting. */
  found: number;
  reason?: OcrRejectReason;
  kinds: Map<number, OcrComponentKind>;
  digitHeight: number;
}

interface Group {
  ids: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  /** Touches the edge of the region: possibly cut off. */
  edge: boolean;
}

const gw = (g: { x0: number; x1: number }) => g.x1 - g.x0 + 1;
const gh = (g: { y0: number; y1: number }) => g.y1 - g.y0 + 1;
const gcy = (g: Group) => (g.y0 + g.y1) / 2;
const boxOf = (g: Group): OcrBox => ({ x: g.x0, y: g.y0, width: gw(g), height: gh(g) });

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function join(a: Group, b: Group): Group {
  return {
    ids: [...a.ids, ...b.ids],
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    area: a.area + b.area,
    edge: a.edge || b.edge,
  };
}

/**
 * Smallest digit height (pixels) that still holds enough detail to be read reliably. Smaller
 * writing is rejected with advice to move closer instead of being guessed.
 */
export const MIN_DIGIT_HEIGHT = 20;
/** A symbol is cut only into parts at least this many typical digit widths wide. */
const MIN_PART_WIDTH = 0.62;

export function segmentDigits(labels: Int32Array, components: Component[], width: number, height: number, strokeWidth: number): SegmentResult {
  const kinds = new Map<number, OcrComponentKind>();
  const total = width * height;
  const minArea = Math.max(6, Math.round(total * 1.5e-5));
  let groups: Group[] = [];
  // Pen strokes have about the same thickness; a mark far thicker than the typical stroke (the
  // dark edge of a desk around a label, a shadow band, a finger) is not writing.
  const thickness = componentStrokeWidths(labels, components, width, height);
  const sized = components.filter((c) => c.area >= minArea).map((c) => thickness[c.id - 1]).sort((a, b) => a - b);
  const typicalStroke = sized.length ? sized[Math.floor(sized.length / 2)] : 0;
  for (const c of components) {
    const w = gw(c);
    const h = gh(c);
    if (c.area < minArea || (w < 3 && h < 3)) { kinds.set(c.id, 'noise'); continue; }
    if (typicalStroke > 0 && thickness[c.id - 1] > Math.max(2.5 * typicalStroke, 8)) { kinds.set(c.id, 'large'); continue; }
    if (w > 0.6 * width || h > 0.9 * height || c.area > 0.12 * total) { kinds.set(c.id, 'large'); continue; }
    // Far flatter than any digit or code (a leftover line, a shadow edge).
    if ((w > 0.2 * width && h * 10 < w) || (w > 4 * MIN_DIGIT_HEIGHT && h * 6 < w)) { kinds.set(c.id, 'line'); continue; }
    const edge = c.x0 <= 1 || c.y0 <= 1 || c.x1 >= width - 2 || c.y1 >= height - 2;
    groups.push({ ids: [c.id], x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, area: c.area, edge });
  }
  const finish = (line: LineSymbol[], found: number, digitHeight: number, reason?: OcrRejectReason): SegmentResult => {
    for (const g of groups) for (const id of g.ids) if (!kinds.has(id)) kinds.set(id, g.edge ? 'border' : 'outside');
    return { line, found, reason, kinds, digitHeight };
  };
  if (!groups.length) return finish([], 0, 0, 'no_ink');

  // 1. Pieces of one digit: within the other's columns, vertically close, clearly smaller. A flat
  //    piece (a flag or crossbar) may stick out sideways; a speck next to a digit stays out of it.
  groups.sort((a, b) => b.area - a.area);
  for (let changed = true; changed;) {
    changed = false;
    search: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
        const flat = gh(b) <= 0.4 * gh(a);
        if (overlap < (flat ? 0.3 * gw(b) : 0.5 * Math.min(gw(a), gw(b)))) continue;
        const gap = Math.max(0, b.y0 - a.y1, a.y0 - b.y1);
        if (gap > 0.35 * Math.max(gh(a), gh(b))) continue;
        if (!(gh(b) <= 0.7 * gh(a) || b.area <= 0.3 * a.area)) continue;
        const inside = b.x0 >= a.x0 && b.x1 <= a.x1 && b.y0 >= a.y0 && b.y1 <= a.y1;
        if (b.area < 0.04 * a.area && !inside) continue;
        groups[i] = join(a, b);
        groups.splice(j, 1);
        changed = true;
        break search;
      }
    }
  }

  // 2. The code line: for every symbol, the symbols of similar height level with it; the
  //    neighbourhood that looks most like a five-digit code wins.
  // Reference height: the third tallest symbol (a code has five digits of similar height, so one
  // or two large non-digit marks do not hide the digits).
  const inner = groups.filter((g) => !g.edge);
  const heights = (inner.length ? inner : groups).map(gh).sort((a, b) => b - a);
  const refH = heights[Math.min(2, heights.length - 1)];
  const tall = groups.filter((g) => gh(g) >= Math.max(MIN_DIGIT_HEIGHT * 0.6, 0.3 * refH));
  let best: Group[] = [];
  let bestScore = -Infinity;
  for (const anchor of tall) {
    const members = tall
      .filter((g) => {
        const r = gh(g) / gh(anchor);
        return r >= 0.4 && r <= 2.5 && Math.abs(gcy(g) - gcy(anchor)) <= 0.45 * Math.max(gh(g), gh(anchor));
      })
      .sort((a, b) => a.x0 - b.x0);
    // Split the row where symbols are far apart (another word or a stray mark).
    const medH = median(members.map(gh));
    let run: Group[] = [];
    const runs: Group[][] = [];
    for (const g of members) {
      if (run.length && g.x0 - Math.max(...run.map((r) => r.x1)) > 1.6 * medH) { runs.push(run); run = []; }
      run.push(g);
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (!r.includes(anchor)) continue;
      const score = Math.min(r.length, CODE_LENGTH) * 10 - Math.max(0, r.length - CODE_LENGTH) * 6 + (8 * Math.min(1, median(r.map(gh)) / refH));
      if (score > bestScore) { bestScore = score; best = r; }
    }
  }
  let line = best;
  if (!line.length) return finish([], 0, 0, 'no_ink');
  const found = line.length;
  const digitHeight = median(line.map(gh));
  const markDigits = () => { for (const g of line) for (const id of g.ids) kinds.set(id, 'digit'); };
  if (digitHeight < MIN_DIGIT_HEIGHT) {
    // A row of small symbols with real ink is a code written too small; loose specks are nothing.
    if (line.length < 3 || median(line.map((g) => g.area)) < 20) return finish([], 0, 0, 'no_ink');
    markDigits();
    return finish([], found, digitHeight, 'too_small');
  }

  // 3a. Too many: drop cut-off marks at the ends and small marks, then join overlapping
  //     neighbours that fit in one digit.
  while (line.length > CODE_LENGTH && (line[0].edge || line[line.length - 1].edge)) {
    if (line[0].edge) line.shift();
    else line.pop();
  }
  if (line.length > CODE_LENGTH) {
    const medArea = median(line.map((g) => g.area));
    line = line.filter((g) => !(gh(g) < 0.5 * digitHeight && g.area < 0.35 * medArea));
  }
  while (line.length > CODE_LENGTH) {
    let at = -1;
    let bestJoin = -Infinity;
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k];
      const b = line[k + 1];
      const unionW = Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0) + 1;
      if (unionW > 1.05 * digitHeight) continue;
      const gap = b.x0 - a.x1 - 1;
      const score = -gap / digitHeight - (0.3 * unionW) / digitHeight;
      if (score > bestJoin) { bestJoin = score; at = k; }
    }
    if (at < 0) break;
    line.splice(at, 2, join(line[at], line[at + 1]));
  }
  if (line.length > CODE_LENGTH) {
    markDigits();
    return finish([], found, digitHeight, 'too_many');
  }

  // 3b. Too few: symbols clearly wider than one digit (touching digits) may hold several digits.
  //     Every symbol gets the part counts its width allows; the engine tries the combinations
  //     that make five and keeps the one the model reads best. A code that runs off the edge of
  //     the region is not "repaired".
  markDigits();
  const single = line.filter((g) => gw(g) / gh(g) >= 0.35 && gw(g) / gh(g) <= 0.95).map(gw);
  const typical = single.length ? median(single) : 0.62 * digitHeight;
  const extra = CODE_LENGTH - line.length;
  const options = line.map((g) => {
    const out = [1];
    for (let p = 2; p <= 1 + extra; p++) if (gw(g) / typical / p >= MIN_PART_WIDTH) out.push(p);
    return out;
  });
  if (extra > 0) {
    const lineTop = Math.min(...line.map((g) => g.y0));
    const lineBottom = Math.max(...line.map((g) => g.y1));
    // A digit cut off by the edge: an edge mark at the code's height, right next to its ends.
    const near = 1.5 * digitHeight;
    const offEdge = line.some((g) => g.edge) || groups.some((g) => g.edge && !line.includes(g)
      && g.y1 >= lineTop && g.y0 <= lineBottom && gh(g) >= 0.4 * digitHeight
      && g.x1 >= line[0].x0 - near && g.x0 <= line[line.length - 1].x1 + near);
    const reachable = options.reduce((a, o) => a + Math.max(...o), 0) >= CODE_LENGTH;
    if (offEdge || !reachable) return finish([], found, digitHeight, offEdge ? 'border' : 'too_few');
  }
  const out: LineSymbol[] = line.map((g, i) => ({
    single: { ids: g.ids, left: null, right: null, box: boxOf(g), split: false, edge: g.edge },
    options: options[i],
    plan: (parts: number) => splitPlan(g, parts, labels, width, strokeWidth, typical),
  }));
  return finish(out, found, digitHeight);
}

const SLOPES = [-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4];
/** Candidate cuts kept per symbol of touching digits. */
const MAX_CUTS = 10;

/** Whether pixel (x, y) is right of cut `c`. */
export function rightOf(c: Cut, x: number, y: number): boolean {
  return x - (y - c.cy) * c.slope >= c.x;
}

/**
 * Candidate cuts for touching digits: anywhere across the symbol, the (possibly slanted) lines
 * that cross the least ink (local minima of the sheared column profile), at most MAX_CUTS of the
 * cheapest, spaced apart. Which of them are used is decided by how well the model reads the parts.
 */
function splitPlan(g: Group, parts: number, labels: Int32Array, width: number, strokeWidth: number, typical: number): SplitPlan {
  const ids = new Set(g.ids);
  const xl: number[] = [];
  const yl: number[] = [];
  for (let y = g.y0; y <= g.y1; y++) {
    for (let x = g.x0; x <= g.x1; x++) {
      if (ids.has(labels[y * width + x])) { xl.push(x); yl.push(y); }
    }
  }
  const xs = Int32Array.from(xl);
  const ys = Int32Array.from(yl);
  const cy = (g.y0 + g.y1) / 2;
  const w = gw(g);
  const margin = Math.max(3, 0.25 * typical);
  const lo = Math.floor(g.x0 + margin);
  const hi = Math.ceil(g.x1 - margin);
  const all: Cut[] = [];
  if (hi > lo) {
    for (const slope of SLOPES) {
      const hist = new Float32Array(hi - lo + 3);
      for (let k = 0; k < xs.length; k++) {
        const xp = Math.round(xs[k] - (ys[k] - cy) * slope) - lo + 1;
        if (xp >= 0 && xp < hist.length) hist[xp]++;
      }
      const cost = new Float32Array(hist.length);
      for (let k = 1; k < hist.length - 1; k++) cost[k] = 0.5 * hist[k - 1] + hist[k] + 0.5 * hist[k + 1] + Math.abs(slope) * strokeWidth;
      for (let k = 2; k < hist.length - 2; k++) {
        if (cost[k] <= cost[k - 1] && cost[k] <= cost[k + 1]) all.push({ x: lo + k - 1, cy, slope, cost: cost[k] });
      }
    }
  }
  all.sort((a, b) => a.cost - b.cost);
  const kept: Cut[] = [];
  const spacing = Math.max(3, 0.12 * typical);
  for (const c of all) {
    if (kept.some((k) => Math.abs(k.x - c.x) < spacing)) continue;
    kept.push(c);
    if (kept.length >= MAX_CUTS) break;
  }
  // Always offer the even split too (digits written without any gap).
  for (let j = 1; j < parts; j++) {
    const x = g.x0 + (j * w) / parts;
    if (!kept.some((k) => Math.abs(k.x - x) < spacing)) kept.push({ x, cy, slope: 0, cost: 0.5 * strokeWidth * 4 });
  }
  kept.sort((a, b) => a.x - b.x);
  return { ids: g.ids, box: boxOf(g), edge: g.edge, parts, cuts: kept, minWidth: 0.3 * typical, maxWidth: 1.9 * typical, xs, ys };
}

/** The digits of a split plan for one cut per boundary; null if a part would hold almost no ink. */
export function splitRegions(plan: SplitPlan, cuts: Cut[]): DigitRegion[] | null {
  const regions: DigitRegion[] = [];
  for (let j = 0; j < plan.parts; j++) {
    const left = j > 0 ? cuts[j - 1] : null;
    const right = j < plan.parts - 1 ? cuts[j] : null;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
    for (let k = 0; k < plan.xs.length; k++) {
      const x = plan.xs[k];
      const y = plan.ys[k];
      if (left && !rightOf(left, x, y)) continue;
      if (right && rightOf(right, x, y)) continue;
      n++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (n < 0.08 * plan.xs.length) return null;
    regions.push({ ids: plan.ids, left, right, box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }, split: true, edge: plan.edge });
  }
  return regions;
}

/** Whether pixel (x, y) with label `l` belongs to `region`. */
export function inRegion(region: DigitRegion, idSet: Set<number>, l: number, x: number, y: number): boolean {
  if (!idSet.has(l)) return false;
  if (region.left && !rightOf(region.left, x, y)) return false;
  if (region.right && rightOf(region.right, x, y)) return false;
  return true;
}
