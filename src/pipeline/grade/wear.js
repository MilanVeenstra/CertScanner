// Wear seen on the device (grade check): whitening along the four edges and around the corners, and each corner's
// shape. Works on the upright card from warpCard; pure and DOM-free, a few milliseconds per side.
//  - Whitening is paper showing where the print is worn. A pixel counts when it is lighter than both the printed border
//    and the background next to the card (so the blend of the two along the cut edge never counts), clearly so, and
//    (on a coloured border) much less coloured. The same position a little deeper in the border must look normal:
//    glare and light print spread inward, edge wear doesn't.
//  - Corner shape: rays from the centre of each corner's curve find where the card ends. A corner whose outline lies
//    inside the curve the other corners share is dinged, soft or missing its tip.
// What it cannot see is reported as such: too few pixels per mm, a light background or a pale (white, silver) border,
// a photo cropped to the card (no background), or a corner outside the photo. Surface is not judged here.
import { toLab, SIDES } from './measure.js';
import { sampleRgb } from './detect.js';

/** Below this many pixels per mm on the card, wear is not judged at all. */
export const WEAR_MIN_PX_PER_MM = 7;
const CORNER_R_MM = 3.2; // nominal corner radius of standard trading cards; the photo's own radius is measured
const EDGE_SKIP_MM = 4.5; // within this distance of a corner an edge belongs to the corner
export const CORNERS = Object.freeze(['tl', 'tr', 'br', 'bl']);
const CORNER_SIDES = { tl: ['top', 'left'], tr: ['top', 'right'], br: ['bottom', 'right'], bl: ['bottom', 'left'] };

const dE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const chroma = (lab) => Math.hypot(lab[1], lab[2]);

function labPx(card, x, y) {
  const { data, width: W, height: H } = card;
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  const j = (y * W + x) * 4;
  if (data[j + 3] === 0) return null; // outside the photo
  return toLab(data[j], data[j + 1], data[j + 2]);
}

/** Pixel `i` deep from side `side` at position `pos` along it (integer warped-pixel coordinates). */
function sidePx(card, side, i, pos) {
  const { width: W, height: H } = card;
  if (side === 'left') return labPx(card, i, pos);
  if (side === 'right') return labPx(card, W - 1 - i, pos);
  if (side === 'top') return labPx(card, pos, i);
  return labPx(card, pos, H - 1 - i);
}

/**
 * The whitening test for one border: lighter than the lighter of border and background by a margin, and on a
 * coloured border, far less coloured. Null when whitening could not stand out (pale border or light background).
 */
export function whiteningTest(ref, bg) {
  const refC = chroma(ref);
  const lighter = Math.max(ref[0], bg[0]);
  if (lighter > 85) return { reason: 'light' };
  if (ref[0] > 62 && refC < 14) return { reason: 'pale-border' }; // silver, grey or white borders hide whitening
  if (refC > 20) {
    // Coloured border (yellow, blue, red...): paper is far less coloured and at least as light as the border, and
    // lighter than the background. A blend with the background is darker than the border or than the background.
    const minL = Math.max(ref[0] - 3, bg[0] + 8);
    return { test: (lab) => chroma(lab) < 0.5 * refC && lab[0] > minL };
  }
  // Dark neutral border (black): paper is much lighter than both border and background.
  const thrL = lighter + Math.max(8, 0.3 * (100 - lighter));
  return { test: (lab) => lab[0] > thrL };
}

/** Border colour of one side: median Lab a little inside the cut edge. */
function sideRef(card, side, s, borderMm) {
  const along = side === 'left' || side === 'right' ? card.height : card.width;
  const d0 = Math.max(1, Math.round(0.5 * s));
  const d1 = Math.max(d0, Math.round(Math.min(1.0, 0.6 * borderMm) * s));
  const L = []; const A = []; const B = [];
  for (let pos = Math.round(along * 0.1); pos < along * 0.9; pos += 3) {
    for (let i = d0; i <= d1; i++) { const c = sidePx(card, side, i, pos); if (c) { L.push(c[0]); A.push(c[1]); B.push(c[2]); } }
  }
  return L.length >= 20 ? [median(L), median(A), median(B)] : null;
}

/** Runs of true values (gaps of one position bridged) at least `minLen` long: [[from, to], ...] (inclusive). */
export function runsOf(flags, minLen) {
  const out = [];
  let start = -1; let lastTrue = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i];
    if (on) { if (start < 0) start = i; lastTrue = i; continue; }
    if (start >= 0 && i - lastTrue > 1) { if (lastTrue - start + 1 >= minLen) out.push([start, lastTrue]); start = -1; }
  }
  if (start >= 0 && lastTrue - start + 1 >= minLen) out.push([start, lastTrue]);
  return out;
}

function edgeWear(card, side, { s, border, bg, i0, i1 }) {
  if (!border?.ok) return { status: 'unknown', reason: 'no-border' };
  if (!bg) return { status: 'unknown', reason: 'no-background' };
  const ref = sideRef(card, side, s, border.mm);
  if (!ref) return { status: 'unknown', reason: 'no-border' };
  const w = whiteningTest(ref, bg);
  if (!w.test) return { status: 'unknown', reason: w.reason };
  const along = side === 'left' || side === 'right' ? card.height : card.width;
  const skip = Math.round(EDGE_SKIP_MM * s);
  const deep = Math.max(i1 + 2, Math.round(Math.min(0.9, 0.7 * border.mm) * s));
  const flags = [];
  for (let pos = skip; pos < along - skip; pos++) {
    let hit = false;
    for (let i = i0; i <= i1 && !hit; i++) { const c = sidePx(card, side, i, pos); if (c && w.test(c)) hit = true; }
    if (hit) { const d = sidePx(card, side, deep, pos); if (d && w.test(d)) hit = false; } // spreads inward: not edge wear
    flags.push(hit);
  }
  const runs = runsOf(flags, Math.max(2, Math.round(0.12 * s))).map(([a, b]) => ({ fromMm: (a + skip) / s, toMm: (b + skip + 1) / s }));
  return { status: 'ok', runs, wornMm: runs.reduce((t, r) => t + r.toMm - r.fromMm, 0) };
}

/** Rays from the corner curve's centre: where the card ends (r, px) and whether paper shows just inside. */
function cornerRays(card, corner, { s, R0, test, i0, i1, cardRef = null, bgRef = null }) {
  const { width: W, height: H } = card;
  const sx = corner === 'tr' || corner === 'br' ? 1 : -1;
  const sy = corner === 'br' || corner === 'bl' ? 1 : -1;
  const cx = sx > 0 ? W - R0 : R0;
  const cy = sy > 0 ? H - R0 : R0;
  const rMin = 0.55 * R0; const rMax = 1.38 * R0;
  const rays = [];
  // Near 0° and 90° the curve meets the straight edges, where the upright image holds hardly any background.
  for (let deg = 24; deg <= 66; deg += 2) {
    const t = (deg * Math.PI) / 180;
    const dx = sx * Math.cos(t); const dy = sy * Math.sin(t);
    const labs = []; let cut = false;
    for (let r = rMin; r <= rMax; r += 0.5) {
      const x = cx + dx * r; const y = cy + dy * r;
      const xi = Math.floor(x); const yi = Math.floor(y);
      if (x < 0.5 || y < 0.5 || x > W - 0.5 || y > H - 0.5) break; // the image ends: the ray ends
      if (card.data[(yi * W + xi) * 4 + 3] === 0) { cut = true; break; } // the photo ends: corner cut off
      const c = sampleRgb(card, x, y);
      if (!c) break;
      labs.push(toLab(c[0], c[1], c[2]));
    }
    if (cut || labs.length < 8) { rays.push(cut ? 'cut' : null); continue; }
    // Where the card ends: the outermost point where the colour is past halfway from the border to the background
    // (a blurred edge spreads over several samples, but its midpoint stays put).
    const inC = cardRef ?? labs[0];
    const outC = bgRef ?? labs[labs.length - 1];
    if (dE(inC, outC) < 12) { rays.push(null); continue; }
    const f = labs.map((c) => { const a = dE(c, inC); const b = dE(c, outC); return a / (a + b || 1); });
    if (f[f.length - 1] < 0.6) { rays.push(null); continue; } // never reached the background
    let k = f.length - 2;
    while (k >= 0 && f[k] >= 0.5) k--;
    if (k < 0) { rays.push(null); continue; }
    const r = rMin + 0.5 * (k + (0.5 - f[k]) / ((f[k + 1] - f[k]) || 1));
    // Paper showing around the outline (whitening also shifts the midpoint, so look a little either side of it; the
    // background can't pass the test).
    let white = false;
    if (test) {
      for (let d = -Math.round(0.4 * s); d <= i1 && !white; d++) {
        const c = sampleRgb(card, cx + dx * (r - d), cy + dy * (r - d));
        if (c && test(toLab(c[0], c[1], c[2]))) white = true;
      }
    }
    rays.push({ deg, r, white });
  }
  return rays;
}

const RANK = { none: 0, minor: 1, visible: 2 };
const worst = (list) => list.reduce((w, r) => (RANK[r] > RANK[w] ? r : w), 'none');

/**
 * @param {{data:Uint8ClampedArray, width:number, height:number}} card  upright card (warpCard)
 * @param {{borders:{pxPerMm:number, sides:object}, bg:Record<string, number[]|null>, blurPx?:number}} o
 *   bg: Lab colour of the background next to each side (null where the photo shows none)
 */
export function measureWear(card, { borders, bg = {}, blurPx = 1 }) {
  const s = borders.pxPerMm;
  if (!(s >= WEAR_MIN_PX_PER_MM)) return { status: 'too-small', pxPerMm: s, edges: { rating: 'unknown', sides: {} }, corners: { rating: 'unknown', list: {} } };
  // From the cut edge itself: a blend of border and background is never lighter than both, so it can't count.
  const i0 = 0;
  const i1 = Math.max(2, Math.round(0.45 * s) + Math.round(Math.max(0, blurPx - 2) / 2));
  // Edges.
  const sides = {};
  for (const side of SIDES) sides[side] = edgeWear(card, side, { s, border: borders.sides[side], bg: bg[side] ?? null, i0, i1 });
  const okSides = SIDES.filter((n) => sides[n].status === 'ok');
  let edgeRating = 'unknown';
  if (okSides.length >= 2) {
    const runs = okSides.reduce((t, n) => t + sides[n].runs.length, 0);
    const worn = okSides.reduce((t, n) => t + sides[n].wornMm, 0);
    edgeRating = runs === 0 ? 'none' : runs >= 3 || worn >= 2 ? 'visible' : 'minor';
  }
  // Corners.
  const R0 = CORNER_R_MM * s;
  const measured = {};
  const list = {};
  for (const corner of CORNERS) {
    const [a, b] = CORNER_SIDES[corner];
    const refs = [a, b].map((n) => (borders.sides[n]?.ok ? sideRef(card, n, s, borders.sides[n].mm) : null)).filter(Boolean);
    const bgs = [a, b].map((n) => bg[n]).filter(Boolean);
    let test = null; let reason = null;
    const mean = (list) => (list.length ? list.reduce((m, r) => m.map((v, i) => v + r[i] / list.length), [0, 0, 0]) : null);
    const cardRef = mean(refs);
    const bgRef = mean(bgs);
    if (cardRef && bgRef) {
      const w = whiteningTest(cardRef, bgRef);
      test = w.test ?? null; reason = w.reason ?? null;
    } else reason = bgRef ? 'no-border' : 'no-background';
    const rays = cornerRays(card, corner, { s, R0, test, i0, i1, cardRef, bgRef });
    const valid = rays.filter((r) => r && r !== 'cut');
    if (valid.length < rays.length * 0.6) { list[corner] = { status: 'unknown', reason: rays.includes('cut') ? 'outside' : 'low-contrast' }; continue; }
    measured[corner] = { rays: valid, radius: median(valid.map((r) => r.r)), test, reason };
  }
  const radii = Object.values(measured).map((m) => m.radius);
  const ref = radii.length >= 2 ? median(radii) : NaN;
  const geometryOk = Number.isFinite(ref) && Math.abs(ref - R0) < 1.5 * s;
  const minor = Math.max(0.15 * s, 1.5); const visible = Math.max(0.3 * s, 3);
  for (const [corner, m] of Object.entries(measured)) {
    if (!geometryOk) { list[corner] = { status: 'unknown', reason: 'shape' }; continue; }
    // Missing material: the outline lies inside the shared curve. Third-largest inward deviation (robust to a stray ray).
    const dev = m.rays.map((r) => ref - r.r).sort((p, q) => q - p);
    const inward = dev[Math.min(2, dev.length - 1)];
    const whiteFrac = m.test ? m.rays.filter((r) => r.white).length / m.rays.length : null;
    let rating = inward >= visible ? 'visible' : inward >= minor ? 'minor' : 'none';
    if (whiteFrac !== null) rating = worst([rating, whiteFrac >= 0.25 ? 'visible' : whiteFrac >= 0.08 ? 'minor' : 'none']);
    list[corner] = { status: 'ok', rating, shapeMm: Math.max(0, inward) / s, whiteFrac, whitening: whiteFrac === null ? m.reason : null };
  }
  const okCorners = CORNERS.filter((c) => list[c]?.status === 'ok');
  const cornerRating = okCorners.length >= 2 ? worst(okCorners.map((c) => list[c].rating)) : 'unknown';
  return { status: 'ok', pxPerMm: s, edges: { rating: edgeRating, sides }, corners: { rating: cornerRating, list, radiusMm: geometryOk ? ref / s : null } };
}
