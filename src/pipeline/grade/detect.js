// Find a raw card in a photo (grade check). Pure and DOM-free: works on ImageData-like {data, width, height} RGBA.
//  1. Downscale to <= DETECT_SIDE px, blur lightly, take the colour gradient (strongest of R, G, B per pixel).
//  2. Thin edges (non-max suppression) and vote them into a Hough accumulator along their own gradient direction.
//  3. Pair near-parallel lines, combine two roughly perpendicular pairs into quads, keep the card-shaped ones
//     (perspective-corrected aspect near 63:88) and score them by how much of each side lies on a matching edge.
//  4. Prefer the outer edge over the inner print frame when both are found (the band between them is the border).
//     Then, among quads a little in or out, the one with most sides on the cut edge: the border's colour just inside,
//     something else just outside (not a holder, sleeve or scanner-lid line around a tightly cropped card).
//  5. Refine the 4 sides at full resolution with sub-pixel edge profiles and a robust line fit: per profile the step
//     where the border ends, not a stronger one just outside it.
import { lineFromPolar, lineThrough, intersect, quadArea, isConvex, orderQuad, rectAspect, fitLine, quadSkew } from './geometry.js';

/** Short/long side of a standard card: Pokémon and One Piece 63 × 88 mm; Disney Lorcana 63.5 × 88.9 mm (0.714). */
export const CARD_RATIO = 63 / 88;
export const DETECT_SIDE = 640;
const THETA_BINS = 360; // 0.5° per bin
const VOTE_SPREAD = 6; // each edge pixel votes ±3° around its gradient direction
const MAX_LINES = 60;
const SIDE_SAMPLES = 32;
const DEG = Math.PI / 180;

/** Area-average downscale of RGBA to float planes (transparent pixels composited on white). */
export function downscale(img, maxSide = DETECT_SIDE) {
  const { width: W, height: H, data } = img;
  const s = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));
  const r = new Float32Array(w * h); const g = new Float32Array(w * h); const b = new Float32Array(w * h);
  const n = new Float32Array(w * h);
  const ox = new Int32Array(W);
  for (let x = 0; x < W; x++) ox[x] = Math.min(w - 1, Math.floor((x * w) / W));
  for (let y = 0; y < H; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / H)) * w;
    let j = y * W * 4;
    for (let x = 0; x < W; x++, j += 4) {
      const k = row + ox[x];
      const a = data[j + 3] / 255;
      const white = 255 * (1 - a);
      r[k] += data[j] * a + white; g[k] += data[j + 1] * a + white; b[k] += data[j + 2] * a + white;
      n[k]++;
    }
  }
  for (let k = 0; k < w * h; k++) { const c = n[k] || 1; r[k] /= c; g[k] /= c; b[k] /= c; }
  return { r, g, b, width: w, height: h, scale: w / W };
}

/** In-place [1 2 1] / 4 blur in x and y. */
function blur(p, w, h) {
  const t = new Float32Array(p.length);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const l = p[o + Math.max(0, x - 1)]; const c = p[o + x]; const r = p[o + Math.min(w - 1, x + 1)];
      t[o + x] = (l + 2 * c + r) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    const u = Math.max(0, y - 1) * w; const o = y * w; const d = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) p[o + x] = (t[u + x] + 2 * t[o + x] + t[d + x]) / 4;
  }
}

/** Sobel gradient of the strongest colour channel per pixel: magnitude and direction (radians). */
export function colorGradient(small) {
  const { width: w, height: h } = small;
  const planes = [small.r, small.g, small.b].map((p) => { const q = Float32Array.from(p); blur(q, w, h); return q; });
  const mag = new Float32Array(w * h);
  const ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      let best = -1; let bx = 0; let by = 0;
      for (const p of planes) {
        const gx = (p[i - w + 1] + 2 * p[i + 1] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - 1] - p[i + w - 1]) / 8;
        const gy = (p[i + w - 1] + 2 * p[i + w] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - w] - p[i - w + 1]) / 8;
        const m = gx * gx + gy * gy;
        if (m > best) { best = m; bx = gx; by = gy; }
      }
      mag[i] = Math.sqrt(best);
      ang[i] = Math.atan2(by, bx);
    }
  }
  return { mag, ang, width: w, height: h };
}

/** Thin edges: keep pixels that are a local maximum across the edge and above an adaptive threshold. */
export function edgeMask(grad) {
  const { mag, ang, width: w, height: h } = grad;
  const sample = [];
  for (let i = 0; i < mag.length; i += 7) sample.push(mag[i]);
  sample.sort((a, b) => a - b);
  const median = sample[sample.length >> 1] ?? 0;
  const threshold = Math.max(4, 1.5 * median);
  const mask = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m < threshold) continue;
      let a = ang[i]; if (a < 0) a += Math.PI; // direction mod 180°
      let dx; let dy;
      if (a < Math.PI / 8 || a >= 7 * Math.PI / 8) { dx = 1; dy = 0; } else if (a < 3 * Math.PI / 8) { dx = 1; dy = 1; } else if (a < 5 * Math.PI / 8) { dx = 0; dy = 1; } else { dx = -1; dy = 1; }
      if (m >= mag[i + dy * w + dx] && m >= mag[i - dy * w - dx]) mask[i] = 1;
    }
  }
  return { mask, threshold };
}

const angleDiff = (t1, t2) => { let d = Math.abs(t1 - t2) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; };

/** Strongest straight lines {theta, rho, votes} (x·cosθ + y·sinθ = ρ, θ in [0, π)), deduplicated, strongest first. */
export function houghLines(grad, mask, { maxLines = MAX_LINES } = {}) {
  const { ang, width: w, height: h } = grad;
  const diag = Math.ceil(Math.hypot(w, h));
  const nRho = 2 * diag + 1;
  const acc = new Int32Array(THETA_BINS * nRho);
  const cos = new Float64Array(THETA_BINS); const sin = new Float64Array(THETA_BINS);
  for (let t = 0; t < THETA_BINS; t++) { cos[t] = Math.cos((t * Math.PI) / THETA_BINS); sin[t] = Math.sin((t * Math.PI) / THETA_BINS); }
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = (i % w) + 0.5; const y = Math.floor(i / w) + 0.5;
    let a = ang[i]; if (a < 0) a += Math.PI;
    const tb = Math.round((a / Math.PI) * THETA_BINS);
    for (let d = -VOTE_SPREAD; d <= VOTE_SPREAD; d++) {
      const t = (tb + d + THETA_BINS) % THETA_BINS;
      const rho = Math.round(x * cos[t] + y * sin[t]) + diag;
      acc[t * nRho + rho]++;
    }
  }
  const minVotes = Math.max(12, 0.1 * Math.min(w, h));
  const peaks = [];
  const RT = 4; const RR = 3;
  for (let t = 0; t < THETA_BINS; t++) {
    for (let r = 0; r < nRho; r++) {
      const v = acc[t * nRho + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -RT; dt <= RT && isMax; dt++) {
        const tt = t + dt;
        if (tt < 0 || tt >= THETA_BINS) continue;
        for (let dr = -RR; dr <= RR; dr++) {
          const rr = r + dr;
          if ((dt || dr) && rr >= 0 && rr < nRho) {
            const u = acc[tt * nRho + rr];
            if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; }
          }
        }
      }
      if (isMax) peaks.push({ theta: (t * Math.PI) / THETA_BINS, rho: r - diag, votes: v });
    }
  }
  peaks.sort((p, q) => q.votes - p.votes);
  const lines = [];
  for (const p of peaks) {
    const dup = lines.some((l) => {
      if (angleDiff(l.theta, p.theta) > 2 * DEG) return false;
      const sameSide = Math.abs(l.theta - p.theta) < Math.PI / 2;
      return Math.abs(l.rho - (sameSide ? p.rho : -p.rho)) < 3;
    });
    if (!dup) lines.push(p);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

/**
 * Fraction of `n` points on the line p→r, at t from t0 to t1 (t < 0 or > 1 lies beyond the ends), that are on an edge
 * pixel whose direction matches the line. Points outside the image miss, or with `inside` are left out (null when
 * fewer than 3 are inside).
 */
function lineSupport(p, r, t0, t1, n, grad, mask, { inside = false } = {}) {
  const { ang, width: w, height: h } = grad;
  const dx = r[0] - p[0]; const dy = r[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; const ny = dx / len;
  const normal = Math.atan2(ny, nx);
  let hits = 0; let count = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + ((t1 - t0) * k) / (n - 1);
    const bx = p[0] + dx * t; const by = p[1] + dy * t;
    if (inside && (bx < 1 || by < 1 || bx >= w - 1 || by >= h - 1)) continue;
    count++;
    for (let o = -2; o <= 2; o++) {
      const x = Math.floor(bx + nx * o); const y = Math.floor(by + ny * o);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x;
      if (mask[i] && angleDiff(ang[i], normal) <= 20 * DEG) { hits++; break; }
    }
  }
  if (inside && count < 3) return null;
  return count ? hits / count : 0;
}

/** Fraction of each side of `q` that lies on an edge pixel whose direction matches the side. */
function sideSupport(q, grad, mask) {
  return [0, 1, 2, 3].map((s) => lineSupport(q[s], q[(s + 1) % 4], 0.08, 0.92, SIDE_SAMPLES, grad, mask));
}

/**
 * How much each corner of `q` looks like a real corner (0.2..1): both sides have an edge just past the rounded tip.
 * A quad built from the lines of two different rectangles (the card's right side with the top of a box around it)
 * has a corner where one of the edges only starts further on. (Whether a line runs on beyond the corner says less:
 * a card lying along a table edge or a wood grain line has real corners too.)
 */
function cornerSupport(q, grad, mask) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const prev = q[(i + 3) % 4]; const c = q[i]; const next = q[(i + 1) % 4];
    const a = lineSupport(c, next, 0.07, 0.18, 8, grad, mask, { inside: true });
    const b = lineSupport(prev, c, 0.82, 0.93, 8, grad, mask, { inside: true });
    out.push(0.2 + 0.8 * Math.min(a ?? 1, b ?? 1));
  }
  return out;
}

/** Point on line l closest to (x, y). */
const foot = (l, x, y) => { const d = l.a * x + l.b * y - l.c; return [x - l.a * d, y - l.b * d]; };

/** Card-shaped quads from the line list, best first: {quad, support[4], ratio, score, area}. */
export function cardQuads(lines, grad, mask) {
  const { width: w, height: h } = grad;
  const cx = w / 2; const cy = h / 2;
  const L = lines.map((l) => ({ ...l, line: lineFromPolar(l.theta, l.rho) }));
  const pairs = [];
  const minSep = 0.15 * Math.min(w, h);
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      if (angleDiff(L[i].theta, L[j].theta) > 12 * DEG) continue;
      const p = foot(L[j].line, cx, cy);
      const sep = Math.abs(L[i].line.a * p[0] + L[i].line.b * p[1] - L[i].line.c);
      if (sep < minSep) continue;
      // Mean direction (mod 180°) of the pair.
      let t2 = L[j].theta; if (Math.abs(t2 - L[i].theta) > Math.PI / 2) t2 += t2 < L[i].theta ? Math.PI : -Math.PI;
      pairs.push({ a: L[i], b: L[j], theta: (L[i].theta + t2) / 2 });
    }
  }
  // Geometry first (cheap): every card-shaped quad with an upper bound of its score (full edge support).
  const shapes = [];
  const margin = 0.03;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const P = pairs[i]; const Q = pairs[j];
      if (Math.abs(angleDiff(P.theta, Q.theta) - Math.PI / 2) > 25 * DEG) continue;
      if ([P.a, P.b].some((l) => l === Q.a || l === Q.b)) continue;
      const corners = [intersect(P.a.line, Q.a.line), intersect(P.a.line, Q.b.line), intersect(P.b.line, Q.b.line), intersect(P.b.line, Q.a.line)];
      if (corners.some((c) => !c || c[0] < -margin * w || c[0] > (1 + margin) * w || c[1] < -margin * h || c[1] > (1 + margin) * h)) continue;
      if (!isConvex(corners)) continue;
      const area = quadArea(corners);
      if (area < 0.08 * w * h) continue;
      const quad = orderQuad(corners);
      const ratio = rectAspect(quad, [cx, cy]);
      if (!(ratio > 0.55 && ratio < 0.9)) continue;
      // Bigger wins among well-supported quads: the card's outline encloses the print frame, text boxes and art.
      const bound = Math.exp(-(((ratio - CARD_RATIO) / 0.05) ** 2)) * Math.sqrt(area / (w * h));
      shapes.push({ quad, ratio, area, bound });
    }
  }
  // Then edge support, best bound first, until no remaining quad can reach the share of the best score that
  // chooseCard still looks at.
  shapes.sort((p, q) => q.bound - p.bound);
  const out = [];
  let best = 0;
  for (let k = 0; k < shapes.length && k < 6000; k++) {
    const c = shapes[k];
    if (c.bound < 0.35 * best) break;
    const support = sideSupport(c.quad, grad, mask);
    if (Math.min(...support) < 0.3) continue;
    const geo = Math.pow(support.reduce((s, v) => s * Math.max(v, 0.01), 1), 0.25);
    const corners = Math.pow(cornerSupport(c.quad, grad, mask).reduce((s, v) => s * v, 1), 0.25);
    const score = geo * corners * c.bound;
    best = Math.max(best, score);
    out.push({ quad: c.quad, support, ratio: c.ratio, area: c.area, score });
  }
  out.sort((p, q) => q.score - p.score);
  return out;
}

/** Median of RGB samples (nulls skipped) with `spread`, the median distance of the samples from it; null with < 6. */
function medianOf(samples) {
  const ok = samples.filter(Boolean);
  if (ok.length < 6) return null;
  const med = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
  const c = [0, 1, 2].map((ch) => med(ok.map((v) => v[ch])));
  c.spread = med(ok.map((v) => Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2])));
  return c;
}

/**
 * Median colour of the low-res planes at the given points (points outside the image are skipped), with `spread`: the
 * median distance of the samples from it (small for a printed border, large for texture). Null with too few points.
 */
function medianColor(small, points) {
  const { r, g, b, width: w, height: h } = small;
  return medianOf(points.map(([x, y]) => {
    const xi = Math.floor(x); const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const i = yi * w + xi;
    return [r[i], g[i], b[i]];
  }));
}

const rgbDist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/** Points along the side s of quad `inner` pushed outward by `offset` (fraction of the inner→outer distance). */
function bandPoints(inner, outer, s, f) {
  const pts = [];
  for (let k = 1; k < 16; k++) {
    const t = 0.15 + (0.7 * k) / 16;
    const a = [inner[s][0] + (inner[(s + 1) % 4][0] - inner[s][0]) * t, inner[s][1] + (inner[(s + 1) % 4][1] - inner[s][1]) * t];
    const b = [outer[s][0] + (outer[(s + 1) % 4][0] - outer[s][0]) * t, outer[s][1] + (outer[(s + 1) % 4][1] - outer[s][1]) * t];
    pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return pts;
}

/**
 * Distance from each side of `inner` to the matching side of `outer` (at the side midpoints; 0 when they coincide
 * within `tol` px), or null when `outer` does not enclose `inner`.
 */
function margins(inner, outer, tol = 0) {
  const out = [];
  const cIn = [(inner[0][0] + inner[2][0]) / 2, (inner[0][1] + inner[2][1]) / 2];
  for (let s = 0; s < 4; s++) {
    const l = lineThrough(outer[s], outer[(s + 1) % 4]);
    const m = [(inner[s][0] + inner[(s + 1) % 4][0]) / 2, (inner[s][1] + inner[(s + 1) % 4][1]) / 2];
    const dm = l.a * m[0] + l.b * m[1] - l.c;
    const dc = l.a * cIn[0] + l.b * cIn[1] - l.c;
    if (Math.abs(dm) <= tol) { out.push(0); continue; }
    if (Math.sign(dm) !== Math.sign(dc)) return null; // the inner side lies outside the outer one
    out.push(Math.abs(dm));
  }
  return out;
}

/**
 * True when the photo looks cropped to the card around `inner` (its print frame): on every side an even band up to
 * the photo edge, and in the photo's corners (outside the card's rounded corners) a colour unlike that band. When
 * the corners have the band's colour, the band is the surface around a card that nearly fills the photo.
 */
function croppedToCard(inner, imageRect, small, short) {
  const m = margins(inner, imageRect, 1.5);
  if (!m) return false;
  const bands = [];
  for (let s = 0; s < 4; s++) {
    if (m[s] < 0.01 * short || m[s] > 0.09 * short) return false;
    const band = medianColor(small, bandPoints(inner, imageRect, s, 0.5));
    if (!band || band.spread >= 14) return false;
    bands.push(band);
  }
  const { width: w, height: h } = small;
  const e = Math.max(2, Math.round(0.012 * Math.min(w, h)));
  let alike = 0;
  for (const [cx, cy] of [[0, 0], [w - e, 0], [w - e, h - e], [0, h - e]]) {
    const pts = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) pts.push([cx + ((i + 0.5) * e) / 3, cy + ((j + 0.5) * e) / 3]);
    const c = medianColor(small, pts);
    if (c && bands.some((b) => rgbDist(b, c) < 25)) alike++;
  }
  return alike < 3;
}

/**
 * Per side of `quad` (low-res px; k = source px per low-res px), whether it lies on the card's cut edge: just inside
 * it (0.7 and 1.3 mm in, past a light rim along the cut) one even colour, the same as inside most other sides (the
 * card's border), and just outside it (0.5 mm) a different one, on each third of the side (a line that crosses from
 * the card's edge to a holder line fails). A holder or sleeve line a little outside the card has its narrow strip
 * inside, then the card; a print frame has art inside. Null for every side when no border colour is shared (art up
 * to the edge), and for a side where the photo ends just outside it.
 */
function edgeEvidence(img, quad, k) {
  const len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  const mm = [0, 1, 2, 3].reduce((t, i) => t + len(quad[i], quad[(i + 1) % 4]), 0) / (2 * (63 + 88));
  const c = [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2];
  const sides = [0, 1, 2, 3].map((s) => {
    const p = quad[s]; const r = quad[(s + 1) % 4];
    const L = len(p, r);
    let nx = -(r[1] - p[1]) / L; let ny = (r[0] - p[0]) / L;
    if ((c[0] - (p[0] + r[0]) / 2) * nx + (c[1] - (p[1] + r[1]) / 2) * ny > 0) { nx = -nx; ny = -ny; } // outward
    return [0.15, 0.4, 0.65].map((t0) => {
      const at = (o) => medianOf(Array.from({ length: 8 }, (_, j) => {
        const t = t0 + (0.2 * j) / 7;
        return sampleRgb(img, (p[0] + (r[0] - p[0]) * t + nx * o * mm) * k, (p[1] + (r[1] - p[1]) * t + ny * o * mm) * k);
      }));
      const near = at(-0.7); const deep = at(-1.3);
      return { even: !!(near && deep && near.spread < 40 && rgbDist(near, deep) < 40), near, out: at(0.5) };
    });
  });
  // The border colour: the even inside colour that most stretches share.
  const all = sides.flat().filter((a) => a.even);
  let border = null; let n = 0;
  for (const a of all) {
    const m = all.filter((b) => sameInk(a.near, b.near)).length;
    if (m > n) { n = m; border = a.near; }
  }
  if (n < 5) return sides.map(() => null);
  return sides.map((parts) => {
    if (parts.some((a) => !a.out)) return null;
    return parts.every((a) => a.even && sameInk(a.near, border) && rgbDist(a.out, border) > 40);
  });
}

/**
 * Whether two colours are the same border ink: close, or both grey within a third in brightness (a silver border's
 * metallic sheen runs from light to dark along a side).
 */
function sameInk(p, q) {
  if (rgbDist(p, q) < 40) return true;
  const lp = (p[0] + p[1] + p[2]) / 3 + 1; const lq = (q[0] + q[1] + q[2]) / 3 + 1;
  if (lp / lq > 1.33 || lq / lp > 1.33) return false;
  const grey = (v, l) => Math.max(Math.abs(v[0] - v[1]), Math.abs(v[1] - v[2]), Math.abs(v[0] - v[2])) / l < 0.08;
  return grey(p, lp) && grey(q, lq) && rgbDist(p, q) < 90;
}

/** Signed distance (+ outward) of each side's midpoint of `q` from the matching side of `ref`. */
function sideShifts(q, ref) {
  const c = [(ref[0][0] + ref[2][0]) / 2, (ref[0][1] + ref[2][1]) / 2];
  return [0, 1, 2, 3].map((s) => {
    const l = lineThrough(ref[s], ref[(s + 1) % 4]);
    const m = [(q[s][0] + q[(s + 1) % 4][0]) / 2, (q[s][1] + q[(s + 1) % 4][1]) / 2];
    const sign = l.a * c[0] + l.b * c[1] - l.c > 0 ? -1 : 1;
    return sign * (l.a * m[0] + l.b * m[1] - l.c);
  });
}

/**
 * Of the candidates whose sides lie at most 2 mm inside and 3.8 mm outside the sides of `pick` (a holder line just
 * outside the card, the print frame just inside it; not the print frame of a card found at its edge), the one with
 * the most sides on the card's cut edge (edgeEvidence); `pick` on a tie.
 */
function onCardEdge(pick, cands, img, k) {
  const short = shortSide(pick.quad);
  const count = (q) => edgeEvidence(img, q, k).filter((v) => v === true).length;
  let best = pick; let bestN = count(pick.quad);
  if (bestN === 4) return pick;
  for (const c of cands) {
    if (c.score < 0.35 * cands[0].score || Math.min(...c.support) < 0.4) continue;
    if (sideShifts(c.quad, pick.quad).some((d) => d < -0.032 * short || d > 0.06 * short)) continue;
    const n = count(c.quad);
    if (n > bestN || (n === bestN && best !== pick && c.score > best.score)) { best = c; bestN = n; }
  }
  return best === pick ? pick : { quad: best.quad, source: 'detected', score: best.score, support: best.support, ratio: best.ratio };
}

/**
 * Choose the card among the candidates. When the best quad has an enclosing quad up to 9 % of the card's short side
 * further out (some sides may coincide), and on the sides that moved the band between them has a colour unlike the
 * area outside, the inner quad was the print frame and the outer one is the card edge. A band that looks like the
 * outside is a sleeve or a shadow: the inner quad is kept. Of several such outer quads the best supported wins (the
 * biggest can mix the card's sides with lines in the background). The photo's own edges count as the card edge only
 * when no detected quad does, the band to them is even all round and every side has one (a photo cropped to the card).
 */
function chooseCard(cands, small, imageRect) {
  if (!cands.length) return imageRect ? { quad: imageRect, source: 'image-edges', score: 0 } : null;
  let best = cands[0];
  for (let round = 0; round < 3; round++) {
    const short = shortSide(best.quad);
    let next = null;
    for (const c of cands) {
      if (c === best || c.score < 0.35 * cands[0].score || Math.min(...c.support) < 0.4) continue;
      const m = margins(best.quad, c.quad, 1.5);
      if (!m || m.some((d) => d > 0.09 * short)) continue;
      const moved = [0, 1, 2, 3].filter((s) => m[s] >= 0.005 * short);
      if (!moved.length) continue;
      // A printed border: an even band whose colour differs from what lies beyond it.
      let border = 0;
      for (const s of moved) {
        if (c.support[s] < 0.6) continue;
        const band = medianColor(small, bandPoints(best.quad, c.quad, s, 0.5));
        const outside = medianColor(small, bandPoints(best.quad, c.quad, s, 2.2));
        if (band && band.spread < 14 && (!outside || rgbDist(band, outside) > 30)) border++;
      }
      if (border < Math.ceil(moved.length * 0.75)) continue;
      if (!next || c.score > next.score) next = c;
    }
    if (!next && imageRect && croppedToCard(best.quad, imageRect, small, short)) {
      return { quad: imageRect, source: 'image-edges', score: best.score, support: [1, 1, 1, 1], ratio: best.ratio };
    }
    if (!next) break;
    best = next;
  }
  return { quad: best.quad, source: 'detected', score: best.score, support: best.support, ratio: best.ratio };
}

const shortSide = (q) => Math.min(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[3][0] - q[2][0], q[3][1] - q[2][1]));

/**
 * True when `quad` is a line drawn on the surface (a playmat's card zone, a box printed around a card): just inside
 * and just outside it the colour is the same on at least 3 sides. A card's edge has its border inside and the
 * surface outside.
 */
function drawnOutline(quad, small) {
  const d = 0.035 * shortSide(quad);
  const c = [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2];
  let same = 0;
  for (let s = 0; s < 4; s++) {
    const p = quad[s]; const r = quad[(s + 1) % 4];
    const len = Math.hypot(r[0] - p[0], r[1] - p[1]) || 1;
    let nx = -(r[1] - p[1]) / len; let ny = (r[0] - p[0]) / len;
    if ((c[0] - (p[0] + r[0]) / 2) * nx + (c[1] - (p[1] + r[1]) / 2) * ny > 0) { nx = -nx; ny = -ny; } // outward
    const at = (o) => Array.from({ length: 12 }, (_, k) => {
      const t = 0.15 + (0.7 * k) / 11;
      return [p[0] + (r[0] - p[0]) * t + nx * o, p[1] + (r[1] - p[1]) * t + ny * o];
    });
    const inside = medianColor(small, at(-d)); const outside = medianColor(small, at(d));
    if (inside && outside && rgbDist(inside, outside) < 20) same++;
  }
  return same >= 3;
}

/**
 * Detect the card. `quad` corners are in source pixels (TL, TR, BR, BL of the upright card).
 * source 'image-edges': no card edge in the photo but the photo itself is card-shaped (cropped or scanned to the card).
 * @returns {{quad:number[][], source:'detected'|'image-edges', score:number, candidates:number}|null}
 */
export function detectCard(img) {
  const small = downscale(img);
  const grad = colorGradient(small);
  const { mask } = edgeMask(grad);
  const lines = houghLines(grad, mask);
  const cands = cardQuads(lines, grad, mask);
  const { width: w, height: h } = small;
  const ratio = Math.min(w, h) / Math.max(w, h);
  const imageRect = Math.abs(ratio - CARD_RATIO) <= 0.025 ? orderQuad([[0, 0], [w, 0], [w, h], [0, h]]) : null;
  let pick = chooseCard(cands, small, imageRect);
  if (pick?.source === 'detected' && drawnOutline(pick.quad, small)) {
    // The card lies inside the outline: choose again among the quads clear of it (not sharing one of its lines).
    const clear = 0.03 * shortSide(pick.quad);
    const inside = cands.filter((c) => c.score >= 0.35 * cands[0].score && margins(c.quad, pick.quad, 0)?.every((m) => m > clear));
    if (inside.length) pick = chooseCard(inside, small, null);
  }
  if (!pick) return null;
  const k = 1 / small.scale;
  if (pick.source === 'detected') pick = onCardEdge(pick, cands, img, k);
  return { ...pick, quad: pick.quad.map(([x, y]) => [x * k, y * k]), candidates: cands.length };
}

/** Bilinear RGB sample at continuous coordinates (pixel centres at +0.5); null outside the image. */
export function sampleRgb(img, x, y) {
  const { data, width: W, height: H } = img;
  const fx = x - 0.5; const fy = y - 0.5;
  if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) return null;
  const x0 = Math.min(W - 2, Math.floor(fx)); const y0 = Math.min(H - 2, Math.floor(fy));
  const ax = fx - x0; const ay = fy - y0;
  const i00 = (y0 * W + x0) * 4; const i10 = i00 + 4; const i01 = i00 + W * 4; const i11 = i01 + 4;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = data[i00 + c] * (1 - ax) + data[i10 + c] * ax;
    const bot = data[i01 + c] * (1 - ax) + data[i11 + c] * ax;
    out[c] = top * (1 - ay) + bot * ay;
  }
  return out;
}

/**
 * Step index of the card edge in a profile across it (inside first; dv[i] = change from sample i to i+1): the first
 * strong step that ends an even run from the inner end (the card's border) with a clear change of colour, or a
 * stronger step up to `mergeSteps` further out (a light rim or the card's core along the cut). A holder rim or a
 * sleeve edge just outside the card can be the strongest step. Where the colour leaves the border without such a
 * step (art up to the edge, a rim at the inner end), the first step at least 0.6 × the strongest from there.
 */
function edgeStep(prof, dv, bi, bv, mergeSteps = 0, perMm = 20) {
  if (!prof[0] || !prof[1] || !prof[2]) return bi;
  let ref = [0, 1, 2].map((c) => (prof[0][c] + prof[1][c] + prof[2][c]) / 3);
  let start = 0;
  if (bi < Math.round(0.45 * perMm)) {
    // The strongest step right at the inner end, and another nearly as strong further out: the profile starts on
    // print in the border (the copyright line). Start again past it, with the colour there. Past the card's own edge
    // there is only the background, with no such step.
    const past = medianOf(prof.slice(bi + 2, bi + 2 + Math.max(6, Math.round(0.2 * perMm))));
    let b2 = -1; let v2 = 0;
    for (let i = bi + 4; i < dv.length; i++) if (dv[i] > v2) { v2 = dv[i]; b2 = i; }
    if (past && b2 >= 0 && v2 >= 0.5 * bv) { ref = past; start = bi + 2; bi = b2; bv = v2; }
  }
  const peak = (i, f) => dv[i] >= f * bv && dv[i] >= dv[i - 1] && dv[i] >= dv[i + 1];
  const top = (i) => {
    let j = i;
    for (let k = i + 1; k < dv.length && (dv[k] >= 0.3 * bv || k <= i + mergeSteps); k++) if (dv[k] > dv[j]) j = k;
    return j;
  };
  let dev = 0; // the largest change from the border colour before the current step starts
  let m = start;
  let i = start + 2;
  for (; i < bi; i++) {
    if (!peak(i, 0.3)) continue;
    let j = i;
    while (j > 1 && dv[j - 1] >= 0.3 * dv[i]) j--; // a blurred step starts at sample j
    for (; m < j; m++) if (prof[m]) dev = Math.max(dev, rgbDist(prof[m], ref));
    const after = prof[i + 3] ?? prof[prof.length - 1];
    if (!after) continue;
    const change = rgbDist(after, ref);
    if (dev > Math.max(20, 0.3 * change)) break;
    if (change < 25) continue;
    // Print inside the border (the copyright line in the bottom border): the border's colour comes back for a while
    // within 1 mm after the step. Past the card's edge it doesn't.
    const back = backAt(prof, ref, i + 3, Math.round(1.0 * perMm), Math.max(1, Math.round(0.25 * perMm)), Math.max(12, 0.25 * change));
    if (back < 0) return top(i);
    i = back; m = back; dev = 0;
  }
  for (; i < bi; i++) if (peak(i, 0.6)) return top(i);
  return bi;
}

/** Start of the first run of `run` samples within `tol` of `ref` in prof[from .. from + span]; -1 if none. */
function backAt(prof, ref, from, span, run, tol) {
  let n = 0;
  for (let k = from; k < Math.min(prof.length, from + span); k++) {
    if (prof[k] && rgbDist(prof[k], ref) < tol) { if (++n >= run) return k - run + 1; } else n = 0;
  }
  return -1;
}

/**
 * Refine the quad's sides at full resolution: per side ~64 profiles across the edge, the sub-pixel position of the
 * card's edge step (edgeStep; edges whose brightness step has the minority sign are dropped), then a robust line fit.
 * A side without enough good points keeps its coarse line.
 */
export function refineQuad(img, quad, { searchPx } = {}) {
  const center = [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2];
  const longSide = Math.max(Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]), 1);
  const r = searchPx ?? Math.max(3, Math.min(0.015 * longSide, (4 * Math.max(img.width, img.height)) / DETECT_SIDE));
  const step = 0.5;
  // A stronger step within 0.2 mm outside the first one is the same edge (a light rim along the cut, the card's core).
  const merge = Math.round((0.2 * longSide) / 88 / step);
  // Profiles start 0.35 mm further in, in the card's border even when the coarse side is on a holder line just outside.
  const rIn = r + (0.35 * longSide) / 88;
  const lines = [];
  /** Per side (0 top, 1 right, 2 bottom, 3 left), the sub-pixel edge points that agree with the fitted line. */
  const edgePoints = [];
  let points = 0;
  let widths = [];
  for (let s = 0; s < 4; s++) {
    const p = quad[s]; const q = quad[(s + 1) % 4];
    const dx = q[0] - p[0]; const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len; let ny = dx / len;
    const mid = [p[0] + dx / 2, p[1] + dy / 2];
    if ((center[0] - mid[0]) * nx + (center[1] - mid[1]) * ny > 0) { nx = -nx; ny = -ny; } // normal points outward
    const found = [];
    const K = 64;
    for (let k = 0; k < K; k++) {
      const t = 0.1 + (0.8 * k) / (K - 1);
      const bx = p[0] + dx * t; const by = p[1] + dy * t;
      const prof = [];
      for (let o = -rIn; o <= r + 1e-9; o += step) prof.push(sampleRgb(img, bx + nx * o, by + ny * o));
      let bi = -1; let bv = 0;
      const dv = [];
      for (let i = 1; i < prof.length; i++) {
        const u = prof[i - 1]; const v = prof[i];
        const d = u && v ? Math.hypot(v[0] - u[0], v[1] - u[1], v[2] - u[2]) : 0;
        dv.push(d);
        if (d > bv) { bv = d; bi = i - 1; }
      }
      if (bi < 0 || bv < 3) continue;
      bi = edgeStep(prof, dv, bi, bv, merge, longSide / 88 / step);
      // Parabolic peak between samples bi-1, bi, bi+1 of the step curve.
      const y0 = dv[bi - 1] ?? dv[bi]; const y1 = dv[bi]; const y2 = dv[bi + 1] ?? dv[bi];
      const den = y0 - 2 * y1 + y2;
      const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
      const o = -rIn + (bi + 0.5 + frac) * step;
      const lumIn = prof[bi] ? prof[bi][0] * 0.3 + prof[bi][1] * 0.59 + prof[bi][2] * 0.11 : 0;
      const lumOut = prof[bi + 1] ? prof[bi + 1][0] * 0.3 + prof[bi + 1][1] * 0.59 + prof[bi + 1][2] * 0.11 : 0;
      // 10-90 % width of the step (sharpness), in source pixels, over the ±r window.
      const w0 = Math.round((rIn - r) / step);
      const total = dv.reduce((a, v, i) => (i >= w0 ? a + v : a), 0);
      let acc = 0; let i10 = w0; let i90 = dv.length - 1;
      for (let i = w0; i < dv.length; i++) { acc += dv[i]; if (acc < 0.1 * total) i10 = i; if (acc <= 0.9 * total) i90 = i; }
      found.push({ pt: [bx + nx * o, by + ny * o], sign: Math.sign(lumOut - lumIn), width: (i90 - i10 + 1) * step });
    }
    const plus = found.filter((f) => f.sign > 0).length;
    const keepSign = plus >= found.length - plus ? 1 : -1;
    const good = found.filter((f) => f.sign === keepSign || f.sign === 0);
    const fit = good.length >= K * 0.4 ? fitLine(good.map((f) => f.pt), { minResidual: 0.6 }) : null;
    if (fit && fit.inliers >= K * 0.35) {
      lines.push(fit);
      points += fit.inliers;
      widths = widths.concat(good.map((f) => f.width));
      // Kept for the local edge position (a lens or a bent card curves the edge; the line can't follow that).
      // Only points near the line that agree with their neighbours: a curve is smooth and shallow, a jump to a holder
      // line or a rim is not.
      const lim = Math.max(1.5, Math.min(3 * fit.rms, (0.15 * longSide) / 88));
      const res = good.map(({ pt: [x, y] }) => fit.a * x + fit.b * y - fit.c);
      edgePoints.push(good.map((f) => f.pt).filter((_, i) => {
        const near = res.slice(Math.max(0, i - 3), i + 4).sort((u, v) => u - v);
        return Math.abs(res[i]) <= lim && Math.abs(res[i] - near[near.length >> 1]) <= 1.5;
      }));
    } else {
      lines.push(lineThrough(p, q));
      edgePoints.push([]);
    }
  }
  const corners = [];
  for (let s = 0; s < 4; s++) {
    const c = intersect(lines[(s + 3) % 4], lines[s]);
    if (!c) return { quad, refined: false, edgeWidthPx: null };
    corners.push(c);
  }
  // A refinement that moved a corner by more than a few search radii found the wrong edge: keep the coarse quad.
  const moved = Math.max(...corners.map((c, i) => Math.hypot(c[0] - quad[i][0], c[1] - quad[i][1])));
  if (moved > 4 * r || !isConvex(corners)) return { quad, refined: false, edgeWidthPx: null };
  widths.sort((a, b) => a - b);
  return { quad: corners, refined: points > 0, edgeWidthPx: widths.length ? widths[widths.length >> 1] : null, skew: quadSkew(corners), edgePoints };
}
