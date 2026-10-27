// Grade check: from a photo to border widths, centering ratios and photo-quality flags. Pure and DOM-free; the panel
// runs it in a module worker (gradeWorker.js) and unit tests call it directly.
import { detectCard, refineQuad, sampleRgb, CARD_RATIO } from './detect.js';
import { warpCard, measureBorders, centeringFrom, toLab, CARD_MM, SIDES } from './measure.js';
import { measureWear } from './wear.js';
import { orderQuad, quadSkew, isConvex, quadArea, homography, applyH } from './geometry.js';

/** Photos are analysed at most this large (long side); enough for ~30 px/mm on a card that fills the frame. */
export const ANALYZE_MAX_SIDE = 2800;
/** Below this many source pixels per mm the centering is only a rough guide (±5 points or more). */
export const LOW_RES_PX_PER_MM = 6;
export const VERY_LOW_RES_PX_PER_MM = 3.5;

const sideLen = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Is `q` a usable card outline inside (or slightly beyond) a width×height photo? */
export function validQuad(q, width, height) {
  if (!Array.isArray(q) || q.length !== 4 || !q.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) return false;
  const m = 0.25;
  if (q.some(([x, y]) => x < -m * width || x > (1 + m) * width || y < -m * height || y > (1 + m) * height)) return false;
  const o = orderQuad(q);
  return isConvex(o) && quadArea(o) >= 0.01 * width * height;
}

/**
 * The photo's edge points in the upright card's pixels, per side: [position along the side, depth from the straight
 * edge] (negative: the real edge lies outside it). refineQuad sides: 0 top, 1 right, 2 bottom, 3 left.
 */
export function outerOffsets(edgePoints, quad, card) {
  const { width: W, height: H } = card;
  const toCard = homography(quad, [[0, 0], [W, 0], [W, H], [0, H]]);
  if (!toCard) return null;
  const out = { top: [], right: [], bottom: [], left: [] };
  const names = ['top', 'right', 'bottom', 'left'];
  edgePoints.forEach((list, i) => {
    for (const [x, y] of list) {
      const [u, v] = applyH(toCard, x, y);
      const name = names[i];
      if (name === 'top') out.top.push([u, v]);
      else if (name === 'right') out.right.push([v, W - u]);
      else if (name === 'bottom') out.bottom.push([u, H - v]);
      else out.left.push([v, u]);
    }
  });
  return out;
}

/** Side of the quad (TL, TR, BR, BL) that each card side lies on: [from corner, to corner]. */
const SIDE_CORNERS = { top: [0, 1], right: [1, 2], bottom: [3, 2], left: [0, 3] };

/**
 * Background colour next to each side of the card (median Lab of points 1.2-2.5 mm outside it, in the photo), or null
 * where the photo shows too little beyond the card (cropped to it, or the card touches the frame).
 */
export function backgroundColors(img, quad, pxPerMm) {
  const cx = (quad[0][0] + quad[2][0]) / 2; const cy = (quad[0][1] + quad[2][1]) / 2;
  const out = {};
  for (const side of SIDES) {
    const [i, j] = SIDE_CORNERS[side];
    const p = quad[i]; const q = quad[j];
    const dx = q[0] - p[0]; const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len; let ny = dx / len;
    const mx = p[0] + dx / 2; const my = p[1] + dy / 2;
    if ((cx - mx) * nx + (cy - my) * ny > 0) { nx = -nx; ny = -ny; }
    const L = []; const A = []; const B = [];
    let tried = 0;
    for (let k = 0; k < 15; k++) {
      const t = 0.2 + (0.6 * k) / 14;
      for (const off of [1.2, 1.8, 2.5]) {
        tried++;
        const c = sampleRgb(img, p[0] + dx * t + nx * off * pxPerMm, p[1] + dy * t + ny * off * pxPerMm);
        if (!c) continue;
        const lab = toLab(c[0], c[1], c[2]);
        L.push(lab[0]); A.push(lab[1]); B.push(lab[2]);
      }
    }
    const med = (a) => { const v = [...a].sort((m, n) => m - n); return v[v.length >> 1]; };
    out[side] = L.length >= tried * 0.6 ? [med(L), med(A), med(B)] : null;
  }
  return out;
}

/**
 * @param {{data:Uint8ClampedArray, width:number, height:number}} img
 * @param {{quad?:number[][]}} [opts] quad: corners placed by hand (any order), skips detection
 * @returns {{status:'ok'|'partial'|'no-border'|'no-card', quad?:number[][], source?:'detected'|'image-edges'|'manual',
 *   card?:{data:Uint8ClampedArray, width:number, height:number, scale:number}, borders?:object, centering?:object, quality?:object}}
 */
export function analyzeCard(img, { quad: given = null } = {}) {
  let quad;
  let source;
  let edgeWidthPx = null;
  let edgePoints = null;
  if (given && validQuad(given, img.width, img.height)) {
    quad = orderQuad(given);
    source = 'manual';
  } else {
    const det = detectCard(img);
    if (!det) return { status: 'no-card' };
    ({ quad, source } = det);
    if (source === 'detected') {
      const r = refineQuad(img, quad);
      quad = r.quad;
      edgeWidthPx = r.edgeWidthPx;
      if (r.refined) edgePoints = r.edgePoints;
    }
  }
  const longSrc = (sideLen(quad[0], quad[3]) + sideLen(quad[1], quad[2])) / 2;
  const pxPerMm = longSrc / CARD_MM.height;
  const card = warpCard(img, quad);
  const borders = measureBorders(card, { outer: edgePoints ? outerOffsets(edgePoints, quad, card) : null });
  // A photo cropped to the card has no cut edge of its own: its crop line can be off by a few pixels.
  const centering = centeringFrom(borders.sides, { scale: card.scale, sysPx: source === 'image-edges' ? 2 : 0.5 });

  let transparent = 0;
  for (let j = 3; j < card.data.length; j += 4 * 7) if (card.data[j] === 0) transparent++;
  const cutOff = transparent / (card.data.length / (4 * 7)) > 0.01;
  const okSides = SIDES.filter((s) => borders.sides[s].ok);
  const blurs = okSides.map((s) => borders.sides[s].edgeWidthPx).filter(Number.isFinite).sort((a, b) => a - b);
  const blurMm = blurs.length ? blurs[blurs.length >> 1] / borders.pxPerMm : null;
  const glare = Math.max(0, ...SIDES.map((s) => borders.sides[s].glare ?? 0));
  const skew = quadSkew(quad);
  const flags = [];
  if (pxPerMm < VERY_LOW_RES_PX_PER_MM) flags.push('very-low-res');
  else if (pxPerMm < LOW_RES_PX_PER_MM) flags.push('low-res');
  if (blurMm !== null && blurMm > 0.5 && blurMm * pxPerMm > 4) flags.push('blurry');
  if (glare > 0.03) flags.push('glare');
  if (skew > 15) flags.push('skewed');
  if (source === 'image-edges') flags.push('cropped');
  if (cutOff) flags.push('cut-off');
  const status = okSides.length === 4 ? 'ok' : (centering.lr || centering.tb) ? 'partial' : 'no-border';
  // Wear needs the background next to the card: a photo cropped to the card has none.
  const bg = source === 'image-edges' ? {} : backgroundColors(img, quad, pxPerMm);
  const wear = status === 'no-border' ? null : measureWear(card, { borders, bg, blurPx: (edgeWidthPx ?? 1) * card.scale });
  return {
    status, quad, source, card, borders, centering, wear,
    quality: { pxPerMm, blurMm, glare, skew, edgeWidthPx, flags, ratio: CARD_RATIO },
  };
}
