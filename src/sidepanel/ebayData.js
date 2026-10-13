// eBay sales overview for the shown slab (ADR A21): eBay's public sold search and Buy It Now search for the card in
// the slab's grade, read on this device with the user's eBay site. Needs the optional host permission for that eBay
// site (asked from a click: "Show eBay sales here"). The browser's eBay cookies go along like a normal visit; when eBay
// shows its bot check instead of results, the page is read once in an inactive tab (setting "readViaTab") or the panel
// asks the user to open eBay. Pages are parsed with DOMParser (inert); only short text values are kept, in memory.
import { ebayUrls, ebayPermission, isEbayUrl, extractListings, isEbayBlocked, ebayOverview } from '../core/ebaySold.js';
import { readViaTab, Blocked } from './tabReader.js';

const TIMEOUT_MS = 15_000;
const MAX_HTML = 4_000_000;
const READY = 'ul.srp-results, .srp-river-results, #srp-river-results, .srp-save-null-search';
const cache = new Map();

export const hasEbayPermission = (site, chromeApi = globalThis.chrome) =>
  chromeApi.permissions.contains({ origins: [ebayPermission(site)] }).catch(() => false);

/** Call directly from a click handler (user gesture). */
export const requestEbayPermission = (site, chromeApi = globalThis.chrome) => chromeApi.permissions.request({ origins: [ebayPermission(site)] });

const parse = (html) => new DOMParser().parseFromString(String(html).slice(0, MAX_HTML), 'text/html');

async function viaFetch(url, site, signal, fetchImpl) {
  const res = await fetchImpl(url, { credentials: 'include', referrerPolicy: 'no-referrer', redirect: 'follow', signal });
  const finalUrl = res.url || url;
  const doc = parse(await res.text());
  if (!isEbayUrl(finalUrl, site) || isEbayBlocked(doc, finalUrl) || res.status === 403 || res.status === 429) throw new Blocked('blocked');
  if (!res.ok) throw new Error(`http ${res.status}`);
  return doc;
}

/**
 * @param {{site:string, grader:string, desc:string, grade:string, signal?:AbortSignal, windowId?:number, allowTab?:boolean}} p
 * @returns {Promise<{status:'ok', urls:{sold:string, active:string}, overview:ReturnType<typeof ebayOverview>}
 *   | {status:'no-permission'|'need-card'|'need-grade'|'blocked'|'error', urls?:{sold:string, active:string}}>}
 */
export async function loadEbay({ site, grader, desc, grade, signal, windowId, allowTab = true, onStage }, {
  fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome,
} = {}) {
  if (!grade) return { status: 'need-grade' };
  const urls = ebayUrls(site, { grader, desc, grade });
  if (!urls) return { status: 'need-card' };
  if (!(await hasEbayPermission(site, chromeApi))) return { status: 'no-permission', urls };
  const key = JSON.stringify([site, grader, urls.query]);
  if (cache.has(key)) return cache.get(key);
  const get = async (url) => {
    try {
      return await viaFetch(url, site, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean)), fetchImpl);
    } catch (e) {
      if (!(e instanceof Blocked) || !allowTab) throw e;
      try { onStage?.('check'); } catch { /* UI only */ }
      const page = await readViaTab(url, { isAllowedUrl: (u) => isEbayUrl(u, site), readySelector: READY, signal, chromeApi, windowId });
      return parse(page.html);
    }
  };
  let out;
  try {
    const sold = extractListings(await get(urls.sold), site);
    const active = extractListings(await get(urls.active), site);
    out = { status: 'ok', urls, overview: ebayOverview({ sold, active }, { grader, grade, desc, site }) };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: e instanceof Blocked ? 'blocked' : 'error', urls }; // not cached: may pass on a retry
  }
  cache.set(key, out);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return out;
}
