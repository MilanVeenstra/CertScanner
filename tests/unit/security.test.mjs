// S6 security fixes (docs/quality/security-review.md SEC-03, SEC-04, SEC-06, SEC-09, SEC-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raceAbort } from '../../src/shared/raceAbort.js';
import { sniffDimensions, dimensionPolicy, SNIFF_UNKNOWN_MAX_BYTES } from '../../src/pipeline/acquire.js';
import { autoOpenKey } from '../../src/sidepanel/viewModel.js';
import { listGrantedSites } from '../../src/sidepanel/permissionsUi.js';

// ---------------------------------------------------------------- SEC-03 raceAbort
test('raceAbort resolves with the promise when not aborted', async () => {
  const ctrl = new AbortController();
  assert.equal(await raceAbort(Promise.resolve(42), ctrl.signal), 42);
  assert.equal(await raceAbort(Promise.resolve(7)), 7);
  await assert.rejects(raceAbort(Promise.reject(new Error('boom')), ctrl.signal), /boom/);
});

test('raceAbort settles on abort even if the promise never does (hostile page / hung API)', async () => {
  const ctrl = new AbortController();
  const never = new Promise(() => {});
  const p = raceAbort(never, ctrl.signal);
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('raceAbort rejects immediately for an already aborted signal and keeps the timeout reason', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(raceAbort(new Promise(() => {}), ctrl.signal), (e) => e.name === 'AbortError');
  const keepAlive = setTimeout(() => {}, 200); // Node unrefs AbortSignal.timeout timers
  const t = AbortSignal.timeout(5);
  await assert.rejects(raceAbort(new Promise(() => {}), t), (e) => e.name === 'TimeoutError');
  clearTimeout(keepAlive);
});

test('raceAbort: a late rejection after abort is not unhandled', async () => {
  const ctrl = new AbortController();
  let rejectLate;
  const late = new Promise((_, r) => { rejectLate = r; });
  const p = raceAbort(late, ctrl.signal);
  ctrl.abort();
  await assert.rejects(p);
  rejectLate(new Error('late'));
  await new Promise((r) => setTimeout(r, 5)); // would crash the test runner if unhandled
});

// ---------------------------------------------------------------- SEC-04 header sniffing
const u32le = (b, i, v) => { b[i] = v & 255; b[i + 1] = (v >>> 8) & 255; b[i + 2] = (v >>> 16) & 255; b[i + 3] = (v >>> 24) & 255; };
const u32be = (b, i, v) => { b[i] = (v >>> 24) & 255; b[i + 1] = (v >>> 16) & 255; b[i + 2] = (v >>> 8) & 255; b[i + 3] = v & 255; };
const ascii = (b, i, s) => { for (let k = 0; k < s.length; k++) b[i + k] = s.charCodeAt(k); };

test('BMP: BITMAPINFOHEADER int32 LE width/height (negative height = top-down)', () => {
  const b = new Uint8Array(64);
  ascii(b, 0, 'BM');
  u32le(b, 14, 40);
  u32le(b, 18, 16000);
  u32le(b, 22, (-16000) >>> 0);
  assert.deepEqual(sniffDimensions(b), { format: 'bmp', width: 16000, height: 16000 });
});

test('BMP: BITMAPCOREHEADER uint16 width/height', () => {
  const b = new Uint8Array(32);
  ascii(b, 0, 'BM');
  u32le(b, 14, 12);
  b[18] = 0x20; b[19] = 0x03; // 800
  b[20] = 0x58; b[21] = 0x02; // 600
  assert.deepEqual(sniffDimensions(b), { format: 'bmp', width: 800, height: 600 });
});

test('WebP: VP8 (lossy), VP8L (lossless) and VP8X', () => {
  const lossy = new Uint8Array(32);
  ascii(lossy, 0, 'RIFF'); ascii(lossy, 8, 'WEBPVP8 ');
  lossy.set([0x9d, 0x01, 0x2a], 23);
  lossy[26] = 0x10; lossy[27] = 0x27; // 10000 (& 0x3fff)
  lossy[28] = 0xe8; lossy[29] = 0x03 | 0x40; // 1000 with scale bits set
  assert.deepEqual(sniffDimensions(lossy), { format: 'webp', width: 10000, height: 1000 });
  const lossless = new Uint8Array(32);
  ascii(lossless, 0, 'RIFF'); ascii(lossless, 8, 'WEBPVP8L');
  lossless[20] = 0x2f;
  const bits = (16000 - 1) | ((12000 - 1) << 14);
  u32le(lossless, 21, bits);
  assert.deepEqual(sniffDimensions(lossless), { format: 'webp', width: 16000, height: 12000 });
  const ext = new Uint8Array(32);
  ascii(ext, 0, 'RIFF'); ascii(ext, 8, 'WEBPVP8X');
  ext[24] = 0x1f; ext[25] = 0x03; ext[26] = 0; // 800 - 1 = 0x31f
  ext[27] = 0x57; ext[28] = 0x02; ext[29] = 0; // 600 - 1 = 0x257
  assert.deepEqual(sniffDimensions(ext), { format: 'webp', width: 800, height: 600 });
});

test('ICO: directory entries (0 means 256) and embedded PNG headers', () => {
  const b = new Uint8Array(6 + 32 + 24);
  b[2] = 1; b[4] = 2; // type icon, 2 entries
  b[6] = 32; b[7] = 32; // entry 1: 32x32
  b[22] = 0; b[23] = 0; // entry 2: 256x256 ...
  u32le(b, 22 + 8, 24); u32le(b, 22 + 12, 38); // ... with PNG data at offset 38
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 38);
  u32be(b, 38 + 16, 30000); u32be(b, 38 + 20, 30000); // the embedded PNG claims 30000x30000
  assert.deepEqual(sniffDimensions(b), { format: 'ico', width: 30000, height: 30000 });
  const small = new Uint8Array(6 + 16);
  small[2] = 1; small[4] = 1; small[6] = 0; small[7] = 0;
  assert.deepEqual(sniffDimensions(small), { format: 'ico', width: 256, height: 256 });
});

test('AVIF/HEIF: ftyp brand + ispe property (largest wins)', () => {
  const b = new Uint8Array(200);
  u32be(b, 0, 24); ascii(b, 4, 'ftypavif');
  u32be(b, 80, 20); ascii(b, 84, 'ispe'); u32be(b, 88, 0); u32be(b, 92, 512); u32be(b, 96, 512);
  u32be(b, 120, 20); ascii(b, 124, 'ispe'); u32be(b, 128, 0); u32be(b, 132, 20000); u32be(b, 136, 15000);
  assert.deepEqual(sniffDimensions(b), { format: 'avif', width: 20000, height: 15000 });
  const heic = new Uint8Array(40);
  u32be(heic, 0, 24); ascii(heic, 4, 'ftypheic');
  assert.deepEqual(sniffDimensions(heic), { format: 'heif', width: null, height: null });
});

test('PNG, GIF and JPEG still sniff', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  u32be(png, 16, 544); u32be(png, 20, 850);
  assert.deepEqual(sniffDimensions(png), { format: 'png', width: 544, height: 850 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]);
  assert.deepEqual(sniffDimensions(gif), { format: 'gif', width: 16, height: 32 });
  assert.deepEqual(sniffDimensions(new Uint8Array([1, 2, 3])), { format: 'unknown', width: null, height: null });
});

test('dimensionPolicy: limits, and unreadable non-common formats above the byte threshold are refused', () => {
  assert.equal(dimensionPolicy({ format: 'bmp', width: 16000, height: 16000 }, 1080), 'too-large');
  assert.equal(dimensionPolicy({ format: 'png', width: 7000, height: 7000 }, 1000), 'too-large'); // 49 MP
  assert.equal(dimensionPolicy({ format: 'png', width: 544, height: 850 }, 113159), 'ok');
  // Common formats whose header we couldn't read (e.g. a JPEG with huge APP segments) are still decoded
  assert.equal(dimensionPolicy({ format: 'jpeg', width: null, height: null }, 5_000_000), 'ok');
  assert.equal(dimensionPolicy({ format: 'webp', width: null, height: null }, 5_000_000), 'ok');
  // Anything else with unknown dimensions: small files are tried, bigger ones refused
  assert.equal(dimensionPolicy({ format: 'heif', width: null, height: null }, SNIFF_UNKNOWN_MAX_BYTES), 'ok');
  assert.equal(dimensionPolicy({ format: 'heif', width: null, height: null }, SNIFF_UNKNOWN_MAX_BYTES + 1), 'unreadable');
  assert.equal(dimensionPolicy({ format: 'unknown', width: null, height: null }, 300 * 1024), 'unreadable');
  assert.equal(dimensionPolicy({ format: 'unknown', width: null, height: null }, 2000), 'ok');
});

// ---------------------------------------------------------------- SEC-06 auto-open key
test('autoOpenKey: per job id for context-menu jobs, per scan for blobs', () => {
  const job = { kind: 'job', job: { id: 'job-1' } };
  assert.equal(autoOpenKey(job, 'scan-a'), 'job:job-1');
  assert.equal(autoOpenKey(job, 'scan-b'), 'job:job-1'); // Sharper-scans re-run: same key -> no second tab
  assert.equal(autoOpenKey({ kind: 'blob', blob: {} }, 'scan-a'), 'scan:scan-a');
});

// ---------------------------------------------------------------- SEC-11 wildcard grants
test('listGrantedSites reports wildcard grants as allSites', async () => {
  const api = (origins) => ({ permissions: { getAll: async () => ({ origins }) } });
  assert.deepEqual(await listGrantedSites(api(['https://i.ebayimg.com/*'])), { hosts: ['i.ebayimg.com'], allSites: [] });
  assert.deepEqual(await listGrantedSites(api(['https://*/*', 'https://b.example/*'])), { hosts: ['b.example'], allSites: ['https://*/*'] });
  assert.deepEqual(await listGrantedSites(api(['<all_urls>'])), { hosts: [], allSites: ['<all_urls>'] });
  assert.deepEqual(await listGrantedSites(api(undefined)), { hosts: [], allSites: [] });
});
