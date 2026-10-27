// Synthetic card photos with known border widths (grade-check tests). Not a test file itself.
import { homography, applyH } from '../../src/pipeline/grade/geometry.js';

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (a, b, s) => {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(s, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const COLORS = Object.freeze({
  yellow: [236, 198, 52], silver: [188, 190, 196], black: [28, 27, 30], navy: [32, 58, 138], white: [244, 244, 240],
});

/**
 * Render a card photo.
 * @param {object} o
 *   width/height: photo size; pxPerMm: card scale; center: card centre in the photo; angle: rotation (degrees);
 *   tilt: perspective (fraction the top side shrinks); border {l, r, t, b} in mm (null: borderless art to the edge);
 *   borderColor, bg (rgb), bgTexture (0..1), noise (± per channel), blur (3×3 box passes), seed, radiusMm (corner radius),
 *   cardMm [w, h]; fill: true = photo is cropped exactly to the card.
 *   Wear: whitening [{side:'top'|'right'|'bottom'|'left', fromMm, toMm, depthMm}] (white paper showing along a cut edge,
 *   positions measured along the side from its top/left end); cornerWhite ['tl'|'tr'|'br'|'bl'] (whitening around that
 *   corner's curve); cornerCut [{corner, mm}] (the tip is missing: a straight cut that far inside the rounded corner).
 * @returns {{data:Uint8ClampedArray, width:number, height:number, corners:number[][], truth:{lr:number, tb:number}}}
 */
export function renderCard(o = {}) {
  const {
    width = 1000, height = 1300, pxPerMm = 12, angle = 0, tilt = 0, border = { l: 3, r: 3, t: 3, b: 3 },
    borderColor = COLORS.yellow, bg = [120, 122, 128], bgTexture = 0, noise = 3, blur = 1, seed = 1, radiusMm = 3,
    cardMm = [63, 88], fill = false, whitening = [], cornerWhite = [], cornerCut = [],
  } = o;
  const [cw, ch] = cardMm;
  const center = o.center ?? [width / 2, height / 2];
  let corners;
  if (fill) {
    corners = [[0, 0], [width, 0], [width, height], [0, height]];
  } else {
    const a = (angle * Math.PI) / 180;
    const rot = ([x, y]) => [center[0] + x * Math.cos(a) - y * Math.sin(a), center[1] + x * Math.sin(a) + y * Math.cos(a)];
    const hw = (cw * pxPerMm) / 2; const hh = (ch * pxPerMm) / 2;
    const shrink = tilt * hw;
    corners = [[-hw + shrink, -hh], [hw - shrink, -hh], [hw, hh], [-hw, hh]].map(rot);
  }
  const toCard = homography(corners, [[0, 0], [cw, 0], [cw, ch], [0, ch]]);
  const rand = rng(seed);
  /** Corner frame: (a, b) = distance from that corner's two sides. */
  const cornerAB = (u, v) => ({ tl: [u, v], tr: [cw - u, v], br: [cw - u, ch - v], bl: [u, ch - v] });
  const inCard = (u, v) => {
    if (u < 0 || v < 0 || u > cw || v > ch) return false;
    const r = radiusMm;
    const cx = u < r ? r : u > cw - r ? cw - r : u;
    const cy = v < r ? r : v > ch - r ? ch - r : v;
    if ((u - cx) ** 2 + (v - cy) ** 2 > r * r) return false;
    const ab = cornerAB(u, v);
    // The arc's point nearest the corner is at a + b = 2r(1 - 1/√2); a cut removes material `mm` further in.
    for (const c of cornerCut) { const [a, b] = ab[c.corner]; if (a + b < 2 * r * (1 - Math.SQRT1_2) + c.mm * Math.SQRT2) return false; }
    return true;
  };
  const WHITE = [238, 236, 228];
  const worn = (u, v) => {
    const along = { top: u, bottom: u, left: v, right: v };
    const depth = { top: v, bottom: ch - v, left: u, right: cw - u };
    for (const w of whitening) if (depth[w.side] < (w.depthMm ?? 0.25) && along[w.side] >= w.fromMm && along[w.side] <= w.toMm) return true;
    const r = radiusMm; const ab = cornerAB(u, v);
    for (const c of cornerWhite) {
      const [a, b] = ab[c];
      if (a < r && b < r && Math.hypot(r - a, r - b) > r - 0.3) return true;
    }
    return false;
  };
  const cardColor = (u, v) => {
    if (worn(u, v)) return WHITE;
    if (border && (u < border.l || u > cw - border.r || v < border.t || v > ch - border.b)) return borderColor;
    // Art: blocks of colours unlike the border, with a dark frame line where the art starts.
    const fx = border ? u - border.l : u; const fy = border ? v - border.t : v;
    if (border && (fx < 0.35 || fy < 0.35 || u > cw - border.r - 0.35 || v > ch - border.b - 0.35)) return [60, 40, 30];
    const k = hash(Math.floor(u / 5), Math.floor(v / 4), seed);
    const pal = [[200, 70, 60], [70, 140, 90], [90, 110, 200], [230, 230, 225], [150, 90, 170], [60, 170, 200]];
    return pal[Math.floor(k * pal.length)];
  };
  const bgColor = (x, y) => {
    if (!bgTexture) return bg;
    const k = hash(Math.floor(x / 23), Math.floor(y / 17), seed + 7) - 0.5;
    return bg.map((c) => c + k * 80 * bgTexture);
  };
  let px = new Float32Array(width * height * 3);
  const S = [0.25, 0.75];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0;
      for (const sy of S) {
        for (const sx of S) {
          const [u, v] = applyH(toCard, x + sx, y + sy);
          const c = inCard(u, v) ? cardColor(u, v) : bgColor(x, y);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const i = (y * width + x) * 3;
      px[i] = r / 4; px[i + 1] = g / 4; px[i + 2] = b / 4;
    }
  }
  for (let pass = 0; pass < blur; pass++) {
    const out = new Float32Array(px.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) {
          let s = 0; let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= width) continue;
              s += px[(yy * width + xx) * 3 + c]; n++;
            }
          }
          out[(y * width + x) * 3 + c] = s / n;
        }
      }
    }
    px = out;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    for (let c = 0; c < 3; c++) data[j + c] = px[i * 3 + c] + (rand() * 2 - 1) * noise;
    data[j + 3] = 255;
  }
  const truth = border
    ? { lr: (Math.max(border.l, border.r) / (border.l + border.r)) * 100, tb: (Math.max(border.t, border.b) / (border.t + border.b)) * 100 }
    : null;
  return { data, width, height, corners, truth };
}

/** Minimal PNG encoder (RGBA, no filtering) for e2e uploads of rendered cards. */
export async function encodePng({ data, width, height }) {
  const { deflateSync } = await import('node:zlib');
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
    return Buffer.concat([len, tb, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
