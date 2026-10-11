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

// ---------------------------------------------------------------- A9 page discovery

export const MAX_PAGE_IMAGES = 24;
export const PAGE_MIN_RENDERED = 120; // CSS px, rendered short side
export const PAGE_MIN_NATURAL = 150;  // px, natural short side
const PAGE_SRC_MAX_CHARS = 2_000_000;
const PAGE_SRC_RE = /^(https?|data|blob):/i;
const DATA_RASTER_RE = /^data:image\/(?!svg)/i; // SEC-19: data: URLs must be raster images
const SVG_RE = /\.svgz?(?:[?#]|$)/i;
const MAX_TOTAL = 1_000_000;

/**
 * Validate the untrusted pageImagesProbe() return value. The envelope must be well formed; individual images
 * that fail a rule are dropped. Result is re-sorted visible-area-first (the page's own order is not trusted),
 * deduplicated by srcUrl and capped at MAX_PAGE_IMAGES.
 * `topmostAtCenter` (SEC-13) must be a boolean when present; a missing value counts as false. `total` (O10) is the
 * page's count of qualifying images before the cap; it falls back to the number of validated images.
 * @returns {{ok:true, value:{v:1, viewport:{width:number,height:number}, dpr:number, total:number,
 *   images:{srcUrl:string, rect:{x:number,y:number,width:number,height:number}, natural:{width:number,height:number},
 *   srcsetBest:string|null, visibleFraction:number, topmostAtCenter:boolean}[]}} | {ok:false, reason:string}}
 */
/** Page title / alt text: page-controlled plain text, kept short and only used as a grader hint. */
export function hintText(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

export function validatePageImages(raw) {
  if (!isObj(raw)) return fail('shape');
  if (raw.v !== 1) return fail('version');
  const viewport = size(raw.viewport, 1, 20000);
  if (!viewport) return fail('viewport');
  if (!fin(raw.dpr) || raw.dpr <= 0 || raw.dpr > 8) return fail('dpr');
  if (!Array.isArray(raw.images) || raw.images.length > 500) return fail('images');
  const seen = new Set();
  const images = [];
  for (const im of raw.images) {
    if (!isObj(im) || typeof im.srcUrl !== 'string' || im.srcUrl.length > PAGE_SRC_MAX_CHARS || !PAGE_SRC_RE.test(im.srcUrl)) continue;
    if (/^data:/i.test(im.srcUrl) && !DATA_RASTER_RE.test(im.srcUrl)) continue;
    if (SVG_RE.test(im.srcUrl) || seen.has(im.srcUrl)) continue;
    const r = im.rect;
    if (!isObj(r) || !fin(r.x) || !fin(r.y) || Math.abs(r.x) > 1e6 || Math.abs(r.y) > 1e7) continue;
    const rs = size(r, 1, 20000);
    const nat = size(im.natural, 1, 100000);
    if (!rs || !nat) continue;
    if (Math.min(rs.width, rs.height) < PAGE_MIN_RENDERED || Math.min(nat.width, nat.height) < PAGE_MIN_NATURAL) continue;
    if (!fin(im.visibleFraction) || im.visibleFraction < 0 || im.visibleFraction > 1) continue;
    if ('topmostAtCenter' in im && typeof im.topmostAtCenter !== 'boolean') continue;
    const origin = originOf(im.srcUrl);
    const srcsetBest = typeof im.srcsetBest === 'string' && im.srcsetBest.length <= MAX_URL_CHARS && /^https?:/i.test(im.srcsetBest)
      && origin && originOf(im.srcsetBest) === origin ? im.srcsetBest : null;
    seen.add(im.srcUrl);
    images.push({
      srcUrl: im.srcUrl, rect: { x: r.x, y: r.y, width: rs.width, height: rs.height }, natural: nat, srcsetBest,
      visibleFraction: im.visibleFraction, topmostAtCenter: im.topmostAtCenter === true, alt: hintText(im.alt),
    });
  }
  const visibleArea = (i) => i.rect.width * i.rect.height * i.visibleFraction;
  images.sort((a, b) => (visibleArea(b) - visibleArea(a)) || (b.rect.width * b.rect.height - a.rect.width * a.rect.height));
  const total = Number.isInteger(raw.total) && raw.total >= 0 && raw.total <= MAX_TOTAL ? Math.max(raw.total, images.length) : images.length;
  return { ok: true, value: { v: 1, viewport, dpr: raw.dpr, title: hintText(raw.title), images: images.slice(0, MAX_PAGE_IMAGES), total } };
}
