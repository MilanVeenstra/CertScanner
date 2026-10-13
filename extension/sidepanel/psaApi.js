// Card details for a PSA cert from PSA's official Public API (user request: "als je de cert hebt kan je gewoon de kaart
// naam hebben"). Needs the user's own free access token (psacard.com/publicapi), kept in chrome.storage.local on this
// device only, and the optional host permission for api.psacard.com (asked when the key is saved).
// Only the cert number and the token are sent, with the browser's psacard.com cookies like a normal visit (PSA's site
// protection may answer a cookieless request with its own 403 page); the response is validated field by field.
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
 * What a non-2xx PSA answer means, or null for a usable one. PSA's API docs: 500 = invalid credentials or a server
 * error, 4xx = a wrong request path, 429 = the daily limit. A 403/503 that is an HTML page (a bot check in front of the
 * API) is PSA's site protection, not a verdict on the key (user report 2026-10-13: a valid key was refused as "not
 * accepted").
 * @returns {Promise<'auth'|'blocked'|'limit'|'server'|'error'|null>}
 */
async function verdict(res) {
  if (res.status === 429) return 'limit';
  if (res.status === 401) return 'auth';
  if (res.status === 403 || res.status === 503) {
    const type = res.headers?.get?.('content-type') ?? '';
    const head = (await res.text().catch(() => '')).slice(0, 2000).trimStart();
    const page = /html/i.test(type) || head.startsWith('<') || Boolean(res.headers?.get?.('cf-mitigated'));
    return page ? 'blocked' : res.status === 403 ? 'auth' : 'error';
  }
  if (res.status >= 500) return 'server';
  return null;
}
const psaInit = (token, signal) => ({
  headers: { Authorization: `bearer ${token}`, Accept: 'application/json' }, credentials: 'include', referrerPolicy: 'no-referrer', signal,
});

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
 * @returns {Promise<{ok:true, card:ReturnType<typeof parsePsaCert>}
 *   | {ok:false, reason:'no-token'|'no-permission'|'auth'|'blocked'|'server'|'not-found'|'limit'|'error'}>}
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
    const res = await fetchImpl(`${PSA_API_ORIGIN}/publicapi/cert/GetByCertNumber/${number}`, psaInit(token, sig));
    const bad = await verdict(res);
    if (bad) return { ok: false, reason: bad };
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

/**
 * Checks a key right after it is saved (uses 1 of the day's lookups); the test number itself doesn't have to exist.
 * `status` is PSA's HTTP status (0 = no answer), shown with the result so a refusal can be told apart from a block.
 * @returns {Promise<{result:'ok'|'auth'|'blocked'|'server'|'limit'|'error'|'no-permission', status:number}>}
 */
export async function testPsaKey(token, { fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome } = {}) {
  if (!okToken(token)) return { result: 'auth', status: 0 };
  try {
    if (!(await chromeApi.permissions.contains({ origins: [PSA_API_PERMISSION] }))) return { result: 'no-permission', status: 0 };
    const res = await fetchImpl(`${PSA_API_ORIGIN}/publicapi/cert/GetByCertNumber/10000000`, psaInit(token.trim(), AbortSignal.timeout(TIMEOUT_MS)));
    return { result: (await verdict(res)) ?? 'ok', status: res.status };
  } catch { return { result: 'error', status: 0 }; }
}
