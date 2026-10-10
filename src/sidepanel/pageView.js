// Pure page-scan view logic for the side panel (ADR A9). No chrome, no DOM: unit-tested in Node.
import { isRestrictedPage } from '../core/certUrls.js';

/** Manifest command name of the page-scan shortcut. */
export const PAGE_COMMAND = 'scan-page';
/** Chrome's shortcut editor. Extensions can't link to chrome:// pages, but may open them with tabs.create. */
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

/** Shortcut text of the page-scan command from chrome.commands.getAll(); '' when unset. */
export function scanShortcut(commands) {
  if (!Array.isArray(commands)) return '';
  const c = commands.find((x) => x && x.name === PAGE_COMMAND);
  const s = typeof c?.shortcut === 'string' ? c.shortcut.trim() : '';
  return s.length > 0 && s.length <= 40 ? s : '';
}

const RESTRICTED_ERROR_RE = /chrome:\/\/|chrome-extension:\/\/|chrome-untrusted:\/\/|devtools:\/\/|edge:\/\/|extensions gallery|cannot be scripted|web ?store/i;

/**
 * A refused executeScript tells pages Chrome never lets extensions read ('restricted') apart from pages the
 * extension simply has no access to yet ('access': the user can click the icon, press the shortcut or allow the site).
 */
export function classifyInjectError(message) {
  return RESTRICTED_ERROR_RE.test(String(message ?? '')) ? 'restricted' : 'access';
}

/**
 * What the panel's "Scan this page" button does with the active tab of its window.
 * The tab's `url` is only visible while CertScanner has access (live activeTab grant or a host grant).
 * Without it, the caller probes with a no-op injection and passes the error text back in.
 * @returns {{action:'scan'|'restricted'|'access'|'probe'}}
 */
export function panelScanPlan(tab, { injectError } = {}) {
  if (!tab || !Number.isInteger(tab.id)) return { action: 'access' };
  if (typeof tab.url === 'string' && tab.url) return { action: isRestrictedPage(tab.url) ? 'restricted' : 'scan' };
  if (injectError === undefined) return { action: 'probe' };
  return { action: classifyInjectError(injectError) };
}

/** Host for "Always allow on ‹host›": only https (optional_host_permissions is https://*\/*). */
export function alwaysAllowHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname ? u.hostname : null;
  } catch {
    return null;
  }
}

/** Page-access body: how this user can give CertScanner access to the page right now. */
export function accessBody({ scanOnClick, shortcut }) {
  if (scanOnClick) return shortcut ? { key: 'page_access_body_keys', subs: [shortcut] } : { key: 'page_access_body', subs: [] };
  return shortcut ? { key: 'page_access_body_keys_only', subs: [shortcut] } : { key: 'page_access_body_none', subs: [] };
}

/** Idle hint under "Scan this page"; null when neither the icon nor a shortcut scans. */
export function idleShortcutHint({ scanOnClick, shortcut }) {
  if (scanOnClick) return shortcut ? { key: 'shortcut_hint', subs: [shortcut] } : { key: 'shortcut_none', subs: [] };
  return shortcut ? { key: 'shortcut_hint_keys_only', subs: [shortcut] } : null;
}

/** Lines under the page-results heading. */
export function pageSummary(result) {
  const out = [{ key: 'page_results_summary', subs: [String(result?.items?.length ?? 0)] }];
  if (result?.partial) out.push({ key: 'page_results_partial', subs: [String(result.partial.checked), String(result.partial.total)] });
  return out;
}

/** Off-site QR warning for a page result (N2): host, and whether a listed number was taken from it. */
export function pageQrInfo(result) {
  const w = (result?.warnings ?? []).find((x) => x && x.code === 'qr-untrusted-host');
  if (!w) return { qrHost: null, qrNumberUsed: false };
  const used = (result.items ?? []).some((i) => (i.evidence ?? []).includes(`qr-untrusted:${w.detail}`));
  return { qrHost: w.detail ?? null, qrNumberUsed: used };
}

/**
 * Error code to show for a failed page scan. 'page-access' = the panel lost access between its tab check and the
 * scan; 'page-timeout' = the 30 s page budget ran out before any number was read.
 */
export function pageErrorCode(error, job) {
  const code = error?.code ?? 'engine-failed';
  if (code === 'restricted' && error?.injectFailed && job?.source === 'panel' && !isRestrictedPage(job.pageUrl)) return 'page-access';
  if (code === 'timeout') return 'page-timeout';
  return code;
}

/**
 * Shape of a page result that the lastResult store (A5) can restore. Only an auto-open fits the existing schema
 * (task 'result'); results lists and page "none" are not restored (they need the thumbnails, which are not stored).
 */
export function persistablePage(result) {
  if (result?.status !== 'auto-open' || !result.top) return null;
  return { candidates: [result.top], warnings: result.warnings ?? [], imageInfo: null };
}
