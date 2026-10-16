// Reads a public page in an inactive tab when a site's bot check (Cloudflare on PriceCharting, eBay's "Pardon Our
// Interruption") blocks the panel's own request (ADR A21; setting "readViaTab", on by default, user request: prices
// right after a scan for personal use). The browser passes the check itself; the page is read once with
// scripting.executeScript (XMLSerializer, read only) and the tab is closed. Only for hosts the extension may access.
export class Blocked extends Error {}

const POLL_MS = 600;
export const TAB_TIMEOUT_MS = 30_000;
export const MAX_HTML = 4_000_000;
/** Tabs open for a read right now (a closed panel never runs the `finally` that closes them). */
const openTabs = new Set();

/** Close every reader tab at once: the panel is going away (pagehide). */
export function closeReaderTabs(chromeApi = globalThis.chrome) {
  for (const id of openTabs) chromeApi.tabs.remove(id).catch(() => {});
  openTabs.clear();
}

/**
 * Injected into the tab: its state and, once the page is past any check, its HTML. Self-contained (runs in the page).
 * @param {number} maxHtml
 * @param {string} readySelector element that only the real page has
 */
export function pageState(maxHtml, readySelector) {
  const title = document.title || '';
  const challenge = /just a moment|attention required|verify you are human|pardon our interruption|security measure/i.test(title)
    || Boolean(document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile, #captcha-box, iframe[src*="captcha"]'))
    || /\/splashui\/(challenge|captcha)/.test(location.pathname);
  const ready = document.readyState === 'complete' && !challenge && Boolean(document.querySelector(readySelector));
  return { url: location.href, challenge, ready, html: ready ? new XMLSerializer().serializeToString(document).slice(0, maxHtml) : '' };
}

/**
 * @param {string} url page to read
 * @param {{isAllowedUrl:(u:string)=>boolean, readySelector:string, signal?:AbortSignal, chromeApi?:object, windowId?:number,
 *   timeoutMs?:number}} o
 * @returns {Promise<{html:string, url:string}>}
 */
export async function readViaTab(url, { isAllowedUrl, readySelector, signal, chromeApi = globalThis.chrome, windowId, timeoutMs = TAB_TIMEOUT_MS }) {
  const tab = await chromeApi.tabs.create({ url, active: false, ...(Number.isInteger(windowId) ? { windowId } : {}) });
  openTabs.add(tab.id);
  try {
    const end = Date.now() + timeoutMs;
    let sawChallenge = false;
    while (Date.now() < end) {
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, POLL_MS));
      let st;
      try {
        [{ result: st } = {}] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: pageState, args: [MAX_HTML, readySelector] });
      } catch { continue; } // still loading / navigating
      if (!st) continue;
      if (!isAllowedUrl(st.url)) throw new Error('left the site');
      sawChallenge ||= st.challenge;
      if (st.ready) return { html: st.html, url: st.url };
    }
    throw new Blocked(sawChallenge ? 'challenge-not-passed' : 'tab-timeout');
  } finally {
    openTabs.delete(tab.id);
    chromeApi.tabs.remove(tab.id).catch(() => {});
  }
}
