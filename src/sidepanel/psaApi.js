// Card details for a PSA cert from PSA's official Public API (user request: "als je de cert hebt kan je gewoon de kaart
// naam hebben"). Needs the user's own free access token (psacard.com/publicapi), kept in chrome.storage.local on this
// device only, and the optional host permission for api.psacard.com (asked when the key is saved).
// Only the cert number and the token are sent; the response is validated field by field.
export const PSA_API_ORIGIN = 'https://api.psacard.com';
export const PSA_API_PERMISSION = `${PSA_API_ORIGIN}/*`;
export const PSA_API_SIGNUP = 'https://www.psacard.com/publicapi';
const TOKEN_KEY = 'psaApiToken';
const TIMEOUT_MS = 10_000;
const cache = new Map();

const str = (v, max = 100) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const int = (v) => (Number.isInteger(v) && v >= 0 ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null));
const okToken = (t) => typeof t === 'string' && /^[\w\-.~+/=]{10,4096}$/.test(t.trim());

export async function loadPsaToken(chromeApi = globalThis.chrome) {
  try { const got = await chromeApi.storage.local.get(TOKEN_KEY); return okToken(got?.[TOKEN_KEY]) ? got[TOKEN_KEY].trim() : null; } catch { return null; }
}
export async function savePsaToken(token, chromeApi = globalThis.chrome) {
  if (!okToken(token)) throw new RangeError('invalid token');
  await chromeApi.storage.local.set({ [TOKEN_KEY]: token.trim() });
  cache.clear();
}
export async function clearPsaToken(chromeApi = globalThis.chrome) {
  await chromeApi.storage.local.remove(TOKEN_KEY);
  cache.clear();
}
export const isPsaToken = okToken;

/**
 * Pure: PSA API JSON -> card details. Search terms follow the label search format: brand word + subject + card number
 * (+ 1st Edition / Shadowless), e.g. "POKEMON CHARIZARD ex 199".
 */
export function parsePsaCert(json) {
  const c = json && typeof json === 'object' ? (json.PSACert ?? json.psaCert ?? json) : null;
  if (!c || typeof c !== 'object') return null;
  const subject = str(c.Subject);
  if (!subject) return null;
  const brand = str(c.Brand);
  const year = str(c.Year ?? c.YearIssued, 10);
  const cardNumber = str(c.CardNumber, 12).replace(/^#/, '');
  const variety = str(c.Variety);
  const gradeText = str(c.CardGrade ?? c.GradeDescription, 40);
  const grade = /(\d{1,2}(?:\.5)?)\s*$/.exec(gradeText)?.[1] ?? null;
  const brandWord = /^[A-Za-zÀ-ÿ]{3,}/.exec(brand)?.[0] ?? '';
  const keep = /\b(1ST EDITION|SHADOWLESS)\b/i.exec(variety)?.[1] ?? '';
  const query = [brandWord, subject, cardNumber, keep.toUpperCase()].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    year, brand, subject, cardNumber, variety, gradeText, grade, query,
    title: [year, brand, subject, cardNumber && `#${cardNumber}`].filter(Boolean).join(' '),
    population: int(c.TotalPopulation), populationHigher: int(c.PopulationHigher),
  };
}

/**
 * @returns {Promise<{ok:true, card:ReturnType<typeof parsePsaCert>} | {ok:false, reason:'no-token'|'no-permission'|'auth'|'not-found'|'limit'|'error'}>}
 */
export async function fetchPsaCert(number, { token, signal, fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome } = {}) {
  if (!okToken(token)) return { ok: false, reason: 'no-token' };
  if (!/^\d{7,10}$/.test(String(number))) return { ok: false, reason: 'not-found' };
  if (cache.has(number)) return cache.get(number);
  try {
    if (!(await chromeApi.permissions.contains({ origins: [PSA_API_PERMISSION] }))) return { ok: false, reason: 'no-permission' };
  } catch { return { ok: false, reason: 'no-permission' }; }
  const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
  let out;
  try {
    const res = await fetchImpl(`${PSA_API_ORIGIN}/publicapi/cert/GetByCertNumber/${number}`, {
      headers: { Authorization: `bearer ${token}`, Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: sig,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth' };
    if (res.status === 429) return { ok: false, reason: 'limit' };
    if (!res.ok) return { ok: false, reason: res.status === 404 ? 'not-found' : 'error' };
    const card = parsePsaCert(JSON.parse((await res.text()).slice(0, 200_000)));
    out = card ? { ok: true, card } : { ok: false, reason: 'not-found' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, reason: 'error' };
  }
  cache.set(number, out);
  return out;
}
