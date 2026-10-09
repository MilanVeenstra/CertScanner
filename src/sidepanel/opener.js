// The only caller of chrome.tabs.create (ADR-001 §8). Decoded/page URLs are never navigated:
// the URL is always rebuilt by buildCertUrl() from a validated grader + digit string.
import { buildCertUrl } from '../core/certUrls.js';
import { addHistoryEntry, makeEntry } from '../shared/history.js';

/**
 * Open the official cert page next to the source tab.
 * @param {{grader:string, number:string, source:string}} candidate grader/number chosen by the scan or the user
 * @param {import('../core/types.js').ScanJob|null} job the context-menu job (null for upload/paste/manual)
 * @param {import('../core/types.js').Settings} settings
 * @param {{windowId?:number, chromeApi?:typeof chrome, now?:number}} [opts]
 * @returns {Promise<{url:string, tabId:number|undefined, historySaved:boolean}>}
 */
export async function openCert(candidate, job, settings, { windowId, chromeApi = globalThis.chrome, now = Date.now() } = {}) {
  const url = buildCertUrl(candidate.grader, candidate.number); // throws RangeError on bad input
  let src = null;
  if (job && Number.isInteger(job.tabId)) {
    try { src = await chromeApi.tabs.get(job.tabId); } catch { src = null; }
  }
  const props = { url, active: !settings?.openInBackground };
  if (src) {
    props.windowId = src.windowId;
    props.index = src.index + 1;
    props.openerTabId = src.id;
  } else if (Number.isInteger(windowId)) {
    props.windowId = windowId;
  }
  let tab;
  try {
    tab = await chromeApi.tabs.create(props);
  } catch {
    // Window gone (e.g. popup fallback outlived it): open in the current window instead.
    tab = await chromeApi.tabs.create({ url, active: props.active });
  }
  const historySaved = await recordHistory(candidate, job, settings, now);
  return { url, tabId: tab?.id, historySaved };
}

/** History is written when a cert is opened or copied, only if saveHistory is on (ADR §9). */
export async function recordHistory(candidate, job, settings, now = Date.now()) {
  if (!settings?.saveHistory) return false;
  try {
    await addHistoryEntry(makeEntry(candidate, job?.pageUrl ?? null, now));
    return true;
  } catch {
    return false;
  }
}
