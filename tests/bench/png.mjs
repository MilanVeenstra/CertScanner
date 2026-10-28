// Minimal PNG reader for the benchmark's card faces: 8-bit RGB, RGBA or palette (with transparency), not interlaced
// (what the card image sites serve). Node's zlib only, no dependencies.
import { inflateSync } from 'node:zlib';

/** @returns {{data: Uint8ClampedArray, width: number, height: number}} RGBA */
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => buf[i] === b)) throw new Error('not a PNG');
  let pos = 8; let W = 0; let H = 0; let type = 0; const idat = []; let plte = null; let trns = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const name = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      W = body.readUInt32BE(0); H = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || (type !== 2 && type !== 3 && type !== 6) || body[12] !== 0) throw new Error(`unsupported PNG (bit depth ${body[8]}, colour type ${type}, interlace ${body[12]})`);
    } else if (name === 'PLTE') plte = Buffer.from(body);
    else if (name === 'tRNS') trns = Buffer.from(body);
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = type === 6 ? 4 : type === 3 ? 1 : 3; const stride = W * bpp;
  const px = new Uint8Array(H * stride);
  for (let y = 0; y < H; y++) {
    const f = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const row = y * stride; const up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0; const b = y ? px[up + x] : 0; const c = x >= bpp && y ? px[up + x - bpp] : 0;
      let p = 0;
      if (f === 1) p = a; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) { const q = a + b - c; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = (raw[src + x] + p) & 255;
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  if (type === 3) {
    if (!plte) throw new Error('palette PNG without PLTE');
    for (let i = 0; i < W * H; i++) {
      const k = px[i];
      data[i * 4] = plte[k * 3]; data[i * 4 + 1] = plte[k * 3 + 1]; data[i * 4 + 2] = plte[k * 3 + 2];
      data[i * 4 + 3] = trns && k < trns.length ? trns[k] : 255;
    }
  } else {
    for (let i = 0, j = 0; i < W * H; i++, j += bpp) { data[i * 4] = px[j]; data[i * 4 + 1] = px[j + 1]; data[i * 4 + 2] = px[j + 2]; data[i * 4 + 3] = bpp === 4 ? px[j + 3] : 255; }
  }
  return { data, width: W, height: H };
}
