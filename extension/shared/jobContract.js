// Shared contract (ADR-001 §4): ScanJob hand-off from the service worker to the side panel via
// chrome.storage.session. Pure: imported by the SW, the side panel and unit tests.

export const MENU_ID = 'certscanner-scan';
/** Context-menu item that sends the image to the grade check (raw cards) instead of the cert scan. */
export const GRADE_MENU_ID = 'certscanner-grade';
/** Manifest command name of the page-scan shortcut (service worker and panel). */
export const PAGE_COMMAND = 'scan-page';
export const SCAN_JOB_VERSION = 1;
export const JOB_TTL_MS = 120_000;
export const MAX_SRC_URL_CHARS = 2_000_000; // larger data: URLs -> srcUrl:null -> 'too-large'
export const MAX_PAGE_URL_CHARS = 8192;
export const MAX_FUTURE_SKEW_MS = 5000;
export const jobKey = (windowId) => `scanJob:${windowId}`;

const SRC_SCHEME_RE = /^(https?|data|blob):/i;
/** Optional ScanJob.srcIssue values (why srcUrl is null): 'too-long' -> too-large, 'unsupported' -> invalid-image. */
export const SRC_ISSUES = new Set(['too-long', 'unsupported']);
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/**
 * A7 / SEC-09: keep only scheme + host + path of the page (no query, hash or credentials);
 * very long paths fall back to the origin. Unparseable values become ''.
 */
export function minimizePageUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  let u;
  try { u = new URL(url); } catch { return ''; }
  const origin = u.origin && u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
  const out = `${origin}${u.pathname}`;
  if (out.length <= MAX_PAGE_URL_CHARS) return out;
  return u.origin && u.origin !== 'null' ? `${u.origin}/` : '';
}

/**
 * Map contextMenus.OnClickData + tabs.Tab to a ScanJob.
 * @returns {import('../core/types.js').ScanJob}
 */
export function createScanJob(info, tab, now, id, { purpose } = {}) {
  const raw = typeof info?.srcUrl === 'string' ? info.srcUrl : null;
  let src = null;
  let srcIssue;
  if (raw !== null && raw.length > MAX_SRC_URL_CHARS) srcIssue = 'too-long';
  else if (raw !== null && !SRC_SCHEME_RE.test(raw)) srcIssue = 'unsupported';
  else src = raw;
  const job = {
    v: SCAN_JOB_VERSION,
    id,
    createdAt: now,
    source: 'contextMenu',
    srcUrl: src,
    pageUrl: minimizePageUrl(info?.pageUrl ?? tab?.url ?? ''),
    frameId: isNonNegInt(info?.frameId) ? info.frameId : 0,
    tabId: tab.id,
    windowId: tab.windowId,
    mediaType: 'image',
  };
  // Additive optional field (S6): why srcUrl is null, so the panel shows the right error.
  if (srcIssue) job.srcIssue = srcIssue;
  // Additive optional field: 'grade' sends the image to the grade check.
  if (purpose === 'grade') job.purpose = 'grade';
  return job;
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
  if (raw.kind === 'page') return parsePageJob(raw);
  if (raw.kind !== undefined && raw.kind !== 'image') return { ok: false, reason: 'shape' };
  const srcOk = raw.srcUrl === null
    || (typeof raw.srcUrl === 'string' && raw.srcUrl.length <= MAX_SRC_URL_CHARS && SRC_SCHEME_RE.test(raw.srcUrl));
  const ok = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64
    && raw.source === 'contextMenu'
    && srcOk
    && typeof raw.pageUrl === 'string' && raw.pageUrl.length <= MAX_PAGE_URL_CHARS
    && isNonNegInt(raw.frameId)
    && isNonNegInt(raw.tabId)
    && Number.isInteger(raw.windowId)
    && raw.mediaType === 'image';
  if (!ok) return { ok: false, reason: 'shape' };
  const job = {
    // Older writers (and QA e2e) may still send frameUrl: accepted and dropped (A7).
    v: SCAN_JOB_VERSION, id: raw.id, createdAt: raw.createdAt, source: 'contextMenu', srcUrl: raw.srcUrl,
    pageUrl: raw.pageUrl, frameId: raw.frameId, tabId: raw.tabId, windowId: raw.windowId, mediaType: 'image',
  };
  if (raw.srcUrl === null && SRC_ISSUES.has(raw.srcIssue)) job.srcIssue = raw.srcIssue;
  if (raw.purpose === 'grade') job.purpose = 'grade';
  return { ok: true, job };
}

// ---------------------------------------------------------------- A9 page jobs

/** Triggers that may create a page job. */
export const PAGE_JOB_SOURCES = new Set(['action', 'command', 'panel']);

/**
 * Page scan job from the toolbar click, the keyboard command or the panel button (A9).
 * A tab the extension cannot read has no `url`: pageUrl '' then routes to the restricted path.
 * @returns {import('../core/types.js').PageScanJob}
 */
export function createPageJob(tab, now, id, source) {
  return {
    v: SCAN_JOB_VERSION, id, createdAt: now, kind: 'page', source, srcUrl: null,
    pageUrl: minimizePageUrl(tab?.url ?? ''), frameId: 0, tabId: tab.id, windowId: tab.windowId,
  };
}

function parsePageJob(raw) {
  const ok = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64
    && PAGE_JOB_SOURCES.has(raw.source)
    && raw.srcUrl === null
    && raw.mediaType === undefined
    && typeof raw.pageUrl === 'string' && raw.pageUrl.length <= MAX_PAGE_URL_CHARS
    && (raw.frameId === undefined || raw.frameId === 0)
    && isNonNegInt(raw.tabId)
    && Number.isInteger(raw.windowId);
  if (!ok) return { ok: false, reason: 'shape' };
  return {
    ok: true,
    job: { v: SCAN_JOB_VERSION, id: raw.id, createdAt: raw.createdAt, kind: 'page', source: raw.source, srcUrl: null, pageUrl: raw.pageUrl, frameId: 0, tabId: raw.tabId, windowId: raw.windowId },
  };
}
