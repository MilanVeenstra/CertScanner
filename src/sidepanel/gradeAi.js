// Grade check, optional AI condition check (corners, edges, surface). Off by default. The user picks a provider in
// Settings, saves their own key (kept in chrome.storage.local on this device only; host access is asked on save) and
// presses "Check condition"; the first time, a disclosure asks for consent. Only the straightened card photo goes out
// (JPEG made by a canvas: no file name, page address, EXIF or location data). Centering is never asked of the AI: it
// is measured on the device. Raw fetch (no SDK): the panel ships unbundled ES modules and the Anthropic SDK's ESM build
// needs a bundler for its own dependencies.
import { RATING_SCORE } from '../core/gradeEstimate.js';

export const PROVIDERS = Object.freeze({
  'claude-haiku': Object.freeze({ vendor: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }),
  'claude-sonnet': Object.freeze({ vendor: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', fallbacks: true }),
  ximilar: Object.freeze({ vendor: 'ximilar', label: 'Ximilar' }),
});

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';
export const XIMILAR_ORIGIN = 'https://api.ximilar.com';
export const VENDORS = Object.freeze({
  anthropic: Object.freeze({
    name: 'Anthropic', storageKey: 'anthropicApiKey', permission: `${ANTHROPIC_ORIGIN}/*`, signup: 'https://console.anthropic.com/settings/keys',
    isKey: (k) => typeof k === 'string' && /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(k.trim()),
  }),
  ximilar: Object.freeze({
    name: 'Ximilar', storageKey: 'ximilarApiToken', permission: `${XIMILAR_ORIGIN}/*`, signup: 'https://app.ximilar.com/',
    isKey: (k) => typeof k === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(k.trim()),
  }),
});
export const AI_PERMISSIONS = Object.freeze(Object.values(VENDORS).map((v) => v.permission));

export const CONSENT_KEY = 'gradeAiConsent';
/** Bump when what is sent changes: everyone is asked again. */
export const CONSENT_VERSION = 1;
const TIMEOUT_MS = 60_000;
const ANTHROPIC_VERSION = '2026-10-21';
/** Images go to Claude at most this large (long side): enough to see corners, and ~2.4k image tokens each. */
export const CLAUDE_IMAGE_SIDE = 1600;
export const XIMILAR_IMAGE_SIDE = 2000;

const area = (chromeApi) => chromeApi.storage.local;

export async function loadKey(vendor, chromeApi = globalThis.chrome) {
  const v = VENDORS[vendor];
  try { const got = await area(chromeApi).get(v.storageKey); const k = got?.[v.storageKey]; return v.isKey(k) ? k.trim() : null; } catch { return null; }
}
export async function saveKey(vendor, key, chromeApi = globalThis.chrome) {
  const v = VENDORS[vendor];
  if (!v.isKey(key)) throw new RangeError('invalid key');
  await area(chromeApi).set({ [v.storageKey]: key.trim() });
}
/** Removing a key also forgets the consent for that provider. */
export async function clearKey(vendor, chromeApi = globalThis.chrome) {
  await area(chromeApi).remove(VENDORS[vendor].storageKey);
  await clearConsent(vendor, chromeApi);
}
export async function hasConsent(vendor, chromeApi = globalThis.chrome) {
  try { const got = await area(chromeApi).get(CONSENT_KEY); return got?.[CONSENT_KEY]?.[vendor]?.v === CONSENT_VERSION; } catch { return false; }
}
export async function saveConsent(vendor, chromeApi = globalThis.chrome, now = Date.now()) {
  const got = await area(chromeApi).get(CONSENT_KEY).catch(() => ({}));
  const all = { ...(got?.[CONSENT_KEY] ?? {}), [vendor]: { v: CONSENT_VERSION, at: now } };
  await area(chromeApi).set({ [CONSENT_KEY]: all });
}
export async function clearConsent(vendor, chromeApi = globalThis.chrome) {
  const got = await area(chromeApi).get(CONSENT_KEY).catch(() => ({}));
  const all = { ...(got?.[CONSENT_KEY] ?? {}) };
  delete all[vendor];
  await area(chromeApi).set({ [CONSENT_KEY]: all });
}

const RATINGS = ['none', 'minor', 'moderate', 'heavy', 'unknown'];
const areaSchema = {
  type: 'object',
  properties: { rating: { type: 'string', enum: RATINGS }, notes: { type: 'string' } },
  required: ['rating', 'notes'],
  additionalProperties: false,
};
export const CONDITION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    corners: areaSchema,
    edges: areaSchema,
    surface: areaSchema,
    photo_issues: { type: 'array', items: { type: 'string' } },
    card: {
      type: 'object',
      properties: { name: { type: 'string' }, number: { type: 'string' } },
      required: ['name', 'number'],
      additionalProperties: false,
    },
  },
  required: ['corners', 'edges', 'surface', 'photo_issues', 'card'],
  additionalProperties: false,
});

export const SYSTEM_PROMPT = [
  'You inspect photos of one raw (ungraded) trading card, such as Pokémon, Disney Lorcana or One Piece, to describe visible wear for a grading estimate.',
  'The photos are already cropped to the card and straightened: the front, and the back when there is a second photo.',
  'Centering is measured separately by software; do not judge it.',
  'Rate corners, edges and surface separately, on what the photos actually show:',
  '- none: no wear visible at this photo size;',
  '- minor: one or two tiny flaws, such as a white speck on an edge or a slightly soft corner;',
  '- moderate: several flaws or clearly visible wear, such as whitening along an edge, a rounded corner or a visible scratch;',
  '- heavy: obvious damage, such as a crease, bend, dent, tear, peeling or a deep scratch;',
  '- unknown: the photo cannot show it (too small, blurry, glare, sleeve or toploader, cut off).',
  'Prefer unknown over a guess. JPEG artefacts, holo or foil patterns and printed texture are not damage.',
  'In notes, say briefly and concretely what you see and where (for example "whitening on the top edge of the back"), or why it cannot be judged.',
  'In photo_issues, list what limits the photos (glare, low resolution, sleeve, blur); leave it empty when nothing does.',
  'In card, give the name and collector number as printed, or empty strings when they cannot be read.',
].join('\n');

export function conditionPrompt({ centering = null, back = false, language = 'en' } = {}) {
  const lines = [back ? 'The first image is the front of the card, the second the back.' : 'This is the front of the card only; the back was not provided.'];
  if (centering) lines.push(`For context only, measured centering: ${centering}.`);
  lines.push(language === 'nl' ? 'Write the notes and photo issues in Dutch.' : 'Write the notes and photo issues in English.');
  return lines.join('\n');
}

async function b64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const statusOf = (res) => {
  if (res.status === 401) return 'auth';
  if (res.status === 403) return 'forbidden';
  if (res.status === 402 || res.status === 429) return 'limit';
  if (res.status === 413) return 'too-large';
  if (res.status === 529 || res.status === 503) return 'overloaded';
  return 'error';
};

const anthropicHeaders = (key, { fallbacks = false } = {}) => ({
  'x-api-key': key,
  'anthropic-version': ANTHROPIC_VERSION,
  // Required by Anthropic for calls that come from a browser origin (the key is the user's own, on their device).
  'anthropic-dangerous-direct-browser-access': 'true',
  'content-type': 'application/json',
  ...(fallbacks ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
});

/** Request body for Claude: the card images and the instruction, JSON answer constrained to CONDITION_SCHEMA. */
export function claudeBody({ model, images, prompt, fallbacks = false }) {
  const content = [];
  for (const data of images) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
  content.push({ type: 'text', text: prompt });
  return {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: CONDITION_SCHEMA } },
    // Claude Sonnet 5.5 on the Claude API: a policy decline is retried server-side on a fallback model.
    ...(fallbacks ? { fallbacks: 'default' } : {}),
    messages: [{ role: 'user', content }],
  };
}

const clip = (s, n = 280) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Claude's JSON answer -> {condition:{corners, edges, surface}, ratings, notes, photoIssues, card}, or null. */
export function parseClaude(json) {
  if (json?.stop_reason === 'refusal') return { refused: true };
  const text = (json?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { return null; }
  const areas = ['corners', 'edges', 'surface'];
  if (!areas.every((a) => RATINGS.includes(out?.[a]?.rating))) return null;
  const condition = {}; const ratings = {}; const notes = {};
  for (const a of areas) {
    ratings[a] = out[a].rating;
    condition[a] = RATING_SCORE[out[a].rating] ?? null;
    notes[a] = clip(out[a].notes);
  }
  const photoIssues = Array.isArray(out.photo_issues) ? out.photo_issues.map((s) => clip(s, 120)).filter(Boolean).slice(0, 6) : [];
  const card = { name: clip(out.card?.name, 80), number: clip(out.card?.number, 24) };
  return { condition, ratings, notes, photoIssues, card };
}

/** Number from a Ximilar grade field: a number, or an object with grade/value. */
const gradeNum = (v) => {
  const n = typeof v === 'object' && v !== null ? Number(v.grade ?? v.value) : Number(v);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
};

/** Ximilar card-grader answer -> {condition, notes, photoIssues, final}, or null. Worst side counts per area. */
export function parseXimilar(json) {
  const records = json?.records ?? json?.response?.records ?? json?.result?.records;
  if (!Array.isArray(records) || !records.length) return null;
  const condition = { corners: null, edges: null, surface: null };
  let final = null;
  const photoIssues = [];
  for (const r of records) {
    const g = r?.grades;
    if (r?._status && Number(r._status.code) >= 400) { photoIssues.push(clip(r._status.text, 120)); continue; }
    if (!g || typeof g !== 'object') continue;
    for (const a of Object.keys(condition)) {
      const v = gradeNum(g[a]);
      if (v !== null) condition[a] = condition[a] === null ? v : Math.min(condition[a], v);
    }
    const f = gradeNum(g.final);
    if (f !== null) final = final === null ? f : Math.min(final, f);
  }
  if (Object.values(condition).every((v) => v === null)) return null;
  return { condition, notes: {}, photoIssues, final };
}

/**
 * Check corners, edges and surface with the chosen provider.
 * @param {{provider:string, key:string, front:Blob, back?:Blob|null, centering?:string, language?:string, signal?:AbortSignal}} o
 * @returns {Promise<{status:'ok', result:object} | {status:'no-permission'|'auth'|'forbidden'|'limit'|'too-large'|'overloaded'|'refused'|'format'|'error'|'timeout'}>}
 */
export async function checkCondition({ provider, key, front, back = null, centering = '', language = 'en', signal }, {
  fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const p = PROVIDERS[provider];
  if (!p) return { status: 'error' };
  const vendor = VENDORS[p.vendor];
  try {
    if (!(await chromeApi.permissions.contains({ origins: [vendor.permission] }))) return { status: 'no-permission' };
  } catch { return { status: 'no-permission' }; }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const sig = AbortSignal.any([signal, timeout].filter(Boolean));
  const opts = (init) => ({ ...init, credentials: 'omit', referrerPolicy: 'no-referrer', signal: sig });
  try {
    const images = [await b64(front), ...(back ? [await b64(back)] : [])];
    if (p.vendor === 'anthropic') {
      const res = await fetchImpl(`${ANTHROPIC_ORIGIN}/v1/messages`, opts({
        method: 'POST', headers: anthropicHeaders(key, { fallbacks: p.fallbacks }),
        body: JSON.stringify(claudeBody({ model: p.model, images, prompt: conditionPrompt({ centering, back: Boolean(back), language }), fallbacks: p.fallbacks })),
      }));
      if (!res.ok) return { status: statusOf(res) };
      const parsed = parseClaude(JSON.parse((await res.text()).slice(0, 2_000_000)));
      if (parsed?.refused) return { status: 'refused' };
      return parsed ? { status: 'ok', result: { provider, ...parsed } } : { status: 'format' };
    }
    // Ximilar card grader: asynchronous request API (submit, poll the status, read the answer).
    const headers = { Authorization: `Token ${key}`, 'content-type': 'application/json' };
    const records = images.map((data, i) => ({ _id: i ? 'back' : 'front', _base64: data, Side: i ? 'Back' : 'Front' }));
    const sub = await fetchImpl(`${XIMILAR_ORIGIN}/account/v2/request/`, opts({
      method: 'POST', headers, body: JSON.stringify({ type: 'card-grader', endpoint: 'grade', records }),
    }));
    if (!sub.ok) return { status: statusOf(sub) };
    const submitted = JSON.parse((await sub.text()).slice(0, 2_000_000));
    const direct = parseXimilar(submitted);
    if (direct) return { status: 'ok', result: { provider, ...direct } };
    const id = typeof submitted?.id === 'string' && /^[\w-]{1,80}$/.test(submitted.id) ? submitted.id : null;
    if (!id) return { status: 'format' };
    for (let i = 0; i < 40; i++) {
      await sleep(i < 5 ? 1000 : 2000);
      const st = await fetchImpl(`${XIMILAR_ORIGIN}/account/v2/request/${id}/status`, opts({ headers }));
      if (!st.ok) return { status: statusOf(st) };
      const state = String(JSON.parse((await st.text()).slice(0, 100_000))?.status ?? '').toUpperCase();
      if (state === 'ERROR' || state === 'FAILED') return { status: 'error' };
      if (state !== 'DONE') continue;
      const got = await fetchImpl(`${XIMILAR_ORIGIN}/account/v2/request/${id}`, opts({ headers }));
      if (!got.ok) return { status: statusOf(got) };
      const parsed = parseXimilar(JSON.parse((await got.text()).slice(0, 2_000_000)));
      return parsed ? { status: 'ok', result: { provider, ...parsed } } : { status: 'format' };
    }
    return { status: 'timeout' };
  } catch (e) {
    if (signal?.aborted) throw e;
    return { status: timeout.aborted ? 'timeout' : 'error' };
  }
}

/** Check a key right after it is saved. Anthropic: list one model (free). Ximilar: not checked (saved as is). */
export async function testKey(vendor, key, { fetchImpl = globalThis.fetch.bind(globalThis), chromeApi = globalThis.chrome } = {}) {
  const v = VENDORS[vendor];
  if (!v.isKey(key)) return 'auth';
  try {
    if (!(await chromeApi.permissions.contains({ origins: [v.permission] }))) return 'no-permission';
    if (vendor !== 'anthropic') return 'unchecked';
    const res = await fetchImpl(`${ANTHROPIC_ORIGIN}/v1/models?limit=1`, {
      headers: anthropicHeaders(key.trim()), credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(12_000),
    });
    if (res.ok) return 'ok';
    const s = statusOf(res);
    return s === 'auth' || s === 'forbidden' ? 'auth' : s === 'limit' ? 'limit' : 'error';
  } catch { return 'error'; }
}
