// Last completed task-card state per window (ADR A5 "should"): chrome.storage.session 'lastResult:<windowId>'.
// No image data, no page or image URL: only what the task card shows. Pure parse/serialize + thin adapter.
import { GRADER_IDS } from '../core/certRules.js';
import { isValidCert } from '../core/certUrls.js';

export const LAST_RESULT_VERSION = 1;
export const LAST_RESULT_TTL_MS = 12 * 60 * 60 * 1000;
export const lastResultKey = (windowId) => `lastResult:${windowId}`;

const TASKS = new Set(['result', 'confirm', 'none', 'error']);
const BODIES = new Set(['auto-open', 'opened', 'confirm', 'none', 'error']);
const SOURCES = new Set(['qr-url', 'barcode', 'ocr', 'manual']);
const METHODS = new Set(['qr-url', 'barcode', 'ocr', 'manual', 'edited']);
const WARNINGS = new Set(['qr-untrusted-host', 'low-resolution', 'ocr-unavailable']);
const ERRORS = new Set(['restricted', 'not-found', 'too-large', 'fetch-failed', 'capture-failed', 'tab-changed',
  'invalid-image', 'engine-failed', 'timeout', 'file-type', 'dropped-link', 'page-timeout']);
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isGrader = (g) => GRADER_IDS.includes(g);

function cleanCandidate(c) {
  if (!isObj(c) || typeof c.number !== 'string' || !/^\d{7,13}$/.test(c.number)) return null;
  if (c.grader !== null && !isValidCert(c.grader, c.number)) return null;
  if (!Array.isArray(c.graderOptions) || !c.graderOptions.every(isGrader)) return null;
  if (typeof c.confidence !== 'number' || !(c.confidence >= 0 && c.confidence <= 1)) return null;
  if (!SOURCES.has(c.source)) return null;
  return { grader: c.grader, graderOptions: [...c.graderOptions], number: c.number, confidence: c.confidence, source: c.source };
}

function cleanWarning(w) {
  if (!isObj(w) || !WARNINGS.has(w.code)) return null;
  const out = { code: w.code };
  if (w.detail !== undefined) {
    if (typeof w.detail !== 'string' || !HOST_RE.test(w.detail)) return null;
    out.detail = w.detail;
  }
  return out;
}

function cleanOpened(o) {
  if (o === null || o === undefined) return null;
  if (!isObj(o) || !isValidCert(o.grader, o.number) || !METHODS.has(o.method) || typeof o.background !== 'boolean') return undefined;
  return { grader: o.grader, number: o.number, method: o.method, background: o.background };
}

/**
 * @param {{task:string, body:string, result:import('../core/types.js').ScanResult|null, error?:{code:string}|null,
 *   opened:{grader:string, number:string, method:string, background:boolean}|null, imageHost:string|null}} view
 */
export function makeLastResult(view, now) {
  const r = view.result;
  return {
    v: LAST_RESULT_VERSION,
    savedAt: now,
    task: view.task,
    body: view.body,
    imageHost: view.imageHost ?? null,
    candidates: (r?.candidates ?? []).map(cleanCandidate).filter(Boolean).slice(0, 5),
    warnings: (r?.warnings ?? []).map(cleanWarning).filter(Boolean),
    resolution: r?.imageInfo?.resolution === 'screen' ? 'screen' : (r?.imageInfo ? 'full' : null),
    error: view.error?.code ? { code: view.error.code } : null,
    opened: cleanOpened(view.opened) ?? null,
  };
}

/** @returns {{ok:true, value:object} | {ok:false}} */
export function parseLastResult(raw, { now }) {
  const no = { ok: false };
  if (!isObj(raw) || raw.v !== LAST_RESULT_VERSION) return no;
  if (typeof raw.savedAt !== 'number' || !Number.isFinite(raw.savedAt) || now - raw.savedAt > LAST_RESULT_TTL_MS || raw.savedAt - now > 60_000) return no;
  if (!TASKS.has(raw.task) || !BODIES.has(raw.body)) return no;
  if (!(raw.imageHost === null || (typeof raw.imageHost === 'string' && HOST_RE.test(raw.imageHost)))) return no;
  if (!Array.isArray(raw.candidates) || !Array.isArray(raw.warnings)) return no;
  const candidates = raw.candidates.map(cleanCandidate);
  const warnings = raw.warnings.map(cleanWarning);
  if (candidates.some((c) => !c) || warnings.some((w) => !w) || candidates.length > 5) return no;
  if (!(raw.resolution === null || raw.resolution === 'full' || raw.resolution === 'screen')) return no;
  let error = null;
  if (raw.error !== null) {
    if (!isObj(raw.error) || !ERRORS.has(raw.error.code)) return no;
    error = { code: raw.error.code };
  }
  const opened = cleanOpened(raw.opened);
  if (opened === undefined) return no;
  if (raw.task === 'result' && !opened) return no;
  if (raw.task === 'confirm' && !candidates.length) return no;
  if (raw.task === 'error' && !error) return no;
  return {
    ok: true,
    value: { v: LAST_RESULT_VERSION, savedAt: raw.savedAt, task: raw.task, body: raw.body, imageHost: raw.imageHost, candidates, warnings, resolution: raw.resolution, error, opened },
  };
}

const area = () => globalThis.chrome.storage.session;

export async function saveLastResult(windowId, view, now = Date.now()) {
  try { await area().set({ [lastResultKey(windowId)]: makeLastResult(view, now) }); } catch { /* quota/unavailable: restore is best effort */ }
}

export async function loadLastResult(windowId, now = Date.now()) {
  try {
    const got = await area().get(lastResultKey(windowId));
    const p = parseLastResult(got?.[lastResultKey(windowId)], { now });
    return p.ok ? p.value : null;
  } catch {
    return null;
  }
}

export async function clearLastResult(windowId) {
  try { await area().remove(lastResultKey(windowId)); } catch { /* ignore */ }
}
