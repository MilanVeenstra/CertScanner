// Prices and recent sales for the shown card, read on this device from PriceCharting's public pages
// (user request: "altijd de prijs en last sold laten zien, zoals op PriceCharting").
// PriceCharting is behind Cloudflare's bot check: plain requests without the browser's cookies get a challenge page
// (ADR A16). fetch() therefore sends the browser's PriceCharting cookies (credentials: 'include'), like a normal visit.
// When the check still has to run, the panel says so and offers "Open PriceCharting" (the user's own visit passes the
// check) and "Try again". CertScanner never opens a tab by itself for this (ADR A18; the earlier inactive-tab
// fallback is gone). Pokémon slabs can use PokemonPriceTracker's API instead (pptApi.js).
// Needs host access to www.pricecharting.com (manifest host_permissions). Pages are parsed with DOMParser (inert:
// no scripts run, nothing is inserted into the panel); src/core/pricecharting.js extracts short text values.
import { PC_PERMISSION, searchUrl, isPcUrl, isProductUrl, bestSearchResult, parseProduct, gradeLabels, pickPrice, pickSales, isChallengePage } from '../core/pricecharting.js';

const TIMEOUT_MS = 15_000;
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

/**
 * @param {{query:string, cardNo?:string|null, grader:string, grade?:string|null, special?:string|null, signal?:AbortSignal}} p
 * @returns {Promise<{status:'ok', url:string, name:string, set:string, prices:{label:string, price:number, text:string}[],
 *   current:{label:string, price:number}|null, lastSold:{date:string, title:string, price:number}|null,
 *   sales:{label:string, rows:{date:string, title:string, price:number, source:string|null}[]}|null, labels:string[]}
 *   | {status:'no-permission'|'not-found'|'unreadable'|'error'|'challenge', url?:string}>}
 */
export async function loadPrices({ query, cardNo = null, grader, grade = null, special = null, signal }, {
  fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome,
} = {}) {
  if (!(await hasPricePermission(chromeApi))) return { status: 'no-permission' };
  const key = JSON.stringify([query, cardNo, grader, grade, special]);
  if (cache.has(key)) return cache.get(key);
  const get = (url) => viaFetch(url, AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean)), fetchImpl);
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
        status: 'ok', source: 'pc', url: page.url, name: p.name, set: p.set, prices: p.prices, current: pickPrice(p.prices, labels),
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
