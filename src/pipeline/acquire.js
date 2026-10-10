// Image acquisition (ADR-001 §5). Chrome adapters live here; decisions are documented per strategy.
// Runs in the side panel: it shares the extension's activeTab grant from the context-menu click.
import { isRestrictedPage } from '../core/certUrls.js';
import { pageProbe } from './pageProbe.js';
import { validateProbeResult } from './probeValidate.js';
import { raceAbort } from '../shared/raceAbort.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_SIDE = 12_000;
export const MAX_PIXELS = 40_000_000;
export const MIN_SIDE = 32;
export const ACQUIRE_TIMEOUT_MS = 12_000;
export const EXTENSION_FETCH_TIMEOUT_MS = 10_000;
export const STRATEGIES = Object.freeze(['data-url', 'extension-fetch', 'page-fetch', 'capture']);

/** Most specific failure wins (ADR §5 strategy 5; invalid-image slotted after too-large). */
const FAIL_ORDER = ['restricted', 'tab-changed', 'not-found', 'too-large', 'invalid-image', 'capture-failed', 'fetch-failed'];

class AcquireError extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

function abortReason(signal) {
  const r = signal?.reason;
  return r && r.name === 'TimeoutError' ? 'timeout' : 'aborted';
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw new AcquireError(abortReason(signal));
}

/** Origin of an image URL (blob: -> inner origin); null for data: and unparseable URLs. */
export function imageOriginOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:') return new URL(u.pathname).origin;
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Files of other formats whose dimensions can't be read are only decoded up to this size (SEC-04). */
export const SNIFF_UNKNOWN_MAX_BYTES = 256 * 1024;
const SNIFF_HEAD_BYTES = 64 * 1024;
const COMMON_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp']);

/**
 * Cheap header sniff so decompression bombs are refused before decoding (SEC-04).
 * Reads PNG, GIF, JPEG (SOFn), WebP (VP8X, VP8, VP8L), BMP (core + info headers), ICO/CUR (directory and
 * embedded PNG headers) and AVIF/HEIF (largest `ispe` property in the bytes given).
 * @param {Uint8Array} b first bytes of the file
 * @returns {{format:string, width:number|null, height:number|null}}
 */
export function sniffDimensions(b) {
  const n = b.length;
  const u16le = (i) => b[i] | (b[i + 1] << 8);
  const u16be = (i) => (b[i] << 8) | b[i + 1];
  const u32le = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const i32le = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  const str = (i, len) => String.fromCharCode(...b.subarray(i, i + len));
  const dims = (format, width, height) => ({ format, width, height });
  const unknown = (format) => ({ format, width: null, height: null });
  const isPng = (i) => n >= i + 24 && b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4e && b[i + 3] === 0x47;

  if (isPng(0)) return dims('png', u32be(16), u32be(20));
  if (n >= 4 && b[0] === 0x89 && b[1] === 0x50) return unknown('png');
  if (n >= 10 && str(0, 3) === 'GIF') return dims('gif', u16le(6), u16le(8));
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return dims('jpeg', u16be(i + 7), u16be(i + 5));
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      i += 2 + u16be(i + 2);
    }
    return unknown('jpeg');
  }
  if (n >= 16 && str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') {
    const chunk = str(12, 4);
    if (chunk === 'VP8X' && n >= 30) return dims('webp', 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
    if (chunk === 'VP8 ' && n >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return dims('webp', u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (chunk === 'VP8L' && n >= 25 && b[20] === 0x2f) {
      const bits = u32le(21);
      return dims('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return unknown('webp');
  }
  if (n >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const headerSize = u32le(14);
    if (headerSize === 12) return dims('bmp', u16le(18), u16le(20));
    if (headerSize >= 40) return dims('bmp', Math.abs(i32le(18)), Math.abs(i32le(22)));
    return unknown('bmp');
  }
  if (n >= 6 && u16le(0) === 0 && (u16le(2) === 1 || u16le(2) === 2) && u16le(4) > 0) {
    const count = Math.min(u16le(4), 256);
    let w = 0;
    let h = 0;
    for (let k = 0; k < count; k++) {
      const e = 6 + k * 16;
      if (e + 16 > n) return unknown('ico');
      w = Math.max(w, b[e] || 256);
      h = Math.max(h, b[e + 1] || 256);
      const offset = u32le(e + 12);
      if (offset + 8 <= n && b[offset] === 0x89 && b[offset + 1] === 0x50) {
        if (!isPng(offset)) return unknown('ico');
        w = Math.max(w, u32be(offset + 16));
        h = Math.max(h, u32be(offset + 20));
      } else if (offset + 8 > n) {
        return unknown('ico'); // image data not in the sniffed bytes: can't vouch for embedded PNG sizes
      }
    }
    return dims('ico', w, h);
  }
  if (n >= 12 && str(4, 4) === 'ftyp') {
    const brand = str(8, 4);
    const format = /^avi[fs]$/.test(brand) ? 'avif' : (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand) ? 'heif' : 'isobmff');
    let w = 0;
    let h = 0;
    for (let i = 4; i + 16 <= n; i++) {
      if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) { // 'ispe'
        w = Math.max(w, u32be(i + 8));
        h = Math.max(h, u32be(i + 12));
      }
    }
    return w && h ? dims(format, w, h) : unknown(format);
  }
  return unknown('unknown');
}

/**
 * Decide before decoding (SEC-04). 'unreadable' only for formats other than PNG/JPEG/GIF/WebP whose dimensions
 * could not be read and that are larger than SNIFF_UNKNOWN_MAX_BYTES.
 * @returns {'ok'|'too-large'|'unreadable'}
 */
export function dimensionPolicy(sniff, byteSize) {
  if (sniff.width !== null && sniff.height !== null) {
    if (sniff.width > MAX_SIDE || sniff.height > MAX_SIDE || sniff.width * sniff.height > MAX_PIXELS) return 'too-large';
    return 'ok';
  }
  if (COMMON_FORMATS.has(sniff.format)) return 'ok';
  return byteSize > SNIFF_UNKNOWN_MAX_BYTES ? 'unreadable' : 'ok';
}

/**
 * Decode with the ADR §5 limits.
 * @returns {Promise<{ok:true, bitmap:ImageBitmap} | {ok:false, reason:'too-large'|'invalid-image'}>}
 */
export async function decodeBlob(blob) {
  if (!blob || typeof blob.size !== 'number' || blob.size === 0) return { ok: false, reason: 'invalid-image' };
  if (blob.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  let policy = 'ok';
  try {
    const head = new Uint8Array(await blob.slice(0, SNIFF_HEAD_BYTES).arrayBuffer());
    policy = dimensionPolicy(sniffDimensions(head), blob.size);
  } catch { policy = blob.size > SNIFF_UNKNOWN_MAX_BYTES ? 'unreadable' : 'ok'; }
  if (policy === 'too-large') return { ok: false, reason: 'too-large' };
  if (policy === 'unreadable') return { ok: false, reason: 'invalid-image' };
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return { ok: false, reason: 'invalid-image' };
  }
  const { width, height } = bitmap;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) { bitmap.close(); return { ok: false, reason: 'too-large' }; }
  if (width < MIN_SIDE || height < MIN_SIDE) { bitmap.close(); return { ok: false, reason: 'invalid-image' }; }
  return { ok: true, bitmap };
}

/** Read a Response body with a byte cap. */
async function readCapped(res, maxBytes, signal) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new AcquireError('too-large');
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { reader.cancel().catch(() => {}); throw new AcquireError('too-large'); }
    chunks.push(value);
  }
  return new Blob(chunks, { type: (res.headers.get('content-type') || '').split(';')[0].trim() });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

const success = (bitmap, blob, method, resolution, origin, canRequestSharper) => ({
  ok: true, bitmap, blob,
  info: { method, resolution, width: bitmap.width, height: bitmap.height, origin, canRequestSharper },
});

/**
 * @param {import('../core/types.js').ScanJob} job
 * @param {{signal?:AbortSignal, strategies?:string[], chromeApi?:typeof chrome}} [opts] strategies: test-only override
 * @returns {Promise<import('../core/types.js').AcquireResult>}
 */
export async function acquireFromJob(job, { signal, strategies, chromeApi = globalThis.chrome } = {}) {
  const sig = AbortSignal.any([signal, AbortSignal.timeout(ACQUIRE_TIMEOUT_MS)].filter(Boolean));
  const order = Array.isArray(strategies) ? strategies.filter((s) => STRATEGIES.includes(s)) : STRATEGIES;
  const srcUrl = job?.srcUrl ?? null;
  const origin = srcUrl ? imageOriginOf(srcUrl) : null;
  const restricted = isRestrictedPage(job?.pageUrl);
  const isData = typeof srcUrl === 'string' && /^data:/i.test(srcUrl);
  const fails = new Set();
  let granted = null; // optional host permission for the image origin (lazy)

  const hasGrant = async () => {
    if (granted !== null) return granted;
    granted = false;
    if (origin && /^https?:/.test(origin)) {
      try {
        const u = new URL(origin);
        granted = await chromeApi.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] });
      } catch { granted = false; }
    }
    return granted;
  };
  const sharper = async (resolution, reason) => Boolean(origin && origin.startsWith('https:')
    && (resolution === 'screen' || reason === 'fetch-failed' || reason === 'capture-failed') && !(await hasGrant()));
  const fail = async (reason) => ({ ok: false, reason, origin, canRequestSharper: await sharper(null, reason) });
  const best = () => FAIL_ORDER.find((r) => fails.has(r)) ?? 'fetch-failed';

  try {
    if (restricted && !isData) return await fail('restricted');
    if (!srcUrl) return await fail(job?.srcIssue === 'unsupported' ? 'invalid-image' : 'too-large');

    let probe = null;
    const runProbe = async (mode) => {
      const results = await raceAbort(chromeApi.scripting.executeScript({
        target: { tabId: job.tabId, frameIds: [job.frameId] },
        world: 'ISOLATED',
        func: pageProbe,
        args: [srcUrl, mode, MAX_IMAGE_BYTES],
      }), sig);
      const v = validateProbeResult(results?.[0]?.result, { srcUrl, maxBytes: MAX_IMAGE_BYTES });
      if (!v.ok) throw new AcquireError('fetch-failed');
      return v.value;
    };
    const tryBlob = async (blob, method, resolution) => {
      const d = await decodeBlob(blob);
      if (d.ok) return success(d.bitmap, blob, method, resolution, origin, await sharper(resolution, null));
      fails.add(d.reason);
      return null;
    };

    for (const strategy of order) {
      throwIfAborted(sig);
      if (strategy === 'data-url') {
        if (!/^data:image\//i.test(srcUrl)) continue;
        try {
          const r = await tryBlob(await dataUrlToBlob(srcUrl), 'data-url', 'full');
          if (r) return r;
        } catch { fails.add('invalid-image'); }
      } else if (strategy === 'extension-fetch') {
        if (!origin || !/^https?:/i.test(srcUrl)) continue;
        const pageOrigin = imageOriginOf(job.pageUrl);
        if (!(await hasGrant()) && origin !== pageOrigin) continue;
        try {
          const res = await fetch(srcUrl, {
            credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'force-cache',
            signal: AbortSignal.any([sig, AbortSignal.timeout(EXTENSION_FETCH_TIMEOUT_MS)]),
          });
          if (!res.ok) { fails.add('fetch-failed'); continue; }
          const r = await tryBlob(await readCapped(res, MAX_IMAGE_BYTES, sig), 'extension-fetch', 'full');
          if (r) return r;
        } catch (e) {
          if (sig.aborted) throw new AcquireError(abortReason(sig));
          fails.add(e instanceof AcquireError ? e.reason : 'fetch-failed');
        }
      } else if (strategy === 'page-fetch') {
        if (restricted) continue;
        try {
          probe = await runProbe('inspect');
        } catch {
          fails.add('fetch-failed');
          continue;
        }
        if (!probe.found) { fails.add('not-found'); continue; }
        if (probe.fetch?.ok) {
          try {
            const r = await tryBlob(await dataUrlToBlob(probe.fetch.dataUrl), 'page-fetch', 'full');
            if (r) return r;
          } catch { fails.add('invalid-image'); }
        } else {
          fails.add(probe.fetch?.reason === 'too-large' ? 'too-large' : 'fetch-failed');
        }
      } else if (strategy === 'capture') {
        if (restricted || (probe && !probe.found)) continue;
        const r = await capture(job, chromeApi, sig, runProbe, fails);
        if (r) {
          const d = await tryBlob(r, 'capture', 'screen');
          if (d) return d;
        }
      }
    }
    throwIfAborted(sig); // a strategy swallowed the abort: report it, not a stale failure
    return await fail(best());
  } catch (e) {
    if (e instanceof AcquireError) return { ok: false, reason: e.reason, origin, canRequestSharper: false };
    if (sig.aborted) return { ok: false, reason: abortReason(sig), origin, canRequestSharper: false };
    return await fail(best());
  }
}

/** Strategy 4: screenshot of the visible tab, cropped to the image rectangle. Returns a PNG blob or null. */
async function capture(job, chromeApi, sig, runProbe, fails) {
  const pageOrigin = imageOriginOf(job.pageUrl);
  /** Same tab still active in its window, same origin as the click. */
  const tabStillThere = async () => {
    let tab;
    try { tab = await raceAbort(chromeApi.tabs.get(job.tabId), sig); } catch { return null; }
    let tabOrigin = null;
    try { tabOrigin = tab.url ? new URL(tab.url).origin : null; } catch { tabOrigin = null; }
    return tab.active && tab.windowId === job.windowId && tabOrigin && tabOrigin === pageOrigin ? tab : null;
  };
  const tab = await tabStillThere();
  if (!tab) { fails.add('tab-changed'); return null; }

  let probe;
  try { probe = await runProbe('capture'); } catch { fails.add('capture-failed'); return null; }
  if (!probe.found) { fails.add('not-found'); return null; }
  if (!probe.rectIsTopLevel || !probe.rect || !probe.viewport) { fails.add('capture-failed'); return null; }
  throwIfAborted(sig);

  let dataUrl;
  for (let attempt = 0; attempt < 2 && !dataUrl; attempt++) {
    try {
      dataUrl = await raceAbort(chromeApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), sig);
    } catch (e) {
      if (sig.aborted) throw new AcquireError(abortReason(sig));
      if (attempt === 0 && /MAX_CAPTURE|per second|quota/i.test(String(e?.message))) {
        await new Promise((r) => setTimeout(r, 600));
        throwIfAborted(sig);
      } else { fails.add('capture-failed'); return null; }
    }
  }
  if (!dataUrl) { fails.add('capture-failed'); return null; }
  // SEC-08: the tab may have switched or navigated between the check above and the screenshot.
  if (!(await tabStillThere())) { fails.add('tab-changed'); return null; }
  let shot;
  try { shot = await createImageBitmap(await dataUrlToBlob(dataUrl)); } catch { fails.add('capture-failed'); return null; }
  try {
    const scale = shot.width / probe.viewport.width;
    const x0 = Math.max(0, Math.floor(probe.rect.x * scale));
    const y0 = Math.max(0, Math.floor(probe.rect.y * scale));
    const x1 = Math.min(shot.width, Math.ceil((probe.rect.x + probe.rect.width) * scale));
    const y1 = Math.min(shot.height, Math.ceil((probe.rect.y + probe.rect.height) * scale));
    if (x1 - x0 < MIN_SIDE || y1 - y0 < MIN_SIDE) { fails.add('capture-failed'); return null; }
    const canvas = new OffscreenCanvas(x1 - x0, y1 - y0);
    canvas.getContext('2d').drawImage(shot, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    shot.close();
  }
}

/**
 * Upload / paste / drop input.
 * @param {Blob} blob
 * @param {'upload'|'paste'|'drop'} method
 * @returns {Promise<import('../core/types.js').AcquireResult>}
 */
export async function acquireFromBlob(blob, method, { signal } = {}) {
  if (signal?.aborted) return { ok: false, reason: abortReason(signal), origin: null, canRequestSharper: false };
  const d = await decodeBlob(blob);
  if (!d.ok) return { ok: false, reason: d.reason, origin: null, canRequestSharper: false };
  return success(d.bitmap, blob, ['upload', 'paste', 'drop'].includes(method) ? method : 'upload', 'full', null, false);
}

// ---------------------------------------------------------------- A9 page mode helpers

/** Same tab still active in its window with the job's page origin (SEC-08), or null. */
async function activeSameOrigin(job, chromeApi, sig) {
  let tab;
  try { tab = await raceAbort(chromeApi.tabs.get(job.tabId), sig); } catch { return null; }
  let tabOrigin = null;
  try { tabOrigin = tab.url ? new URL(tab.url).origin : null; } catch { tabOrigin = null; }
  return tab.active && tab.windowId === job.windowId && tabOrigin && tabOrigin === imageOriginOf(job.pageUrl) ? tab : null;
}

/**
 * One screenshot of the visible tab for page mode (no scrolling). Tab/origin are checked before and after.
 * @returns {Promise<{ok:true, bitmap:ImageBitmap} | {ok:false, reason:'tab-changed'|'capture-failed'}>}
 */
export async function captureViewport(job, { signal, chromeApi = globalThis.chrome } = {}) {
  const tab = await activeSameOrigin(job, chromeApi, signal);
  if (!tab) return { ok: false, reason: 'tab-changed' };
  let dataUrl = null;
  for (let attempt = 0; attempt < 2 && !dataUrl; attempt++) {
    try {
      dataUrl = await raceAbort(chromeApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' }), signal);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt === 0 && /MAX_CAPTURE|per second|quota/i.test(String(e?.message))) await new Promise((r) => setTimeout(r, 600));
      else return { ok: false, reason: 'capture-failed' };
    }
  }
  if (!dataUrl) return { ok: false, reason: 'capture-failed' };
  if (!(await activeSameOrigin(job, chromeApi, signal))) return { ok: false, reason: 'tab-changed' };
  try {
    return { ok: true, bitmap: await createImageBitmap(await dataUrlToBlob(dataUrl)) };
  } catch {
    return { ok: false, reason: 'capture-failed' };
  }
}

/** Crop a CSS-px rect (viewport coordinates) out of a viewport screenshot. PNG blob, or null when too small. */
export async function cropToBlob(shot, rect, viewport) {
  const scale = shot.width / viewport.width;
  const x0 = Math.max(0, Math.floor(rect.x * scale));
  const y0 = Math.max(0, Math.floor(rect.y * scale));
  const x1 = Math.min(shot.width, Math.ceil((rect.x + rect.width) * scale));
  const y1 = Math.min(shot.height, Math.ceil((rect.y + rect.height) * scale));
  if (x1 - x0 < MIN_SIDE || y1 - y0 < MIN_SIDE) return null;
  const canvas = new OffscreenCanvas(x1 - x0, y1 - y0);
  canvas.getContext('2d').drawImage(shot, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Wrap a decoded blob as an AcquireResult (page-mode crops). */
export async function acquiredFromBlob(blob, method, resolution, origin, canRequestSharper) {
  const d = await decodeBlob(blob);
  if (!d.ok) return { ok: false, reason: d.reason, origin, canRequestSharper: false };
  return success(d.bitmap, blob, method, resolution, origin, canRequestSharper);
}
