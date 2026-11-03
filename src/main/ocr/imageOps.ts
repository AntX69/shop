/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Image operations for handwritten-code OCR, on plain typed arrays (no native dependencies):
 * luminance, paper-brightness estimation (lighting correction), hysteresis thresholding,
 * ruled-line removal and connected components.
 */

/** BT.601 luminance 0-255; transparent pixels count as white paper. */
export function luminance(rgba: ArrayLike<number>, width: number, height: number): Float32Array {
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    const a = rgba[j + 3];
    out[i] = a === 255 ? y : (y * a + 255 * (255 - a)) / 255;
  }
  return out;
}

/**
 * Paper brightness at every pixel. Pen strokes are narrower than a block, so a block's maximum is
 * the paper around them; a block that is all ink (thick marker) takes its brighter neighbours'
 * value. The block grid is smoothed and interpolated bilinearly, which follows gradual light
 * changes (vignetting, a lamp to one side, a soft shadow).
 */
export function estimateBackground(gray: Float32Array, width: number, height: number, block: number): Float32Array {
  const bw = Math.ceil(width / block);
  const bh = Math.ceil(height / block);
  let grid: Float32Array = new Float32Array(bw * bh);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / block) * bw;
    for (let x = 0; x < width; x++) {
      const i = row + Math.floor(x / block);
      const v = gray[y * width + x];
      if (v > grid[i]) grid[i] = v;
    }
  }
  // A block much darker than its brightest neighbour is (mostly) ink, not paper. (The dark desk
  // next to a label is treated the same way; the thick false-ink band this leaves around the
  // label is far thicker than pen strokes and is set aside by the segmenter.)
  const fixed = new Float32Array(grid);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = by + dy;
        const xx = bx + dx;
        if (yy >= 0 && yy < bh && xx >= 0 && xx < bw && grid[yy * bw + xx] > m) m = grid[yy * bw + xx];
      }
      if (grid[by * bw + bx] < 0.8 * m) fixed[by * bw + bx] = m;
    }
  }
  grid = boxBlur3(boxBlur3(fixed, bw, bh), bw, bh);

  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(bh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(bw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const fx = gx - x0;
      const a = grid[y0 * bw + x0] * (1 - fx) + grid[y0 * bw + x1] * fx;
      const b = grid[y1 * bw + x0] * (1 - fx) + grid[y1 * bw + x1] * fx;
      out[y * width + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

function boxBlur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += src[yy * w + xx]; c++; }
      }
      out[y * w + x] = s / c;
    }
  }
  return out;
}

/** Ink darkness relative to the paper around it: 0 = paper, 1 = black. */
export function darkness(gray: Float32Array, background: Float32Array): Float32Array {
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const bg = Math.max(24, background[i]);
    const d = (bg - gray[i]) / bg;
    out[i] = d < 0 ? 0 : d > 1 ? 1 : d;
  }
  return out;
}

/** Value below which `q` (0-1) of the values lie, from a 1024-bin histogram of 0..1 data. */
export function quantile(values: Float32Array, q: number): number {
  const bins = 1024;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < values.length; i++) hist[Math.min(bins - 1, Math.floor(values[i] * bins))]++;
  const target = q * values.length;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) return (b + 0.5) / bins;
  }
  return 1;
}

/**
 * Hysteresis threshold: pixels at least `high` dark start ink regions, which then grow through
 * pixels at least `low` dark. Faint parts of a real stroke are kept (they touch its dark core);
 * faint specks and paper texture are not (nothing dark enough starts them).
 */
export function hysteresis(d: Float32Array, width: number, height: number, low: number, high: number): Uint8Array {
  const n = width * height;
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (d[i] >= high) { mask[i] = 1; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= width) continue;
        const j = yy * width + xx;
        if (!mask[j] && d[j] >= low) { mask[j] = 1; queue[tail++] = j; }
      }
    }
  }
  return mask;
}

/**
 * Removes printed notebook lines (ruled or squared paper), also when the paper is held at a slight
 * angle: straight lines within 12 degrees of horizontal or vertical are found with a Hough
 * transform (on the mask at half resolution; a line is a long, dense row of ink no handwritten
 * digit makes) and their pixels are cleared, except where a pen stroke crosses the line (the ink
 * continues beyond the line's thickness), so digits written on a line are not cut apart.
 * Returns the number of removed pixels.
 */
export function removeRuledLines(mask: Uint8Array, width: number, height: number, maxThickness: number): number {
  // Half-resolution copy (2x2 maximum) for finding the lines.
  const hw = Math.ceil(width / 2);
  const hh = Math.ceil(height / 2);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const i = 2 * y * width + 2 * x;
      const right = 2 * x + 1 < width;
      const down = 2 * y + 1 < height;
      if (mask[i] || (right && mask[i + 1]) || (down && mask[i + width]) || (right && down && mask[i + width + 1])) { xs.push(x); ys.push(y); }
    }
  }
  if (!xs.length) return 0;
  const px = Int32Array.from(xs);
  const py = Int32Array.from(ys);
  const minH = Math.round(0.3 * width);
  const minV = Math.round(0.7 * height);
  return removeLineFamily(mask, width, height, findLines(px, py, hw, hh, true, Math.round(minH / 2), maxThickness), true, maxThickness, minH)
    + removeLineFamily(mask, width, height, findLines(px, py, hw, hh, false, Math.round(minV / 2), maxThickness), false, maxThickness, minV);
}

const LINE_ANGLES = Array.from({ length: 49 }, (_, i) => ((-12 + i * 0.5) * Math.PI) / 180);
const LINE_COS = LINE_ANGLES.map(Math.cos);
const LINE_SIN = LINE_ANGLES.map(Math.sin);

interface Line { a: number; r: number }

/** Hough peaks (angle index, distance in full-resolution pixels) of lines at least `minLength` half-pixels long. */
function findLines(xs: Int32Array, ys: Int32Array, hw: number, hh: number, horizontal: boolean, minLength: number, maxThickness: number): Line[] {
  const offset = Math.ceil(Math.max(hw, hh) * 0.25) + 2;
  const size = (horizontal ? hh : hw) + 2 * offset;
  const peaks: Array<{ a: number; r: number; count: number }> = [];
  const hist = new Int32Array(size);
  for (let a = 0; a < LINE_ANGLES.length; a++) {
    hist.fill(0);
    const c = LINE_COS[a];
    const s = LINE_SIN[a];
    for (let k = 0; k < xs.length; k++) {
      const r = Math.round(horizontal ? ys[k] * c - xs[k] * s : xs[k] * c + ys[k] * s) + offset;
      if (r >= 0 && r < size) hist[r]++;
    }
    for (let r = 1; r < size - 1; r++) {
      const n = hist[r - 1] + hist[r] + hist[r + 1];
      if (n >= minLength && hist[r] >= hist[r - 1] && hist[r] >= hist[r + 1]) peaks.push({ a, r: r - offset, count: n });
    }
  }
  peaks.sort((p, q) => q.count - p.count);
  const lines: Line[] = [];
  const near = Math.max(2, Math.ceil(maxThickness / 2) + 1);
  for (const p of peaks) {
    if (lines.some((l) => Math.abs(l.a - p.a) <= 4 && Math.abs(l.r / 2 - p.r) <= near)) continue;
    lines.push({ a: p.a, r: p.r * 2 });
    // Squared paper with small squares has well over a hundred lines across a Full HD frame.
    if (lines.length >= 200) break;
  }
  return lines;
}

/**
 * Clears each line's pixels along its band, keeping pixels where a stroke crosses it. A Hough peak
 * counts as a printed line only where ink runs along it for at least `minRun` pixels: continuously
 * (gaps of a few pixels allowed), or, for a faint line that thresholding broke into dashes, with
 * ink on at least 60% of its length. A row of separate digit strokes is neither.
 */
function removeLineFamily(mask: Uint8Array, width: number, height: number, lines: Line[], horizontal: boolean, maxThickness: number, minRun: number): number {
  const band = maxThickness / 2 + 1.5;
  const along = horizontal ? width : height;
  const across = horizontal ? height : width;
  const gapAllowed = 2 * maxThickness + 2;
  const covered = new Uint8Array(along);
  const thin = new Uint8Array(along);
  const kill: number[] = [];
  for (const line of lines) {
    const c = LINE_COS[line.a];
    const s = LINE_SIN[line.a];
    // Horizontal: y*c - x*s = r, so y = (r + x*s) / c. Vertical: x*c + y*s = r, so x = (r - y*s) / c.
    const centreAt = (t: number) => (horizontal ? (line.r + t * s) / c : (line.r - t * s) / c);
    const pixel = (t: number, q: number) => (horizontal ? q * width + t : t * width + q);
    // Positions where the line has ink, and where that ink is thin across it (a printed line is
    // thin; a blob or the dark edge of the paper is not).
    covered.fill(0);
    thin.fill(0);
    for (let t = 0; t < along; t++) {
      const centre = centreAt(t);
      const lo = Math.max(0, Math.ceil(centre - band));
      const hi = Math.min(across - 1, Math.floor(centre + band));
      let first = -1;
      let lastInk = -1;
      for (let q = lo; q <= hi; q++) if (mask[pixel(t, q)]) { if (first < 0) first = q; lastInk = q; }
      if (first < 0) continue;
      covered[t] = 1;
      const clearBefore = first > lo || first === 0 || !mask[pixel(t, first - 1)];
      const clearAfter = lastInk < hi || lastInk === across - 1 || !mask[pixel(t, lastInk + 1)];
      if (lastInk - first + 1 <= maxThickness + 2 && clearBefore && clearAfter) thin[t] = 1;
    }
    // Longest stretch of ink along the line (a faint line shows only where it touches the
    // digits, so their ink counts here); else a faint line broken into thin dashes.
    let bestStart = 0, bestEnd = -1, start = -1, last = -1e9;
    for (let t = 0; t < along; t++) {
      if (!covered[t]) continue;
      if (t - last > gapAllowed) start = t;
      last = t;
      if (t - start > bestEnd - bestStart) { bestStart = start; bestEnd = t; }
    }
    if (bestEnd - bestStart + 1 < minRun) {
      let first = -1, lastThin = -1, inked = 0, run = 0, longest = 0, prev = -1e9;
      for (let t = 0; t < along; t++) {
        if (!thin[t]) continue;
        if (first < 0) first = t;
        inked++;
        run = t - prev <= gapAllowed ? run + (t - prev) : 1;
        if (run > longest) longest = run;
        prev = t;
        lastThin = t;
      }
      const extent = lastThin - first + 1;
      if (first < 0 || extent < minRun || inked < 0.6 * extent || longest < 0.25 * minRun) continue;
      bestStart = first;
      bestEnd = lastThin;
    }
    for (let t = bestStart; t <= bestEnd; t++) {
      const centre = centreAt(t);
      const lo = Math.max(0, Math.ceil(centre - band));
      const hi = Math.min(across - 1, Math.floor(centre + band));
      for (let q = lo; q <= hi; q++) {
        const i = pixel(t, q);
        if (!mask[i]) continue;
        // Ink across the line (perpendicular run) longer than a line is thick: a crossing stroke.
        let run = 1;
        if (horizontal) {
          for (let k = 1; k <= maxThickness && q - k >= 0 && mask[i - k * width]; k++) run++;
          for (let k = 1; k <= maxThickness && q + k < height && mask[i + k * width]; k++) run++;
        } else {
          for (let k = 1; k <= maxThickness && q - k >= 0 && mask[i - k]; k++) run++;
          for (let k = 1; k <= maxThickness && q + k < width && mask[i + k]; k++) run++;
        }
        if (run <= maxThickness) kill.push(i);
      }
    }
  }
  let removed = 0;
  for (const i of kill) if (mask[i]) { mask[i] = 0; removed++; }
  return removed;
}

export interface Component {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

/** 8-connected components (two passes with union-find). Labels are 1-based; 0 = background. */
export function connectedComponents(mask: Uint8Array, width: number, height: number): { labels: Int32Array; components: Component[] } {
  const labels = new Int32Array(width * height);
  let parent = new Int32Array(1024);
  let next = 1;
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const unite = (a: number, b: number): number => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    if (ra < rb) { parent[rb] = ra; return ra; }
    parent[ra] = rb;
    return rb;
  };
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      // Already-visited neighbours: W, NW, N, NE.
      let l = x > 0 ? labels[i - 1] : 0;
      if (y > 0) {
        const nw = x > 0 ? labels[i - width - 1] : 0;
        const n = labels[i - width];
        const ne = x < width - 1 ? labels[i - width + 1] : 0;
        if (nw) l = l ? unite(l, nw) : nw;
        if (n) l = l ? unite(l, n) : n;
        if (ne) l = l ? unite(l, ne) : ne;
      }
      if (!l) {
        if (next >= parent.length) {
          const grown = new Int32Array(parent.length * 2);
          grown.set(parent);
          parent = grown;
        }
        l = next++;
        parent[l] = l;
      }
      labels[i] = l;
    }
  }
  const remap = new Int32Array(next);
  const components: Component[] = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    let id = remap[root];
    const x = i % width;
    const y = (i - x) / width;
    if (!id) {
      id = components.length + 1;
      remap[root] = id;
      components.push({ id, x0: x, y0: y, x1: x, y1: y, area: 0 });
    }
    labels[i] = id;
    const c = components[id - 1];
    if (x < c.x0) c.x0 = x;
    if (x > c.x1) c.x1 = x;
    if (y < c.y0) c.y0 = y;
    if (y > c.y1) c.y1 = y;
    c.area++;
  }
  return { labels, components };
}

/** Mean stroke width of every component (2 x area / boundary length), indexed by id - 1. */
export function componentStrokeWidths(labels: Int32Array, components: Component[], width: number, height: number): Float32Array {
  const edges = new Float32Array(components.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = labels[i];
      if (!l) continue;
      let e = 0;
      if (x === 0 || labels[i - 1] !== l) e++;
      if (x === width - 1 || labels[i + 1] !== l) e++;
      if (y === 0 || labels[i - width] !== l) e++;
      if (y === height - 1 || labels[i + width] !== l) e++;
      edges[l - 1] += e;
    }
  }
  return Float32Array.from(components, (c, k) => (edges[k] ? (2 * c.area) / edges[k] : 0));
}

/** Downscaled 0-255 plane for diagnostics previews: cell average, or cell maximum for masks. */
export function previewPlane(src: ArrayLike<number>, width: number, height: number, scale: number, map: (v: number) => number, mode: 'mean' | 'max' = 'mean'): Uint8Array {
  const pw = Math.max(1, Math.round(width * scale));
  const ph = Math.max(1, Math.round(height * scale));
  const acc = new Float32Array(pw * ph);
  const count = new Uint32Array(pw * ph);
  for (let y = 0; y < height; y++) {
    const py = Math.min(ph - 1, Math.floor(y * scale));
    for (let x = 0; x < width; x++) {
      const i = py * pw + Math.min(pw - 1, Math.floor(x * scale));
      const v = map(src[y * width + x]);
      if (mode === 'max') { if (v > acc[i]) acc[i] = v; } else { acc[i] += v; count[i]++; }
    }
  }
  const out = new Uint8Array(pw * ph);
  for (let i = 0; i < out.length; i++) {
    const v = mode === 'max' ? acc[i] : acc[i] / Math.max(1, count[i]);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return out;
}
