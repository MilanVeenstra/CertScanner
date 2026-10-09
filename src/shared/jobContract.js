// Shared contract (ADR-001 §4): ScanJob hand-off from the service worker to the side panel via
// chrome.storage.session. Pure: imported by the SW, the side panel and unit tests.

export const MENU_ID = 'certscanner-scan';
export const SCAN_JOB_VERSION = 1;
export const JOB_TTL_MS = 120_000;
export const MAX_SRC_URL_CHARS = 2_000_000; // larger data: URLs -> srcUrl:null -> 'too-large'
export const MAX_PAGE_URL_CHARS = 8192;
export const MAX_FUTURE_SKEW_MS = 5000;
export const jobKey = (windowId) => `scanJob:${windowId}`;

const SRC_SCHEME_RE = /^(https?|data|blob):/i;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

function shortenUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.length <= MAX_PAGE_URL_CHARS) return url;
  try {
    const origin = new URL(url).origin;
    return origin && origin !== 'null' ? `${origin}/` : '';
  } catch {
    return '';
  }
}

/**
 * Map contextMenus.OnClickData + tabs.Tab to a ScanJob.
 * @returns {import('../core/types.js').ScanJob}
 */
export function createScanJob(info, tab, now, id) {
  const src = typeof info?.srcUrl === 'string' && info.srcUrl.length <= MAX_SRC_URL_CHARS && SRC_SCHEME_RE.test(info.srcUrl)
    ? info.srcUrl : null;
  const frameUrl = typeof info?.frameUrl === 'string' && info.frameUrl.length <= MAX_PAGE_URL_CHARS ? info.frameUrl : null;
  return {
    v: SCAN_JOB_VERSION,
    id,
    createdAt: now,
    source: 'contextMenu',
    srcUrl: src,
    pageUrl: shortenUrl(info?.pageUrl ?? tab?.url ?? ''),
    frameUrl,
    frameId: isNonNegInt(info?.frameId) ? info.frameId : 0,
    tabId: tab.id,
    windowId: tab.windowId,
    mediaType: 'image',
  };
}

/**
 * Validate an untrusted stored job.
 * @returns {{ok:true, job:import('../core/types.js').ScanJob} | {ok:false, reason:'shape'|'version'|'stale'|'window'}}
 */
export function parseScanJob(raw, { now, windowId }) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'shape' };
  if (raw.v !== SCAN_JOB_VERSION) return { ok: false, reason: 'version' };
  if (raw.windowId !== windowId) return { ok: false, reason: 'window' };
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return { ok: false, reason: 'shape' };
  const age = now - raw.createdAt;
  if (age < -MAX_FUTURE_SKEW_MS || age > JOB_TTL_MS) return { ok: false, reason: 'stale' };
  const srcOk = raw.srcUrl === null
    || (typeof raw.srcUrl === 'string' && raw.srcUrl.length <= MAX_SRC_URL_CHARS && SRC_SCHEME_RE.test(raw.srcUrl));
  const ok = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64
    && raw.source === 'contextMenu'
    && srcOk
    && typeof raw.pageUrl === 'string' && raw.pageUrl.length <= MAX_PAGE_URL_CHARS
    && (raw.frameUrl === null || raw.frameUrl === undefined || (typeof raw.frameUrl === 'string' && raw.frameUrl.length <= MAX_PAGE_URL_CHARS))
    && isNonNegInt(raw.frameId)
    && isNonNegInt(raw.tabId)
    && Number.isInteger(raw.windowId)
    && raw.mediaType === 'image';
  if (!ok) return { ok: false, reason: 'shape' };
  return {
    ok: true,
    job: {
      v: SCAN_JOB_VERSION, id: raw.id, createdAt: raw.createdAt, source: 'contextMenu', srcUrl: raw.srcUrl,
      pageUrl: raw.pageUrl, frameUrl: raw.frameUrl ?? null, frameId: raw.frameId, tabId: raw.tabId,
      windowId: raw.windowId, mediaType: 'image',
    },
  };
}
