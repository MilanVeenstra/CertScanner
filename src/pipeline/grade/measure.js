// Grade check measurements on a found card. Pure and DOM-free.
//  - warpCard: perspective-correct the card into an upright image (never upscaled; long side at most WARP_MAX px).
//  - measureBorders: per side ~72 profiles from the cut edge inward; the border ends where the colour leaves the
//    border colour (CIE ΔE, half-height crossing, sub-pixel). Robust statistics per side give width and uncertainty.
//  - centeringFrom: left/right and top/bottom ratios with propagated uncertainty, as graders write them (55/45).
import { homography, applyH } from './geometry.js';
import { sampleRgb } from './detect.js';

export const CARD_MM = Object.freeze({ width: 63, height: 88 });
export const WARP_MAX = 2000;
export const WARP_MIN = 240;
export const SIDES = Object.freeze(['left', 'right', 'top', 'bottom']);
const PROFILES = 72;

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
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const quantile = (a, f) => { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

/** Lab colour of warped pixel `i` px deep from side `side`, at position `pos` along it, averaged over 3 px along the side. */
function labAt(card, side, i, pos) {
  const { data, width: W, height: H } = card;
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let o = -1; o <= 1; o++) {
    const p = pos + o;
    let x; let y;
    if (side === 'left') { x = i; y = p; } else if (side === 'right') { x = W - 1 - i; y = p; } else if (side === 'top') { x = p; y = i; } else { x = p; y = H - 1 - i; }
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const j = (y * W + x) * 4;
    if (data[j + 3] === 0) continue; // outside the photo
    r += data[j]; g += data[j + 1]; b += data[j + 2]; n++;
  }
  return n ? toLab(r / n, g / n, b / n) : null;
}

/**
 * Border width per side of the upright card.
 * @returns {{pxPerMm:number, sides:Record<string, {ok:boolean, px:number, mm:number, sigmaPx:number, n:number, spreadMm:number,
 *   glare:number, edgeWidthPx:number|null, reason?:string}>}}
 */
export function measureBorders(card) {
  const s = card.height / CARD_MM.height;
  const d0 = Math.max(1, Math.round(0.3 * s)); // skip the cut edge: anti-aliasing, whitening, background bleed
  const refBand = Math.max(2, Math.round(0.4 * s));
  const dMax = Math.min(Math.round(12 * s), Math.floor(0.3 * card.width));
  const sides = {};
  for (const side of SIDES) {
    const along = side === 'left' || side === 'right' ? card.height : card.width;
    const positions = [];
    for (let k = 0; k < PROFILES; k++) positions.push(Math.round(along * (0.12 + (0.76 * k) / (PROFILES - 1))));
    // Reference: the border colour right inside the cut edge.
    const ref = [];
    for (const pos of positions) for (let i = d0; i < d0 + refBand; i++) { const c = labAt(card, side, i, pos); if (c) ref.push(c); }
    if (ref.length < 20) { sides[side] = { ok: false, reason: 'outside' }; continue; }
    const refLab = [median(ref.map((c) => c[0])), median(ref.map((c) => c[1])), median(ref.map((c) => c[2]))];
    const noise = quantile(ref.map((c) => dE(c, refLab)), 0.9);
    const T = Math.max(10, 3 * noise);
    const glareCount = ref.filter((c) => c[0] > 95 && Math.hypot(c[1], c[2]) < 8).length;
    const glare = refLab[0] < 85 ? glareCount / ref.length : 0;
    const widths = [];
    const edgeW = [];
    const persist = Math.max(2, Math.round(0.1 * s));
    const plateauLen = Math.max(3, Math.round(0.3 * s));
    for (const pos of positions) {
      const e = [];
      for (let i = 0; i <= dMax; i++) { const c = labAt(card, side, i, pos); e.push(c ? dE(c, refLab) : NaN); }
      let first = -1;
      for (let i = d0 + 1; i + persist < e.length; i++) {
        let ok = true;
        for (let k = 0; k < persist; k++) if (!(e[i + k] >= T)) { ok = false; break; }
        if (ok) { first = i; break; }
      }
      if (first < 0) continue;
      // The border ends at the steepest rise of ΔE next to the first crossing (unbiased for a blurred step, whatever
      // colour follows); parabolic sub-pixel peak. D[k] = e[k+1] - e[k] sits at depth k + 1 (between pixel centres).
      const win = Math.max(2, Math.round(0.15 * s));
      let k = -1; let best = 0;
      for (let i = Math.max(d0, first - win); i <= first + win && i + 1 < e.length; i++) {
        const d = e[i + 1] - e[i];
        if (d > best) { best = d; k = i; }
      }
      if (k < 0) continue;
      const dm = k > d0 ? e[k] - e[k - 1] : best;
      const dp = k + 2 < e.length ? e[k + 2] - e[k + 1] : best;
      const den = dm - 2 * best + dp;
      const delta = den < 0 && Number.isFinite(den) ? Math.max(-0.5, Math.min(0.5, (0.5 * (dm - dp)) / den)) : 0;
      widths.push(k + 1 + delta);
      // 10-90 % rise width of this transition (sharpness).
      const plateau = Math.max(...e.slice(first, first + plateauLen).filter(Number.isFinite));
      let a = k; while (a > d0 && e[a] >= 0.1 * plateau) a--;
      let b = k + 1; while (b < e.length - 1 && e[b] < 0.9 * plateau) b++;
      edgeW.push(b - a);
    }
    const found = widths.length;
    if (found < PROFILES * 0.4) { sides[side] = { ok: false, reason: 'no-edge', n: found, glare }; continue; }
    const m = median(widths);
    const mad = 1.4826 * median(widths.map((w) => Math.abs(w - m)));
    const limit = Math.max(3 * mad, 0.75, 0.05 * s);
    const inl = widths.filter((w) => Math.abs(w - m) <= limit);
    const mean = inl.reduce((a, v) => a + v, 0) / inl.length;
    const sd = Math.sqrt(inl.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, inl.length - 1));
    const n = inl.length;
    let reason;
    if (n < PROFILES * 0.4 || n < found * 0.6) reason = 'inconsistent';
    else if (mean < 0.25 * s || mean > 11 * s) reason = 'implausible';
    sides[side] = {
      ok: !reason, reason, px: mean, mm: mean / s, sigmaPx: sd / Math.sqrt(n), n, spreadMm: sd / s, glare,
      edgeWidthPx: edgeW.length ? median(edgeW) : null,
    };
  }
  return { pxPerMm: s, sides };
}

/**
 * Centering ratios from border widths. pct = the wider border's share of both (55 means 55/45).
 * `scale` = warped px per source px; `sysPx` = systematic error per border in source px (edge fit, warp).
 * @returns {{lr:object|null, tb:object|null, worst:object|null}}
 */
export function centeringFrom(sides, { scale = 1, sysPx = 0.5, floorPct = 0.3 } = {}) {
  const sys = Math.hypot(0.35, sysPx * scale); // warped px
  const axis = (a, b, names) => {
    const A = sides[a]; const B = sides[b];
    if (!A?.ok || !B?.ok) return null;
    const sA = Math.hypot(A.sigmaPx ?? 0, sys); const sB = Math.hypot(B.sigmaPx ?? 0, sys);
    const tot = A.px + B.px;
    const share = Math.max(A.px, B.px) / tot;
    const sigma = Math.hypot((Math.sqrt((B.px * sA) ** 2 + (A.px * sB) ** 2) / tot ** 2) * 100, floorPct);
    return { pct: share * 100, sigma, wide: A.px >= B.px ? names[0] : names[1], a: A.px, b: B.px };
  };
  const lr = axis('left', 'right', ['left', 'right']);
  const tb = axis('top', 'bottom', ['top', 'bottom']);
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
