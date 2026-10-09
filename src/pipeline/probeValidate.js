// Pure validation of the untrusted pageProbe() return value (ADR-001 §5 "Page probe contract").
// The page controls everything the probe returns; only validated, re-built values leave here.

const FETCH_FAIL_REASONS = new Set(['cors', 'http', 'too-large', 'timeout']);
const DATA_URL_RE = /^data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]*$/;
const MAX_URL_CHARS = 8192;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'blob:') return new URL(u.pathname).origin;
    return u.origin;
  } catch {
    return null;
  }
}

function size(v, lo, hi) {
  if (!isObj(v) || !fin(v.width) || !fin(v.height)) return null;
  if (v.width < lo || v.width > hi || v.height < lo || v.height > hi) return null;
  return { width: v.width, height: v.height };
}

const fail = (reason) => ({ ok: false, reason });

/**
 * @param {unknown} raw
 * @param {{srcUrl:string, maxBytes:number}} opts
 * @returns {{ok:true, value:object} | {ok:false, reason:string}}
 */
export function validateProbeResult(raw, { srcUrl, maxBytes }) {
  if (!isObj(raw)) return fail('shape');
  if (raw.v !== 1) return fail('version');
  if (typeof raw.found !== 'boolean') return fail('found');
  if (!raw.found) return { ok: true, value: { v: 1, found: false } };

  const value = { v: 1, found: true };

  if ('rect' in raw) {
    const r = raw.rect;
    if (!isObj(r) || !fin(r.x) || !fin(r.y) || Math.abs(r.x) > 1e6 || Math.abs(r.y) > 1e7) return fail('rect');
    const s = size(r, 4, 20000);
    if (!s) return fail('rect');
    value.rect = { x: r.x, y: r.y, width: s.width, height: s.height };
  }
  if ('rectIsTopLevel' in raw) {
    if (typeof raw.rectIsTopLevel !== 'boolean') return fail('rectIsTopLevel');
    value.rectIsTopLevel = raw.rectIsTopLevel;
  }
  if ('viewport' in raw) {
    const s = size(raw.viewport, 1, 20000);
    if (!s) return fail('viewport');
    value.viewport = s;
  }
  if ('dpr' in raw) {
    if (!fin(raw.dpr) || raw.dpr <= 0 || raw.dpr > 8) return fail('dpr');
    value.dpr = raw.dpr;
  }
  if ('natural' in raw) {
    const s = size(raw.natural, 0, 100000);
    if (!s) return fail('natural');
    value.natural = s;
  }

  const srcOrigin = originOf(srcUrl);
  let srcsetBest = null;
  if (typeof raw.srcsetBest === 'string' && raw.srcsetBest.length <= MAX_URL_CHARS && /^https?:/i.test(raw.srcsetBest)
      && srcOrigin && originOf(raw.srcsetBest) === srcOrigin) {
    srcsetBest = raw.srcsetBest;
  }
  if ('srcsetBest' in raw) value.srcsetBest = srcsetBest;

  if ('fetch' in raw) {
    const f = raw.fetch;
    if (!isObj(f)) return fail('fetch');
    if (f.ok === true) {
      const maxChars = Math.ceil((maxBytes * 4) / 3) + 256;
      if (typeof f.dataUrl !== 'string' || f.dataUrl.length > maxChars || !DATA_URL_RE.test(f.dataUrl)) return fail('dataUrl');
      if (typeof f.url !== 'string' || (f.url !== srcUrl && f.url !== srcsetBest)) return fail('fetch-url');
      value.fetch = { ok: true, dataUrl: f.dataUrl, url: f.url };
    } else if (f.ok === false && FETCH_FAIL_REASONS.has(f.reason)) {
      value.fetch = { ok: false, reason: f.reason };
    } else {
      return fail('fetch');
    }
  }
  return { ok: true, value };
}
