// Realistic card-photo and flatbed-scan simulator for the grade-check benchmark (scripts/bench-grade.mjs) and its
// regression gate (tests/unit/gradeBench.test.mjs). Pure Node, deterministic from a seed, no dependencies.
//
//  Card     stylised templates (no real artwork or logos) drawn analytically in card millimetres, with known border
//           widths per side (truth: the width at each side's midpoint), a rounded outline, print noise, a print turned
//           slightly against the cut, and optional wear (edge and corner whitening, cut, blunted or dented corners)
//           whose ground truth is recorded. Optionally (registerFaces) official card renders instead, the whole print
//           moved against the cut by a known amount.
//  Photo    a pinhole camera over a card lying on a surface, by ray casting: focal length, distance, tilt (pitch/yaw)
//           and in-plane rotation give the projection; the card may curl (cylindrical bow); its face sits 0.3 mm above
//           the surface, so its side wall shows on the side facing the camera and it casts a soft contact shadow.
//           Optional penny sleeve. Radial lens distortion (k1), lateral chromatic aberration, vignetting, a lighting
//           gradient, exposure and white balance, specular glare, Gaussian defocus (optionally varying across the
//           frame), Poisson-Gaussian sensor noise with some spatial correlation, ISP sharpening of luma, 8-bit sRGB,
//           JPEG.
//  Scan     orthographic, slight skew, white lid (with the thin shadow a CIS lamp throws along one edge) or black
//           backing (sometimes a faint light rim where the lamp catches the cut edge), anisotropic CIS blur, low
//           noise, optional JPEG; a crop around the card or a full A4 page.
//  JPEG     a real round trip: RGB→YCbCr, 4:2:0 (box) subsampling, 8×8 DCT, IJG tables scaled by quality,
//           quantisation, inverse DCT, libjpeg "fancy" (triangle) chroma upsampling, back to RGB.
//
// Rendering works in linear light. Pixels the card outline crosses, and any pixel whose print or surface varies, get
// 2×2 stratified jittered samples (unbiased edge coverage); from 11 px/mm up a pixel whose four corner samples agree
// within a few levels takes their average instead (a large speed-up on smooth areas, same accuracy). Coordinates
// follow geometry.js: pixel (i, j) covers [i, i+1] × [j, j+1]. The simulator has its own geometry (it doesn't import
// the code under test), so a change in src/ can't change the renders.
import { rng, encodePng } from '../unit/gradeFixtures.mjs';

export { rng, encodePng };

const DEG = Math.PI / 180;
const SQRT2 = Math.SQRT2;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------- random helpers

/** Uint32 seed for one case: FNV-1a of "scenario:seed:index". */
export function caseSeed(scenario, seed, index) {
  let h = 0x811c9dc5;
  for (const ch of `${scenario}:${seed}:${index}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
const U = (rand, a, b) => a + (b - a) * rand();
const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length];
const chance = (rand, p) => rand() < p;
const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const sym = (rand, a) => U(rand, -a, a);

/** Integer hash → [0, 1). */
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Lattice of random values for value noise (period 256 cells: longer than a card at every scale used here). */
const VN = (() => { const r = rng(9001); const t = new Float32Array(256 * 256); for (let i = 0; i < t.length; i++) t[i] = r(); return t; })();
/** Smooth value noise in [0, 1); `seed` shifts the lattice. */
function vnoise(x, y, seed) {
  const fxi = Math.floor(x); const fyi = Math.floor(y);
  let fx = x - fxi; let fy = y - fyi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const ix = (fxi + seed) & 255; const iy = (fyi + (seed >>> 8)) & 255;
  const ix1 = (ix + 1) & 255; const r0 = iy << 8; const r1 = ((iy + 1) & 255) << 8;
  const a = VN[r0 + ix]; const b = VN[r0 + ix1]; const c = VN[r1 + ix]; const d = VN[r1 + ix1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}
const jitterColor = (rand, c, a) => c.map((v) => Math.max(0, Math.min(255, v + sym(rand, a))));

// ---------------------------------------------------------------- colour transfer

const LIN_N = 4096;
const SRGB2LIN = new Float32Array(LIN_N + 2); // index: sRGB value × 16
for (let i = 0; i <= LIN_N + 1; i++) { const c = Math.min(1, i / 16 / 255); SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
/** sRGB 0..255 (float) → linear 0..1. */
const toLin = (v) => (v > 0 ? (v < 255 ? SRGB2LIN[(v * 16 + 0.5) | 0] : 1) : 0);
const GAM_N = 4096;
const LIN2SRGB = new Float32Array(GAM_N + 2); // index: sqrt(linear) × GAM_N
for (let i = 0; i <= GAM_N + 1; i++) { const l = Math.min(1, (i / GAM_N) ** 2); LIN2SRGB[i] = 255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055); }
/** linear → sRGB 0..255 (float, clipped). */
const toSrgb = (l) => { if (!(l > 0)) return 0; if (l >= 1) return 255; const f = Math.sqrt(l) * GAM_N; const i = f | 0; return LIN2SRGB[i] + (LIN2SRGB[i + 1] - LIN2SRGB[i]) * (f - i); };

// ---------------------------------------------------------------- shapes

/** Signed distance (mm) to the rounded rectangle [x0, x1] × [y0, y1] with corner radius r; negative inside. */
function sdRoundRect(u, v, x0, y0, x1, y1, r) {
  const hx = (x1 - x0) / 2; const hy = (y1 - y0) / 2;
  const qx = Math.abs(u - x0 - hx) - hx + r; const qy = Math.abs(v - y0 - hy) - hy + r;
  if (qx > 0 && qy > 0) return Math.sqrt(qx * qx + qy * qy) - r;
  return (qx > qy ? qx : qy) - r;
}
const inRect = (u, v, r) => u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3];

/** Stylised text: 1 where a glyph stroke is, rows of glyphs of height h and advance w starting at (x0, y0). */
function textInk(u, v, x0, x1, y0, h, w, seed) {
  if (u < x0 || u > x1 || v < y0 || v > y0 + h) return 0;
  const gx = (u - x0) / w; const gi = Math.floor(gx); const fu = gx - gi; const fv = (v - y0) / h;
  if (hash2(gi, seed, 11) < 0.17 || fu < 0.1 || fu > 0.9) return 0;
  const r1 = hash2(gi, seed, 12); const r2 = hash2(gi, seed, 13);
  const stem = 0.2 + 0.55 * r1;
  if (Math.abs(fu - stem) < 0.1 && fv > (r2 < 0.35 ? 0 : 0.32)) return 1;
  if (Math.abs(fv - (0.32 + 0.6 * r2)) < 0.09) return 1;
  if (r1 > 0.45) { const dx = (fu - 0.5) / 0.38; const dy = (fv - 0.64) / 0.34; const d = dx * dx + dy * dy; if (d < 1 && d > 0.42) return 1; }
  return 0;
}

/** Smooth "art": a sky/ground gradient with soft-shaded blobs, some outlined. Writes sRGB into o. */
function makeArt(rand, rect, { palette = null, grey = false } = {}) {
  const [x0, y0, x1, y1] = rect;
  const hue = U(rand, 0, 360);
  const sat = grey ? U(rand, 0.02, 0.12) : U(rand, 0.35, 0.85);
  const sky0 = hsv(hue, sat, U(rand, 0.55, 0.95)); const sky1 = hsv(hue + U(rand, -40, 40), sat * U(rand, 0.6, 1.2), U(rand, 0.35, 0.9));
  const ground = hsv(hue + U(rand, 60, 200), sat, U(rand, 0.25, 0.7));
  const horizon = y0 + (y1 - y0) * U(rand, 0.5, 0.85);
  const blobs = [];
  const nb = 3 + Math.floor(rand() * 5);
  for (let k = 0; k < nb; k++) {
    const col = palette ? pick(rand, palette) : hsv(U(rand, 0, 360), grey ? U(rand, 0, 0.15) : U(rand, 0.3, 0.95), U(rand, 0.3, 1));
    blobs.push({
      cx: U(rand, x0, x1), cy: U(rand, y0, y1), irx: 1 / (U(rand, 0.08, 0.35) * (x1 - x0)), iry: 1 / (U(rand, 0.08, 0.35) * (y1 - y0)), col,
      outline: chance(rand, 0.5) ? U(rand, 0.04, 0.1) : 0,
    });
  }
  const seed = (rand() * 1e9) | 0;
  const ih = 1 / (y1 - y0);
  return (u, v, o) => {
    const t = (v - y0) * ih;
    let r = sky0[0] + (sky1[0] - sky0[0]) * t; let g = sky0[1] + (sky1[1] - sky0[1]) * t; let b = sky0[2] + (sky1[2] - sky0[2]) * t;
    if (v > horizon) { const k = Math.min(1, (v - horizon) * 0.8); r += (ground[0] - r) * k; g += (ground[1] - g) * k; b += (ground[2] - b) * k; }
    for (let k = 0; k < blobs.length; k++) {
      const p = blobs[k];
      const dx = (u - p.cx) * p.irx; const dy = (v - p.cy) * p.iry;
      const d = dx * dx + dy * dy;
      if (d >= 1.05) continue;
      if (p.outline && d > 1 - 2 * p.outline && d < 1.05) { r = 30; g = 26; b = 28; continue; }
      if (d >= 1) continue;
      const shade = 1.08 - 0.45 * d + 0.12 * dy;
      r = p.col[0] * shade; g = p.col[1] * shade; b = p.col[2] * shade;
    }
    const n = (vnoise(u * 0.6, v * 0.6, seed) - 0.5) * 18;
    o[0] = r + n; o[1] = g + n; o[2] = b + n;
  };
}

// ---------------------------------------------------------------- card templates

const YELLOW = [236, 198, 52];
const PAPER = [241, 239, 231];
const TYPE_FRAMES = {
  grass: [120, 172, 92], fire: [214, 96, 66], water: [86, 150, 214], psychic: [170, 108, 180], fighting: [188, 122, 76],
  darkness: [62, 70, 82], metal: [158, 164, 172], dragon: [150, 132, 70], colorless: [222, 220, 210],
};
export const TEMPLATES = Object.freeze(['pokemon-front', 'pokemon-back', 'lorcana', 'onepiece', 'silver-fullart']);
const CARD_SIZE = { lorcana: [63.5, 88.9] };
/** Borders wider by design (mm moved from the second side to the first when centred): Lorcana's bottom border is 3.2 mm
 * wider than its top one. The truth of such a card's centering is taken against that layout, as graders do. */
const LAYOUT_SHIFT = { lorcana: { tb: 1.6 } };

/** Print noise of a solid ink area: slow mottle plus fine grain (sRGB levels). */
const printNoise = (u, v, seed, mottle, grain) => (vnoise(u * 1.4, v * 1.4, seed) - 0.5) * 2 * mottle + (hash2(Math.floor(u * 16), Math.floor(v * 16), seed) - 0.5) * 2 * grain;

function pokemonFront(rand, B, { frame = null, line = null } = {}) {
  const cw = 63; const ch = 88;
  const seed = (rand() * 1e9) | 0;
  const border = jitterColor(rand, YELLOW, 4);
  const type = frame ?? pick(rand, Object.keys(TYPE_FRAMES));
  const frameCol = type === 'lightning'
    // "Lightning" frames are a paler or warmer yellow: about 8-20 ΔE from the border, the hard case.
    ? [Math.min(255, border[0] + U(rand, -2, 6)), Math.min(255, border[1] + U(rand, 4, 16)), Math.min(255, border[2] + U(rand, 22, 60))]
    : jitterColor(rand, TYPE_FRAMES[type], 10);
  const hasLine = line ?? chance(rand, 0.5);
  const lineW = U(rand, 0.12, 0.3);
  const lineCol = mix3(frameCol, [40, 30, 25], U(rand, 0.45, 0.75));
  const x0 = B.l; const x1 = cw - B.r; const y0 = B.t; const y1 = ch - B.b;
  const rIn = U(rand, 0.4, 1.4);
  const name = [x0 + 1.2, y0 + 0.9, x1 - 1.2, y0 + 5.0];
  const art = [x0 + 2.3, y0 + 5.7, x1 - 2.3, y0 + 5.7 + U(rand, 36, 40)];
  const artFrame = 0.5;
  const artCol = jitterColor(rand, [196, 190, 170], 15);
  const artFn = makeArt(rand, art);
  const textTop = art[3] + 3.6;
  const textBox = [x0 + 1.4, textTop, x1 - 1.4, y1 - 10];
  const bar = [x0 + 1.4, y1 - 9.2, x1 - 1.4, y1 - 5.4];
  const barCol = mix3(frameCol, [250, 250, 245], 0.4);
  const boxCol = mix3(frameCol, [246, 244, 236], U(rand, 0.55, 0.85));
  const textRows = [];
  for (let y = textTop + 1.2; y < textBox[3] - 1.8; y += U(rand, 2.6, 3.6)) textRows.push(y);
  const energies = textRows.filter((_, i) => i % 3 === 0).map((y) => ({ y: y + 0.8, col: jitterColor(rand, pick(rand, Object.values(TYPE_FRAMES)), 20) }));
  const tex = U(rand, 2, 6);
  return {
    template: 'pokemon-front', cw, ch, radius: U(rand, 2.8, 3.2), thickness: 0.3, borders: B,
    variant: { frame: type, line: hasLine }, wall: [214, 210, 200], gloss: 1,
    shade(u, v, o) {
      const dIn = -sdRoundRect(u, v, x0, y0, x1, y1, rIn); // depth inside the inner frame edge
      if (dIn < 0) {
        const n = printNoise(u, v, seed, 3, 2.5);
        o[0] = border[0] + n; o[1] = border[1] + n; o[2] = border[2] + n * 0.6;
        return;
      }
      if (hasLine && dIn < lineW) { o[0] = lineCol[0]; o[1] = lineCol[1]; o[2] = lineCol[2]; return; }
      if (u >= art[0] && u <= art[2] && v >= art[1] && v <= art[3]) { artFn(u, v, o); return; }
      if (u >= art[0] - artFrame && u <= art[2] + artFrame && v >= art[1] - artFrame && v <= art[3] + artFrame) {
        const k = 0.85 + 0.25 * Math.sin((u + v) * 0.9);
        o[0] = artCol[0] * k; o[1] = artCol[1] * k; o[2] = artCol[2] * k;
        return;
      }
      let c = frameCol;
      let ink = 0;
      if (inRect(u, v, name)) {
        ink = textInk(u, v, name[0] + 1.5, name[0] + 24, name[1] + 1.0, 2.4, 1.6, seed) || textInk(u, v, name[2] - 9, name[2] - 1.2, name[1] + 1.2, 2.0, 1.3, seed + 1);
      } else if (inRect(u, v, textBox)) {
        c = boxCol;
        for (let k = 0; k < textRows.length && !ink; k++) ink = textInk(u, v, textBox[0] + 7, textBox[2] - 1, textRows[k], 1.4, 1.05, seed + 10 + k);
        for (const e of energies) { const dx = u - (textBox[0] + 3.2); const dy = v - e.y; if (dx * dx + dy * dy < 1.2) { c = e.col; break; } }
      } else if (inRect(u, v, bar)) {
        c = barCol;
        ink = textInk(u, v, bar[0] + 2, bar[2] - 2, bar[1] + 1.2, 1.3, 1.6, seed + 40);
      } else if (v > art[3] + artFrame && v < textTop) {
        ink = textInk(u, v, art[0] + 4, art[2] - 4, art[3] + 1.1, 1.1, 0.8, seed + 41);
      } else if (v > y1 - 3.9 && v < y1 - 2.3) {
        // Small print near the bottom border (illustrator, set number): close to the border's inner edge.
        ink = textInk(u, v, x0 + 2, x0 + 26, y1 - 3.9, 1.3, 0.9, seed + 42) || textInk(u, v, x1 - 12, x1 - 2, y1 - 3.9, 1.3, 0.9, seed + 43);
      }
      if (ink) { o[0] = 34; o[1] = 30; o[2] = 30; return; }
      const k = 1 + (tex / 100) * Math.sin((u - v) * 2.1) + (vnoise(u * 0.8, v * 0.8, seed + 5) - 0.5) * 0.05;
      o[0] = c[0] * k; o[1] = c[1] * k; o[2] = c[2] * k;
    },
  };
}

const BALL_BLACK = [24, 22, 26]; const BALL_WHITE = [234, 234, 230];
function pokemonBack(rand, B) {
  const cw = 63; const ch = 88;
  const seed = (rand() * 1e9) | 0;
  const border = jitterColor(rand, [26, 50, 124], 5);
  const gx = U(rand, -0.08, 0.08); const gy = U(rand, -0.08, 0.08);
  const x0 = B.l; const x1 = cw - B.r; const y0 = B.t; const y1 = ch - B.b;
  const soft = U(rand, 0.06, 0.2); // the border meets the swirl in a soft step, not a printed line
  const dark = jitterColor(rand, [30, 74, 158], 8); const light = jitterColor(rand, [116, 170, 232], 10);
  const sc = [U(rand, 26, 37), U(rand, 40, 52)];
  const arms = 3 + Math.floor(rand() * 3);
  const blobs = Array.from({ length: 5 }, () => ({ x: U(rand, 0, cw), y: U(rand, 0, ch), r: U(rand, 8, 22), a: U(rand, -0.35, 0.45) }));
  // Soft elliptical rings (no hard line anywhere in the swirl).
  const rings = Array.from({ length: 2 + Math.floor(rand() * 2) }, () => {
    const ang = U(rand, 0, Math.PI);
    return { x: U(rand, 5, cw - 5), y: U(rand, 10, ch - 10), irx: 1 / U(rand, 10, 26), iry: 1 / U(rand, 6, 16), c: Math.cos(ang), s: Math.sin(ang), w: U(rand, 0.12, 0.3), a: U(rand, 0.15, 0.35) };
  });
  const ball = { x: cw / 2 + sym(rand, 0.5), y: ch * 0.55, r: U(rand, 13, 16) };
  const red = jitterColor(rand, [206, 42, 44], 10);
  // The swirl is smooth: tabulate it on a 0.25 mm grid once per card, bilinear in between.
  const G = 4; const gw = Math.ceil(cw * G) + 2; const gh = Math.ceil(ch * G) + 2;
  const swirl = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const u = i / G; const v = j / G;
      const dx = u - sc[0]; const dy = v - sc[1];
      const r = Math.sqrt(dx * dx + dy * dy);
      let t = 0.42 + 0.3 * Math.sin(arms * Math.atan2(dy, dx) + r * 0.22 + 3 * vnoise(u * 0.08, v * 0.08, seed));
      for (let k = 0; k < blobs.length; k++) { const p = blobs[k]; const ex = u - p.x; const ey = v - p.y; t += p.a * Math.exp(-(ex * ex + ey * ey) / (p.r * p.r)); }
      for (let k = 0; k < rings.length; k++) {
        const q = rings[k]; const ex = u - q.x; const ey = v - q.y;
        const a = (ex * q.c + ey * q.s) * q.irx; const b = (-ex * q.s + ey * q.c) * q.iry;
        const d = (Math.sqrt(a * a + b * b) - 1) / q.w;
        t += q.a * Math.exp(-d * d);
      }
      swirl[j * gw + i] = clamp01(t);
    }
  }
  const banner = { x: cw / 2, y: ch * 0.24, rx: U(rand, 19, 23), ry: U(rand, 6, 8) };
  return {
    template: 'pokemon-back', cw, ch, radius: U(rand, 2.8, 3.2), thickness: 0.3, borders: B, variant: {}, wall: [200, 198, 192], gloss: 1,
    shade(u, v, o) {
      const dIn = -sdRoundRect(u, v, x0, y0, x1, y1, 0.8);
      const n = printNoise(u, v, seed, 2.5, 2);
      const bk = 1 + gx * (u / cw - 0.5) * 2 + gy * (v / ch - 0.5) * 2;
      if (dIn < -soft) { o[0] = border[0] * bk + n; o[1] = border[1] * bk + n; o[2] = border[2] * bk + n; return; }
      // Swirl: spiral arms around a centre plus broad light patches; dark near some of the border, light near other parts.
      const gu = Math.max(0, Math.min(gw - 1.001, u * G)); const gv = Math.max(0, Math.min(gh - 1.001, v * G));
      const i0 = gu | 0; const j0 = gv | 0; const fu = gu - i0; const fv = gv - j0; const q = j0 * gw + i0;
      const t = swirl[q] + (swirl[q + 1] - swirl[q]) * fu + (swirl[q + gw] - swirl[q]) * fv + (swirl[q] - swirl[q + 1] - swirl[q + gw] + swirl[q + gw + 1]) * fu * fv;
      let cr = dark[0] + (light[0] - dark[0]) * t; let cg = dark[1] + (light[1] - dark[1]) * t; let cb = dark[2] + (light[2] - dark[2]) * t;
      // Central ball: red top, white bottom, black band and ring, shaded.
      const bx = u - ball.x; const by = v - ball.y; const br = Math.sqrt(bx * bx + by * by);
      if (br < ball.r) {
        const sh = 1.05 - 0.25 * (br / ball.r) ** 2 - 0.08 * (bx + by) / ball.r;
        const c = br > ball.r - 0.9 || Math.abs(by) < 1.4 || (br < 4.6 && br > 3.2) ? BALL_BLACK : br <= 3.2 || by >= 0 ? BALL_WHITE : red;
        cr = c[0] * sh; cg = c[1] * sh; cb = c[2] * sh;
      }
      const ex = (u - banner.x) / banner.rx; const ey = (v - banner.y) / banner.ry; const ed = ex * ex + ey * ey;
      if (ed < 1) { if (ed > 0.8) { cr = 36; cg = 70; cb = 160; } else { cr = 250; cg = 206 - 30 * ey; cb = 44; } }
      if (dIn < soft) { const k = smooth(-soft, soft, dIn); cr = border[0] * bk + (cr - border[0] * bk) * k; cg = border[1] * bk + (cg - border[1] * bk) * k; cb = border[2] * bk + (cb - border[2] * bk) * k; }
      o[0] = cr + n; o[1] = cg + n; o[2] = cb + n;
    },
  };
}

function lorcana(rand, B) {
  const [cw, ch] = CARD_SIZE.lorcana;
  const seed = (rand() * 1e9) | 0;
  const black = jitterColor(rand, [20, 20, 24], 4);
  const gold = jitterColor(rand, [206, 170, 86], 10);
  const gw = U(rand, 0.45, 0.9);
  const x0 = B.l; const x1 = cw - B.r; const y0 = B.t; const y1 = ch - B.b;
  const rIn = U(rand, 1.5, 2.6);
  const artFn = makeArt(rand, [x0, y0, x1, y1]);
  const ink = pick(rand, [[230, 150, 40], [140, 70, 170], [40, 150, 90], [200, 40, 50], [40, 110, 200], [150, 155, 165]]);
  const box = [x0 + gw + 1.2, y1 - 30, x1 - gw - 1.2, y1 - gw - 1.2];
  const parchment = jitterColor(rand, [230, 218, 188], 8);
  const banner = [x0 + gw, y1 - 37, x1 - gw, y1 - 30.5];
  const rows = [];
  for (let y = box[1] + 2; y < box[3] - 2; y += U(rand, 2.6, 3.4)) rows.push(y);
  const cost = { x: x0 + 7, y: y0 + 7, r: 4.2 };
  return {
    template: 'lorcana', cw, ch, radius: U(rand, 3.0, 3.4), thickness: 0.33, borders: B, variant: {}, wall: [196, 192, 184], gloss: 1,
    shade(u, v, o) {
      const dIn = -sdRoundRect(u, v, x0, y0, x1, y1, rIn);
      if (dIn < 0) { const n = printNoise(u, v, seed, 2, 2); o[0] = black[0] + n; o[1] = black[1] + n; o[2] = black[2] + n; return; }
      if (dIn < gw) {
        const k = 0.8 + 0.3 * Math.sin(u * 0.7 + v * 0.45) + (hash2(Math.floor(u * 20), Math.floor(v * 20), seed) - 0.5) * 0.12;
        o[0] = gold[0] * k; o[1] = gold[1] * k; o[2] = gold[2] * k; return;
      }
      const cx = u - cost.x; const cy = v - cost.y; const cd = Math.sqrt(cx * cx + cy * cy);
      if (cd < cost.r) { if (cd > cost.r - 0.6) { o[0] = gold[0]; o[1] = gold[1]; o[2] = gold[2]; } else { o[0] = 40; o[1] = 46; o[2] = 70; } return; }
      if (inRect(u, v, banner)) {
        const t = textInk(u, v, banner[0] + 5, banner[2] - 8, banner[1] + 1.8, 2.8, 1.7, seed);
        o[0] = t ? 235 : 28; o[1] = t ? 232 : 26; o[2] = t ? 224 : 34; return;
      }
      if (inRect(u, v, box)) {
        if (u < box[0] + 2.2) { o[0] = ink[0]; o[1] = ink[1]; o[2] = ink[2]; return; }
        let t = 0;
        for (let k = 0; k < rows.length && !t; k++) t = textInk(u, v, box[0] + 4, box[2] - 2, rows[k], 1.4, 1.05, seed + 3 + k);
        if (t) { o[0] = 40; o[1] = 34; o[2] = 30; } else { o[0] = parchment[0]; o[1] = parchment[1]; o[2] = parchment[2]; }
        return;
      }
      artFn(u, v, o);
    },
  };
}

function onePiece(rand, B) {
  const cw = 63; const ch = 88;
  const seed = (rand() * 1e9) | 0;
  const dark = jitterColor(rand, [26, 25, 30], 5);
  const color = jitterColor(rand, pick(rand, [[204, 40, 48], [36, 150, 84], [40, 92, 196], [124, 60, 164], [236, 200, 50]]), 12);
  const fw = U(rand, 1.0, 2.2);
  const x0 = B.l; const x1 = cw - B.r; const y0 = B.t; const y1 = ch - B.b;
  const rIn = U(rand, 0.3, 1.2);
  const artFn = makeArt(rand, [x0 + fw, y0 + fw, x1 - fw, y1 - fw]);
  const box = [x0 + fw + 1.5, y1 - fw - 24, x1 - fw - 1.5, y1 - fw - 7];
  const nameBand = [x0 + fw, y1 - fw - 6.2, x1 - fw, y1 - fw - 0.8];
  const rows = [];
  for (let y = box[1] + 1.8; y < box[3] - 1.8; y += U(rand, 2.6, 3.4)) rows.push(y);
  return {
    template: 'onepiece', cw, ch, radius: U(rand, 2.8, 3.2), thickness: 0.3, borders: B, variant: {}, wall: [205, 202, 195], gloss: 1,
    shade(u, v, o) {
      const dIn = -sdRoundRect(u, v, x0, y0, x1, y1, rIn);
      if (dIn < 0) { const n = printNoise(u, v, seed, 2, 2); o[0] = dark[0] + n; o[1] = dark[1] + n; o[2] = dark[2] + n; return; }
      if (dIn < fw) { const k = 0.92 + 0.08 * Math.sin(v * 0.5); o[0] = color[0] * k; o[1] = color[1] * k; o[2] = color[2] * k; return; }
      const cx = u - (x0 + fw + 5); const cy = v - (y0 + fw + 5);
      if (cx * cx + cy * cy < 16) { o[0] = color[0] * 0.8; o[1] = color[1] * 0.8; o[2] = color[2] * 0.8; return; }
      if (inRect(u, v, nameBand)) {
        const t = textInk(u, v, nameBand[0] + 8, nameBand[2] - 8, nameBand[1] + 1.4, 2.6, 1.6, seed);
        o[0] = t ? 20 : color[0]; o[1] = t ? 20 : color[1]; o[2] = t ? 24 : color[2]; return;
      }
      if (inRect(u, v, box)) {
        let t = 0;
        for (let k = 0; k < rows.length && !t; k++) t = textInk(u, v, box[0] + 1.5, box[2] - 1.5, rows[k], 1.4, 1.05, seed + 3 + k);
        artFn(u, v, o);
        const a = t ? 0 : 0.82; const w = t ? 25 : 244;
        o[0] = o[0] * (1 - a) + w * a; o[1] = o[1] * (1 - a) + w * a; o[2] = o[2] * (1 - a) + w * a;
        if (t) { o[0] = 25; o[1] = 25; o[2] = 28; }
        return;
      }
      artFn(u, v, o);
    },
  };
}

function silverFullArt(rand, B, { greyArt = null } = {}) {
  const cw = 63; const ch = 88;
  const seed = (rand() * 1e9) | 0;
  const silver = jitterColor(rand, [186, 189, 197], 6);
  const x0 = B.l; const x1 = cw - B.r; const y0 = B.t; const y1 = ch - B.b;
  const grey = greyArt ?? chance(rand, 0.3);
  const artFn = makeArt(rand, [x0, y0, x1, y1], { grey });
  const sheen = U(rand, 0.4, 1.2); const sheenDir = U(rand, 0, Math.PI);
  const sx = Math.cos(sheenDir) * sheen; const sy = Math.sin(sheenDir) * sheen;
  const rows = [];
  for (let y = y1 - 16; y < y1 - 3; y += 3) rows.push(y);
  return {
    template: 'silver-fullart', cw, ch, radius: U(rand, 2.8, 3.2), thickness: 0.3, borders: B, variant: { greyArt: grey }, wall: [206, 204, 198], gloss: 1.3,
    shade(u, v, o) {
      // Foil: fine grain, sparkle and a sheen that drifts across the card.
      const g = hash2(Math.floor(u * 22), Math.floor(v * 22), seed);
      const foil = (g - 0.5) * 26 + (g > 0.993 ? 50 : 0) + 14 * Math.sin(u * sx + v * sy);
      if (u < x0 || u > x1 || v < y0 || v > y1) { o[0] = silver[0] + foil; o[1] = silver[1] + foil; o[2] = silver[2] + foil; return; }
      artFn(u, v, o);
      let t = 0;
      if (v > y1 - 17) for (let k = 0; k < rows.length && !t; k++) t = textInk(u, v, x0 + 4, x1 - 4, rows[k], 1.4, 1.05, seed + k);
      if (v < y0 + 6) t = textInk(u, v, x0 + 3, x0 + 28, y0 + 2, 2.6, 1.7, seed + 99);
      if (t) { o[0] = 245; o[1] = 245; o[2] = 245; return; }
      const f = foil * 0.5;
      o[0] += f; o[1] += f; o[2] += f;
    },
  };
}

// ---------------------------------------------------------------- official card faces (opt-in: bench:grade --faces)
// Real print designs (tests/bench/officialFaces.mjs). The whole print is moved against the cut by a known amount, as a
// miscut does, so the true borders are the render's measured ones plus that shift.
const FACES = [];
let faceMode = false;
/** Make the faces available ([{id, img, borders:{l,r,t,b} mm, cornerRadiusMm}]); `use`: every scenario draws its card from them. */
export function registerFaces(faces, { use = true } = {}) { FACES.length = 0; FACES.push(...faces); faceMode = use && FACES.length > 0; }

/** Per axis the render's total border, split by a sampled centering share (as sampleBorders does). */
function shiftedBorders(rand, base, shift = {}, { spread = 5, maxShare = 70 } = {}) {
  const [l, r] = splitAxis(rand, base.l + base.r, shift.lr ?? 0, { spread, maxShare });
  const [t, b] = splitAxis(rand, base.t + base.b, shift.tb ?? 0, { spread, maxShare });
  return { l, r, t, b };
}

/** A face's designed difference: Lorcana's wide bottom border, from the render itself (centred by design). */
const faceShift = (F) => (F.game === 'lorcana' ? { tb: (F.borders.b - F.borders.t) / 2 } : {});

function officialFace(rand, B, { face }) {
  const F = FACES.find((f) => f.id === face);
  if (!F) throw new Error(`card face ${face} is not loaded (bench:grade --faces)`);
  const { data, width: W, height: H } = F.img;
  const [cw, ch] = F.cardMm ?? [63, 88]; const sx = W / cw; const sy = H / ch;
  const dx = B.l - F.borders.l; const dy = B.t - F.borders.t; // the print moved right / down
  // Print points outside the render's own outline (the strip the print moved away from) take the colour 0.4 mm inside
  // it, the border's colour: clamped into a rounded rectangle that stays clear of the render's transparent corners.
  const m = 0.4; const rr = (F.cornerRadiusMm ?? 3) - m + 0.3;
  const lx = m + rr; const hx = cw - m - rr; const ly = m + rr; const hy = ch - m - rr;
  return {
    template: 'official', cw, ch, radius: U(rand, 2.8, 3.2), thickness: F.game === 'lorcana' ? 0.33 : 0.3, borders: B,
    variant: { face, game: F.game }, wall: [214, 210, 200], gloss: 1, layoutShift: faceShift(F),
    shade(u, v, o) {
      let x = u - dx; let y = v - dy;
      const cx = x < lx ? lx : x > hx ? hx : x; const cy = y < ly ? ly : y > hy ? hy : y;
      const ex = x - cx; const ey = y - cy; const e = Math.hypot(ex, ey);
      if (e > rr) { x = cx + (ex * rr) / e; y = cy + (ey * rr) / e; }
      // Bilinear in the render (pixel centres at +0.5).
      const fx = x * sx - 0.5; const fy = y * sy - 0.5;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(fx))); const y0 = Math.max(0, Math.min(H - 2, Math.floor(fy)));
      const ax = Math.max(0, Math.min(1, fx - x0)); const ay = Math.max(0, Math.min(1, fy - y0));
      const i = (y0 * W + x0) * 4; const j = i + W * 4;
      for (let c = 0; c < 3; c++) o[c] = (data[i + c] * (1 - ax) + data[i + 4 + c] * ax) * (1 - ay) + (data[j + c] * (1 - ax) + data[j + 4 + c] * ax) * ay;
    },
  };
}

/** Borders in mm per side: per-axis total around the template's nominal, split by a centering share. */
export function sampleBorders(rand, template, { spread = 5, maxShare = 70 } = {}) {
  const total = { 'pokemon-front': [5.4, 7.0], 'pokemon-back': [7.0, 9.0], lorcana: [5.4, 7.2], onepiece: [5.0, 6.8], 'silver-fullart': [4.2, 6.0] }[template];
  const shift = LAYOUT_SHIFT[template] ?? {};
  // Lorcana: top and bottom together 3.2 mm more (the wide bottom border).
  const axis = (d = 0) => splitAxis(rand, U(rand, total[0], total[1]) + 2 * d, d, { spread, maxShare });
  const [l, r] = axis(shift.lr); const [t, b] = axis(shift.tb);
  return { l, r, t, b };
}

/** Two borders with total T: a centering share sampled around 50 %, taken against the layout (d: mm of designed extra
 * width on the second side over the first, halved). */
function splitAxis(rand, T, d = 0, { spread = 5, maxShare = 70 } = {}) {
  const share = Math.min(maxShare, 50 + Math.abs(gauss(rand)) * spread) / 100;
  const first = (chance(rand, 0.5) ? T * share : T * (1 - share)) - d;
  return [first, T - first];
}

/** A card model: template print + outline (rounded, possibly damaged) + wear. */
export function makeCard(rand, template, borders, { variant = {}, wear = null, printTilt = 0, sleeve = null } = {}) {
  const base = template === 'pokemon-front' ? pokemonFront(rand, borders, variant)
    : template === 'pokemon-back' ? pokemonBack(rand, borders)
      : template === 'lorcana' ? lorcana(rand, borders)
        : template === 'onepiece' ? onePiece(rand, borders)
          : template === 'silver-fullart' ? silverFullArt(rand, borders, variant)
            : template === 'official' ? officialFace(rand, borders, variant)
              : null;
  if (!base) throw new Error(`unknown template ${template}`);
  const { cw, ch, radius } = base;
  base.layoutShift = base.layoutShift ?? LAYOUT_SHIFT[template] ?? {};
  const W = wear ?? { edges: [], corners: [] };
  const seed = (rand() * 1e9) | 0;
  // Outline: per-corner radius (blunted corners are rounder), straight cuts across tips, round dents.
  const CORNER_IDX = { tl: 0, tr: 1, br: 2, bl: 3 };
  const rc = [radius, radius, radius, radius];
  const cutC = [-Infinity, -Infinity, -Infinity, -Infinity]; // per corner: a + b below which the tip is cut off
  const dents = [[], [], [], []];
  const rims = [0, 0, 0, 0];
  for (const c of W.corners) {
    const k = CORNER_IDX[c.corner];
    if (c.type === 'blunt') { rc[k] = radius + c.mm / (SQRT2 - 1); rims[k] = Math.max(rims[k], c.rimMm ?? 0); }
    if (c.type === 'cut') { cutC[k] = 2 * radius * (1 - Math.SQRT1_2) + c.mm * SQRT2; rims[k] = Math.max(rims[k], c.rimMm ?? 0); }
    if (c.type === 'dent') {
      // A round bite centred on the outline at angle `at` (0° = on the side edge, 90° = on the top/bottom edge).
      const a = (c.at ?? 45) * DEG;
      const ax = radius - radius * Math.cos(a); const by = radius - radius * Math.sin(a); // corner frame (from the two sides)
      dents[k].push({ a: ax, b: by, r: c.mm });
      rims[k] = Math.max(rims[k], c.rimMm ?? 0);
    }
  }
  const hasDamage = W.corners.some((c) => c.type !== 'whitening');
  /** Corner frame: distances from the corner's two sides. */
  const sd = (u, v) => {
    const k = u < cw / 2 ? (v < ch / 2 ? 0 : 3) : (v < ch / 2 ? 1 : 2);
    let d = sdRoundRect(u, v, 0, 0, cw, ch, rc[k]);
    if (!hasDamage) return d;
    const a = k === 0 || k === 3 ? u : cw - u; const b = k === 0 || k === 1 ? v : ch - v;
    if (cutC[k] > 0) { const dc = (cutC[k] - (a + b)) / SQRT2; if (dc > d) d = dc; }
    const L = dents[k];
    for (let i = 0; i < L.length; i++) { const p = L[i]; const dd = p.r - Math.hypot(a - p.a, b - p.b); if (dd > d) d = dd; }
    return d;
  };
  // Whitening: paper showing within a ragged depth of the cut edge.
  const edgeRuns = W.edges.map((e) => ({ ...e, seed: (rand() * 1e9) | 0 }));
  const cornerWhite = W.corners.filter((c) => c.type === 'whitening').map((c) => ({ ...c, k: CORNER_IDX[c.corner], seed: (rand() * 1e9) | 0 }));
  const maxDepth = Math.max(0.05, ...edgeRuns.map((e) => e.depthMm), ...cornerWhite.map((c) => c.depthMm), ...rims) + 0.05;
  const paper = (u, v, o) => { const k = 0.96 + 0.04 * hash2(Math.floor(u * 30), Math.floor(v * 30), seed); o[0] = PAPER[0] * k; o[1] = PAPER[1] * k; o[2] = PAPER[2] * k; };
  const anyWear = edgeRuns.length || cornerWhite.length || hasDamage;
  // The cut is rarely parallel to the print: the print is turned by `printTilt` degrees about the card centre, so the
  // borders taper slightly along each side (the truth is the width at each side's midpoint).
  const ta = printTilt * DEG; const tc = Math.cos(ta); const ts = Math.sin(ta); const hw = cw / 2; const hh = ch / 2;
  const shade = ta ? (u, v, o) => base.shade(hw + (u - hw) * tc + (v - hh) * ts, hh - (u - hw) * ts + (v - hh) * tc, o) : base.shade;
  const haze = sleeve ? sleeve.haze : 0;
  const worn = (u, v, d) => {
    for (let i = 0; i < edgeRuns.length; i++) {
      const e = edgeRuns[i];
      const along = e.side === 'top' || e.side === 'bottom' ? u : v;
      if (along < e.fromMm || along > e.toMm) continue;
      const depth = e.side === 'top' ? v : e.side === 'bottom' ? ch - v : e.side === 'left' ? u : cw - u;
      const taper = Math.min(1, (along - e.fromMm) / 0.25, (e.toMm - along) / 0.25);
      const lim = e.depthMm * taper * (0.55 + 0.45 * vnoise(along * 4, 0, e.seed));
      if (depth < lim * 0.6) return e.strength ?? 1;
      if (depth < lim && hash2(Math.floor(u * 25), Math.floor(v * 25), e.seed) < 0.6) return e.strength ?? 1; // speckled inner rim
    }
    for (let i = 0; i < cornerWhite.length; i++) {
      const c = cornerWhite[i];
      const k = c.k;
      const a = k === 0 || k === 3 ? u : cw - u; const b = k === 0 || k === 1 ? v : ch - v;
      const r = rc[k];
      if (a > r || b > r) continue;
      const ang = Math.atan2(r - b, r - a) / DEG; // 0° toward the side edge, 90° toward the top/bottom edge
      if (ang < c.fromDeg || ang > c.toDeg) continue;
      const taper = Math.min(1, (ang - c.fromDeg) / 8, (c.toDeg - ang) / 8);
      const lim = c.depthMm * taper * (0.6 + 0.4 * vnoise(ang * 0.3, 5, c.seed));
      if (d < lim * 0.6) return c.strength ?? 1;
      if (d < lim && hash2(Math.floor(u * 25), Math.floor(v * 25), c.seed) < 0.6) return c.strength ?? 1;
    }
    if (hasDamage) {
      const k = u < cw / 2 ? (v < ch / 2 ? 0 : 3) : (v < ch / 2 ? 1 : 2);
      if (rims[k] > 0 && d < rims[k]) {
        const a = k === 0 || k === 3 ? u : cw - u; const b = k === 0 || k === 1 ? v : ch - v;
        if (a < rc[k] + 1.5 && b < rc[k] + 1.5 && hash2(Math.floor(u * 25), Math.floor(v * 25), seed + k) < 0.75) return 1;
      }
    }
    return 0;
  };
  return {
    ...base, seed,
    wear: W,
    sd,
    /** Print colour (sRGB) at (u, v); d = depth inside the outline (mm) when known (wear lies within maxDepth of it). */
    face(u, v, d, o) {
      const w = anyWear && d < maxDepth ? worn(u, v, d) : 0;
      if (w >= 1) paper(u, v, o);
      else {
        shade(u, v, o);
        // Light whitening: paper showing through part of the ink.
        if (w > 0) { const r = o[0]; const g = o[1]; const b = o[2]; paper(u, v, o); o[0] = r + (o[0] - r) * w; o[1] = g + (o[1] - g) * w; o[2] = b + (o[2] - b) * w; }
      }
      if (haze) { o[0] += (255 - o[0]) * haze; o[1] += (255 - o[1]) * haze; o[2] += (255 - o[2]) * haze; }
    },
    maxDepth, printTilt,
    /** Border widths at each side's midpoint (mm), with the print tilt. */
    trueBorders() {
      const k = 1 / tc;
      return { l: hw + (borders.l - hw) * k, r: cw - (hw + (cw - borders.r - hw) * k), t: hh + (borders.t - hh) * k, b: ch - (hh + (ch - borders.b - hh) * k) };
    },
  };
}

// ---------------------------------------------------------------- backgrounds (in card-plane mm; the surface the card lies on)

export const BACKGROUNDS = Object.freeze(['dark', 'mid', 'light', 'wood', 'playmat', 'lid-white', 'lid-black']);

export function makeBackground(rand, kind) {
  const seed = (rand() * 1e9) | 0;
  const ang = U(rand, 0, Math.PI); const ca = Math.cos(ang); const sa = Math.sin(ang);
  if (kind === 'dark' || kind === 'mid' || kind === 'light' || kind === 'lid-white' || kind === 'lid-black') {
    const base = kind === 'dark' ? hsv(U(rand, 0, 360), U(rand, 0, 0.35), U(rand, 0.08, 0.2))
      : kind === 'mid' ? hsv(U(rand, 0, 360), U(rand, 0, 0.25), U(rand, 0.35, 0.6))
        : kind === 'light' ? hsv(U(rand, 20, 60), U(rand, 0, 0.08), U(rand, 0.82, 0.96))
          : kind === 'lid-white' ? hsv(U(rand, 30, 220), U(rand, 0, 0.03), U(rand, 0.9, 0.96))
            : hsv(0, 0, U(rand, 0.04, 0.09));
    const uneven = kind.startsWith('lid') ? 0.01 : U(rand, 0.02, 0.06);
    const grain = kind.startsWith('lid') ? 1.2 : U(rand, 1.5, 5);
    const cell = U(rand, 6, 14); // fabric / paper grain cells per mm
    return {
      kind, plain: true, base,
      shade(u, v, o) {
        const k = 1 + (vnoise(u / 45, v / 45, seed) - 0.5) * 2 * uneven;
        const g = (hash2(Math.floor(u * cell), Math.floor(v * cell), seed) - 0.5) * 2 * grain;
        o[0] = base[0] * k + g; o[1] = base[1] * k + g; o[2] = base[2] * k + g;
      },
    };
  }
  if (kind === 'wood') {
    const light = hsv(U(rand, 22, 38), U(rand, 0.35, 0.6), U(rand, 0.55, 0.8));
    const darkC = hsv(U(rand, 18, 32), U(rand, 0.5, 0.75), U(rand, 0.25, 0.45));
    const spacing = U(rand, 2.5, 7);
    return {
      kind, plain: false, base: light,
      shade(u, v, o) {
        const p = u * ca + v * sa; const q = -u * sa + v * ca;
        const t = q / spacing + 1.6 * vnoise(p / 40, q / 12, seed) + 0.3 * vnoise(p / 6, q / 3, seed + 1);
        let band = 0.5 + 0.5 * Math.sin(2 * Math.PI * t);
        band = band * band * band;
        const fibre = (hash2(Math.floor(p * 0.6), Math.floor(q * 7), seed + 2) - 0.5) * 0.12;
        const k = clamp01(band * 0.85 + fibre + 0.08);
        o[0] = light[0] + (darkC[0] - light[0]) * k; o[1] = light[1] + (darkC[1] - light[1]) * k; o[2] = light[2] + (darkC[2] - light[2]) * k;
      },
    };
  }
  if (kind === 'playmat') {
    // Neoprene playmat: smooth printed art, a fabric texture and the zone outlines printed around card slots.
    const cols = [hsv(U(rand, 0, 360), U(rand, 0.3, 0.8), U(rand, 0.15, 0.5)), hsv(U(rand, 0, 360), U(rand, 0.3, 0.8), U(rand, 0.3, 0.7)), hsv(U(rand, 0, 360), U(rand, 0.2, 0.6), U(rand, 0.5, 0.85))];
    const line = hsv(U(rand, 0, 360), U(rand, 0, 0.3), U(rand, 0.75, 0.95));
    const lw = U(rand, 0.6, 1.3);
    const za = sym(rand, 3) * DEG; const zc = Math.cos(za); const zs = Math.sin(za);
    const gap = U(rand, 2.5, 6);
    const zone = { x0: -gap + sym(rand, 2), y0: -gap + sym(rand, 2), w: 63 + 2 * gap, h: 88 + 2 * gap, pitch: 63 + 2 * gap + U(rand, 4, 10) };
    return {
      kind, plain: false, base: cols[1],
      shade(u, v, o) {
        const t = vnoise(u / 55, v / 55, seed) * 0.7 + vnoise(u / 17, v / 17, seed + 1) * 0.3;
        const c = t < 0.5 ? mix3(cols[0], cols[1], t * 2) : mix3(cols[1], cols[2], t * 2 - 1);
        const g = (hash2(Math.floor(u * 9), Math.floor(v * 9), seed + 2) - 0.5) * 8;
        // Zone outlines in a frame slightly rotated against the card.
        const p = (u - 31.5) * zc + (v - 44) * zs + 31.5; const q = -(u - 31.5) * zs + (v - 44) * zc + 44;
        const col = Math.floor((p - zone.x0) / zone.pitch); const px = p - zone.x0 - col * zone.pitch;
        let on = false;
        if (q > zone.y0 - lw && q < zone.y0 + zone.h + lw && px < zone.w + lw) {
          if (Math.abs(px) < lw / 2 || Math.abs(px - zone.w) < lw / 2) on = true;
          if (px <= zone.w && (Math.abs(q - zone.y0) < lw / 2 || Math.abs(q - zone.y0 - zone.h) < lw / 2)) on = true;
        }
        if (on) { o[0] = line[0] + g; o[1] = line[1] + g; o[2] = line[2] + g; return; }
        o[0] = c[0] + g; o[1] = c[1] + g; o[2] = c[2] + g;
      },
    };
  }
  throw new Error(`unknown background ${kind}`);
}

/**
 * A clear penny sleeve around the card: over the surface it adds a faint haze and a thin bright or dark outline.
 * sleeve: {m: [left, top, right, bottom] mm beyond the card, lw (outline width mm), line (+ brighter / − darker), haze}.
 */
/**
 * Over black backing a CIS lamp lights the card's cut edge: a thin bright rim just outside the outline on the side
 * facing the lamp. rim: {side 'top' | 'bottom', w (mm), strength 0..1, color sRGB}.
 */
export function rimmed(bg, rim, card) {
  if (!rim) return bg;
  const { cw, ch } = card; const top = rim.side === 'top';
  return {
    kind: bg.kind, plain: false, base: bg.base,
    shade(u, v, o) {
      bg.shade(u, v, o);
      if (top ? v > 6 : v < ch - 6) return;
      const d = card.sd(u, v);
      if (d < 0 || d > rim.w) return;
      // Facing the lamp: strongest on the straight edge, fading round the corners.
      const ny = top ? -v : v - ch; const k = Math.max(0, Math.min(1, (ny + 1) / 1.5));
      const t = rim.strength * k * (u > -1 && u < cw + 1 ? 1 : 0);
      o[0] += (rim.color[0] - o[0]) * t; o[1] += (rim.color[1] - o[1]) * t; o[2] += (rim.color[2] - o[2]) * t;
    },
  };
}

export function sleeved(bg, sleeve, cw, ch) {
  if (!sleeve) return bg;
  const [ml, mt, mr, mb] = sleeve.m;
  const x0 = -ml; const y0 = -mt; const x1 = cw + mr; const y1 = ch + mb;
  const hl = sleeve.lw / 2; const h = sleeve.haze; const L = sleeve.line;
  return {
    kind: bg.kind, plain: false, base: bg.base,
    shade(u, v, o) {
      bg.shade(u, v, o);
      const d = sdRoundRect(u, v, x0, y0, x1, y1, 1.5);
      if (d > hl) return;
      if (d > -hl) {
        const t = L > 0 ? L : -L; const target = L > 0 ? 255 : 0;
        o[0] += (target - o[0]) * t; o[1] += (target - o[1]) * t; o[2] += (target - o[2]) * t;
        return;
      }
      o[0] += (255 - o[0]) * h; o[1] += (255 - o[1]) * h; o[2] += (255 - o[2]) * h;
    },
  };
}

// ---------------------------------------------------------------- 3×3 helpers

const mat3 = (A, B) => {
  const C = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return C;
};
const mv3 = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h; const Bv = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * Bv + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, Bv / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}
const rotXm = (a) => { const c = Math.cos(a); const s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotYm = (a) => { const c = Math.cos(a); const s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };

// ---------------------------------------------------------------- camera

/**
 * Pinhole camera over the table, by ray casting. World: X right, Y down, Z into the table; the table is Z = 0, the
 * card face Z = −thickness − lift(u, v) and its underside Z = −lift(u, v), where `bow` lifts a curled card
 * (cylindrical: {axis 'u' curls across the width / 'v' along the length, sag mm, edgesUp}). The card's centre is at the
 * world origin, rotated `rotation` in the table plane; the camera looks along d = Ry(yaw)·Rx(pitch)·(0,0,1) at
 * `target` from distance D = f / scale. Radial distortion r_d = r_u·(1 + k1·ρ_u²) with ρ = r / f.
 */
export function cameraModel({ W, H, f, k1 = 0, pp = [0, 0], pitch = 0, yaw = 0, rotation = 0, scale, target = [0, 0], cw, ch, thickness = 0.3, bow = null }) {
  const M = mat3(rotYm(yaw * DEG), rotXm(pitch * DEG)); // camera → world (columns: camera axes)
  const d = [M[2], M[5], M[8]];
  const D = f / scale;
  const C = [target[0] - D * d[0], target[1] - D * d[1], -D * d[2]];
  const cx = W / 2 + pp[0]; const cy = H / 2 + pp[1];
  const th = rotation * DEG; const c = Math.cos(th); const s = Math.sin(th);
  const hw = cw / 2; const hh = ch / 2;
  const lift = !bow || !(bow.sag > 0) ? null : bow.axis === 'v'
    ? (bow.edgesUp ? (u, v) => bow.sag * ((v - hh) / hh) ** 2 : (u, v) => bow.sag * Math.max(0, 1 - ((v - hh) / hh) ** 2))
    : (bow.edgesUp ? (u) => bow.sag * ((u - hw) / hw) ** 2 : (u) => bow.sag * Math.max(0, 1 - ((u - hw) / hw) ** 2));
  // Inverse distortion: a table over ρ_d², built on first use (fitting the card into the frame only projects).
  const rMax = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy)) / f * 1.05 + 0.01;
  const N = 2048;
  let lut = null;
  const buildLut = () => {
    lut = new Float64Array(N + 2);
    for (let i = 0; i <= N + 1; i++) {
      const rd = Math.sqrt((i / N) * rMax * rMax);
      let ru = rd;
      for (let it = 0; it < 20 && k1; it++) ru -= (ru * (1 + k1 * ru * ru) - rd) / (1 + 3 * k1 * ru * ru);
      lut[i] = rd > 0 ? ru / rd : 1;
    }
    return lut;
  };
  const lutScale = N / (rMax * rMax);
  const invF2 = 1 / (f * f);
  const distort = (x, y) => {
    const dx = x - cx; const dy = y - cy;
    const k = 1 + k1 * (dx * dx + dy * dy) * invF2;
    return [cx + dx * k, cy + dy * k];
  };
  let rx = 0; let ry = 0; let rz = 1; // world direction of the current ray
  /** Card coordinates where the current ray meets Z = z0 − lift(u, v) (a few fixed-point steps on a curled card). */
  const hit = (z0, curved, out, k) => {
    let z = z0; let u = 0; let v = 0;
    for (let it = 0; it < (curved && lift ? 30 : 1); it++) {
      const t = (z - C[2]) / rz;
      const X = C[0] + t * rx; const Y = C[1] + t * ry;
      u = hw + c * X + s * Y; v = hh - s * X + c * Y;
      if (!(curved && lift)) break;
      const zn = z0 - lift(u, v);
      if (Math.abs(zn - z) < 1e-5) break;
      z = zn;
    }
    out[k] = u; out[k + 1] = v;
  };
  const project = (u, v, z) => {
    const X = c * (u - hw) - s * (v - hh); const Y = s * (u - hw) + c * (v - hh);
    const px = X - C[0]; const py = Y - C[1]; const pz = z - C[2];
    // world → camera: Mᵀ
    const xc = M[0] * px + M[3] * py + M[6] * pz; const yc = M[1] * px + M[4] * py + M[7] * pz; const zc = M[2] * px + M[5] * py + M[8] * pz;
    return distort(f * xc / zc + cx, f * yc / zc + cy);
  };
  return {
    D,
    /** Card coordinates of image point (x, y): face → out[0..1], table → out[2..3], card underside → out[4..5]. */
    map(x, y, out) {
      let X = x; let Y = y;
      if (k1) {
        if (!lut) buildLut();
        const dx = x - cx; const dy = y - cy;
        const t = (dx * dx + dy * dy) * invF2 * lutScale;
        const i = Math.min(N, t | 0);
        const k = lut[i] + (lut[i + 1] - lut[i]) * (t - i);
        X = cx + dx * k; Y = cy + dy * k;
      }
      const ux = (X - cx) / f; const uy = (Y - cy) / f;
      rx = M[0] * ux + M[1] * uy + M[2]; ry = M[3] * ux + M[4] * uy + M[5]; rz = M[6] * ux + M[7] * uy + M[8];
      hit(-thickness, true, out, 0);
      hit(0, false, out, 2);
      if (lift) hit(0, true, out, 4); else { out[4] = out[2]; out[5] = out[3]; }
    },
    /** Image point of card point (u, v) on the face ('top'), the card's underside ('bot') or the table ('table'). */
    project(u, v, plane = 'top') {
      const l = lift ? lift(u, v) : 0;
      return project(u, v, plane === 'top' ? -thickness - l : plane === 'bot' ? -l : 0);
    },
  };
}

/** Scanner: orthographic, skewed by `skew` degrees, card centre at `center` (px). */
export function scannerModel({ ppm, skew, center, cw, ch }) {
  const a = skew * DEG; const c = Math.cos(a) * ppm; const s = Math.sin(a) * ppm;
  // image = center + Rot·(u − cw/2, v − ch/2)·ppm
  const H = [c, -s, center[0] - c * cw / 2 + s * ch / 2, s, c, center[1] - s * cw / 2 - c * ch / 2, 0, 0, 1];
  const Hi = inv3(H);
  return {
    map(x, y, out) {
      out[0] = Hi[0] * x + Hi[1] * y + Hi[2]; out[1] = Hi[3] * x + Hi[4] * y + Hi[5];
      out[2] = out[0]; out[3] = out[1]; out[4] = out[0]; out[5] = out[1];
    },
    project(u, v) { return [H[0] * u + H[1] * v + H[2], H[3] * u + H[4] * v + H[5]]; },
  };
}

// ---------------------------------------------------------------- rasteriser

/** From this scale up, smooth pixels are taken from their corners (the thinnest printed line, 0.12 mm, spans > 1.3 px). */
export const ADAPTIVE_MIN_PX_PER_MM = 11;

/**
 * Render linear-light RGB planes. Lighting and glare are applied per pixel.
 * scene: {W, H, ss, model:{map}, card, bg, wall (bool), shadow {dx, dy, blur, strength} | null,
 *         light {exposure, vig, grad, gdir, wb, cx, cy}, glare {x, y, sa, sb, ang, amp} | null}
 */
function rasterize(scene) {
  const { W, H, model, card, bg, wall = false, shadow = null, light, glare = null } = scene;
  const ss = scene.ss ?? 2;
  const N = W * H;
  const R = new Float32Array(N); const G = new Float32Array(N); const B = new Float32Array(N);
  // Per grid point (pixel corner): u, v, sd on the card face; u, v, sd on the table; and with `adaptive` the sRGB colour
  // there (face inside the card, table outside). A pixel whose 4 corner colours agree within ADAPT_LEVELS is smooth:
  // the corner average is its value. Elsewhere 2×2 stratified jittered samples are taken. Below ~11 px/mm a thin line
  // could fit between corners, so every pixel is supersampled there.
  const adaptive = scene.adaptive ?? false;
  const T = scene.adaptLevels ?? 5;
  const stride = 14; // + the card underside's u, v (side wall test) at 12, 13
  let row0 = new Float64Array((W + 1) * stride); let row1 = new Float64Array((W + 1) * stride);
  const tmp = [0, 0, 0, 0, 0, 0];
  const col = [0, 0, 0];
  const fill = (y, row) => {
    for (let x = 0; x <= W; x++) {
      model.map(x, y, tmp);
      const j = x * stride;
      const sd = card.sd(tmp[0], tmp[1]);
      row[j] = tmp[0]; row[j + 1] = tmp[1]; row[j + 2] = sd;
      row[j + 3] = tmp[2]; row[j + 4] = tmp[3]; row[j + 5] = wall ? card.sd(tmp[4], tmp[5]) : shadow ? card.sd(tmp[2], tmp[3]) : sd;
      row[j + 12] = tmp[4]; row[j + 13] = tmp[5];
      if (adaptive) {
        if (sd < 0) card.face(tmp[0], tmp[1], -sd, col);
        else if (!bg.plain) bg.shade(tmp[2], tmp[3], col);
        else { col[0] = 0; col[1] = 0; col[2] = 0; }
        row[j + 6] = col[0]; row[j + 7] = col[1]; row[j + 8] = col[2];
        row[j + 9] = toLin(col[0]); row[j + 10] = toLin(col[1]); row[j + 11] = toLin(col[2]);
      }
    }
  };
  const smoothCorners = (j0, j1) => {
    for (let c = 6; c < 9; c++) {
      const a = row0[j0 + c]; const b = row0[j1 + c]; const d = row1[j0 + c]; const e = row1[j1 + c];
      const hi = Math.max(a, b, d, e); const lo = Math.min(a, b, d, e);
      if (hi - lo > T) return false;
    }
    return true;
  };
  const cornerAvg = (j0, j1, c) => 0.25 * (row0[j0 + c] + row0[j1 + c] + row1[j0 + c] + row1[j1 + c]);
  fill(0, row0);
  const wallLin = wall ? card.wall.map(toLin).map((v) => v * (scene.wallShade ?? 0.8)) : null;
  const inv = 1 / (ss * ss);
  let jit = (scene.seed ?? 1) >>> 0 || 1;
  const rnd = () => { jit ^= jit << 13; jit ^= jit >>> 17; jit ^= jit << 5; return (jit >>> 0) / 4294967296; };
  const bgPlain = bg.plain;
  const maxDepth = card.maxDepth;
  const sh = shadow; const shReach = sh ? Math.hypot(sh.dx, sh.dy) + 2.5 * sh.blur : 0;
  const halfDiag = Math.hypot(W, H) / 2;
  const { exposure, vig, grad, gdir, wb } = light;
  const lcx = light.cx ?? W / 2; const lcy = light.cy ?? H / 2;
  const gcx = Math.cos(gdir); const gsy = Math.sin(gdir);
  const wb0 = wb[0] * exposure; const wb1 = wb[1] * exposure; const wb2 = wb[2] * exposure;
  let gl = null;
  if (glare) { const c = Math.cos(glare.ang); const s = Math.sin(glare.ang); gl = { ...glare, c, s, ia: 1 / (2 * glare.sa * glare.sa), ib: 1 / (2 * glare.sb * glare.sb), reach: 3.2 * Math.max(glare.sa, glare.sb) }; }
  const gloss = card.gloss ?? 1;
  for (let y = 0; y < H; y++) {
    fill(y + 1, row1);
    for (let x = 0; x < W; x++) {
      const j0 = x * stride; const j1 = j0 + stride;
      const u00 = row0[j0]; const v00 = row0[j0 + 1]; const u10 = row0[j1]; const v10 = row0[j1 + 1];
      const u01 = row1[j0]; const v01 = row1[j0 + 1]; const u11 = row1[j1]; const v11 = row1[j1 + 1];
      const s00 = row0[j0 + 2]; const s10 = row0[j1 + 2]; const s01 = row1[j0 + 2]; const s11 = row1[j1 + 2];
      const smin = Math.min(s00, s10, s01, s11); const smax = Math.max(s00, s10, s01, s11);
      const du = u10 - u00; const dv = v10 - v00; const eu = u01 - u00; const ev = v01 - v00; const xu = u00 - u10 - u01 + u11; const xv = v00 - v10 - v01 + v11;
      const delta = Math.abs(du) + Math.abs(dv) + Math.abs(eu) + Math.abs(ev);
      let r = 0; let g = 0; let b = 0; let c = 0;
      const b00u = row0[j0 + 3]; const b00v = row0[j0 + 4]; const b10u = row0[j1 + 3]; const b10v = row0[j1 + 4];
      const b01u = row1[j0 + 3]; const b01v = row1[j0 + 4]; const b11u = row1[j1 + 3]; const b11v = row1[j1 + 4];
      const bsmin = Math.min(row0[j0 + 5], row0[j1 + 5], row1[j0 + 5], row1[j1 + 5]);
      const bdu = b10u - b00u; const bdv = b10v - b00v; const beu = b01u - b00u; const bev = b01v - b00v; const bxu = b00u - b10u - b01u + b11u; const bxv = b00v - b10v - b01v + b11v;
      if (smax < -delta && adaptive && smoothCorners(j0, j1)) {
        r = cornerAvg(j0, j1, 9); g = cornerAvg(j0, j1, 10); b = cornerAvg(j0, j1, 11); c = 1;
      } else if (smax < -delta) {
        // Card face only.
        const near = smin > -maxDepth - delta;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const fx = (sx + rnd()) / ss; const fy = (sy + rnd()) / ss;
            const u = u00 + du * fx + eu * fy + xu * fx * fy; const v = v00 + dv * fx + ev * fy + xv * fx * fy;
            card.face(u, v, near ? -card.sd(u, v) : 99, col);
            r += toLin(col[0]); g += toLin(col[1]); b += toLin(col[2]);
          }
        }
        r *= inv; g *= inv; b *= inv; c = 1;
      } else if (smin > delta && (!wall || bsmin > delta * 2)) {
        // Table only.
        if (bgPlain) {
          bg.shade(b00u + bdu * 0.5 + beu * 0.5 + bxu * 0.25, b00v + bdv * 0.5 + bev * 0.5 + bxv * 0.25, col);
          r = toLin(col[0]); g = toLin(col[1]); b = toLin(col[2]);
        } else if (adaptive && smoothCorners(j0, j1)) {
          r = cornerAvg(j0, j1, 9); g = cornerAvg(j0, j1, 10); b = cornerAvg(j0, j1, 11);
        } else {
          for (let sy = 0; sy < ss; sy++) {
            for (let sx = 0; sx < ss; sx++) {
              const fx = (sx + rnd()) / ss; const fy = (sy + rnd()) / ss;
              bg.shade(b00u + bdu * fx + beu * fy + bxu * fx * fy, b00v + bdv * fx + bev * fy + bxv * fx * fy, col);
              r += toLin(col[0]); g += toLin(col[1]); b += toLin(col[2]);
            }
          }
          r *= inv; g *= inv; b *= inv;
        }
      } else {
        // Mixed: the card outline (and on a photo, maybe its side wall) crosses this pixel.
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const fx = (sx + rnd()) / ss; const fy = (sy + rnd()) / ss;
            const u = u00 + du * fx + eu * fy + xu * fx * fy; const v = v00 + dv * fx + ev * fy + xv * fx * fy;
            const d = card.sd(u, v);
            if (d < 0) {
              card.face(u, v, -d, col);
              r += toLin(col[0]); g += toLin(col[1]); b += toLin(col[2]); c++;
              continue;
            }
            const bu = b00u + bdu * fx + beu * fy + bxu * fx * fy; const bv = b00v + bdv * fx + bev * fy + bxv * fx * fy;
            if (wall) {
              // The ray missed the face but meets the card's underside inside the outline: it passed through a side wall.
              const w00u = row0[j0 + 12]; const w00v = row0[j0 + 13];
              const wu = w00u + (row0[j1 + 12] - w00u) * fx + (row1[j0 + 12] - w00u) * fy + (w00u - row0[j1 + 12] - row1[j0 + 12] + row1[j1 + 12]) * fx * fy;
              const wv = w00v + (row0[j1 + 13] - w00v) * fx + (row1[j0 + 13] - w00v) * fy + (w00v - row0[j1 + 13] - row1[j0 + 13] + row1[j1 + 13]) * fx * fy;
              if (card.sd(wu, wv) < 0) { r += wallLin[0]; g += wallLin[1]; b += wallLin[2]; continue; }
            }
            bg.shade(bu, bv, col);
            r += toLin(col[0]); g += toLin(col[1]); b += toLin(col[2]);
          }
        }
        r *= inv; g *= inv; b *= inv; c *= inv;
      }
      // Contact shadow on the table (smooth: once per pixel).
      if (sh && c < 1 && bsmin < shReach) {
        const bu = b00u + (bdu + beu) * 0.5 + bxu * 0.25; const bv = b00v + (bdv + bev) * 0.5 + bxv * 0.25;
        const k = 1 - sh.strength * (1 - smooth(-sh.blur, sh.blur, card.sd(bu - sh.dx, bv - sh.dy)));
        const kk = c + (1 - c) * k;
        r *= kk; g *= kk; b *= kk;
      }
      // Lighting: vignetting, gradient, exposure, white balance; then specular glare (mostly on the glossy card).
      const px = x + 0.5 - lcx; const py = y + 0.5 - lcy;
      const rho2 = (px * px + py * py) / (halfDiag * halfDiag);
      const L = (1 - vig * rho2) * (1 + grad * (px * gcx + py * gsy) / halfDiag);
      r *= L * wb0; g *= L * wb1; b *= L * wb2;
      if (gl) {
        const gx = x + 0.5 - gl.x; const gy = y + 0.5 - gl.y;
        if (gx > -gl.reach && gx < gl.reach && gy > -gl.reach && gy < gl.reach) {
          const a = gx * gl.c + gy * gl.s; const bb = -gx * gl.s + gy * gl.c;
          const e = gl.amp * Math.exp(-a * a * gl.ia - bb * bb * gl.ib) * (c * gloss + (1 - c) * 0.12);
          r += e; g += e; b += e;
        }
      }
      const i = y * W + x;
      R[i] = r; G[i] = g; B[i] = b;
    }
    const t = row0; row0 = row1; row1 = t;
  }
  return { R, G, B };
}

// ---------------------------------------------------------------- filters

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

/** Separable blur of one plane with kernels kx, ky (clamped edges). In place; tmp is scratch of the same size. */
function blurPlane(p, W, H, kx, ky, tmp) {
  if (kx) {
    const r = (kx.length - 1) >> 1;
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let s = 0;
        if (x >= r && x < W - r) { const b = o + x - r; for (let k = 0; k < kx.length; k++) s += kx[k] * p[b + k]; }
        else for (let k = -r; k <= r; k++) { const xx = x + k < 0 ? 0 : x + k >= W ? W - 1 : x + k; s += kx[k + r] * p[o + xx]; }
        tmp[o + x] = s;
      }
    }
  } else tmp.set(p);
  if (ky) {
    const r = (ky.length - 1) >> 1;
    const acc = new Float32Array(W);
    for (let y = 0; y < H; y++) {
      const o = y * W;
      acc.fill(0);
      for (let k = -r; k <= r; k++) {
        const yy = y + k < 0 ? 0 : y + k >= H ? H - 1 : y + k;
        const w = ky[k + r]; const q = yy * W;
        for (let x = 0; x < W; x++) acc[x] += w * tmp[q + x];
      }
      p.set(acc, o);
    }
  } else p.set(tmp);
}

/** Gaussian defocus / CIS blur of the RGB planes; sigma2 + dir blend toward a second blur across the frame (depth of field). */
function opticalBlur(planes, W, H, { sx, sy = sx, sigma2 = null, dir = 0 } = {}) {
  const tmp = new Float32Array(W * H);
  const kx = sx > 0.25 ? gaussKernel(sx) : null; const ky = sy > 0.25 ? gaussKernel(sy) : null;
  if (sigma2 === null || Math.abs(sigma2 - sx) < 0.15) {
    for (const p of planes) blurPlane(p, W, H, kx, ky, tmp);
    return;
  }
  const k2 = sigma2 > 0.25 ? gaussKernel(sigma2) : null;
  const c = Math.cos(dir); const s = Math.sin(dir);
  const ext = Math.abs(c) * W / 2 + Math.abs(s) * H / 2;
  const tmp2 = new Float32Array(W * H);
  for (const p of planes) {
    const q = Float32Array.from(p);
    blurPlane(p, W, H, kx, ky, tmp);
    blurPlane(q, W, H, k2, k2, tmp2);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const t = clamp01(0.5 + 0.5 * ((x - W / 2) * c + (y - H / 2) * s) / ext);
        const i = y * W + x;
        p[i] += (q[i] - p[i]) * t;
      }
    }
  }
}

/** Lateral chromatic aberration: red magnified by (1 + eps), blue by (1 − eps) about (cx, cy); green is the reference. */
function chromaticAberration([R, , B], W, H, cx, cy, eps) {
  if (!eps) return;
  for (const [p, k] of [[R, 1 / (1 + eps)], [B, 1 / (1 - eps)]]) {
    const src = Float32Array.from(p);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Pixel centres: sample the source at the de-magnified position.
        let sx = cx + (x + 0.5 - cx) * k - 0.5; let sy = cy + (y + 0.5 - cy) * k - 0.5;
        sx = sx < 0 ? 0 : sx > W - 1.001 ? W - 1.001 : sx; sy = sy < 0 ? 0 : sy > H - 1.001 ? H - 1.001 : sy;
        const x0 = sx | 0; const y0 = sy | 0; const fx = sx - x0; const fy = sy - y0; const i = y0 * W + x0;
        p[y * W + x] = src[i] + (src[i + 1] - src[i]) * fx + (src[i + W] - src[i]) * fy + (src[i] - src[i + 1] - src[i + W] + src[i + W + 1]) * fx * fy;
      }
    }
  }
}

const GTAB = (() => {
  const r = rng(12345);
  const t = new Float32Array(65536);
  for (let i = 0; i < t.length; i++) t[i] = gauss(r);
  return t;
})();

/**
 * Poisson-Gaussian sensor noise on linear planes: variance a·v + b. A share `corr` (0..1) is common to the channels
 * (luma); with `spatial` that common part is low-passed with [1 2 1]/4 (demosaicing and ISP denoising correlate
 * neighbouring pixels), its variance kept.
 */
function sensorNoise(planes, W, H, { a, b, corr = 0.4, spatial = false, seed = 1 }) {
  const N = W * H;
  let s = (seed >>> 0) || 7;
  const common = new Float32Array(N);
  for (let i = 0; i < N; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; common[i] = GTAB[s >>> 16]; }
  if (spatial) {
    const k = new Float32Array([0.25, 0.5, 0.25]);
    blurPlane(common, W, H, k, k, new Float32Array(N));
    for (let i = 0; i < N; i++) common[i] *= 2.6667;
  }
  const own = Math.sqrt(1 - corr * corr);
  for (const p of planes) {
    for (let i = 0; i < N; i++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const v = p[i];
      p[i] = v + Math.sqrt(a * (v > 0 ? v : 0) + b) * (corr * common[i] + own * GTAB[s >>> 16]);
    }
  }
}

/** Linear planes → 8-bit RGBA (sRGB), with optional unsharp masking of luma (phone ISP). Overwrites the planes. */
function encodeSrgb([r, g, b], W, H, { sharpen = null } = {}) {
  const N = W * H;
  for (let i = 0; i < N; i++) { r[i] = toSrgb(r[i]); g[i] = toSrgb(g[i]); b[i] = toSrgb(b[i]); }
  if (sharpen && sharpen.amount > 0) {
    const Y = new Float32Array(N);
    for (let i = 0; i < N; i++) Y[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i];
    const Yb = Float32Array.from(Y);
    const k = gaussKernel(sharpen.sigma);
    blurPlane(Yb, W, H, k, k, new Float32Array(N));
    const amt = sharpen.amount; const thr = sharpen.threshold ?? 1;
    for (let i = 0; i < N; i++) {
      let d = Y[i] - Yb[i];
      d = d > thr ? d - thr : d < -thr ? d + thr : 0;
      d *= amt;
      r[i] += d; g[i] += d; b[i] += d;
    }
  }
  const data = new Uint8ClampedArray(N * 4);
  for (let i = 0, j = 0; i < N; i++, j += 4) { data[j] = r[i]; data[j + 1] = g[i]; data[j + 2] = b[i]; data[j + 3] = 255; }
  return data;
}

// ---------------------------------------------------------------- JPEG round trip

const STD_LUM = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const STD_CHR = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array(32).fill(99)];

/** IJG quality scaling of a base table (jcparam.c), baseline-limited to 1..255. */
export function qualityTable(base, quality) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return Float32Array.from(base, (v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100))));
}

// 8-point orthonormal DCT-II and its inverse by even/odd decomposition (22 multiplies each). c_m = cos(mπ/16) / 2.
const [K1, K2, K3, K4, K5, K6, K7] = [1, 2, 3, 4, 5, 6, 7].map((m) => Math.cos((m * Math.PI) / 16) / 2);
function fdct8(a, o, st) {
  const x0 = a[o]; const x1 = a[o + st]; const x2 = a[o + 2 * st]; const x3 = a[o + 3 * st];
  const x4 = a[o + 4 * st]; const x5 = a[o + 5 * st]; const x6 = a[o + 6 * st]; const x7 = a[o + 7 * st];
  const s0 = x0 + x7; const s1 = x1 + x6; const s2 = x2 + x5; const s3 = x3 + x4;
  const d0 = x0 - x7; const d1 = x1 - x6; const d2 = x2 - x5; const d3 = x3 - x4;
  const e0 = s0 + s3; const e1 = s1 + s2; const f0 = s0 - s3; const f1 = s1 - s2;
  a[o] = K4 * (e0 + e1); a[o + 4 * st] = K4 * (e0 - e1);
  a[o + 2 * st] = K2 * f0 + K6 * f1; a[o + 6 * st] = K6 * f0 - K2 * f1;
  a[o + st] = K1 * d0 + K3 * d1 + K5 * d2 + K7 * d3;
  a[o + 3 * st] = K3 * d0 - K7 * d1 - K1 * d2 - K5 * d3;
  a[o + 5 * st] = K5 * d0 - K1 * d1 + K7 * d2 + K3 * d3;
  a[o + 7 * st] = K7 * d0 - K5 * d1 + K3 * d2 - K1 * d3;
}
function idct8(a, o, st) {
  const X0 = a[o]; const X1 = a[o + st]; const X2 = a[o + 2 * st]; const X3 = a[o + 3 * st];
  const X4 = a[o + 4 * st]; const X5 = a[o + 5 * st]; const X6 = a[o + 6 * st]; const X7 = a[o + 7 * st];
  const p = K4 * (X0 + X4); const q = K4 * (X0 - X4);
  const E0 = p + K2 * X2 + K6 * X6; const E3 = p - K2 * X2 - K6 * X6;
  const E1 = q + K6 * X2 - K2 * X6; const E2 = q - K6 * X2 + K2 * X6;
  const O0 = K1 * X1 + K3 * X3 + K5 * X5 + K7 * X7;
  const O1 = K3 * X1 - K7 * X3 - K1 * X5 - K5 * X7;
  const O2 = K5 * X1 - K1 * X3 + K7 * X5 + K3 * X7;
  const O3 = K7 * X1 - K5 * X3 + K3 * X5 - K1 * X7;
  a[o] = E0 + O0; a[o + 7 * st] = E0 - O0; a[o + st] = E1 + O1; a[o + 6 * st] = E1 - O1;
  a[o + 2 * st] = E2 + O2; a[o + 5 * st] = E2 - O2; a[o + 3 * st] = E3 + O3; a[o + 4 * st] = E3 - O3;
}
/** Reference 2-D DCT by matrix products (tests only). */
export function dct2Reference(block) {
  const C = (k, n) => (k === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * n + 1) * k * Math.PI) / 16);
  const out = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += C(u, y) * C(v, x) * block[y * 8 + x]; out[u * 8 + v] = s; }
  return out;
}
export function dct2(block) { const a = Float64Array.from(block); for (let y = 0; y < 8; y++) fdct8(a, y * 8, 1); for (let x = 0; x < 8; x++) fdct8(a, x, 8); return a; }
export function idct2(block) { const a = Float64Array.from(block); for (let x = 0; x < 8; x++) idct8(a, x, 8); for (let y = 0; y < 8; y++) idct8(a, y * 8, 1); return a; }

/** Quantise one plane block by block (orthonormal 8×8 DCT = JPEG's FDCT) and decode it back: rounded, clamped 0..255. */
function planeRoundTrip(p, w, h, Q) {
  const blk = new Float64Array(64);
  const iQ = Q.map((v) => 1 / v);
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      for (let y = 0; y < 8; y++) { const o = (by + y) * w + bx; for (let x = 0; x < 8; x++) blk[y * 8 + x] = p[o + x] - 128; }
      for (let y = 0; y < 8; y++) fdct8(blk, y * 8, 1);
      for (let x = 0; x < 8; x++) fdct8(blk, x, 8);
      for (let i = 0; i < 64; i++) blk[i] = Math.round(blk[i] * iQ[i]) * Q[i];
      for (let x = 0; x < 8; x++) idct8(blk, x, 8);
      for (let y = 0; y < 8; y++) idct8(blk, y * 8, 1);
      for (let y = 0; y < 8; y++) {
        const o = (by + y) * w + bx;
        for (let x = 0; x < 8; x++) { const v = Math.round(blk[y * 8 + x] + 128); p[o + x] = v < 0 ? 0 : v > 255 ? 255 : v; }
      }
    }
  }
}

/**
 * JPEG compression and decoding of an RGBA image, as a browser would see the file: 4:2:0 (or 4:4:4) chroma,
 * IJG tables at `quality`, libjpeg's triangle ("fancy") chroma upsampling.
 */
export function jpegRoundTrip({ data, width: W, height: H }, quality, { subsampling = '420' } = {}) {
  const sub = subsampling === '420';
  const mcu = sub ? 16 : 8;
  const PW = Math.ceil(W / mcu) * mcu; const PH = Math.ceil(H / mcu) * mcu;
  const Y = new Float32Array(PW * PH); const Cb = new Float32Array(PW * PH); const Cr = new Float32Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    const row = Math.min(H - 1, y) * W;
    for (let x = 0; x < PW; x++) {
      const j = (row + (x < W ? x : W - 1)) * 4;
      const r = data[j]; const g = data[j + 1]; const b = data[j + 2];
      const i = y * PW + x;
      // jccolor.c: fixed-point with rounding; floor(v + 0.5) is the same.
      Y[i] = Math.floor(0.299 * r + 0.587 * g + 0.114 * b + 0.5);
      Cb[i] = Math.floor(128.5 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      Cr[i] = Math.floor(128.5 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  const QL = qualityTable(STD_LUM, quality); const QC = qualityTable(STD_CHR, quality);
  planeRoundTrip(Y, PW, PH, QL);
  let cb = Cb; let cr = Cr;
  if (sub) {
    const cw = PW / 2; const chh = PH / 2;
    cb = new Float32Array(cw * chh); cr = new Float32Array(cw * chh);
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const i = 2 * y * PW + 2 * x;
        const bias = (x & 1) ? 2 : 1; // jcsample.c alternates the rounding bias
        cb[y * cw + x] = (Cb[i] + Cb[i + 1] + Cb[i + PW] + Cb[i + PW + 1] + bias) >> 2;
        cr[y * cw + x] = (Cr[i] + Cr[i + 1] + Cr[i + PW] + Cr[i + PW + 1] + bias) >> 2;
      }
    }
    planeRoundTrip(cb, cw, chh, QC); planeRoundTrip(cr, cw, chh, QC);
    // h2v2 fancy upsampling (jdsample.c): rows 3:1, then columns 3:1, with libjpeg's rounding.
    const up = (c) => {
      const out = new Float32Array(PW * PH);
      const colsum = new Float32Array(cw);
      for (let y = 0; y < chh; y++) {
        for (let half = 0; half < 2; half++) {
          const far = half === 0 ? Math.max(0, y - 1) : Math.min(chh - 1, y + 1);
          for (let x = 0; x < cw; x++) colsum[x] = 3 * c[y * cw + x] + c[far * cw + x];
          const o = (2 * y + half) * PW;
          for (let x = 0; x < cw; x++) {
            const l = colsum[Math.max(0, x - 1)]; const m = colsum[x]; const r = colsum[Math.min(cw - 1, x + 1)];
            out[o + 2 * x] = (3 * m + l + 8) >> 4;
            out[o + 2 * x + 1] = (3 * m + r + 7) >> 4;
          }
        }
      }
      return out;
    };
    cb = up(cb); cr = up(cr);
  } else {
    planeRoundTrip(cb, PW, PH, QC); planeRoundTrip(cr, PW, PH, QC);
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * PW + x; const j = (y * W + x) * 4;
      const yy = Y[i]; const b = cb[i] - 128; const r = cr[i] - 128;
      out[j] = yy + 1.402 * r + 0.5 | 0;
      out[j + 1] = yy - 0.344136 * b - 0.714136 * r + 0.5 | 0;
      out[j + 2] = yy + 1.772 * b + 0.5 | 0;
      out[j + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

// ---------------------------------------------------------------- resampling (as the panel does before analysis)

/** Area-average resize of RGBA (each output pixel averages the source area it covers). */
export function resizeArea({ data, width: W, height: H }, w, h) {
  const weights = (n, m) => {
    // For each output index: list of [source index, weight].
    const out = [];
    const s = n / m;
    for (let i = 0; i < m; i++) {
      const a = i * s; const b = (i + 1) * s;
      const list = [];
      for (let k = Math.floor(a); k < Math.min(n, Math.ceil(b)); k++) { const wgt = Math.min(b, k + 1) - Math.max(a, k); if (wgt > 1e-9) list.push([k, wgt / s]); }
      out.push(list);
    }
    return out;
  };
  const wx = weights(W, w); const wy = weights(H, h);
  const tmp = new Float32Array(w * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0;
      for (const [k, wt] of wx[x]) { const j = (y * W + k) * 4; r += data[j] * wt; g += data[j + 1] * wt; b += data[j + 2] * wt; }
      const i = (y * w + x) * 3; tmp[i] = r; tmp[i + 1] = g; tmp[i + 2] = b;
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0;
      for (const [k, wt] of wy[y]) { const i = (k * w + x) * 3; r += tmp[i] * wt; g += tmp[i + 1] * wt; b += tmp[i + 2] * wt; }
      const j = (y * w + x) * 4; out[j] = r; out[j + 1] = g; out[j + 2] = b; out[j + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

/** Cut `rect` ({x, y, w, h}, photo px) out of an image, long side at most maxSide (gradeEngine.drawCrop): {img, scale}. */
export function cropArea({ data, width: W }, rect, maxSide = 3600) {
  const sub = new Uint8ClampedArray(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) sub.set(data.subarray(((rect.y + y) * W + rect.x) * 4, ((rect.y + y) * W + rect.x + rect.w) * 4), y * rect.w * 4);
  const img = { data: sub, width: rect.w, height: rect.h };
  const k = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  if (k === 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(rect.w * k)); const h = Math.max(1, Math.round(rect.h * k));
  return { img: resizeArea(img, w, h), scale: rect.w / w };
}

/**
 * What analyzeCard sees: the photo with its long side at most maxSide (gradeEngine.analysisSize), truth corners scaled.
 */
export function prepareForAnalysis({ img, truth, meta }, maxSide = 2800) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s === 1) return { img, truth, meta: { ...meta, analysisScale: 1 } };
  const w = Math.max(1, Math.round(img.width * s)); const h = Math.max(1, Math.round(img.height * s));
  const sx = w / img.width; const sy = h / img.height;
  return {
    img: resizeArea(img, w, h),
    truth: { ...truth, corners: truth.corners.map(([x, y]) => [x * sx, y * sy]), pxPerMm: truth.pxPerMm * (sx + sy) / 2 },
    meta: { ...meta, analysisScale: s },
  };
}

// ---------------------------------------------------------------- one render

const ratio = (a, b) => (Math.max(a, b) / (a + b)) * 100;

function truthOf(card, corners) {
  const B = card.trueBorders();
  const len = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const sh = card.layoutShift ?? {};
  return {
    lr: ratio(B.l + (sh.lr ?? 0), B.r - (sh.lr ?? 0)), tb: ratio(B.t + (sh.tb ?? 0), B.b - (sh.tb ?? 0)), borders: { ...B }, shift: { ...sh }, corners,
    pxPerMm: (len(corners[0], corners[3]) + len(corners[1], corners[2])) / 2 / card.ch,
    wear: { edges: card.wear.edges.map((e) => ({ ...e })), corners: card.wear.corners.map((c) => ({ ...c })) },
  };
}

/** Fit the card into the frame: shrink the scale, then the off-centre shift, until all of its outline is inside. */
function placeInFrame(p, card) {
  let { scale } = p;
  let shift = p.shift ?? [0, 0];
  const margin = p.margin ?? Math.max(6, 0.015 * Math.max(p.W, p.H));
  for (let it = 0; it < 80; it++) {
    // Card offset in the image ≈ shift × available slack: aim the camera the other way.
    const cam0 = cameraModel({ ...p, scale, target: [0, 0], cw: card.cw, ch: card.ch, thickness: card.thickness, bow: p.bow });
    const pts0 = outlinePts(cam0, card);
    const bx = bbox(pts0);
    const slackX = Math.max(0, (p.W - (bx[2] - bx[0])) / 2 - margin); const slackY = Math.max(0, (p.H - (bx[3] - bx[1])) / 2 - margin);
    const cx0 = (bx[0] + bx[2]) / 2 - p.W / 2; const cy0 = (bx[1] + bx[3]) / 2 - p.H / 2;
    const want = [shift[0] * slackX - cx0, shift[1] * slackY - cy0];
    const target = [-want[0] / scale, -want[1] / scale];
    const cam = cameraModel({ ...p, scale, target, cw: card.cw, ch: card.ch, thickness: card.thickness, bow: p.bow });
    const b = bbox(outlinePts(cam, card));
    if (b[0] >= margin && b[1] >= margin && b[2] <= p.W - margin && b[3] <= p.H - margin) return { cam, scale, target };
    if (Math.abs(shift[0]) + Math.abs(shift[1]) > 0.05) shift = [shift[0] * 0.6, shift[1] * 0.6];
    else scale *= 0.97;
  }
  throw new Error('card does not fit the frame');
}
const outlinePts = (cam, card) => {
  const pts = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    pts.push(cam.project(card.cw * t, 0), cam.project(card.cw * t, card.ch), cam.project(0, card.ch * t), cam.project(card.cw, card.ch * t));
    pts.push(cam.project(card.cw * t, 0, 'bot'), cam.project(card.cw * t, card.ch, 'bot'), cam.project(0, card.ch * t, 'bot'), cam.project(card.cw, card.ch * t, 'bot'));
  }
  return pts;
};
const bbox = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

/**
 * Photo of a card on a surface.
 * p: {seed, template, borders, variant?, wear?, W, H, f, k1, pp, pitch, yaw, rotation, scale (px/mm), shift [-1..1]²,
 *     bg (kind), shadow, light, glare, psf {sigma, sigma2?, dir?}, noise {a, b, corr, spatial}, sharpen, jpeg (quality | null)}
 */
export function renderPhoto(p) {
  const rand = rng((p.seed ^ 0x9e3779b9) >>> 0);
  const card = makeCard(rand, p.template, p.borders, { variant: p.variant, wear: p.wear, printTilt: p.printTilt ?? 0, sleeve: p.sleeve });
  const bg = sleeved(makeBackground(rand, p.bg), p.sleeve, card.cw, card.ch);
  const { cam, scale, target } = placeInFrame(p, card);
  const corners = [[0, 0], [card.cw, 0], [card.cw, card.ch], [0, card.ch]].map(([u, v]) => cam.project(u, v));
  const lin = rasterize({
    W: p.W, H: p.H, ss: p.ss ?? 2, model: cam, card, bg, wall: true, wallShade: p.wallShade ?? 0.8, seed: p.seed, adaptive: p.adaptive ?? scale >= ADAPTIVE_MIN_PX_PER_MM,
    shadow: p.shadow, light: p.light, glare: p.glare,
  });
  const planes = [lin.R, lin.G, lin.B];
  opticalBlur(planes, p.W, p.H, { sx: p.psf.sigma, sigma2: p.psf.sigma2 ?? null, dir: p.psf.dir ?? 0 });
  chromaticAberration(planes, p.W, p.H, p.W / 2 + (p.pp?.[0] ?? 0), p.H / 2 + (p.pp?.[1] ?? 0), p.ca ?? 0);
  sensorNoise(planes, p.W, p.H, { ...p.noise, seed: p.seed ^ 0x5bd1e995 });
  let img = { data: encodeSrgb(planes, p.W, p.H, { sharpen: p.sharpen }), width: p.W, height: p.H };
  if (p.jpeg) img = jpegRoundTrip(img, p.jpeg, { subsampling: p.subsampling ?? '420' });
  return { img, truth: truthOf(card, corners), meta: { ...summarize(p), template: card.template, variant: card.variant, scaleUsed: +scale.toFixed(2), camDistMm: +cam.D.toFixed(0), target } };
}

/**
 * Flatbed scan. p: {seed, template, borders, variant?, wear?, dpi, skew, margins [l, t, r, b] mm (crop) | page {w, h, x, y} mm,
 *   bg ('lid-white' | 'lid-black'), shadow?, cis {sx, sy}, noise, jpeg}
 */
export function renderScan(p) {
  const rand = rng((p.seed ^ 0x9e3779b9) >>> 0);
  const card = makeCard(rand, p.template, p.borders, { variant: p.variant, wear: p.wear, printTilt: p.printTilt ?? 0 });
  const bg = rimmed(makeBackground(rand, p.bg), p.rim, card);
  const ppm = p.dpi / 25.4;
  let W; let H; let center;
  // Footprint of the skewed card (mm), so a crop keeps its margins around it.
  const a = Math.abs(p.skew * DEG);
  const fw = card.cw * Math.cos(a) + card.ch * Math.sin(a); const fh = card.cw * Math.sin(a) + card.ch * Math.cos(a);
  if (p.page) {
    W = Math.round(p.page.w * ppm); H = Math.round(p.page.h * ppm);
    center = [(p.page.x + fw / 2) * ppm, (p.page.y + fh / 2) * ppm];
  } else {
    const [ml, mt, mr, mb] = p.margins;
    W = Math.round((fw + ml + mr) * ppm); H = Math.round((fh + mt + mb) * ppm);
    center = [(ml + fw / 2) * ppm, (mt + fh / 2) * ppm];
  }
  const model = scannerModel({ ppm, skew: p.skew, center, cw: card.cw, ch: card.ch });
  const corners = [[0, 0], [card.cw, 0], [card.cw, card.ch], [0, card.ch]].map(([u, v]) => model.project(u, v));
  const lin = rasterize({
    W, H, ss: p.ss ?? 2, model, card, bg, wall: false, seed: p.seed, shadow: p.shadow ?? null, adaptive: p.adaptive ?? ppm >= ADAPTIVE_MIN_PX_PER_MM,
    light: { exposure: 1, vig: 0, grad: p.drift ?? 0, gdir: 0, wb: [1, 1, 1] }, glare: null,
  });
  const planes = [lin.R, lin.G, lin.B];
  opticalBlur(planes, W, H, { sx: p.cis.sx, sy: p.cis.sy });
  sensorNoise(planes, W, H, { ...p.noise, seed: p.seed ^ 0x5bd1e995 });
  let img = { data: encodeSrgb(planes, W, H), width: W, height: H };
  if (p.jpeg) img = jpegRoundTrip(img, p.jpeg, { subsampling: p.subsampling ?? '420' });
  return { img, truth: truthOf(card, corners), meta: { ...summarize(p), template: card.template, variant: card.variant, W, H } };
}

/** Params without the bulky parts, for reports. */
function summarize(p) {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === 'wear') continue;
    out[k] = typeof v === 'number' ? +v.toFixed(4) : v;
  }
  return out;
}

// ---------------------------------------------------------------- scenarios

/** A wear sample: edge whitening runs, corner whitening, cut / blunted / dented corners. */
export function sampleWear(rand, card = { cw: 63, ch: 88 }, { edges = chance(rand, 0.6), corners = null } = {}) {
  const wantCorners = corners ?? (!edges || chance(rand, 0.5));
  const out = { edges: [], corners: [] };
  if (edges) {
    const n = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      const side = pick(rand, ['top', 'bottom', 'left', 'right']);
      const len = side === 'top' || side === 'bottom' ? card.cw : card.ch;
      const L = U(rand, 0.6, 6);
      const from = U(rand, 6.5, len - 6.5 - L);
      out.edges.push({ side, fromMm: +from.toFixed(2), toMm: +(from + L).toFixed(2), depthMm: +U(rand, 0.1, 0.4).toFixed(2), strength: +U(rand, 0.6, 1).toFixed(2) });
    }
  }
  if (wantCorners) {
    const n = 1 + Math.floor(rand() * 2);
    const used = new Set();
    for (let k = 0; k < n; k++) {
      let corner = pick(rand, ['tl', 'tr', 'br', 'bl']);
      if (used.has(corner)) continue;
      used.add(corner);
      const type = pick(rand, ['whitening', 'whitening', 'cut', 'blunt', 'dent']);
      if (type === 'whitening') {
        const from = U(rand, 0, 50);
        out.corners.push({ corner, type, fromDeg: +from.toFixed(0), toDeg: +Math.min(90, from + U(rand, 25, 90)).toFixed(0), depthMm: +U(rand, 0.12, 0.35).toFixed(2), strength: +U(rand, 0.6, 1).toFixed(2) });
      } else if (type === 'cut') {
        out.corners.push({ corner, type, mm: +U(rand, 0.2, 0.8).toFixed(2), rimMm: chance(rand, 0.7) ? +U(rand, 0.05, 0.15).toFixed(2) : 0 });
      } else if (type === 'blunt') {
        out.corners.push({ corner, type, mm: +U(rand, 0.2, 0.6).toFixed(2), rimMm: chance(rand, 0.6) ? +U(rand, 0.05, 0.12).toFixed(2) : 0 });
      } else {
        out.corners.push({ corner, type, mm: +U(rand, 0.25, 0.6).toFixed(2), at: +U(rand, 15, 75).toFixed(0), rimMm: chance(rand, 0.6) ? +U(rand, 0.05, 0.12).toFixed(2) : 0 });
      }
    }
  }
  return out;
}

const NORMAL_TEMPLATES = ['pokemon-front', 'pokemon-front', 'pokemon-front', 'pokemon-back', 'pokemon-back', 'lorcana', 'onepiece'];
const normalVariant = (rand, template) => (template === 'pokemon-front'
  ? { frame: pick(rand, Object.keys(TYPE_FRAMES)), line: chance(rand, 0.5) } : {});

function phoneBase(rand, { s, fill, maxLong = 2800, long = null, tilt = 8, rot = 8, fRange = [0.8, 1.6], k1 = 0.03,
  bgs = ['dark', 'mid'], jpeg = [85, 95], psf = [0.45, 1.1], noiseA = [1000, 4000], glareP = 0.15, sharpenP = 0.7, sag = 0.6, sleeveP = 0, exposure = [0.88, 1.05] }) {
  let L = long ?? Math.min(maxLong, Math.round((88 * s) / fill));
  if ((88 * s) / L > 0.93) s = (0.93 * L) / 88;
  const portrait = true;
  const W = portrait ? Math.round(L * 0.75) : L; const H = portrait ? L : Math.round(L * 0.75);
  const tiltMag = Math.abs(gauss(rand)) * tilt * 0.6; const tiltDir = U(rand, 0, 2 * Math.PI);
  const pitch = Math.max(-tilt, Math.min(tilt, tiltMag * Math.cos(tiltDir))); const yaw = Math.max(-tilt, Math.min(tilt, tiltMag * Math.sin(tiltDir)));
  const glare = chance(rand, glareP) ? { x: U(rand, 0.2, 0.8) * W, y: U(rand, 0.2, 0.8) * H, sa: U(rand, 3, 10) * s, sb: U(rand, 2, 6) * s, ang: U(rand, 0, Math.PI), amp: U(rand, 0.08, 0.3) } : null;
  return {
    W, H, scale: s, f: U(rand, fRange[0], fRange[1]) * L, k1: -U(rand, 0, k1), pp: [0, 0],
    pitch: +pitch.toFixed(2), yaw: +yaw.toFixed(2), rotation: +sym(rand, rot).toFixed(2), shift: [sym(rand, 0.8), sym(rand, 0.8)],
    bg: pick(rand, bgs),
    shadow: { dx: sym(rand, 1.2), dy: U(rand, 0.2, 1.4), blur: U(rand, 0.6, 2.2), strength: U(rand, 0.08, 0.35) },
    light: { exposure: U(rand, exposure[0], exposure[1]), vig: U(rand, 0.05, 0.3), grad: U(rand, 0, 0.15), gdir: U(rand, 0, 2 * Math.PI), wb: [U(rand, 0.95, 1.06), 1, U(rand, 0.9, 1.04)] },
    glare,
    psf: { sigma: U(rand, psf[0], psf[1]) },
    noise: { a: 1 / U(rand, noiseA[0], noiseA[1]), b: U(rand, 0.001, 0.003) ** 2, corr: 0.5, spatial: true },
    sharpen: chance(rand, sharpenP) ? { amount: U(rand, 0.3, 0.9), sigma: U(rand, 0.8, 1.6), threshold: U(rand, 0.5, 2) } : null,
    wallShade: U(rand, 0.55, 0.95),
    jpeg: Math.round(U(rand, jpeg[0], jpeg[1] + 0.99) - 0.5),
    // A raw card is rarely flat: half of them curl a little (sag in mm, across the width or along the length).
    bow: chance(rand, 0.5) ? { axis: chance(rand, 0.6) ? 'u' : 'v', sag: +U(rand, 0.1, sag).toFixed(2), edgesUp: chance(rand, 0.5) } : null,
    ca: sym(rand, 0.0008), // lateral chromatic aberration left after the phone's correction
    printTilt: printTilt(rand),
    sleeve: chance(rand, sleeveP) ? sampleSleeve(rand) : null,
  };
}
const printTilt = (rand) => +Math.max(-0.3, Math.min(0.3, gauss(rand) * 0.1)).toFixed(3);
const sampleSleeve = (rand) => ({
  m: [U(rand, 0.6, 2.5), U(rand, 2, 6), U(rand, 0.6, 2.5), U(rand, 0.6, 2)].map((v) => +v.toFixed(2)),
  lw: +U(rand, 0.15, 0.4).toFixed(2), line: +(chance(rand, 0.7) ? U(rand, 0.06, 0.25) : -U(rand, 0.05, 0.15)).toFixed(3), haze: +U(rand, 0.01, 0.05).toFixed(3),
});

function scanBase(rand, { dpi, bg, page = false }) {
  const mMax = dpi >= 1200 ? 7 : 12; // a 1200 dpi crop is cut tighter (and is 4× the pixels)
  const margins = [U(rand, 3, mMax), U(rand, 3, mMax), U(rand, 3, mMax), U(rand, 3, mMax)];
  const sx = U(rand, 0.6, 1.0);
  const out = {
    mode: 'scan', dpi, skew: +sym(rand, 2).toFixed(2), bg,
    cis: { sx, sy: sx * U(rand, 0.85, 1.15) },
    noise: { a: 1 / U(rand, 8000, 20000), b: U(rand, 0.0008, 0.0015) ** 2, corr: 0.2, spatial: false },
    jpeg: chance(rand, 0.7) ? Math.round(U(rand, 85, 95.99) - 0.5) : null,
    drift: U(rand, 0, 0.03),
    printTilt: printTilt(rand),
    // A CIS lamp lights from one side: the card's 0.3 mm thickness throws a thin shadow on a white lid along one edge.
    shadow: bg === 'lid-white' ? { dx: 0, dy: (chance(rand, 0.5) ? 1 : -1) * U(rand, 0.1, 0.25), blur: U(rand, 0.06, 0.15), strength: U(rand, 0.15, 0.45) } : null,
    // Over black backing the lamp catches the cut edge: a faint light rim on the side facing it (strength is a guess, not
    // calibrated against real scans).
    rim: bg === 'lid-black' && chance(rand, 0.4) ? { side: chance(rand, 0.5) ? 'top' : 'bottom', w: +U(rand, 0.03, 0.08).toFixed(3), strength: +U(rand, 0.1, 0.4).toFixed(2), color: [200, 198, 190] } : null,
  };
  if (page) out.page = { w: 210, h: 297, x: U(rand, 8, 210 - 75), y: U(rand, 8, 297 - 100) };
  else out.margins = margins.map((m) => +m.toFixed(2));
  return out;
}

const withCard = (rand, p, { templates = NORMAL_TEMPLATES, spread = 5, template = null, variant = null, darkOnDark = false } = {}) => {
  if (faceMode) {
    const F = pick(rand, FACES);
    return { ...p, template: 'official', variant: { face: F.id, game: F.game }, borders: shiftedBorders(rand, F.borders, faceShift(F), { spread }) };
  }
  // A black border on black backing has no outline at all: such scans are left out.
  const pool = p.bg === 'lid-black' ? templates.filter((t) => t !== 'lorcana' && t !== 'onepiece') : templates;
  const t = template ?? pick(rand, pool);
  // A black border on a dark surface hardly has an outline: that pairing belongs to the hard scenario.
  const bg = !darkOnDark && p.bg === 'dark' && (t === 'lorcana' || t === 'onepiece') ? 'mid' : p.bg;
  return { ...p, bg, template: t, variant: variant ?? normalVariant(rand, t), borders: sampleBorders(rand, t, { spread }) };
};

/** Scenario name → { description, sample(rand, index) → render params }. */
export const SCENARIOS = {
  'phone-good': {
    description: 'phone photo, 12-30 px/mm, mild tilt, JPEG 85-95, dark or mid background',
    sample: (rand) => withCard(rand, { mode: 'photo', ...phoneBase(rand, { s: U(rand, 12, 30), fill: U(rand, 0.6, 0.9) }) }),
  },
  'phone-listing': {
    description: 'listing photo, 1600 px, 8-14 px/mm, JPEG 70-85, mixed backgrounds',
    sample: (rand) => {
      const p = phoneBase(rand, { s: U(rand, 8, 14), long: 1600, tilt: 10, rot: 10, fRange: [0.9, 2.2], bgs: ['dark', 'mid', 'light', 'wood', 'playmat'], jpeg: [70, 85], psf: [0.5, 1.4], noiseA: [700, 2500], sharpenP: 0.85, sag: 1.0, sleeveP: 0.15, exposure: [0.85, 1.18] });
      p.pp = [sym(rand, 0.12) * p.W, sym(rand, 0.12) * p.H]; // often a crop of a larger photo
      return withCard(rand, { mode: 'photo', ...p });
    },
  },
  'phone-low': {
    description: 'small phone photo, 4-8 px/mm, JPEG 60-75',
    sample: (rand) => withCard(rand, { mode: 'photo', ...phoneBase(rand, { s: U(rand, 4, 8), fill: U(rand, 0.5, 0.85), bgs: ['dark', 'mid', 'light', 'wood'], jpeg: [60, 75], psf: [0.6, 1.5], noiseA: [300, 1200], sag: 0.8 }) }, { spread: 6 }),
  },
  'scan-600-white': {
    description: 'flatbed 600 dpi, crop around the card, white lid',
    sample: (rand) => withCard(rand, scanBase(rand, { dpi: 600, bg: 'lid-white' })),
  },
  'scan-600-black': {
    description: 'flatbed 600 dpi, crop around the card, black backing',
    sample: (rand) => withCard(rand, scanBase(rand, { dpi: 600, bg: 'lid-black' })),
  },
  'scan-1200-black': {
    description: 'flatbed 1200 dpi, crop, black backing (analysed at 2800 px like the panel does)',
    sample: (rand) => withCard(rand, scanBase(rand, { dpi: 1200, bg: 'lid-black' })),
  },
  'scan-300-fullpage': {
    description: 'flatbed 300 dpi, the whole A4 page, card somewhere on it',
    sample: (rand) => withCard(rand, scanBase(rand, { dpi: 300, bg: chance(rand, 0.7) ? 'lid-white' : 'lid-black', page: true })),
  },
  hard: {
    description: 'yellow-on-yellow frame, silver full-art, strong tilt, glare, textured or dark-on-dark background, sleeve, curled card',
    sample: (rand) => {
      // With official faces the card itself is a real design: only the photo factors apply.
      const first = faceMode ? ['strong-tilt', 'glare', 'textured-bg', 'sleeve', 'curled'] : ['yellow-on-yellow', 'silver-fullart', 'strong-tilt', 'glare', 'textured-bg', 'dark-on-dark', 'sleeve', 'curled'];
      const factors = [pick(rand, first)];
      if (chance(rand, 0.4)) { const f = pick(rand, ['strong-tilt', 'glare', 'textured-bg', 'sleeve', 'curled']); if (!factors.includes(f)) factors.push(f); }
      const has = (f) => factors.includes(f);
      const strong = has('strong-tilt');
      const p = phoneBase(rand, {
        s: U(rand, 9, 24), fill: U(rand, 0.6, 0.88), tilt: strong ? 34 : 8, rot: strong ? 30 : 10, fRange: strong ? [0.7, 1.0] : [0.8, 1.6],
        bgs: has('textured-bg') ? ['wood', 'playmat'] : has('dark-on-dark') ? ['dark'] : ['dark', 'mid', 'light'],
        jpeg: [78, 92], glareP: 0,
      });
      if (strong) {
        const mag = U(rand, 18, 32); const dir = U(rand, 0, 2 * Math.PI);
        p.pitch = +(mag * Math.cos(dir)).toFixed(2); p.yaw = +(mag * Math.sin(dir)).toFixed(2);
        if (chance(rand, 0.3)) p.rotation = +(90 + sym(rand, 10)).toFixed(2); // lying sideways
        // Close up with a wide lens: the far end is softer than the near one.
        p.psf = { sigma: U(rand, 0.4, 0.9), sigma2: U(rand, 1.2, 2.2), dir: U(rand, 0, 2 * Math.PI) };
      }
      if (has('glare')) {
        // A specular blob over part of the border, sometimes clipping.
        const side = pick(rand, ['l', 'r', 't', 'b']);
        const x = side === 'l' ? 0.2 : side === 'r' ? 0.8 : U(rand, 0.3, 0.7); const y = side === 't' ? 0.15 : side === 'b' ? 0.85 : U(rand, 0.3, 0.7);
        p.glare = { x: x * p.W, y: y * p.H, sa: U(rand, 4, 14) * p.scale, sb: U(rand, 2, 7) * p.scale, ang: U(rand, 0, Math.PI), amp: U(rand, 0.4, 1.2) };
      }
      if (has('sleeve')) p.sleeve = sampleSleeve(rand);
      if (has('curled')) p.bow = { axis: chance(rand, 0.6) ? 'u' : 'v', sag: +U(rand, 1, 2.5).toFixed(2), edgesUp: chance(rand, 0.5) };
      let card;
      if (has('yellow-on-yellow')) card = { template: 'pokemon-front', variant: { frame: 'lightning', line: false } };
      else if (has('silver-fullart')) card = { template: 'silver-fullart', variant: {} };
      else if (has('dark-on-dark')) card = { template: pick(rand, ['lorcana', 'onepiece']), variant: {} };
      else card = {};
      return { mode: 'photo', hard: factors, ...withCard(rand, p, { ...card, spread: 6, darkOnDark: true }) };
    },
  },
  wear: {
    description: 'good conditions (14-26 px/mm, JPEG 88-95, dark/mid background); odd cases worn, even cases clean',
    sample: (rand, index) => {
      const p = withCard(rand, { mode: 'photo', ...phoneBase(rand, { s: U(rand, 14, 26), fill: U(rand, 0.65, 0.9), tilt: 5, jpeg: [88, 95], glareP: 0, psf: [0.45, 0.9], sag: 0.4 }) });
      const size = CARD_SIZE[p.template] ?? [63, 88];
      p.wear = index % 2 === 1 ? sampleWear(rand, { cw: size[0], ch: size[1] }) : { edges: [], corners: [] };
      return p;
    },
  },
};
export const SCENARIO_NAMES = Object.freeze(Object.keys(SCENARIOS));

/** Render case `index` of a scenario, deterministic from (scenario, seed, index). */
export function renderCase(scenario, seed, index, overrides = {}) {
  const sc = SCENARIOS[scenario];
  if (!sc) throw new Error(`unknown scenario ${scenario}`);
  const cs = caseSeed(scenario, seed, index);
  const rand = rng(cs);
  const p = { ...sc.sample(rand, index), seed: cs, ...overrides };
  const out = p.mode === 'scan' ? renderScan(p) : renderPhoto(p);
  out.meta = { scenario, caseSeed: cs, seedArg: seed, index, ...out.meta };
  return out;
}

// ---------------------------------------------------------------- helpers for reports

/** Max corner distance (mm) between a found quad and the true one, over the 4 cyclic orders and both directions. */
export function quadErrorMm(found, truth) {
  if (!found || found.length !== 4) return Infinity;
  let best = Infinity;
  for (const seq of [found, [...found].reverse()]) {
    for (let k = 0; k < 4; k++) {
      let m = 0;
      for (let i = 0; i < 4; i++) { const p = seq[(i + k) % 4]; const q = truth.corners[i]; m = Math.max(m, Math.hypot(p[0] - q[0], p[1] - q[1])); }
      best = Math.min(best, m);
    }
  }
  return best / truth.pxPerMm;
}

/** Which true corner the found quad's first corner is (0: the same orientation, 2: the card lies upside down). */
export function quadOrientation(found, truth) {
  let best = 0; let bestD = Infinity;
  for (let k = 0; k < 4; k++) {
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(found[i][0] - truth.corners[(i + k) % 4][0], found[i][1] - truth.corners[(i + k) % 4][1]);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/**
 * Centering error of an analyzeCard result against the truth, per axis: |measured − true| share of the left (top)
 * border in points, in card orientation. Unlike the folded "55/45" number it doesn't shrink near 50/50.
 * @returns {{lr:{pct, sigma, share, trueShare, err}|null, tb:object|null, err:number|null}} err: worst axis, both measured
 */
export function scoreCentering(result, truth) {
  const flip = Array.isArray(result.quad) && quadOrientation(result.quad, truth) === 2;
  const out = { lr: null, tb: null, err: null };
  for (const ax of ['lr', 'tb']) {
    const c = result.centering?.[ax];
    if (!c) continue;
    const [a, b] = ax === 'lr' ? ['l', 'r'] : ['t', 'b'];
    // Against the layout (Lorcana's wide bottom border), as the grade check reports it.
    const trueShare = ((truth.borders[a] + (truth.shift?.[ax] ?? 0)) / (truth.borders[a] + truth.borders[b])) * 100;
    let share = c.wide === (ax === 'lr' ? 'left' : 'top') ? c.pct : 100 - c.pct;
    if (flip) share = 100 - share;
    out[ax] = { pct: c.pct, sigma: c.sigma, share, trueShare, err: Math.abs(share - trueShare) };
  }
  if (out.lr && out.tb) out.err = Math.max(out.lr.err, out.tb.err);
  return out;
}

/** Copy of the image with quads drawn on it (1 px lines): [{quad, color:[r,g,b]}]. */
export function drawQuads({ data, width: W, height: H }, quads) {
  const out = new Uint8ClampedArray(data);
  const put = (x, y, c) => { const xi = Math.round(x); const yi = Math.round(y); if (xi < 0 || yi < 0 || xi >= W || yi >= H) return; const j = (yi * W + xi) * 4; out[j] = c[0]; out[j + 1] = c[1]; out[j + 2] = c[2]; };
  for (const { quad, color } of quads) {
    if (!quad) continue;
    for (let i = 0; i < 4; i++) {
      const p = quad[i]; const q = quad[(i + 1) % 4];
      const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]));
      for (let k = 0; k <= n; k++) put(p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n, color);
    }
  }
  return { data: out, width: W, height: H };
}

