// Prices and recent sales for the shown card, read on this device from PriceCharting's public pages
// (user request: "altijd de prijs en last sold laten zien, zoals op PriceCharting").
// PriceCharting is behind Cloudflare's bot check: plain requests without the browser's cookies get a challenge
// page (seen in an open-source PriceCharting crawler, see ADR A16). So:
//   1. fetch() with the browser's PriceCharting cookies (credentials: 'include'), like a normal visit;
//   2. on a challenge, open the page in an inactive tab (the browser passes the check itself), read the page there
//      with scripting.executeScript, close the tab. After that the cookie lets step 1 work again.
// Needs host access to www.pricecharting.com (manifest host_permissions). Pages are parsed with DOMParser (inert:
// no scripts run, nothing is inserted into the panel); src/core/pricecharting.js extracts short text values.
import { PC_PERMISSION, searchUrl, isPcUrl, isProductUrl, bestSearchResult, parseProduct, gradeLabels, pickPrice, pickSales, isChallengePage } from '../core/pricecharting.js';

const TIMEOUT_MS = 15_000;
const TAB_TIMEOUT_MS = 30_000;
const MAX_HTML = 4_000_000;
const cache = new Map();

export const hasPricePermission = (chromeApi = globalThis.chrome) =>
  chromeApi.permissions.contains({ origins: [PC_PERMISSION] }).catch(() => false);

/** Call directly from a click handler (user gesture); only needed when access was removed. */
export const requestPricePermission = (chromeApi = globalThis.chrome) => chromeApi.permissions.request({ origins: [PC_PERMISSION] });

class Challenge extends Error {}

const parse = (html) => new DOMParser().parseFromString(String(html).slice(0, MAX_HTML), 'text/html');

async function viaFetch(url, signal, fetchImpl) {
  const res = await fetchImpl(url, { credentials: 'include', referrerPolicy: 'no-referrer', redirect: 'follow', signal });
  const finalUrl = res.url || url;
  if (!isPcUrl(finalUrl)) throw new Error('left PriceCharting');
  if (res.headers?.get?.('cf-mitigated') === 'challenge') throw new Challenge('challenge');
  const doc = parse(await res.text());
  if (isChallengePage(doc) || res.status === 403 || res.status === 503) throw new Challenge('challenge');
  if (!res.ok) throw new Error(`http ${res.status}`);
  return { doc, url: finalUrl };
}

/** Injected into the PriceCharting tab: its state and, once past the bot check, the page HTML. Self-contained. */
function pcTabState(maxHtml) {
  const title = document.title || '';
  const challenge = /just a moment|attention required|verify you are human/i.test(title)
    || Boolean(document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile'));
  const ready = document.readyState === 'complete' && !challenge && Boolean(document.querySelector('h1, table, #games_table'));
  return { url: location.href, challenge, ready, html: ready ? new XMLSerializer().serializeToString(document).slice(0, maxHtml) : '' }; // read only
}

async function viaTab(url, { signal, chromeApi, windowId }) {
  const tab = await chromeApi.tabs.create({ url, active: false, ...(Number.isInteger(windowId) ? { windowId } : {}) });
  try {
    const end = Date.now() + TAB_TIMEOUT_MS;
    let sawChallenge = false;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, 600));
      let st;
      try {
        [{ result: st } = {}] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: pcTabState, args: [MAX_HTML] });
      } catch { continue; } // still loading / navigating
      if (!st) continue;
      if (!isPcUrl(st.url)) throw new Error('left PriceCharting');
      sawChallenge ||= st.challenge;
      if (st.ready) return { doc: parse(st.html), url: st.url };
    }
    throw new Challenge(sawChallenge ? 'challenge-not-passed' : 'tab-timeout');
  } finally {
    chromeApi.tabs.remove(tab.id).catch(() => {});
  }
}

/**
 * @param {{query:string, cardNo?:string|null, grader:string, grade?:string|null, signal?:AbortSignal, windowId?:number,
 *   onStage?:(stage:'fetch'|'check')=>void}} p
 * @returns {Promise<{status:'ok', url:string, name:string, set:string, prices:{label:string, price:number, text:string}[],
 *   current:{label:string, price:number}|null, lastSold:{date:string, title:string, price:number}|null,
 *   sales:{label:string, rows:{date:string, title:string, price:number, source:string|null}[]}|null, labels:string[]}
 *   | {status:'no-permission'|'not-found'|'unreadable'|'error'|'challenge', url?:string}>}
 */
export async function loadPrices({ query, cardNo = null, grader, grade = null, special = null, signal, windowId, onStage }, {
  fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome, allowTab = true,
} = {}) {
  if (!(await hasPricePermission(chromeApi))) return { status: 'no-permission' };
  const key = JSON.stringify([query, cardNo, grader, grade, special]);
  if (cache.has(key)) return cache.get(key);
  const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS + TAB_TIMEOUT_MS)].filter(Boolean));
  const get = async (url) => {
    try {
      return await viaFetch(url, AbortSignal.any([sig, AbortSignal.timeout(TIMEOUT_MS)]), fetchImpl);
    } catch (e) {
      if (!(e instanceof Challenge) || !allowTab) throw e;
      try { onStage?.('check'); } catch { /* UI only */ }
      return viaTab(url, { signal: sig, chromeApi, windowId });
    }
  };
  let out;
  try {
    let page = await get(searchUrl(query));
    if (!isProductUrl(page.url)) {
      const href = bestSearchResult(page.doc, query, cardNo);
      if (!href) { out = { status: 'not-found', url: page.url }; cache.set(key, out); return out; }
      page = await get(href);
    }
    const p = parseProduct(page.doc);
    if (!p.prices.length && !Object.keys(p.sales).length) {
      out = { status: 'unreadable', url: page.url };
    } else {
      const labels = gradeLabels(grader, grade, special);
      const sales = pickSales(p.sales, labels);
      out = {
        status: 'ok', url: page.url, name: p.name, set: p.set, prices: p.prices, current: pickPrice(p.prices, labels),
        lastSold: sales?.rows[0] ?? null, sales, labels,
      };
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: e instanceof Challenge ? 'challenge' : 'error' }; // not cached: may pass on a retry
  }
  cache.set(key, out);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return out;
}
