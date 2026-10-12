// PokemonPriceTracker API client (ADR A18): the user's own key, kept in chrome.storage.local on this device only, and
// the optional host permission for www.pokemonpricetracker.com (asked when the key is saved). Only the card's search
// words go out (e.g. "CHARIZARD ex 199"); no cert number, image or page address.
import { PPT_PERMISSION, PPT_LIMIT, pptUrl, pptSearch, parsePptCards, bestPptCard, pptResult } from '../core/ppt.js';

const TOKEN_KEY = 'pptApiToken';
const TIMEOUT_MS = 12_000;
const cache = new Map();

const okToken = (t) => typeof t === 'string' && /^[\w\-.~+/=]{16,4096}$/.test(t.trim());
export const isPptToken = okToken;

export async function loadPptToken(chromeApi = globalThis.chrome) {
  try { const got = await chromeApi.storage.local.get(TOKEN_KEY); return okToken(got?.[TOKEN_KEY]) ? got[TOKEN_KEY].trim() : null; } catch { return null; }
}
export async function savePptToken(token, chromeApi = globalThis.chrome) {
  if (!okToken(token)) throw new RangeError('invalid token');
  await chromeApi.storage.local.set({ [TOKEN_KEY]: token.trim() });
  cache.clear();
}
export async function clearPptToken(chromeApi = globalThis.chrome) {
  await chromeApi.storage.local.remove(TOKEN_KEY);
  cache.clear();
}

/**
 * Prices for a Pokémon card in the slab's grade.
 * @returns {Promise<object>} the panel's ok price result, or {status:'no-token'|'no-permission'|'auth'|'limit'|'not-found'|'error'}
 */
export async function loadPptPrices({ desc, cardNo = null, grader, grade, token, signal }, {
  fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome,
} = {}) {
  if (!okToken(token)) return { status: 'no-token' };
  const search = pptSearch(desc);
  if (!search) return { status: 'not-found' };
  try {
    if (!(await chromeApi.permissions.contains({ origins: [PPT_PERMISSION] }))) return { status: 'no-permission' };
  } catch { return { status: 'no-permission' }; }
  // One request per card name: the grade is picked from the same answer, so a grade change costs no credits.
  let cards = cache.get(search);
  if (!cards) {
    const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
    try {
      const res = await fetchImpl(pptUrl(search), {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: sig,
      });
      if (res.status === 401 || res.status === 403) return { status: 'auth' };
      if (res.status === 429 || res.status === 402) return { status: 'limit' };
      if (!res.ok) return { status: res.status === 404 ? 'not-found' : 'error' };
      cards = parsePptCards(JSON.parse((await res.text()).slice(0, 2_000_000)));
    } catch (e) {
      if (signal?.aborted) throw e;
      return { status: 'error' };
    }
    cache.set(search, cards);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  const card = bestPptCard(cards.slice(0, PPT_LIMIT * 5), { desc, cardNo });
  if (!card) return { status: 'not-found' };
  return pptResult(card, { grader, grade });
}
