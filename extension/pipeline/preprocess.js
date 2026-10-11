// Canvas preprocessing (ADR-001 §6). DOM-free: OffscreenCanvas + ImageData only.
// - OCR image: scaled (long side 2000, kept if within [1600, 2400], upscaling <= 3x), grayscale,
//   1st-99th percentile contrast stretch, encoded once as PNG.
// - Barcode image: RGBA ImageData near the original resolution.
// - Digit crops: padded, scaled to ~64 px text height (<= 4x), Otsu-thresholded, 16 px white border.

export const TARGET_LONG_SIDE = 2000;
export const MIN_LONG_SIDE = 1600;
export const MAX_LONG_SIDE = 2400;
export const MAX_UPSCALE = 3;
export const BAND_FRACTION = 0.35;
export const DIGIT_TEXT_HEIGHT = 64;
export const DIGIT_MAX_SCALE = 4;
export const DIGIT_BORDER = 16;

/** Scale factor for the OCR image. */
export function ocrScale(width, height) {
  const L = Math.max(width, height);
  if (!(L > 0)) return 1;
  if (L < MIN_LONG_SIDE) return Math.min(TARGET_LONG_SIDE / L, MAX_UPSCALE);
  if (L > MAX_LONG_SIDE) return TARGET_LONG_SIDE / L;
  return 1;
}

/** Luma of an RGBA buffer into a Uint8ClampedArray. */
export function toLuma(rgba) {
  const n = rgba.length >> 2;
  const out = new Uint8ClampedArray(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    // White-composite transparent pixels so transparent PNGs read as paper, not black.
    const a = rgba[j + 3] / 255;
    const y = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    out[i] = y * a + 255 * (1 - a);
  }
  return out;
}

/** In-place 1st-99th percentile contrast stretch. */
export function stretchContrast(gray, lo = 0.01, hi = 0.99) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const n = gray.length;
  let acc = 0; let pLo = 0; let pHi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * lo) { pLo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * (1 - hi)) { pHi = v; break; } }
  if (pHi - pLo < 8) return gray;
  const k = 255 / (pHi - pLo);
  for (let i = 0; i < n; i++) gray[i] = (gray[i] - pLo) * k;
  return gray;
}

/** Otsu threshold (0-255) of a gray buffer. */
export function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0; let wB = 0; let best = 0; let threshold = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; threshold = v; }
  }
  return threshold;
}

function grayToImageData(gray, width, height) {
  const data = new ImageData(width, height);
  const d = data.data;
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = gray[i]; d[j + 3] = 255; }
  return data;
}

function drawRotated(source, sw, sh, rotation, scale) {
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const swap = rotation === 90 || rotation === 270;
  const canvas = new OffscreenCanvas(swap ? h : w, swap ? w : h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, -w / 2, -h / 2, w, h);
  return canvas;
}

export const LABEL_WIDTH = 2400;
export const LABEL_MAX_UPSCALE = 3;
export const LABEL_FRACTION = 0.32;

/**
 * The slab label at text-reading size: the top (or, upside down, the bottom) part of the photo, scaled so the label is
 * about 2400 px wide (upscaling <= 3x), grayscale with stretched contrast. Used to read the card name, which is printed
 * smaller than the cert number and is lost in the full-image pass on small photos.
 * @param {ImageBitmap} bitmap
 * @param {{which?:'top'|'bottom', rotation?:0|90|180|270}} [opts]
 * @returns {Promise<Blob>}
 */
export async function labelImage(bitmap, { which = 'top', rotation = 0 } = {}) {
  const swap = rotation === 90 || rotation === 270;
  const w0 = swap ? bitmap.height : bitmap.width;
  const scale = Math.min(LABEL_MAX_UPSCALE, LABEL_WIDTH / Math.max(1, w0));
  const full = drawRotated(bitmap, bitmap.width, bitmap.height, rotation, scale);
  const bandH = Math.max(1, Math.round(full.height * LABEL_FRACTION));
  const out = new OffscreenCanvas(full.width, bandH);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  if (which === 'bottom') { ctx.translate(full.width, bandH); ctx.rotate(Math.PI); } // upside-down photo
  ctx.drawImage(full, 0, which === 'bottom' ? full.height - bandH : 0, full.width, bandH, 0, 0, full.width, bandH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const gray = stretchContrast(toLuma(ctx.getImageData(0, 0, full.width, bandH).data));
  ctx.putImageData(grayToImageData(gray, full.width, bandH), 0, 0);
  return out.convertToBlob({ type: 'image/png' });
}

/**
 * @typedef {{left:number, top:number, width:number, height:number}} Rect
 * @typedef {{width:number, height:number, scale:number, rotation:number, ocrBlob:Blob, imageData:ImageData|null,
 *   bands:{top:Rect, bottom:Rect}, cropForDigits:(rect:Rect)=>Promise<Blob>, bandBlob:(which:'top'|'bottom', rotate180?:boolean)=>Promise<Blob>,
 *   rotate:(deg:90|180|270)=>Promise<Prepared>}} Prepared
 */

/**
 * @param {ImageBitmap} bitmap
 * @param {{rotation?:0|90|180|270, withBarcodeData?:boolean}} [opts]
 * @returns {Promise<Prepared>}
 */
export async function preprocess(bitmap, { rotation = 0, withBarcodeData = true } = {}) {
  const scale = ocrScale(bitmap.width, bitmap.height);
  const canvas = drawRotated(bitmap, bitmap.width, bitmap.height, rotation, scale);
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gray = stretchContrast(toLuma(ctx.getImageData(0, 0, width, height).data));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.putImageData(grayToImageData(gray, width, height), 0, 0);
  const ocrBlob = await canvas.convertToBlob({ type: 'image/png' });

  let imageData = null;
  if (withBarcodeData) {
    const bScale = Math.max(bitmap.width, bitmap.height) > MAX_LONG_SIDE ? TARGET_LONG_SIDE / Math.max(bitmap.width, bitmap.height) : 1;
    const bc = drawRotated(bitmap, bitmap.width, bitmap.height, rotation, bScale);
    imageData = bc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, bc.width, bc.height);
  }

  const topH = Math.round(height * BAND_FRACTION);
  const bands = {
    top: { left: 0, top: 0, width, height: topH },
    bottom: { left: 0, top: height - topH, width, height: topH },
  };

  async function cropForDigits(rect) {
    const pad = Math.round(rect.height * 0.25);
    const x0 = Math.max(0, Math.floor(rect.left - pad));
    const y0 = Math.max(0, Math.floor(rect.top - pad));
    const x1 = Math.min(width, Math.ceil(rect.left + rect.width + pad));
    const y1 = Math.min(height, Math.ceil(rect.top + rect.height + pad));
    const cw = Math.max(1, x1 - x0);
    const ch = Math.max(1, y1 - y0);
    const s = Math.min(DIGIT_TEXT_HEIGHT / Math.max(1, rect.height), DIGIT_MAX_SCALE);
    const ow = Math.max(1, Math.round(cw * s));
    const oh = Math.max(1, Math.round(ch * s));
    const out = new OffscreenCanvas(ow + 2 * DIGIT_BORDER, oh + 2 * DIGIT_BORDER);
    const octx = out.getContext('2d', { willReadFrequently: true });
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(canvas, x0, y0, cw, ch, DIGIT_BORDER, DIGIT_BORDER, ow, oh);
    const inner = octx.getImageData(DIGIT_BORDER, DIGIT_BORDER, ow, oh);
    const g = toLuma(inner.data);
    const t = otsuThreshold(g);
    let dark = 0;
    for (let i = 0; i < g.length; i++) { g[i] = g[i] > t ? 255 : 0; if (!g[i]) dark++; }
    if (dark > g.length / 2) for (let i = 0; i < g.length; i++) g[i] = 255 - g[i]; // keep paper white
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.putImageData(grayToImageData(g, ow, oh), DIGIT_BORDER, DIGIT_BORDER);
    return out.convertToBlob({ type: 'image/png' });
  }

  async function bandBlob(which, rotate180 = false) {
    const r = bands[which];
    const out = new OffscreenCanvas(r.width, r.height);
    const octx = out.getContext('2d');
    if (rotate180) { octx.translate(r.width, r.height); octx.rotate(Math.PI); }
    octx.drawImage(canvas, r.left, r.top, r.width, r.height, 0, 0, r.width, r.height);
    return out.convertToBlob({ type: 'image/png' });
  }

  return {
    width, height, scale, rotation, ocrBlob, imageData, bands, cropForDigits, bandBlob,
    rotate: (deg) => preprocess(bitmap, { rotation: deg, withBarcodeData: false }),
  };
}
