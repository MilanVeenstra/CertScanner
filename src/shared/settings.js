// Settings (ADR-001 §9): chrome.storage.sync 'settings'. Pure migration + a thin chrome adapter.
// Nothing touches `chrome` at import time so unit tests can import this module in Node.
import { isEbaySite, DEFAULT_EBAY_SITE } from '../core/priceLinks.js';

export const SETTINGS_KEY = 'settings';
export const SETTINGS_VERSION = 1;
// A9: scanOnToolbarClick (default true) - the toolbar icon scans the page; when false it only opens the panel.
// ebaySite (2026-10-11): which eBay the price & listing links open (key of EBAY_SITES).
export const DEFAULT_SETTINGS = Object.freeze({ v: 1, autoOpen: true, openInBackground: false, saveHistory: true, scanOnToolbarClick: true, ebaySite: DEFAULT_EBAY_SITE });
const FIELDS = ['autoOpen', 'openInBackground', 'saveHistory', 'scanOnToolbarClick'];
const CHOICE_FIELDS = { ebaySite: isEbaySite };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Tolerant read of stored settings.
 * @returns {{value:import('../core/types.js').Settings, needsWrite:boolean}}
 */
export function migrateSettings(raw) {
  if (!isObj(raw) || !Number.isInteger(raw.v) || raw.v < 1) return { value: { ...DEFAULT_SETTINGS }, needsWrite: false };
  const value = { ...DEFAULT_SETTINGS };
  for (const f of FIELDS) if (typeof raw[f] === 'boolean') value[f] = raw[f];
  for (const [f, ok] of Object.entries(CHOICE_FIELDS)) if (ok(raw[f])) value[f] = raw[f];
  // v === 1: current. v > 1 (newer device): known fields only, never written back unless the user edits.
  // Older versions would be step-migrated here and return needsWrite:true (none exist yet).
  return { value, needsWrite: false };
}

/**
 * Object to write when the user edits settings. Keeps fields/version written by a newer version.
 * @throws {TypeError} on unknown keys or non-boolean values
 */
export function applySettingsPatch(raw, patch) {
  for (const [k, v] of Object.entries(patch ?? {})) {
    const valid = FIELDS.includes(k) ? typeof v === 'boolean' : Object.prototype.hasOwnProperty.call(CHOICE_FIELDS, k) && CHOICE_FIELDS[k](v);
    if (!valid) throw new TypeError(`invalid setting ${k}`);
  }
  const current = migrateSettings(raw).value;
  const newer = isObj(raw) && Number.isInteger(raw.v) && raw.v > SETTINGS_VERSION;
  const base = newer ? { ...raw } : { v: SETTINGS_VERSION };
  return { ...base, ...pick(current), ...patch };
}

function pick(s) {
  return { autoOpen: s.autoOpen, openInBackground: s.openInBackground, saveHistory: s.saveHistory, scanOnToolbarClick: s.scanOnToolbarClick, ebaySite: s.ebaySite };
}

const area = () => globalThis.chrome.storage.sync;

export async function loadSettings() {
  const got = await area().get(SETTINGS_KEY);
  return migrateSettings(got?.[SETTINGS_KEY]).value;
}

/** Persist a user edit; returns the new effective settings. */
export async function saveSettings(patch) {
  const got = await area().get(SETTINGS_KEY);
  const next = applySettingsPatch(got?.[SETTINGS_KEY], patch);
  await area().set({ [SETTINGS_KEY]: next });
  return migrateSettings(next).value;
}

/** Subscribe to changes from any panel/device. Returns an unsubscribe function. */
export function onSettingsChanged(cb) {
  const l = (changes, areaName) => {
    if (areaName === 'sync' && changes[SETTINGS_KEY]) cb(migrateSettings(changes[SETTINGS_KEY].newValue).value);
  };
  globalThis.chrome.storage.onChanged.addListener(l);
  return () => globalThis.chrome.storage.onChanged.removeListener(l);
}
