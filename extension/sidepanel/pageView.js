// Pure page-scan view logic for the side panel (ADR A9). No chrome, no DOM: unit-tested in Node.
import { isRestrictedPage } from '../core/certUrls.js';
import { DEFAULT_RULES } from '../core/certRules.js';

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

/** Host for "Always allow on ‹host›": https only (the optional host permission covers https sites only). */
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

/**
 * O11 body: a toolbar/shortcut page job whose access was gone by scan time (e.g. the tab navigated to another site
 * right after the click). Same four variants as accessBody, worded for "this tab".
 */
export function noAccessBody({ scanOnClick, shortcut }) {
  if (scanOnClick) return shortcut ? { key: 'err_page_no_access_body', subs: [shortcut] } : { key: 'err_page_no_access_body_icon', subs: [] };
  return shortcut ? { key: 'err_page_no_access_body_keys', subs: [shortcut] } : { key: 'err_page_no_access_body_none', subs: [] };
}

/** Idle hint under "Scan this page"; null when neither the icon nor a shortcut scans. */
export function idleShortcutHint({ scanOnClick, shortcut }) {
  if (scanOnClick) return shortcut ? { key: 'shortcut_hint', subs: [shortcut] } : { key: 'shortcut_none', subs: [] };
  return shortcut ? { key: 'shortcut_hint_keys_only', subs: [shortcut] } : null;
}

/**
 * O10: how many photos were checked out of the slab-sized photos found, when the 8-photo cap left some unchecked.
 * null when every photo found was checked.
 */
export function pageCoverage(result) {
  const checked = Array.isArray(result?.images) ? result.images.length : 0;
  const total = Number.isInteger(result?.totalFound) ? result.totalFound : (result?.discovered ?? 0);
  return checked > 0 && total > checked ? { checked, total } : null;
}

/** Lines under the page-results heading. */
export function pageSummary(result) {
  const out = [{ key: 'page_results_summary', subs: [String(result?.items?.length ?? 0)] }];
  if (result?.partial) {
    out.push({ key: 'page_results_partial', subs: [String(result.partial.checked), String(result.partial.total)] });
  } else {
    const cov = pageCoverage(result);
    if (cov) out.push({ key: 'page_results_capped', subs: [String(cov.checked), String(cov.total)] });
  }
  return out;
}

/** Reason line of the page "none" state: no slab-sized photo, every photo checked, or only some of them (O10). */
export function pageNoneReason(result) {
  if (!result?.discovered) return { key: 'page_none_no_images', subs: [] };
  const cov = pageCoverage(result);
  return cov ? { key: 'page_none_checked_some', subs: [String(cov.checked), String(cov.total)] } : { key: 'page_none_checked', subs: [] };
}

/** Off-site QR warning for a page result (N2): host, and whether a listed number was taken from it. */
export function pageQrInfo(result) {
  const w = (result?.warnings ?? []).find((x) => x && x.code === 'qr-untrusted-host');
  if (!w) return { qrHost: null, qrNumberUsed: false };
  const used = (result.items ?? []).some((i) => (i.evidence ?? []).includes(`qr-untrusted:${w.detail}`));
  return { qrHost: w.detail ?? null, qrNumberUsed: used };
}

/**
 * Error code to show for a failed page scan. When Chrome refused the injection on a page that is not restricted:
 * 'page-access' for the panel button (it lost access between its tab check and the scan), 'page-no-access' (O11)
 * for a toolbar/shortcut job whose grant was gone by scan time. Pages Chrome never lets extensions read stay
 * 'restricted'. 'page-timeout' = the 30 s page budget ran out before any number was read.
 */
export function pageErrorCode(error, job) {
  const code = error?.code ?? 'engine-failed';
  if (code === 'restricted' && error?.injectFailed && !isRestrictedPage(job?.pageUrl)
      && classifyInjectError(error.injectError) === 'access') {
    return job?.source === 'panel' ? 'page-access' : 'page-no-access';
  }
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

/**
 * Note under a results row: a number taken from an off-site QR code (N2, warning), or a read below the auto-open
 * threshold (muted). null for clear reads.
 */
export function pageRowNote(item, rules = DEFAULT_RULES) {
  const qr = (item?.evidence ?? []).find((e) => typeof e === 'string' && e.startsWith('qr-untrusted:'));
  if (qr) return { key: 'page_row_offsite', subs: [qr.slice('qr-untrusted:'.length)], tone: 'warning' };
  if (typeof item?.confidence === 'number' && item.confidence < rules.SCORE.thresholds.autoOpen) return { key: 'page_row_unclear', subs: [], tone: 'muted' };
  return null;
}
