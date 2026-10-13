// Card details for a PSA cert from PSA's official Public API (user request: "als je de cert hebt kan je gewoon de kaart
// naam hebben"). Needs the user's own free access token (psacard.com/publicapi), kept in chrome.storage.local on this
// device only, and the optional host permission for api.psacard.com (asked when the key is saved).
// Only the cert number and the token are sent (no cookies, no referrer); the response is validated field by field.
export const PSA_API_ORIGIN = 'https://api.psacard.com';
export const PSA_API_PERMISSION = `${PSA_API_ORIGIN}/*`;
export const PSA_API_SIGNUP = 'https://www.psacard.com/publicapi';
const TOKEN_KEY = 'psaApiToken';
const TIMEOUT_MS = 10_000;
const cache = new Map();

// PSA's free key allows 100 calls a day (user report 2026-10-13: "daily quota exceeded" with a key never used on
// purpose). So: every call is counted on this device (psaCalls, shown in Settings), answers are kept for the browser
// session (storage.session, so reopening the panel doesn't ask PSA again), and after a quota answer no lookup is sent
// for the rest of that day. PSA's day is assumed to be UTC.
export const PSA_DAILY_LIMIT = 100;
const CALLS_KEY = 'psaCalls';
const LIMIT_KEY = 'psaLimitedDay';
const SESSION_KEY = 'psaCerts';
const today = () => new Date().toISOString().slice(0, 10);

/** Calls this extension sent to PSA today (UTC). */
export async function psaCallsToday(chromeApi = globalThis.chrome) {
  try { const c = (await chromeApi.storage.local.get(CALLS_KEY))?.[CALLS_KEY]; return c?.day === today() && Number.isInteger(c.n) ? c.n : 0; } catch { return 0; }
}
async function countCall(chromeApi) {
  try { await chromeApi.storage.local.set({ [CALLS_KEY]: { day: today(), n: (await psaCallsToday(chromeApi)) + 1 } }); } catch { /* counting is best effort */ }
}
async function limitedToday(chromeApi) {
  try { return (await chromeApi.storage.local.get(LIMIT_KEY))?.[LIMIT_KEY] === today(); } catch { return false; }
}
async function setLimited(chromeApi, on) {
  try { if (on) await chromeApi.storage.local.set({ [LIMIT_KEY]: today() }); else await chromeApi.storage.local.remove(LIMIT_KEY); } catch { /* best effort */ }
}
async function sessionGet(number, chromeApi) {
  try {
    const kept = (await chromeApi.storage.session.get(SESSION_KEY))?.[SESSION_KEY]?.[number];
    return kept && (kept.ok ? kept.card && typeof kept.card === 'object' : kept.reason === 'not-found') ? kept : null;
  } catch { return null; }
}
async function sessionSet(number, out, chromeApi) {
  try {
    const all = (await chromeApi.storage.session.get(SESSION_KEY))?.[SESSION_KEY] ?? {};
    all[number] = out;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete all[k];
    await chromeApi.storage.session.set({ [SESSION_KEY]: all });
  } catch { /* the in-memory cache still works */ }
}

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
 * What a failed PSA answer means, or null for a usable one or another 4xx (the caller decides). PSA's API docs: 500 =
 * invalid credentials or a server error, 4xx = a wrong request path, 429 = the daily limit. A 403/503 that is an HTML
 * page (a bot check in front of the API) is PSA's site protection, not a verdict on the key. `detail` = the answer's
 * type and first words, shown with a key check so a refusal can be read (user report 2026-10-13: three keys refused
 * with 403; from this build the request carries no Origin header, measured).
 * @returns {Promise<{kind:'auth'|'blocked'|'limit'|'server'|'error', detail:string}|null>}
 */
async function verdict(res) {
  if (res.ok) return null;
  const type = (res.headers?.get?.('content-type') ?? '').split(';')[0].trim();
  const text = (await res.text().catch(() => '')).slice(0, 4000);
  const page = /html/i.test(type) || text.trimStart().startsWith('<') || Boolean(res.headers?.get?.('cf-mitigated'));
  const said = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  const detail = [type, said && `“${said}”`].filter(Boolean).join(' ');
  let kind = null;
  if (res.status === 429 || /quota|calls? (?:limit|exceeded)/i.test(said)) kind = 'limit'; // PSA has sent its quota text with a 403 too
  else if (res.status === 401) kind = 'auth';
  else if (res.status === 403 || res.status === 503) kind = page ? 'blocked' : res.status === 403 ? 'auth' : 'error';
  else if (res.status >= 500) kind = 'server';
  return kind ? { kind, detail } : null;
}
const psaInit = (token, signal) => ({
  headers: { Authorization: `bearer ${token}`, Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal,
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
  const kept = await sessionGet(number, chromeApi);
  if (kept) { cache.set(number, kept); return kept; }
  try {
    if (!(await chromeApi.permissions.contains({ origins: [PSA_API_PERMISSION] }))) return { ok: false, reason: 'no-permission' };
  } catch { return { ok: false, reason: 'no-permission' }; }
  if (await limitedToday(chromeApi)) return { ok: false, reason: 'limit' }; // no call: it would only be refused
  const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)].filter(Boolean));
  let out;
  try {
    await countCall(chromeApi);
    const res = await fetchImpl(`${PSA_API_ORIGIN}/publicapi/cert/GetByCertNumber/${number}`, psaInit(token, sig));
    const bad = await verdict(res);
    if (bad?.kind === 'limit') await setLimited(chromeApi, true);
    if (bad) return { ok: false, reason: bad.kind };
    if (!res.ok) return { ok: false, reason: res.status === 404 ? 'not-found' : 'error' };
    const card = parsePsaCert(JSON.parse((await res.text()).slice(0, 200_000)));
    out = card ? { ok: true, card } : { ok: false, reason: 'not-found' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, reason: 'error' };
  }
  cache.set(number, out);
  await sessionSet(number, out, chromeApi);
  return out;
}

/**
 * Checks a key right after it is saved (uses 1 of the day's lookups, even during a pause); the test number itself
 * doesn't have to exist.
 * `status` is PSA's HTTP status (0 = no answer) and `detail` its answer's type and first words, shown with the result.
 * @returns {Promise<{result:'ok'|'auth'|'blocked'|'server'|'limit'|'error'|'no-permission', status:number, detail:string}>}
 */
export async function testPsaKey(token, { fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome } = {}) {
  if (!okToken(token)) return { result: 'auth', status: 0, detail: '' };
  try {
    if (!(await chromeApi.permissions.contains({ origins: [PSA_API_PERMISSION] }))) return { result: 'no-permission', status: 0, detail: '' };
    await countCall(chromeApi);
    const res = await fetchImpl(`${PSA_API_ORIGIN}/publicapi/cert/GetByCertNumber/10000000`, psaInit(token.trim(), AbortSignal.timeout(TIMEOUT_MS)));
    const bad = await verdict(res);
    await setLimited(chromeApi, bad?.kind === 'limit'); // a working answer lifts today's pause
    return { result: bad?.kind ?? 'ok', status: res.status, detail: bad?.detail ?? '' };
  } catch { return { result: 'error', status: 0, detail: '' }; }
}
