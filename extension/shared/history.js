// Recent scans (ADR-001 §9): chrome.storage.local 'history'. Newest first, <= 25 entries, deduped on
// grader+number. No image data and no URLs are stored: only the grader, number, time, source and page host.
import { isValidCert } from '../core/certUrls.js';

export const HISTORY_KEY = 'history';
export const HISTORY_VERSION = 1;
export const MAX_HISTORY = 25;
const SOURCES = new Set(['qr-url', 'barcode', 'ocr', 'manual']);
const HOST_RE = /^[a-z0-9.-]{1,253}$/i;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function cleanEntry(e) {
  if (!isObj(e)) return null;
  if (!isValidCert(e.grader, e.number)) return null;
  if (typeof e.at !== 'number' || !Number.isFinite(e.at) || e.at <= 0) return null;
  if (!SOURCES.has(e.source)) return null;
  if (!(e.pageHost === null || (typeof e.pageHost === 'string' && HOST_RE.test(e.pageHost)))) return null;
  return { grader: e.grader, number: e.number, at: e.at, source: e.source, pageHost: e.pageHost };
}

/** @returns {{value:{v:number, entries:import('../core/types.js').HistoryEntry[]}, needsWrite:boolean}} */
export function migrateHistory(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.v) || raw.v < 1 || !Array.isArray(raw.entries)) {
    return { value: { v: HISTORY_VERSION, entries: [] }, needsWrite: false };
  }
  const entries = raw.entries.map(cleanEntry).filter(Boolean).slice(0, MAX_HISTORY);
  const dropped = entries.length !== raw.entries.length;
  return { value: { v: HISTORY_VERSION, entries }, needsWrite: raw.v === HISTORY_VERSION && dropped };
}

/** Pure reducer. @throws {TypeError} for invalid entries */
export function addEntry(history, entry, max = MAX_HISTORY) {
  const e = cleanEntry(entry);
  if (!e) throw new TypeError('invalid history entry');
  const rest = (history?.entries ?? []).filter((x) => !(x.grader === e.grader && x.number === e.number));
  return { v: HISTORY_VERSION, entries: [e, ...rest].slice(0, max) };
}

/**
 * Entry from a candidate (grader + number chosen by the user). The page host is never stored
 * (UX spec R-09: grader, number, method and time only); `pageHost` stays in the schema as null.
 */
export function makeEntry({ grader, number, source }, _pageUrl, at) {
  return { grader, number, at, source: SOURCES.has(source) ? source : 'manual', pageHost: null };
}

/** Pure reducer for "Wrong number? Edit" (spec J12): the newest entry is replaced, not duplicated. */
export function replaceLatest(history, entry, max = MAX_HISTORY) {
  const rest = (history?.entries ?? []).slice(1);
  return addEntry({ v: HISTORY_VERSION, entries: rest }, entry, max);
}

const area = () => globalThis.chrome.storage.local;

export async function loadHistory() {
  const got = await area().get(HISTORY_KEY);
  const { value, needsWrite } = migrateHistory(got?.[HISTORY_KEY]);
  if (needsWrite) await area().set({ [HISTORY_KEY]: value }).catch(() => {});
  return value;
}

export async function addHistoryEntry(entry, { replace = false } = {}) {
  const current = await loadHistory();
  const next = replace ? replaceLatest(current, entry) : addEntry(current, entry);
  await area().set({ [HISTORY_KEY]: next });
  return next;
}

export async function clearHistory() {
  await area().remove(HISTORY_KEY);
}

export function onHistoryChanged(cb) {
  const l = (changes, areaName) => {
    if (areaName === 'local' && changes[HISTORY_KEY]) cb(migrateHistory(changes[HISTORY_KEY].newValue).value);
  };
  globalThis.chrome.storage.onChanged.addListener(l);
  return () => globalThis.chrome.storage.onChanged.removeListener(l);
}
