// S6 security fixes (security review SEC-03, SEC-04, SEC-06, SEC-09, SEC-11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { raceAbort } from '../../src/shared/raceAbort.js';
import { sniffDimensions, dimensionPolicy, sniffBlob, decodeBlob, acquireFromJob, SNIFF_UNKNOWN_MAX_BYTES, SNIFF_HEAD_BYTES, SNIFF_DEEP_BYTES } from '../../src/pipeline/acquire.js';
import { autoOpenKey } from '../../src/sidepanel/viewModel.js';
import { listGrantedSites, removeSite, removeAllSites, removalStatus, requestAllSites, hasAllSites } from '../../src/sidepanel/permissionsUi.js';

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
  // SEC-14: a GIF header alone no longer vouches for the size (the first frame may be larger than the screen)
  const gifHead = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]);
  assert.deepEqual(sniffDimensions(gifHead), { format: 'gif', width: null, height: null, more: true });
  assert.deepEqual(sniffDimensions(gif({ screen: [16, 32], frames: [[0, 0, 16, 32]] })), { format: 'gif', width: 16, height: 32 });
  assert.deepEqual(sniffDimensions(new Uint8Array([1, 2, 3])), { format: 'unknown', width: null, height: null });
});

test('dimensionPolicy: limits, and unreadable non-common formats above the byte threshold are refused', () => {
  assert.equal(dimensionPolicy({ format: 'bmp', width: 16000, height: 16000 }, 1080), 'too-large');
  assert.equal(dimensionPolicy({ format: 'png', width: 7000, height: 7000 }, 1000), 'too-large'); // 49 MP
  assert.equal(dimensionPolicy({ format: 'png', width: 544, height: 850 }, 113159), 'ok');
  // SEC-14: a JPEG/GIF whose size can't be found (SOF/frame beyond the walked bytes) is refused above the threshold
  assert.equal(dimensionPolicy({ format: 'jpeg', width: null, height: null }, 5_000_000), 'unreadable');
  assert.equal(dimensionPolicy({ format: 'gif', width: null, height: null }, 5_000_000), 'unreadable');
  assert.equal(dimensionPolicy({ format: 'jpeg', width: null, height: null }, SNIFF_UNKNOWN_MAX_BYTES), 'ok');
  // PNG/WebP keep their size at a fixed offset: unreadable = truncated, which fails to decode at once
  assert.equal(dimensionPolicy({ format: 'webp', width: null, height: null }, 5_000_000), 'ok');
  assert.equal(dimensionPolicy({ format: 'png', width: null, height: null }, 5_000_000), 'ok');
  // Anything else with unknown dimensions: small files are tried, bigger ones refused
  assert.equal(dimensionPolicy({ format: 'heif', width: null, height: null }, SNIFF_UNKNOWN_MAX_BYTES), 'ok');
  assert.equal(dimensionPolicy({ format: 'heif', width: null, height: null }, SNIFF_UNKNOWN_MAX_BYTES + 1), 'unreadable');
  assert.equal(dimensionPolicy({ format: 'unknown', width: null, height: null }, 300 * 1024), 'unreadable');
  assert.equal(dimensionPolicy({ format: 'unknown', width: null, height: null }, 2000), 'ok');
});

// ---------------------------------------------------------------- SEC-14 JPEG segment walk, GIF frames, no re-decode

/** JPEG: SOI, `appBytes` of APP1 segments (each <= 65533 payload bytes), SOF0 w x h, SOS, a little data, EOI. */
function jpeg({ appBytes = 0, width = 16000, height = 16000, sof = true, sosFirst = false } = {}) {
  const parts = [[0xff, 0xd8]];
  let left = appBytes;
  while (left > 0) {
    const len = Math.min(left, 65533);
    const seg = new Uint8Array(4 + len);
    seg.set([0xff, 0xe1, ((len + 2) >> 8) & 255, (len + 2) & 255]);
    seg.fill(0xff, 4); // payload full of 0xff bytes: must not be mistaken for markers
    parts.push(seg);
    left -= len;
  }
  const sofSeg = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0, 0x12, 0x34, 0xff, 0xd9];
  if (sosFirst) parts.push(sos);
  if (sof) parts.push(sofSeg);
  if (!sosFirst) parts.push(sos);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** GIF89a with a logical screen, optional comment extension of `comment` bytes, then image descriptors. */
function gif({ screen = [10, 10], comment = 0, frames = [[0, 0, 10, 10]] } = {}) {
  const bytes = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, screen[0] & 255, screen[0] >> 8, screen[1] & 255, screen[1] >> 8, 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
  if (comment) {
    bytes.push(0x21, 0xfe);
    for (let left = comment; left > 0; left -= 255) { const n = Math.min(255, left); bytes.push(n); for (let k = 0; k < n; k++) bytes.push(0x41); }
    bytes.push(0);
  }
  for (const [x, y, w, h] of frames) bytes.push(0x2c, x & 255, x >> 8, y & 255, y >> 8, w & 255, w >> 8, h & 255, h >> 8, 0, 2, 2, 0x4c, 0x01, 0);
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

test('SEC-14 JPEG: SOF after 64 KiB of APP segments is found by walking up to 1 MiB; huge sizes refused before decoding', async () => {
  const b = jpeg({ appBytes: 200_000 });
  assert.ok(b.length > SNIFF_HEAD_BYTES);
  assert.deepEqual(sniffDimensions(b.subarray(0, SNIFF_HEAD_BYTES)), { format: 'jpeg', width: null, height: null, more: true });
  assert.deepEqual(sniffDimensions(b), { format: 'jpeg', width: 16000, height: 16000 });
  assert.deepEqual(await sniffBlob(new Blob([b])), { format: 'jpeg', width: 16000, height: 16000 });
  // createImageBitmap does not exist in Node: reaching it would throw, so 'too-large' proves no decode was tried
  assert.deepEqual(await decodeBlob(new Blob([b], { type: 'image/jpeg' })), { ok: false, reason: 'too-large' });
});

test('SEC-14 JPEG: no SOF within 1 MiB (or SOS before SOF) -> refused when larger than the threshold', async () => {
  const far = jpeg({ appBytes: SNIFF_DEEP_BYTES + 70_000 });
  assert.deepEqual(await sniffBlob(new Blob([far])), { format: 'jpeg', width: null, height: null, more: true });
  assert.deepEqual(await decodeBlob(new Blob([far])), { ok: false, reason: 'invalid-image' });
  const sosFirst = jpeg({ appBytes: 300_000, sosFirst: true });
  assert.deepEqual(sniffDimensions(sosFirst), { format: 'jpeg', width: null, height: null });
  assert.deepEqual(await decodeBlob(new Blob([sosFirst])), { ok: false, reason: 'invalid-image' });
  const noSof = jpeg({ appBytes: 100, sof: false });
  assert.deepEqual(sniffDimensions(noSof), { format: 'jpeg', width: null, height: null });
});

test('SEC-14 GIF: the largest image-descriptor extent counts, not just the logical screen', async () => {
  assert.deepEqual(sniffDimensions(gif({ screen: [10, 10], frames: [[0, 0, 16000, 16000]] })), { format: 'gif', width: 16000, height: 16000 });
  assert.deepEqual(sniffDimensions(gif({ screen: [100, 100], frames: [[0, 0, 100, 100], [12000, 50, 10, 10]] })), { format: 'gif', width: 12010, height: 100 });
  assert.equal(dimensionPolicy(sniffDimensions(gif({ frames: [[0, 0, 16000, 16000]] })), 2000), 'too-large');
  // First frame behind 200 KB of comment blocks: found by the deep walk
  const deep = gif({ screen: [10, 10], comment: 200_000, frames: [[0, 0, 16000, 16000]] });
  assert.equal(sniffDimensions(deep.subarray(0, SNIFF_HEAD_BYTES)).more, true);
  assert.deepEqual(await sniffBlob(new Blob([deep])), { format: 'gif', width: 16000, height: 16000 });
  assert.deepEqual(await decodeBlob(new Blob([deep])), { ok: false, reason: 'too-large' });
  // No frame within 1 MiB: unknown, refused above the threshold
  const far = gif({ comment: SNIFF_DEEP_BYTES + 10_000, frames: [[0, 0, 16000, 16000]] });
  assert.deepEqual(await decodeBlob(new Blob([far])), { ok: false, reason: 'invalid-image' });
});

test('SEC-14 acquire: after too-large no other fetch strategy fetches or decodes the image again', async () => {
  const png = new Uint8Array(64);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  u32be(png, 16, 20000); u32be(png, 20, 20000);
  const savedFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(png, { headers: { 'content-type': 'image/png' } }); };
  const calls = [];
  const chromeApi = {
    permissions: { contains: async () => false },
    scripting: { executeScript: async (o) => { calls.push(o.args?.[1]); return [{ result: { v: 1, found: true } }]; } },
  };
  try {
    const job = { v: 1, id: 'j', createdAt: 0, source: 'contextMenu', srcUrl: 'https://shop.example/big.png', pageUrl: 'https://shop.example/item', frameId: 0, tabId: 1, windowId: 2, mediaType: 'image' };
    const r = await acquireFromJob(job, { strategies: ['extension-fetch', 'page-fetch'], chromeApi });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'too-large');
    assert.equal(fetches, 1);
    assert.deepEqual(calls, [], 'page-fetch (in-page fetch + decode) skipped');
  } finally {
    globalThis.fetch = savedFetch;
  }
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

test('listGrantedSites leaves out install-time hosts and origins with their own control', async () => {
  const api = {
    permissions: { getAll: async () => ({ origins: ['https://www.pricecharting.com/*', 'https://api.psacard.com/*', 'https://i.ebayimg.com/*'] }) },
    runtime: { getManifest: () => ({ host_permissions: ['https://www.pricecharting.com/*'] }) },
  };
  assert.deepEqual(await listGrantedSites(api, { exclude: ['https://api.psacard.com/*'] }), { hosts: ['i.ebayimg.com'], allSites: [] });
});

test('"Always allow on all sites" asks for https sites only; a failing check counts as not granted', async () => {
  const asked = [];
  const api = { permissions: { request: async (p) => { asked.push(p); return true; }, contains: async (p) => p.origins[0] === 'https://*/*' } };
  assert.equal(await requestAllSites(api), true);
  assert.deepEqual(asked, [{ origins: ['https://*/*'] }]);
  assert.equal(await hasAllSites(api), true);
  assert.equal(await hasAllSites({ permissions: { contains: async () => { throw new Error('gone'); } } }), false);
});

// ---------------------------------------------------------------- SEC-17 removal announcement from the resolved result
test('SEC-17: "Removed" is announced only when Chrome resolved true; otherwise "Couldn\'t remove"', async () => {
  assert.deepEqual(removalStatus(true, 'i.ebayimg.com'), { key: 'status_site_removed', subs: ['i.ebayimg.com'] });
  assert.deepEqual(removalStatus(false, 'All sites'), { key: 'status_site_not_removed', subs: ['All sites'] });
  assert.deepEqual(removalStatus(undefined, 'x'), { key: 'status_site_not_removed', subs: ['x'] });
  const api = (result) => ({ permissions: { remove: async () => { if (result instanceof Error) throw result; return result; } } });
  assert.equal(await removeSite('a.example', api(true)), true);
  assert.equal(await removeAllSites(['<all_urls>'], api(new Error('required permission'))), false); // install-time grant
  assert.equal(await removeAllSites(['https://*/*'], api(false)), false);
});
