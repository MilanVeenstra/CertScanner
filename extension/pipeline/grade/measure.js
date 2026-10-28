// Grade check measurements on a found card. Pure and DOM-free.
//  - warpCard: perspective-correct the card into an upright image (never upscaled; long side at most WARP_MAX px).
//  - measureBorders: per side, 9 stretches; per stretch the median colour at each depth from the cut edge (CIE Lab);
//    the border ends at the first clear colour step that leaves the border colour for good and that most stretches
//    share (sub-pixel; text printed in the border is passed over). The mean of the agreeing stretches gives the width,
//    their spread the uncertainty.
//  - centeringFrom: left/right and top/bottom ratios with propagated uncertainty, as graders write them (55/45).
import { homography, applyH } from './geometry.js';
import { sampleRgb } from './detect.js';

export const CARD_MM = Object.freeze({ width: 63, height: 88 });
export const WARP_MAX = 2600;
export const WARP_MIN = 240;
export const SIDES = Object.freeze(['left', 'right', 'top', 'bottom']);
const SEGMENTS = 9;

/**
 * Upright card image from the photo. `quad` = TL, TR, BR, BL in source pixels.
 * @returns {{data:Uint8ClampedArray, width:number, height:number, scale:number}} scale = warped px per source px
 */
export function warpCard(img, quad, { maxHeight = WARP_MAX } = {}) {
  const longSide = (Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]) + Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1])) / 2;
  const height = Math.round(Math.max(WARP_MIN, Math.min(maxHeight, longSide)));
  const width = Math.round((height * CARD_MM.width) / CARD_MM.height);
  const H = homography([[0, 0], [width, 0], [width, height], [0, height]], quad);
  const data = new Uint8ClampedArray(width * height * 4);
  if (!H) return { data, width, height, scale: height / longSide };
  const { data: src, width: W, height: Hs } = img;
  let j = 0;
  for (let y = 0; y < height; y++) {
    const v = y + 0.5;
    for (let x = 0; x < width; x++, j += 4) {
      const [sx, sy] = applyH(H, x + 0.5, v);
      // Bilinear sample; outside the photo (a corner cut off by the frame) stays transparent black.
      const fx = sx - 0.5; const fy = sy - 0.5;
      if (fx < -0.5 || fy < -0.5 || fx > W - 0.5 || fy > Hs - 0.5) continue;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))); const y0 = Math.max(0, Math.min(Hs - 2, Math.floor(fy)));
      const ax = Math.max(0, Math.min(1, fx - x0)); const ay = Math.max(0, Math.min(1, fy - y0));
      const i00 = (y0 * W + x0) * 4; const i10 = i00 + 4; const i01 = i00 + W * 4; const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] * (1 - ax) + src[i10 + c] * ax;
        const bot = src[i01 + c] * (1 - ax) + src[i11 + c] * ax;
        data[j + c] = top * (1 - ay) + bot * ay;
      }
      data[j + 3] = 255;
    }
  }
  return { data, width, height, scale: height / longSide };
}

// sRGB -> CIE Lab (D65).
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
export function toLab(r, g, b) {
  const R = LIN[r | 0]; const G = LIN[g | 0]; const B = LIN[b | 0];
  const x = fLab((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = fLab(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = fLab((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const dE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
let sortBuf = new Float64Array(256);
/** Median (upper middle) of the first `n` values; numeric typed-array sort, much faster than Array#sort on hot paths. */
const median = (a, n = a.length) => {
  if (!n) return NaN;
  if (sortBuf.length < n) sortBuf = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) sortBuf[i] = a[i];
  return sortBuf.subarray(0, n).sort()[n >> 1];
};

/**
 * Border width per side of the upright card. Each side is cut into SEGMENTS stretches; per stretch, the colour at
 * every depth from the cut edge is the median over the stretch (print dots, text and noise average out). The border
 * ends at the first clear colour step after which the colour stays unlike the border: a thin line inside the border
 * (the colour comes back) does not end it; a soft printed gradient ends where the coarse step is steepest (halfway).
 * The side's width is the median over the stretches; stretches that disagree (art over the border) are left out.
 * @returns {{pxPerMm:number, sides:Record<string, {ok:boolean, px:number, mm:number, sigmaPx:number, n:number, spreadMm:number,
 *   glare:number, edgeWidthPx:number|null, reason?:string}>}}
 */
export function measureBorders(card, { outer = null } = {}) {
  const s = card.height / CARD_MM.height;
  const d0 = Math.max(1, Math.round(0.3 * s)); // skip the cut edge: anti-aliasing, whitening, background bleed
  const r0 = Math.max(d0, Math.round(0.45 * s)); // border colour band: 0.45-1.25 mm in
  const refBand = Math.max(2, Math.round(0.8 * s));
  const dMax = Math.min(Math.round(11.5 * s), Math.floor(0.3 * card.width));
  const step = Math.max(1, Math.round(0.12 * s)); // along the side
  const k = Math.max(1, Math.round(0.06 * s)); // fine step: ΔE between depth d-k and d+k
  const K = Math.max(2, Math.round(0.3 * s)); // coarse step, for soft printed gradients
  const after0 = Math.max(2, Math.round(0.15 * s)); const after1 = Math.max(after0 + 2, Math.round(0.6 * s));
  const cluster = Math.max(2, Math.round(0.15 * s));
  const sides = {};
  for (const side of SIDES) {
    const along = side === 'left' || side === 'right' ? card.height : card.width;
    const outerPts = outer?.[side] ?? [];
    const outerAt = (pos) => {
      const near = outerPts.filter((q) => Math.abs(q[0] - pos) <= 0.06 * along).map((q) => q[1]);
      return near.length >= 3 ? Math.max(-1.5 * s, Math.min(1.0 * s, median(near))) : 0;
    };
    const segs = []; const segRefs = []; const segBounds = []; const segP = []; const segOa = []; let glareN = 0; let refN = 0;
    for (let g = 0; g < SEGMENTS; g++) {
      const a0 = Math.round(along * (0.12 + (0.76 * g) / SEGMENTS));
      const a1 = Math.round(along * (0.12 + (0.76 * (g + 1)) / SEGMENTS));
      const P = depthProfile(card, side, a0, a1, step, dMax);
      // The border's colour, a little way in: a shadow or a light rim along the cut edge is not the border.
      const refs = P.slice(r0, r0 + refBand).filter(Boolean);
      if (refs.length < refBand / 2) continue;
      const ref = [0, 1, 2].map((c) => median(refs.map((v) => v[c])));
      segRefs.push(ref);
      // Glare: blown-out pixels in the band right inside the cut edge (a coloured border only).
      if (ref[0] < 85) {
        for (let a = a0; a < a1; a += step * 2) for (let d = r0; d < r0 + refBand; d++) {
          const c = labAtPx(card, side, d, a);
          if (!c) continue;
          refN++; if (c[0] > 95 && Math.hypot(c[1], c[2]) < 8) glareN++;
        }
      }
      const far = (from, to) => {
        const v = P.slice(Math.max(0, from), Math.min(P.length, to)).filter(Boolean);
        return v.length ? dE([0, 1, 2].map((c) => median(v.map((x) => x[c]))), ref) : 0;
      };
      const grad = (r) => P.map((_, d) => (P[d - r] && P[d + r] ? dE(P[d + r], P[d - r]) : 0));
      const gf = grad(k); const gc = grad(K);
      const lo = d0 + Math.max(1, k); const hi = dMax - after1 - 1;
      const gmax = Math.max(0, ...gf.slice(lo, Math.min(hi, Math.round(7 * s))));
      const e = P.map((v) => (v ? dE(v, ref) : NaN));
      // Every step that leaves the border colour for good: sharp ones, and coarse ones with no sharp one near (soft
      // printed gradients).
      // Sharp steps closer together than `cluster` are one edge (a sharpened photo rings beside it): keep its peak.
      const peaks = [];
      for (let d = lo; d <= hi; d++) if (gf[d] >= 5 && gf[d] >= gf[d - 1] && gf[d] > gf[d + 1]) peaks.push(d);
      const sharpAt = new Set();
      for (let i = 0; i < peaks.length;) {
        let j = i; let top = peaks[i];
        while (j + 1 < peaks.length && peaks[j + 1] - peaks[j] <= cluster) { j++; if (gf[peaks[j]] > gf[top]) top = peaks[j]; }
        if (gf[top] >= 0.2 * gmax) sharpAt.add(top);
        i = j + 1;
      }
      const ends = [];
      for (let d = lo; d <= hi; d++) {
        let gg = null; let r = k;
        if (sharpAt.has(d)) gg = gf;
        else if (gc[d] >= 10 && gc[d] >= gc[d - 1] && gc[d] > gc[d + 1] && !peaks.some((p) => Math.abs(p - d) <= K + cluster)) { gg = gc; r = K; }
        // The colour must leave the border colour and stay away (text or a thin line in the border comes back).
        if (!gg || far(d + after0 + (r - k), d + after1 + (r - k)) < 10 || far(d + after1 + (r - k), d + 2 * after1 + (r - k)) < 6) continue;
        const den = gg[d - 1] - 2 * gg[d] + gg[d + 1];
        const frac = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (gg[d - 1] - gg[d + 1])) / den)) : 0;
        // 10-90 % rise width of the step (sharpness), from the colour distance to the border colour.
        const top = far(d + after0, d + after1);
        let x = d; while (x > d0 && e[x] >= 0.1 * top) x--;
        let y = d; while (y < e.length - 1 && e[y] < 0.9 * top) y++;
        const at = d + 0.5 + frac;
        ends.push({ w: at - outerAt((a0 + a1) / 2), sharp: y - x, d, sharpStep: gg === gf });
      }
      segs.push(ends);
      segBounds.push([a0, a1]); segP.push(P); segOa.push(outerAt((a0 + a1) / 2));
    }
    // The border ends at the first depth where most stretches have a step (text or a logo in the border, or art that
    // crosses it, steps in a few stretches only); each stretch then gives its step nearest that depth.
    const tol = Math.max(1.5, 0.2 * s);
    const need = Math.max(3, Math.ceil(0.5 * segs.length));
    const all = segs.flat().map((x) => x.w).sort((p, q) => p - q);
    const has = (ends, w) => ends.some((x) => Math.abs(x.w - w) <= tol);
    const support = (w) => segs.filter((ends) => has(ends, w)).length;
    // A step lies inside the border, not at its end (the copyright line in the bottom border of modern cards, a thin
    // line), when the stretches without it keep the border's colour well past it and nearly every stretch has a step
    // shortly after. Art that hides the border's end in some stretches leaves no such pattern.
    const insideBorder = (w) => {
      const sw = support(w);
      if (!all.some((w2) => w2 > w + tol && w2 <= w + 1.6 * s && support(w2) >= Math.max(need, segs.length - 2, sw + 1))) return false;
      let lack = 0; let cont = 0;
      segs.forEach((ends, i) => {
        if (has(ends, w)) return;
        const next = ends.find((x) => x.w > w + tol)?.w ?? Infinity;
        const from = Math.round(w + segOa[i] + Math.max(tol, 0.2 * s));
        const to = Math.min(Math.round(Math.min(next - cluster, w + 0.7 * s) + segOa[i]), segP[i].length - 1);
        if (to - from < 0.2 * s) return; // too little room before its own next step to tell
        const v = [];
        for (let d = from; d <= to; d++) if (segP[i][d]) v.push(dE(segP[i][d], segRefs[i]));
        if (!v.length) return;
        lack++;
        if (median(v) < 5) cont++;
      });
      return cont >= 2 && cont >= 0.5 * lack;
    };
    let depth;
    for (const w of all) {
      if (support(w) < need) continue;
      if (!insideBorder(w)) { depth = w; break; }
    }
    const widths = []; const edgeW = []; const used = [];
    if (depth !== undefined) {
      segs.forEach((ends, i) => {
        const near = ends.filter((x) => Math.abs(x.w - depth) <= tol).sort((p, q) => Math.abs(p.w - depth) - Math.abs(q.w - depth))[0];
        if (!near) return;
        // Where the light itself is halfway between the two colours (the steepest colour change sits off-centre on a
        // blurred edge toward the darker side).
        const shift = near.sharpStep ? linearMidpoint(card, side, segBounds[i], step, near.d, k) : null;
        widths.push(shift === null ? near.w : near.w + shift);
        edgeW.push(near.sharp); used.push(segRefs[i]);
      });
    }
    // A border has one colour along the side; art that reaches the cut changes colour from stretch to stretch.
    const mid = [0, 1, 2].map((c) => median(used.map((v) => v[c])));
    const colourSpread = used.length ? median(used.map((v) => dE(v, mid))) : 0;
    const found = widths.length;
    const glare = refN ? glareN / refN : 0;
    if (found < need) { sides[side] = { ok: false, reason: 'no-edge', n: found, glare, colourSpread }; continue; }
    const m = median(widths);
    const mad = 1.4826 * median(widths.map((w) => Math.abs(w - m)));
    const limit = Math.max(3 * mad, 0.15 * s, 0.75);
    const inl = widths.filter((w) => Math.abs(w - m) <= limit);
    const mean = inl.reduce((t, v) => t + v, 0) / inl.length;
    const sd = Math.sqrt(inl.reduce((t, v) => t + (v - mean) ** 2, 0) / Math.max(1, inl.length - 1));
    const n = inl.length;
    let reason;
    if (colourSpread > 20) reason = 'not-a-border';
    else if (n < need || n < found * 0.6) reason = 'inconsistent';
    else if (mean < 0.25 * s || mean > 11 * s) reason = 'implausible';
    sides[side] = {
      ok: !reason, reason, px: mean, mm: mean / s, sigmaPx: Math.max(sd, 0.25 * k) / Math.sqrt(n), n, spreadMm: sd / s, glare,
      edgeWidthPx: edgeW.length ? median(edgeW) : null, colourSpread, lab: mid,
    };
  }
  return { pxPerMm: s, sides };
}

/**
 * Sub-pixel correction (px) for a sharp step found at depth `d`: where the median linear-light colour of the stretch
 * crosses halfway between the colours just before and just after the step. Null when it can't be placed.
 */
function linearMidpoint(card, side, [a0, a1], step, d, k) {
  const at = (depth) => {
    const R = []; const G = []; const B = [];
    for (let a = a0; a < a1; a += step) {
      const j = pixelIndex(card, side, depth, a);
      if (j < 0) continue;
      R.push(LIN[card.data[j]]); G.push(LIN[card.data[j + 1]]); B.push(LIN[card.data[j + 2]]);
    }
    return R.length >= 3 ? [median(R), median(G), median(B)] : null;
  };
  const lo = d - k - 3; const hi = d + k + 3;
  const A = at(lo); const Z = at(hi);
  if (!A || !Z) return null;
  const v = [Z[0] - A[0], Z[1] - A[1], Z[2] - A[2]];
  const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (vv < 1e-4) return null;
  let prev = 0;
  for (let i = lo + 1; i <= hi; i++) {
    const c = at(i);
    if (!c) return null;
    const t = ((c[0] - A[0]) * v[0] + (c[1] - A[1]) * v[1] + (c[2] - A[2]) * v[2]) / vv;
    if (prev <= 0.5 && t > 0.5) {
      const pos = i - 1 + 0.5 + (0.5 - prev) / (t - prev); // between pixel centres i-1 and i
      return Math.abs(pos - (d + 0.5)) <= k + 1.5 ? pos - (d + 0.5) : null;
    }
    prev = t;
  }
  return null;
}

/** Data index of one warped pixel `d` px deep from `side` at position `a` along it; -1 outside the photo. */
function pixelIndex(card, side, d, a) {
  const { data, width: W, height: H } = card;
  const x = side === 'left' ? d : side === 'right' ? W - 1 - d : a;
  const y = side === 'top' ? d : side === 'bottom' ? H - 1 - d : a;
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  const j = (y * W + x) * 4;
  return data[j + 3] === 0 ? -1 : j;
}

/** Lab of one warped pixel `d` px deep from `side` at position `a` along it; null outside the photo. */
function labAtPx(card, side, d, a) {
  const { data, width: W, height: H } = card;
  const x = side === 'left' ? d : side === 'right' ? W - 1 - d : a;
  const y = side === 'top' ? d : side === 'bottom' ? H - 1 - d : a;
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const j = (y * W + x) * 4;
  return data[j + 3] === 0 ? null : toLab(data[j], data[j + 1], data[j + 2]);
}

/** Per depth 0..dMax from `side`: the median Lab colour over positions a0..a1 (every `step` px); null if none. */
function depthProfile(card, side, a0, a1, step, dMax) {
  const out = [];
  const cap = Math.ceil((a1 - a0) / step) + 1;
  const L = new Float64Array(cap); const A = new Float64Array(cap); const B = new Float64Array(cap);
  for (let d = 0; d <= dMax; d++) {
    let n = 0;
    for (let a = a0; a < a1; a += step) {
      const c = labAtPx(card, side, d, a);
      if (c) { L[n] = c[0]; A[n] = c[1]; B[n] = c[2]; n++; }
    }
    out.push(n >= 3 ? [median(L, n), median(A, n), median(B, n)] : null);
  }
  return out;
}

/** Disney Lorcana prints its bottom border this much wider than the top one (the artist, number and copyright line). */
export const LORCANA_BOTTOM_EXTRA_MM = 3.2;

/**
 * A card layout whose borders differ by design, from the measured borders: Lorcana (black all round, the bottom border
 * 3.2 mm wider than the top; top and bottom together 9-10 mm whatever the cut, against 5-7 mm on other games' cards,
 * left and right 5-6 mm; a very small photo reads every border a little narrow).
 * Returns {name, shift} with `shift` in warped px for centeringFrom (+ moves width from the second side to the first;
 * the card may lie upside down), or null.
 */
export function cardLayout(sides, pxPerMm) {
  if (!SIDES.every((n) => sides[n]?.ok && sides[n].lab)) return null;
  if (!SIDES.every((n) => sides[n].lab[0] < 25 && Math.hypot(sides[n].lab[1], sides[n].lab[2]) < 15)) return null;
  const t = sides.top.mm; const b = sides.bottom.mm; const lr = sides.left.mm + sides.right.mm;
  // A miscut moves width from one side to the other but keeps the sum; up to about 65/35 against the layout.
  const diff = Math.abs(b - t);
  if (t + b < 7.2 || t + b > 11.5 || lr < 4.4 || lr > 7.2 || diff < 0.4 || diff > 6) return null;
  const d = (LORCANA_BOTTOM_EXTRA_MM / 2) * pxPerMm;
  return { name: 'lorcana', extraMm: LORCANA_BOTTOM_EXTRA_MM, shift: { tb: b > t ? d : -d } };
}

/**
 * Centering ratios from border widths. pct = the wider border's share of both (55 means 55/45).
 * `scale` = warped px per source px; `sysPx` = systematic error per border in source px (edge fit, warp); `shift`: a
 * layout's designed difference ({lr, tb}, warped px; cardLayout).
 * @returns {{lr:object|null, tb:object|null, worst:object|null}}
 */
export function centeringFrom(sides, { scale = 1, sysPx = 0.5, floorPct = 0.3, shift = null } = {}) {
  const sys = Math.hypot(0.35, sysPx * scale); // warped px
  const axis = (a, b, names, d = 0) => {
    const A = sides[a]; const B = sides[b];
    if (!A?.ok || !B?.ok) return null;
    const sA = Math.hypot(A.sigmaPx ?? 0, sys); const sB = Math.hypot(B.sigmaPx ?? 0, sys);
    // A layout that prints one border wider by design is centred when both are equal after taking `d` from it.
    const pa = A.px + d; const pb = B.px - d;
    const tot = pa + pb;
    const share = Math.max(pa, pb) / tot;
    const sigma = Math.hypot((Math.sqrt((pb * sA) ** 2 + (pa * sB) ** 2) / tot ** 2) * 100, floorPct);
    return { pct: share * 100, sigma, wide: pa >= pb ? names[0] : names[1], a: A.px, b: B.px };
  };
  const lr = axis('left', 'right', ['left', 'right'], shift?.lr ?? 0);
  const tb = axis('top', 'bottom', ['top', 'bottom'], shift?.tb ?? 0);
  const worst = [lr && { axis: 'lr', ...lr }, tb && { axis: 'tb', ...tb }].filter(Boolean).sort((p, q) => q.pct - p.pct)[0] ?? null;
  return { lr, tb, worst };
}

/** "55/45" for a share of 55.2 (rounded to whole points; the larger number first). */
export function ratioText(pct) {
  const a = Math.round(Math.max(50, Math.min(100, pct)));
  return `${a}/${100 - a}`;
}

/** Re-measure widths for a hand-placed line: width in warped px from the cut edge, uncertainty 0.75 px. */
export function manualSide(px, pxPerMm) {
  return { ok: px > 0, px, mm: px / pxPerMm, sigmaPx: 0.75, n: 1, spreadMm: 0, glare: 0, edgeWidthPx: null, manual: true };
}

export { sampleRgb };
