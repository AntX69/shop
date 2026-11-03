/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Simulated webcam pictures of a handwritten code, for OCR regression tests and benchmarks.
 *
 * The digits themselves are real handwriting (pen trajectories or scanned MNIST digits, see
 * datasets.ts); only the paper, pen, layout, lighting and camera are simulated: paper colour and
 * texture, ruled or squared notebook paper, black/blue pen or pencil and its thickness, digit
 * spacing (touching to wide), slant, rotation, position anywhere in the frame, uneven light and
 * shadow, low contrast, camera blur and sensor noise. This is NOT a substitute for real webcam
 * photos: it tests the pipeline against conditions we can describe, not ones we cannot foresee.
 */

import { Rng } from './rng.ts';
import type { PenDigit } from './datasets.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A digit shape in its own unit space: pen strokes or a coverage bitmap. */
export type Glyph =
  | { kind: 'pen'; label: number; strokes: Array<Array<[number, number]>>; width: number; height: number }
  | { kind: 'bitmap'; label: number; pixels: Float32Array; width: number; height: number };

export function penGlyph(d: PenDigit): Glyph {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of d.strokes) for (const [x, y] of s) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const strokes = d.strokes.map((s) => s.map(([x, y]) => [x - minX, y - minY] as [number, number]));
  return { kind: 'pen', label: d.label, strokes, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** MNIST digit cropped to its ink. */
export function bitmapGlyph(images: Uint8Array, index: number, label: number): Glyph {
  const base = index * 784;
  let minX = 28, minY = 28, maxX = -1, maxY = -1;
  for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
    if (images[base + y * 28 + x] > 40) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const pixels = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = images[base + (y + minY) * 28 + x + minX] / 255;
  return { kind: 'bitmap', label, pixels, width: w, height: h };
}

export interface Scene {
  width: number;
  height: number;
  /** Digits to draw; '' gives a blank sheet. */
  code: string;
  /** Glyph for each character of `code`. */
  glyphs: Glyph[];
  /** Digit height in pixels. */
  digitHeight: number;
  /** Code centre as a fraction of the frame. */
  centerX: number;
  centerY: number;
  /** Gap between digits as a fraction of the digit height (negative: overlapping). */
  gaps: number[];
  /** Horizontal shear (italic handwriting), e.g. 0.25. */
  slant: number;
  rotationDeg: number;
  /** Pen width as a fraction of the digit height. */
  strokeFrac: number;
  ink: [number, number, number];
  inkOpacity: number;
  paper: [number, number, number];
  ruling: 'plain' | 'ruled' | 'grid';
  rulingSpacing: number;
  rulingDarkness: number;
  /** Paper sheet smaller than the frame: fraction of the frame it covers, else 1. */
  sheet: Box | null;
  background: [number, number, number];
  /** Light: brightness gradient across the frame, vignetting, shadow strength (0 = none). */
  gradient: [number, number];
  vignette: number;
  shadow: number;
  shadowAngle: number;
  brightness: number;
  blurSigma: number;
  noiseSigma: number;
  /** Per-digit jitter, fractions of the digit height. */
  scaleJitter: number[];
  baselineJitter: number[];
  seed: number;
}

export interface RenderedScene {
  rgba: Uint8Array;
  width: number;
  height: number;
  code: string;
  /** Ink box of every drawn digit, in frame pixels, left to right. */
  digitBoxes: Box[];
}

/** Draws the scene; deterministic for a given scene. */
export function renderScene(scene: Scene): RenderedScene {
  const { width: W, height: H } = scene;
  const rng = new Rng(scene.seed ^ 0x5bd1e995);
  const cover = new Float32Array(W * H);
  const digitBoxes: Box[] = [];

  // Layout in "code space" (unrotated, origin at the code centre).
  const h = scene.digitHeight;
  const items = scene.glyphs.map((g, i) => {
    const s = (h * (1 + (scene.scaleJitter[i] || 0))) / g.height;
    return { g, s, w: g.width * s, hh: g.height * s, dy: (scene.baselineJitter[i] || 0) * h };
  });
  let total = 0;
  items.forEach((it, i) => { total += it.w + (i > 0 ? scene.gaps[i - 1] * h : 0); });
  const theta = (scene.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = scene.centerX * W;
  const cy = scene.centerY * H;
  const toFrame = (ux: number, uy: number): [number, number] => [cx + ux * cos - uy * sin, cy + ux * sin + uy * cos];
  const radius = Math.max(0.6, (scene.strokeFrac * h) / 2);

  let x0 = -total / 2;
  items.forEach((it, i) => {
    if (i > 0) x0 += scene.gaps[i - 1] * h;
    const top = -it.hh / 2 + it.dy;
    // Glyph point -> code space (slant around the glyph's vertical centre) -> frame.
    const map = (gx: number, gy: number): [number, number] => {
      const ux = x0 + gx * it.s + (it.hh / 2 - gy * it.s) * scene.slant;
      const uy = top + gy * it.s;
      return toFrame(ux, uy);
    };
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const grow = (x: number, y: number, r: number) => {
      bx0 = Math.min(bx0, x - r); by0 = Math.min(by0, y - r); bx1 = Math.max(bx1, x + r); by1 = Math.max(by1, y + r);
    };
    if (it.g.kind === 'pen') {
      const pressure = 0.85 + 0.15 * rng.next();
      for (const stroke of it.g.strokes) {
        const pts = stroke.map(([gx, gy]) => map(gx, gy));
        if (pts.length === 1) pts.push([pts[0][0] + 0.01, pts[0][1]]);
        for (let k = 1; k < pts.length; k++) {
          drawSegment(cover, W, H, pts[k - 1], pts[k], radius, pressure);
          grow(pts[k][0], pts[k][1], radius);
        }
        grow(pts[0][0], pts[0][1], radius);
      }
    } else {
      // Bitmap: inverse-map every frame pixel of the glyph's destination box.
      const g = it.g;
      const corners = [map(0, 0), map(g.width, 0), map(0, g.height), map(g.width, g.height)];
      const fx0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))) - 2);
      const fx1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))) + 2);
      const fy0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))) - 2);
      const fy1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))) + 2);
      for (let fy = fy0; fy <= fy1; fy++) {
        for (let fx = fx0; fx <= fx1; fx++) {
          // frame -> code space
          const dx = fx + 0.5 - cx;
          const dy = fy + 0.5 - cy;
          const ux = dx * cos + dy * sin;
          const uy = -dx * sin + dy * cos;
          const gy = (uy - top) / it.s;
          const gx = (ux - x0 - (it.hh / 2 - gy * it.s) * scene.slant) / it.s;
          const v = sampleBilinear(g.pixels, g.width, g.height, gx - 0.5, gy - 0.5);
          if (v > 0.02) {
            const a = smoothstep(0.15, 0.65, v);
            const idx = fy * W + fx;
            if (a > cover[idx]) cover[idx] = a;
            if (a > 0.3) grow(fx + 0.5, fy + 0.5, 0.5);
          }
        }
      }
    }
    if (Number.isFinite(bx0)) {
      digitBoxes.push({ x: Math.max(0, bx0), y: Math.max(0, by0), width: Math.min(W, bx1) - Math.max(0, bx0), height: Math.min(H, by1) - Math.max(0, by0) });
    }
    x0 += it.w;
  });

  // Paper, ruling, background, ink.
  const img = new Float32Array(W * H * 3);
  const sheet = scene.sheet;
  const texture = lowFrequencyNoise(W, H, rng, 0.025);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const onSheet = !sheet || (x >= sheet.x && x < sheet.x + sheet.width && y >= sheet.y && y < sheet.y + sheet.height);
      let r: number, g: number, b: number;
      if (onSheet) {
        const t = 1 + texture[i];
        r = scene.paper[0] * t; g = scene.paper[1] * t; b = scene.paper[2] * t;
        const rule = rulingCoverage(scene, x, y, cx, cy, cos, sin);
        if (rule > 0) {
          const d = rule * scene.rulingDarkness;
          // Light-blue/grey print: darkens red and green more than blue.
          r *= 1 - d * 1.1; g *= 1 - d * 0.85; b *= 1 - d * 0.45;
        }
      } else {
        const t = 1 + texture[i] * 2;
        r = scene.background[0] * t; g = scene.background[1] * t; b = scene.background[2] * t;
      }
      const a = onSheet ? cover[i] * scene.inkOpacity : 0;
      img[i * 3] = r * (1 - a) + scene.ink[0] * a;
      img[i * 3 + 1] = g * (1 - a) + scene.ink[1] * a;
      img[i * 3 + 2] = b * (1 - a) + scene.ink[2] * a;
    }
  }

  // Light: gradient, vignetting and a soft shadow edge.
  const sa = (scene.shadowAngle * Math.PI) / 180;
  const sx = Math.cos(sa);
  const sy = Math.sin(sa);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W - 0.5;
      const v = y / H - 0.5;
      let light = scene.brightness * (1 + scene.gradient[0] * u + scene.gradient[1] * v);
      light *= 1 - scene.vignette * (u * u + v * v) * 2;
      if (scene.shadow > 0) {
        const s = (u * sx + v * sy) * 6; // soft edge through the centre
        light *= 1 - scene.shadow / (1 + Math.exp(-s));
      }
      const i = (y * W + x) * 3;
      img[i] *= light; img[i + 1] *= light; img[i + 2] *= light;
    }
  }

  if (scene.blurSigma > 0.2) gaussianBlur3(img, W, H, scene.blurSigma);

  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) {
      const v = img[i * 3 + c] + rng.normal() * scene.noiseSigma;
      rgba[i * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    rgba[i * 4 + 3] = 255;
  }
  return { rgba, width: W, height: H, code: scene.code, digitBoxes };
}

function smoothstep(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function sampleBilinear(p: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < -1 || y < -1 || x > w || y > h) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : p[yy * w + xx]);
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/** Anti-aliased round-capped pen segment. */
function drawSegment(cover: Float32Array, W: number, H: number, a: [number, number], b: [number, number], r: number, pressure: number): void {
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r - 1));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0]) + r + 1));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r - 1));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1]) + r + 1));
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-6;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5 - a[0];
      const py = y + 0.5 - a[1];
      const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
      const ex = px - t * dx;
      const ey = py - t * dy;
      const d = Math.sqrt(ex * ex + ey * ey);
      const c = Math.min(1, Math.max(0, r + 0.5 - d)) * pressure;
      const i = y * W + x;
      if (c > cover[i]) cover[i] = c;
    }
  }
}

function rulingCoverage(scene: Scene, x: number, y: number, cx: number, cy: number, cos: number, sin: number): number {
  if (scene.ruling === 'plain') return 0;
  // Ruling follows the paper (rotated with the code).
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  const s = scene.rulingSpacing;
  const line = (t: number) => {
    const m = ((t % s) + s) % s;
    const d = Math.min(m, s - m);
    return Math.min(1, Math.max(0, 1.2 - d));
  };
  // Lines sit half a spacing below/above the code centre so the code is written between/on them.
  let c = line(v + s * 0.5 - scene.digitHeight * 0.55);
  if (scene.ruling === 'grid') c = Math.max(c, line(u + s * 0.3));
  return c;
}

function lowFrequencyNoise(W: number, H: number, rng: Rng, amp: number): Float32Array {
  const gw = 12;
  const gh = 6;
  const grid = new Float32Array((gw + 1) * (gh + 1)).map(() => (rng.next() * 2 - 1) * amp);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const gy = (y / H) * gh;
    const y0 = Math.min(gh - 1, Math.floor(gy));
    const fy = gy - y0;
    for (let x = 0; x < W; x++) {
      const gx = (x / W) * gw;
      const x0 = Math.min(gw - 1, Math.floor(gx));
      const fx = gx - x0;
      const a = grid[y0 * (gw + 1) + x0] * (1 - fx) + grid[y0 * (gw + 1) + x0 + 1] * fx;
      const b = grid[(y0 + 1) * (gw + 1) + x0] * (1 - fx) + grid[(y0 + 1) * (gw + 1) + x0 + 1] * fx;
      out[y * W + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

function gaussianBlur3(img: Float32Array, W: number, H: number, sigma: number): void {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(img.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const xx = Math.min(W - 1, Math.max(0, x + i));
          acc += img[(y * W + xx) * 3 + c] * k[i + r];
        }
        tmp[(y * W + x) * 3 + c] = acc;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) {
          const yy = Math.min(H - 1, Math.max(0, y + i));
          acc += tmp[(yy * W + x) * 3 + c] * k[i + r];
        }
        img[(y * W + x) * 3 + c] = acc;
      }
    }
  }
}

/** Glyph pools per digit, used to draw codes in one writer's hand where possible. */
export class GlyphBank {
  private byWriter = new Map<number, Glyph[][]>();
  private byDigit: Glyph[][] = Array.from({ length: 10 }, () => []);

  add(writer: number, g: Glyph): void {
    if (!this.byWriter.has(writer)) this.byWriter.set(writer, Array.from({ length: 10 }, () => []));
    this.byWriter.get(writer)![g.label].push(g);
    this.byDigit[g.label].push(g);
  }

  get writers(): number[] {
    return [...this.byWriter.keys()];
  }

  /** Glyphs for `code`, from one writer when that writer has every digit. */
  pick(code: string, rng: Rng): Glyph[] {
    const writers = this.writers;
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = this.byWriter.get(rng.pick(writers))!;
      if ([...code].every((c) => w[Number(c)].length > 0)) return [...code].map((c) => rng.pick(w[Number(c)]));
    }
    return [...code].map((c) => rng.pick(this.byDigit[Number(c)]));
  }
}

export type Condition =
  | 'random' | 'center' | 'left' | 'right' | 'top' | 'bottom' | 'user-case' | 'wide-spacing' | 'tight-spacing'
  | 'touching' | 'overlapping' | 'slanted' | 'rotated' | 'ruled' | 'grid' | 'uneven-light' | 'shadow' | 'low-contrast' | 'blue-pen'
  | 'thick-marker' | 'thin-pen' | 'small' | 'blurry' | 'label-on-desk';

export interface SceneOptions {
  width?: number;
  height?: number;
  code?: string;
  condition?: Condition;
  /** Digit height as a fraction of the frame height, overriding the condition's range. */
  digitHeightRange?: [number, number];
}

/** Random 5-digit store code (10000-99999). */
export function randomCode(rng: Rng): string {
  return String(rng.int(10000, 99999));
}

/**
 * A scene drawn from realistic ranges; `condition` pushes one factor to the hard end so it can
 * be tested on its own. Default frame: the camera region StorePOS reads from a 1920x1080 frame.
 */
export function makeScene(bank: GlyphBank, rng: Rng, opts: SceneOptions = {}): Scene {
  const W = opts.width ?? 1690;
  const H = opts.height ?? 565;
  const cond = opts.condition ?? 'random';
  const code = opts.code ?? randomCode(rng);
  const glyphs = code ? bank.pick(code, rng) : [];
  const n = code.length;

  let digitHeight = H * rng.uniform(0.14, 0.4);
  if (cond === 'small') digitHeight = rng.uniform(26, 34);
  let gapRange: [number, number] = [0.08, 0.45];
  if (cond === 'wide-spacing') gapRange = [0.6, 1.0];
  if (cond === 'tight-spacing') gapRange = [0.0, 0.08];
  // Touching: stroke ends meet a neighbour; overlapping: digits cross into each other (stress test).
  if (cond === 'touching') gapRange = [-0.07, -0.01];
  if (cond === 'overlapping') gapRange = [-0.15, -0.07];
  const gaps = Array.from({ length: Math.max(0, n - 1) }, () => rng.uniform(gapRange[0], gapRange[1]));
  let slant = rng.normal() * 0.08;
  if (cond === 'slanted') slant = rng.pick([-1, 1]) * rng.uniform(0.25, 0.4);
  let rotationDeg = rng.normal() * 2.5;
  if (cond === 'rotated') rotationDeg = rng.pick([-1, 1]) * rng.uniform(7, 11);

  // Approximate code width to keep it inside the frame.
  const avgAspect = glyphs.length ? glyphs.reduce((a, g) => a + g.width / g.height, 0) / glyphs.length : 0.6;
  const codeW = digitHeight * (avgAspect * n + gaps.reduce((a, b) => a + b, 0)) + digitHeight * Math.abs(slant);
  const marginX = Math.min(0.45, (codeW / 2 + digitHeight * 0.3) / W);
  const marginY = Math.min(0.45, (digitHeight * 0.75) / H);
  const span = (lo: number, hi: number) => (lo < hi ? rng.uniform(lo, hi) : (lo + hi) / 2);
  let centerX = span(marginX, 1 - marginX);
  let centerY = span(marginY, 1 - marginY);
  if (cond === 'center') { centerX = 0.5; centerY = 0.5; }
  if (cond === 'left') centerX = marginX + 0.01;
  if (cond === 'right') centerX = 1 - marginX - 0.01;
  if (cond === 'top') centerY = marginY + 0.01;
  if (cond === 'bottom') centerY = 1 - marginY - 0.01;
  if (cond === 'user-case') {
    // The reported case: a compact code across the 2nd-3rd fifths of the frame.
    digitHeight = H * rng.uniform(0.22, 0.32);
    for (let i = 0; i < gaps.length; i++) gaps[i] = rng.uniform(0.02, 0.18);
    const w = digitHeight * (avgAspect * n + gaps.reduce((a, b) => a + b, 0));
    centerX = Math.max(w / 2 / W + 0.02, rng.uniform(0.33, 0.45));
    centerY = rng.uniform(0.42, 0.58);
  }

  if (opts.digitHeightRange) {
    const old = digitHeight;
    digitHeight = H * rng.uniform(opts.digitHeightRange[0], opts.digitHeightRange[1]);
    // Keep the code inside the frame at its new size.
    const w = (codeW * digitHeight) / old;
    const mx = Math.min(0.45, (w / 2 + digitHeight * 0.2) / W);
    const my = Math.min(0.45, (digitHeight * 0.6) / H);
    centerX = Math.min(1 - mx, Math.max(mx, centerX));
    centerY = Math.min(1 - my, Math.max(my, centerY));
  }

  let strokeFrac = rng.uniform(0.035, 0.09);
  if (cond === 'thick-marker') strokeFrac = rng.uniform(0.14, 0.2);
  if (cond === 'thin-pen') strokeFrac = rng.uniform(0.022, 0.03);
  const pens: Array<[number, number, number]> = [[25, 25, 32], [28, 45, 140], [22, 30, 95]];
  let ink = rng.pick(pens);
  if (cond === 'blue-pen') ink = [45, 70, 170];
  let inkOpacity = rng.uniform(0.82, 1);
  const paperBase = rng.uniform(215, 248);
  let paper: [number, number, number] = rng.chance(0.15)
    ? [paperBase, paperBase * 0.97, paperBase * 0.78] // yellowish note
    : [paperBase, paperBase * rng.uniform(0.98, 1), paperBase * rng.uniform(0.95, 1)];
  let brightness = rng.uniform(0.75, 1.05);
  if (cond === 'low-contrast') {
    // Faint pencil-like ink in dim light.
    ink = [120, 120, 128];
    inkOpacity = rng.uniform(0.55, 0.7);
    brightness = rng.uniform(0.5, 0.65);
  }
  let ruling: Scene['ruling'] = rng.chance(0.15) ? 'ruled' : rng.chance(0.12) ? 'grid' : 'plain';
  if (cond === 'ruled') ruling = 'ruled';
  if (cond === 'grid') ruling = 'grid';
  const rulingSpacing = ruling === 'grid' ? digitHeight * rng.uniform(0.55, 0.85) : digitHeight * rng.uniform(1.25, 1.7);
  const rulingDarkness = rng.uniform(0.15, 0.35);

  let gradient: [number, number] = [rng.normal() * 0.12, rng.normal() * 0.12];
  let vignette = rng.uniform(0, 0.25);
  let shadow = rng.chance(0.1) ? rng.uniform(0.1, 0.3) : 0;
  if (cond === 'uneven-light') { gradient = [rng.pick([-1, 1]) * rng.uniform(0.45, 0.6), rng.normal() * 0.2]; vignette = rng.uniform(0.3, 0.45); }
  if (cond === 'shadow') shadow = rng.uniform(0.35, 0.5);

  let blurSigma = rng.uniform(0.5, 1.4);
  if (cond === 'blurry') blurSigma = rng.uniform(1.8, 2.3);
  const noiseSigma = rng.uniform(1.5, 5);

  let sheet: Box | null = null;
  if (cond === 'label-on-desk') {
    const sw = Math.min(W - 20, codeW + digitHeight * rng.uniform(0.8, 1.6));
    const sh = Math.min(H - 20, digitHeight * rng.uniform(1.8, 2.6));
    sheet = { x: centerX * W - sw / 2, y: centerY * H - sh / 2, width: sw, height: sh };
    rotationDeg = rng.normal() * 1.5;
  }

  return {
    width: W, height: H, code, glyphs, digitHeight, centerX, centerY, gaps, slant, rotationDeg, strokeFrac,
    ink, inkOpacity, paper, ruling, rulingSpacing, rulingDarkness, sheet,
    background: [rng.uniform(60, 140), rng.uniform(50, 120), rng.uniform(40, 100)],
    gradient, vignette, shadow, shadowAngle: rng.uniform(0, 360), brightness, blurSigma, noiseSigma,
    scaleJitter: Array.from({ length: n }, () => rng.normal() * 0.07),
    baselineJitter: Array.from({ length: n }, () => rng.normal() * 0.04),
    seed: Math.floor(rng.next() * 2 ** 31),
  };
}
