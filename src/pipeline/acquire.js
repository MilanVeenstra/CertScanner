// Image acquisition (ADR-001 §5). Chrome adapters live here; decisions are documented per strategy.
// Runs in the side panel: it shares the extension's activeTab grant from the context-menu click.
import { isRestrictedPage } from '../core/certUrls.js';
import { pageProbe } from './pageProbe.js';
import { validateProbeResult } from './probeValidate.js';

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

/** Cheap header sniff so decompression bombs are refused before decoding. */
export function sniffDimensions(bytes) {
  const b = bytes;
  const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32be(16), height: u32be(20) };
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58) {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: (b[i + 7] << 8) | b[i + 8], height: (b[i + 5] << 8) | b[i + 6] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Decode with the ADR §5 limits.
 * @returns {Promise<{ok:true, bitmap:ImageBitmap} | {ok:false, reason:'too-large'|'invalid-image'}>}
 */
export async function decodeBlob(blob) {
  if (!blob || typeof blob.size !== 'number' || blob.size === 0) return { ok: false, reason: 'invalid-image' };
  if (blob.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  try {
    const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
    const dims = sniffDimensions(head);
    if (dims && (dims.width > MAX_SIDE || dims.height > MAX_SIDE || dims.width * dims.height > MAX_PIXELS)) {
      return { ok: false, reason: 'too-large' };
    }
  } catch { /* fall through to the decoder */ }
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
    if (!srcUrl) return await fail('too-large');

    let probe = null;
    const runProbe = async (mode) => {
      const results = await chromeApi.scripting.executeScript({
        target: { tabId: job.tabId, frameIds: [job.frameId] },
        world: 'ISOLATED',
        func: pageProbe,
        args: [srcUrl, mode, MAX_IMAGE_BYTES],
      });
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
    return await fail(best());
  } catch (e) {
    if (e instanceof AcquireError) return { ok: false, reason: e.reason, origin, canRequestSharper: false };
    if (sig.aborted) return { ok: false, reason: abortReason(sig), origin, canRequestSharper: false };
    return await fail(best());
  }
}

/** Strategy 4: screenshot of the visible tab, cropped to the image rectangle. Returns a PNG blob or null. */
async function capture(job, chromeApi, sig, runProbe, fails) {
  let tab;
  try { tab = await chromeApi.tabs.get(job.tabId); } catch { fails.add('tab-changed'); return null; }
  const pageOrigin = imageOriginOf(job.pageUrl);
  let tabOrigin = null;
  try { tabOrigin = tab.url ? new URL(tab.url).origin : null; } catch { tabOrigin = null; }
  if (!tab.active || tab.windowId !== job.windowId || !tabOrigin || tabOrigin !== pageOrigin) { fails.add('tab-changed'); return null; }

  let probe;
  try { probe = await runProbe('capture'); } catch { fails.add('capture-failed'); return null; }
  if (!probe.found) { fails.add('not-found'); return null; }
  if (!probe.rectIsTopLevel || !probe.rect || !probe.viewport) { fails.add('capture-failed'); return null; }
  throwIfAborted(sig);

  let dataUrl;
  for (let attempt = 0; attempt < 2 && !dataUrl; attempt++) {
    try {
      dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (e) {
      if (attempt === 0 && /MAX_CAPTURE|per second|quota/i.test(String(e?.message))) {
        await new Promise((r) => setTimeout(r, 600));
        throwIfAborted(sig);
      } else { fails.add('capture-failed'); return null; }
    }
  }
  if (!dataUrl) { fails.add('capture-failed'); return null; }
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
