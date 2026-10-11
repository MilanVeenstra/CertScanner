// The only caller of chrome.tabs.create (ADR-001 §8). Decoded/page URLs are never navigated:
// cert URLs are always rebuilt by buildCertUrl() from a validated grader + digit string, and price links must pass
// isPriceUrl() (allow-listed eBay/130point search URLs built by priceLinks.js).
import { buildCertUrl, hasDirectUrl } from '../core/certUrls.js';
import { isPriceUrl } from '../core/priceLinks.js';
import { addHistoryEntry, makeEntry } from '../shared/history.js';

/**
 * Open the official cert page next to the source tab.
 * @param {{grader:string, number:string, source:string}} candidate grader/number chosen by the scan or the user
 * @param {import('../core/types.js').ScanJob|null} job the context-menu job (null for upload/paste/manual)
 * @param {import('../core/types.js').Settings} settings
 * @param {{windowId?:number, chromeApi?:typeof chrome, now?:number}} [opts]
 * @returns {Promise<{url:string, tabId:number|undefined, historySaved:boolean}>}
 */
export async function openCert(candidate, job, settings, { windowId, chromeApi = globalThis.chrome, now = Date.now(), replaceLatest = false,
  clipboard = globalThis.navigator?.clipboard } = {}) {
  const url = buildCertUrl(candidate.grader, candidate.number); // throws RangeError on bad input
  // A lookup form (Beckett) can't be linked per number: copy it first, while the click still counts as a user gesture.
  let copied = false;
  if (!hasDirectUrl(candidate.grader)) {
    try { await clipboard.writeText(candidate.number); copied = true; } catch { copied = false; }
  }
  const { tab, active } = await openNextToSource(url, job, settings, windowId, chromeApi);
  const historySaved = await recordHistory(candidate, job, settings, now, { replace: replaceLatest });
  return { url, tabId: tab?.id, active, historySaved, copied };
}

/**
 * Open a price/listing search (eBay, 130point) next to the source tab. Only links built by priceLinks.js pass, and
 * nothing is added to the scan history (these are searches, not cert pages).
 */
export async function openPriceLink(url, job, settings, { windowId, chromeApi = globalThis.chrome } = {}) {
  if (!isPriceUrl(url)) throw new RangeError('not a price link');
  const { tab } = await openNextToSource(url, job, settings, windowId, chromeApi);
  return { url, tabId: tab?.id };
}

async function openNextToSource(url, job, settings, windowId, chromeApi) {
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
  return { tab, active: props.active };
}

/** History is written when a cert is opened or copied, only if saveHistory is on (ADR §9). */
export async function recordHistory(candidate, job, settings, now = Date.now(), { replace = false } = {}) {
  if (!settings?.saveHistory) return false;
  try {
    await addHistoryEntry(makeEntry(candidate, job?.pageUrl ?? null, now), { replace });
    return true;
  } catch {
    return false;
  }
}
