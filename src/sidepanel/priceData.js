// Prices and recent sales for the shown card, read on this device from PriceCharting's public pages
// (user request: "altijd de prijs en last sold laten zien, zoals op PriceCharting").
// Needs the optional host permission for www.pricecharting.com (asked once, from a click). Requests carry no
// cookies and no referrer; only the card's search terms are sent. Pages are parsed with DOMParser (inert: no
// scripts run, nothing is inserted into the panel); src/core/pricecharting.js extracts short text values.
import { PC_PERMISSION, searchUrl, isPcUrl, isProductUrl, bestSearchResult, parseProduct, gradeLabels, pickPrice, pickSales } from '../core/pricecharting.js';

const TIMEOUT_MS = 12_000;
const MAX_HTML = 4_000_000;
const cache = new Map();

export const hasPricePermission = (chromeApi = globalThis.chrome) =>
  chromeApi.permissions.contains({ origins: [PC_PERMISSION] }).catch(() => false);

/** Call directly from a click handler (user gesture). */
export const requestPricePermission = (chromeApi = globalThis.chrome) => chromeApi.permissions.request({ origins: [PC_PERMISSION] });

async function getPage(url, signal, fetchImpl) {
  if (!isPcUrl(url)) throw new Error('not a PriceCharting page');
  const res = await fetchImpl(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const finalUrl = res.url || url;
  if (!isPcUrl(finalUrl)) throw new Error('left PriceCharting');
  const html = (await res.text()).slice(0, MAX_HTML);
  return { doc: new DOMParser().parseFromString(html, 'text/html'), url: finalUrl };
}

/**
 * @param {{query:string, cardNo?:string|null, grader:string, grade?:string|null, signal?:AbortSignal}} p
 * @returns {Promise<{status:'ok', url:string, name:string, set:string, prices:{label:string, price:number, text:string}[],
 *   current:{label:string, price:number, text:string}|null, sales:{label:string, rows:{date:string, title:string, price:number, text:string}[]}|null,
 *   labels:string[]} | {status:'no-permission'|'not-found'|'unreadable'|'error', url?:string}>}
 */
export async function loadPrices({ query, cardNo = null, grader, grade = null, signal }, { fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome } = {}) {
  if (!(await hasPricePermission(chromeApi))) return { status: 'no-permission' };
  const key = JSON.stringify([query, cardNo, grader, grade]);
  if (cache.has(key)) return cache.get(key);
  const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
  let out;
  try {
    let page = await getPage(searchUrl(query), sig, fetchImpl);
    if (!isProductUrl(page.url)) {
      const href = bestSearchResult(page.doc, query, cardNo);
      if (!href) { out = { status: 'not-found', url: page.url }; cache.set(key, out); return out; }
      page = await getPage(href, sig, fetchImpl);
    }
    const p = parseProduct(page.doc);
    if (!p.prices.length && !Object.keys(p.sales).length) {
      out = { status: 'unreadable', url: page.url };
    } else {
      const labels = gradeLabels(grader, grade);
      out = { status: 'ok', url: page.url, name: p.name, set: p.set, prices: p.prices, current: pickPrice(p.prices, labels), sales: pickSales(p.sales, labels), labels };
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: 'error' }; // not cached: a network hiccup may pass
  }
  cache.set(key, out);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return out;
}
