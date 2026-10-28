// Grade check on realistic simulated photos and scans (tests/bench/gradeSim.mjs): a small, fast regression gate drawn
// from the benchmark scenarios (scripts/bench-grade.mjs, `npm run bench:grade`), plus checks that keep the simulator
// itself honest (exact DCT, JPEG fidelity, camera geometry, determinism).
//
// The thresholds below are a REGRESSION FLOOR, not a quality target: they are set from the benchmark baseline of the
// algorithm as of 2026-10 with headroom, so today's code passes them comfortably. Tighten them as the algorithm
// improves (run the benchmark, read the per-case errors, lower the bounds).
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCard } from '../../src/pipeline/grade/analyze.js';
import {
  renderCase, prepareForAnalysis, quadErrorMm, scoreCentering, jpegRoundTrip, dct2, idct2, dct2Reference, cameraModel, rng,
} from '../bench/gradeSim.mjs';
import { decodePng } from '../bench/png.mjs';

// [scenario, index (seed 1), max centering error in points per axis, wear expected]. Baseline errors (2026-10):
// 0.01-0.22 points, outlines within 0.3 mm, no false wear alarms, the worn case seen. Every case must be found
// (outline within 1 mm) and measured on both axes.
const CASES = [
  ['phone-good', 3, 1.0], // Pokémon back on a dark surface, 18 px/mm
  ['phone-good', 2, 1.0], // Lorcana on mid grey
  ['phone-listing', 5, 1.0], // 1600 px listing photo, JPEG 70-85
  ['phone-listing', 18, 1.0],
  ['phone-listing', 19, 1.0], // on wood
  ['phone-listing', 0, 1.0], // on wood, grain along the card's side (once a mix of card and grain lines)
  ['phone-listing', 2, 1.0], // in a playmat's card zone (once the zone was taken for the card)
  ['phone-low', 6, 1.5], // ~5 px/mm
  ['phone-low', 12, 1.5],
  ['scan-600-white', 1, 1.0],
  ['scan-600-black', 3, 1.0],
  ['wear', 10, 1.0], // clean
  ['wear', 16, 1.0], // clean
  ['wear', 19, 1.0, 'edges'], // edge whitening that must be seen
];

const SEEN = new Set(['minor', 'visible']);
for (const [scenario, index, maxErr, wearArea = null] of CASES) {
  test(`grade bench: ${scenario} #${index} found and measured within ${maxErr} points${wearArea ? `, ${wearArea} wear seen` : ', no false wear alarm'}`, () => {
    const { img, truth } = prepareForAnalysis(renderCase(scenario, 1, index));
    const r = analyzeCard(img);
    assert.notEqual(r.status, 'no-card', 'card found');
    const off = quadErrorMm(r.quad, truth);
    assert.ok(off < 1, `outline within 1 mm (${off.toFixed(2)} mm)`);
    const score = scoreCentering(r, truth);
    assert.ok(score.lr && score.tb, `both axes measured (${r.status})`);
    for (const axis of ['lr', 'tb']) assert.ok(score[axis].err <= maxErr, `${axis}: error ${score[axis].err.toFixed(2)} > ${maxErr} points`);
    const worn = truth.wear.edges.length > 0 || truth.wear.corners.length > 0;
    if (wearArea) assert.ok(SEEN.has(r.wear?.[wearArea]?.rating), `${wearArea} wear seen (${r.wear?.[wearArea]?.rating})`);
    if (!worn) {
      for (const area of ['edges', 'corners']) {
        const rating = r.wear?.[area]?.rating ?? 'unknown';
        assert.ok(!SEEN.has(rating), `no false ${area} alarm (${rating})`);
      }
    }
  });
}

test('grade sim: the 8×8 DCT is the orthonormal JPEG transform and inverts exactly', () => {
  const r = rng(3);
  const block = Array.from({ length: 64 }, () => r() * 255 - 128);
  const a = dct2(block); const ref = dct2Reference(block); const back = idct2(a);
  for (let i = 0; i < 64; i++) {
    assert.ok(Math.abs(a[i] - ref[i]) < 1e-9, 'forward');
    assert.ok(Math.abs(back[i] - block[i]) < 1e-9, 'inverse');
  }
});

test('grade sim: JPEG round trip keeps a smooth image close at high quality and degrades with lower quality', () => {
  const W = 64; const H = 48;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const j = (y * W + x) * 4; data[j] = 40 + 3 * x; data[j + 1] = 200 - 2 * y; data[j + 2] = x < 32 ? 30 : 220; data[j + 3] = 255; }
  const psnr = (q) => {
    const out = jpegRoundTrip({ data, width: W, height: H }, q).data;
    let se = 0; for (let i = 0; i < data.length; i++) if ((i & 3) !== 3) se += (out[i] - data[i]) ** 2;
    return 10 * Math.log10((255 * 255) / (se / (W * H * 3)));
  };
  const p95 = psnr(95); const p60 = psnr(60);
  assert.ok(p95 > 33, `q95 PSNR ${p95.toFixed(1)} dB`);
  assert.ok(p60 < p95, 'lower quality, more error');
});

test('grade sim: camera projection and ray casting agree (tilt, lens distortion, curled card)', () => {
  const r = rng(5);
  for (let t = 0; t < 40; t++) {
    const bow = t % 2 ? { axis: t % 4 === 1 ? 'u' : 'v', sag: 2 * r(), edgesUp: r() < 0.5 } : null;
    const cam = cameraModel({ W: 1500, H: 2000, f: 1500 * (0.8 + r()), k1: -0.04 * r(), pitch: 40 * (r() - 0.5), yaw: 40 * (r() - 0.5), rotation: 360 * r(), scale: 12 + 10 * r(), cw: 63, ch: 88, bow });
    for (let k = 0; k < 10; k++) {
      const u = r() * 63; const v = r() * 88; const out = [0, 0, 0, 0, 0, 0];
      const [x, y] = cam.project(u, v, 'top');
      if (x < 0 || y < 0 || x > 1500 || y > 2000) continue;
      cam.map(x, y, out);
      assert.ok(Math.hypot(out[0] - u, out[1] - v) < 1e-3, `face point back within 0.001 mm (${t}/${k})`);
    }
  }
});

test('grade sim: a case renders the same bytes every time', () => {
  const hash = (d) => { let h = 2166136261; for (let i = 0; i < d.length; i += 7) h = Math.imul(h ^ d[i], 16777619); return h >>> 0; };
  const a = renderCase('phone-low', 7, 3); const b = renderCase('phone-low', 7, 3);
  assert.equal(hash(a.img.data), hash(b.img.data));
  assert.deepEqual(a.truth, b.truth);
});

test('grade sim: the PNG reader for the official card faces undoes all five row filters (RGB, RGBA, palette)', async () => {
  const { deflateSync } = await import('node:zlib');
  const W = 5; const H = 6;
  for (const bpp of [3, 4]) {
    const px = Uint8Array.from({ length: W * H * bpp }, (_, i) => (i * 37 + (i >> 3) * 11) & 255);
    const stride = W * bpp; const raw = [];
    for (let y = 0; y < H; y++) {
      const f = y % 5; raw.push(f);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? px[y * stride + x - bpp] : 0; const b = y ? px[(y - 1) * stride + x] : 0; const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
        const q = a + b - c; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c);
        const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
        raw.push((px[y * stride + x] - pred) & 255);
      }
    }
    const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = bpp === 4 ? 6 : 2;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]);
    const img = decodePng(png);
    assert.equal(img.width, W); assert.equal(img.height, H);
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 4; c++) assert.equal(img.data[i * 4 + c], c < bpp ? px[i * bpp + c] : 255, `pixel ${i} channel ${c} (${bpp} bytes)`);
  }
  // Palette with transparency (the One Piece card site serves those): index → colour, alpha from tRNS.
  const idx = Uint8Array.from({ length: W * H }, (_, i) => i % 3);
  const raw = []; for (let y = 0; y < H; y++) { raw.push(0); for (let x = 0; x < W; x++) raw.push(idx[y * W + x]); }
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 3;
  const plte = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90]); const trns = Buffer.from([0, 128]);
  const img = decodePng(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', trns), chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', Buffer.alloc(0))]));
  for (let i = 0; i < W * H; i++) {
    const k = idx[i];
    assert.deepEqual([...img.data.slice(i * 4, i * 4 + 4)], [plte[k * 3], plte[k * 3 + 1], plte[k * 3 + 2], k < 2 ? trns[k] : 255], `palette pixel ${i}`);
  }
});
