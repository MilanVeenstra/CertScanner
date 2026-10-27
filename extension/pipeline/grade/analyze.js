// Grade check: from a photo to border widths, centering ratios and photo-quality flags. Pure and DOM-free; the panel
// runs it in a module worker (gradeWorker.js) and unit tests call it directly.
import { detectCard, refineQuad, CARD_RATIO } from './detect.js';
import { warpCard, measureBorders, centeringFrom, CARD_MM, SIDES } from './measure.js';
import { orderQuad, quadSkew, isConvex, quadArea } from './geometry.js';

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
 * @param {{data:Uint8ClampedArray, width:number, height:number}} img
 * @param {{quad?:number[][]}} [opts] quad: corners placed by hand (any order), skips detection
 * @returns {{status:'ok'|'partial'|'no-border'|'no-card', quad?:number[][], source?:'detected'|'image-edges'|'manual',
 *   card?:{data:Uint8ClampedArray, width:number, height:number, scale:number}, borders?:object, centering?:object, quality?:object}}
 */
export function analyzeCard(img, { quad: given = null } = {}) {
  let quad;
  let source;
  let edgeWidthPx = null;
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
    }
  }
  const longSrc = (sideLen(quad[0], quad[3]) + sideLen(quad[1], quad[2])) / 2;
  const pxPerMm = longSrc / CARD_MM.height;
  const card = warpCard(img, quad);
  const borders = measureBorders(card);
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
  return {
    status, quad, source, card, borders, centering,
    quality: { pxPerMm, blurMm, glare, skew, edgeWidthPx, flags, ratio: CARD_RATIO },
  };
}
