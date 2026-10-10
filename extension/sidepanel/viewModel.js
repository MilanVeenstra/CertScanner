// Pure view logic for the side panel (UX spec §3, §4, §6). No chrome, no DOM: unit-tested in Node.
import { DEFAULT_RULES } from '../core/certRules.js';
import { buildCertUrl, isValidCert, parseQrPayload } from '../core/certUrls.js';
import { decide } from '../core/routing.js';
import { MAX_IMAGE_BYTES } from '../pipeline/acquire.js';

export const MIN_DIGITS = Math.min(...DEFAULT_RULES.ALL_LENGTHS);
export const MAX_DIGITS = Math.max(...DEFAULT_RULES.ALL_LENGTHS);
export const MAX_IMAGE_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));
export const GRADER_LABEL = Object.freeze({ psa: 'grader_psa', 'cgc-comics': 'grader_cgc_comics', 'cgc-cards': 'grader_cgc_cards' });

/** "https://www.psacard.com/cert/01234567" -> "psacard.com/cert/01234567" (exact path kept). */
export function displayUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}${u.search}`;
  } catch {
    return '';
  }
}

/** URL preview line under Open: {key, subs} or null when the grader/number pair can't be opened. */
export function previewText(grader, number) {
  if (!grader) return { key: 'url_preview_pending', subs: [] };
  if (!isValidCert(grader, number)) return null;
  return { key: 'url_preview', subs: [displayUrl(buildCertUrl(grader, number))] };
}

/** Message key for how the number was obtained. */
export function methodKey(source, { edited = false } = {}) {
  if (edited || source === 'edited') return 'method_edited';
  return { ocr: 'method_ocr', barcode: 'method_barcode', 'qr-url': 'method_qr', manual: 'method_typed' }[source] ?? 'method_ocr';
}

/**
 * Why a scan needs confirmation (S3), priority order, at most two.
 * @returns {{key:string, subs:string[]}[]}
 */
export function confirmReasons(result, settings, rules = DEFAULT_RULES) {
  const cands = result?.candidates ?? [];
  const top = cands[0];
  if (!top) return [];
  const out = [];
  const numbers = new Set(cands.map((c) => c.number));
  if (numbers.size >= 2) out.push({ key: 'reason_multiple', subs: [String(numbers.size)] });
  if (top.grader === null) {
    const opts = top.graderOptions ?? [];
    if (opts.includes('cgc-comics') && opts.includes('cgc-cards')) out.push({ key: 'reason_cgc_both', subs: [] });
    else out.push({ key: 'reason_grader_unknown', subs: [] });
  }
  const lowRes = result.imageInfo?.resolution === 'screen' || (result.warnings ?? []).some((w) => w.code === 'low-resolution');
  if (top.confidence < rules.SCORE.thresholds.autoOpen || lowRes) out.push({ key: 'reason_unclear', subs: [] });
  if (settings?.autoOpen === false && decide(cands, { ...settings, autoOpen: true }, result.warnings ?? [], rules) === 'auto-open') {
    out.push({ key: 'reason_always_ask', subs: [] });
  }
  return out.slice(0, 2);
}

const ERRORS = {
  restricted: { id: 'E1', tone: 'warning', k: 'err_restricted', actions: ['page?', 'choose'], pageBody: 'err_restricted_page_body' },
  'not-found': { id: 'E2', tone: 'warning', k: 'err_not_found', actions: ['retry?', 'choose'] },
  'tab-changed': { id: 'E2', tone: 'warning', k: 'err_not_found', actions: ['retry?', 'choose'] },
  'too-large': { id: 'E3', tone: 'warning', k: 'err_too_large', actions: ['choose'], size: true },
  'capture-failed': { id: 'E4', tone: 'warning', k: 'err_capture', actions: ['retry?', 'choose'] },
  'fetch-failed': { id: 'E4', tone: 'warning', k: 'err_capture', actions: ['retry?', 'choose'] },
  'engine-failed': { id: 'E5', tone: 'danger', k: 'err_engine', actions: ['reload', 'type'] },
  'file-type': { id: 'E6', tone: 'warning', k: 'err_file_type', actions: ['choose'] },
  'invalid-image': { id: 'E7', tone: 'warning', k: 'err_decode', actions: ['choose'] },
  'dropped-link': { id: 'E8', tone: 'warning', k: 'err_dropped_link', actions: ['choose'], menu: true },
  // A9: the 30 s page budget ran out before any number was read.
  'page-timeout': { id: 'E11', tone: 'warning', k: 'err_page_timeout', actions: ['retry?', 'choose'], menu: true },
  // O11: a toolbar/shortcut page job lost access to its tab before the scan (body: pageView.noAccessBody).
  'page-no-access': { id: 'E12', tone: 'warning', k: 'err_page_no_access', actions: ['page?', 'choose'] },
};

/**
 * Error code (ScanErrorCode or UI-level 'file-type'/'dropped-link'/'page-timeout'/'page-no-access') -> S5 view.
 * `retryable`: the last input can be re-run (an in-memory job or blob).
 * `page`: the failed input was an A9 page scan (E1/E12 then offer "Scan this page").
 * `body`: {key, subs} replacing the default body (E12 names the icon and the current shortcut).
 */
export function errorView(code, { retryable = false, menuTitle = '', page = false, body: bodyOverride = null } = {}) {
  const e = ERRORS[code] ?? { id: 'E9', tone: 'danger', k: 'err_generic', actions: ['retry?', 'type'] };
  if (bodyOverride?.key) {
    const actions = e.actions.flatMap((a) => (a === 'retry?' ? (retryable ? ['retry'] : []) : a === 'page?' ? (page ? ['page-scan'] : []) : [a]));
    return { id: e.id, tone: e.tone, heading: `${e.k}_heading`, body: bodyOverride.key, bodySubs: [...(bodyOverride.subs ?? [])], actions };
  }
  const bodySubs = e.size ? [`${MAX_IMAGE_MB} MB`] : e.menu ? [menuTitle] : [];
  const actions = e.actions.flatMap((a) => {
    if (a === 'retry?') return retryable ? ['retry'] : [];
    if (a === 'page?') return page ? ['page-scan'] : [];
    return [a];
  });
  const body = page && e.pageBody ? e.pageBody : `${e.k}_body`;
  return { id: e.id, tone: e.tone, heading: `${e.k}_heading`, body, bodySubs, actions };
}

// ---------------------------------------------------------------- manual entry (§4)

const PREFIXES = [
  [/^cgc\s+comics?\b\s*/i, 'cgc-comics'],
  [/^cgc\s+cards?\b\s*/i, 'cgc-cards'],
  [/^psa\b\s*/i, 'psa'],
  [/^cgc\b\s*/i, 'cgc'],
];
const FILLER_RE = /(^|\s)(cert|no\.|nr\.|#)(?=\s|$|\d)/gi;
const URLISH_RE = /^[a-z][a-z0-9+.-]*:\/\/|^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}\//i;
const MAX_INPUT = 64;

/**
 * Live analysis of a cert field value.
 * @returns {{empty:boolean, url:{ok:true, grader:string, number:string}|{ok:false}|null, prefix:null|'psa'|'cgc'|'cgc-comics'|'cgc-cards',
 *   digits:string, badChars:boolean, dash:boolean}}
 */
export function analyzeCertInput(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const base = { empty: !raw, url: null, prefix: null, digits: '', badChars: false, dash: false };
  if (!raw) return base;
  if (URLISH_RE.test(raw)) {
    const q = parseQrPayload(raw);
    return { ...base, url: q.kind === 'official' ? { ok: true, grader: q.grader, number: q.number } : { ok: false } };
  }
  if (raw.length > MAX_INPUT) return { ...base, badChars: true };
  let rest = raw;
  let prefix = null;
  for (const [re, g] of PREFIXES) {
    if (re.test(rest)) { prefix = g; rest = rest.replace(re, ''); break; }
  }
  rest = rest.replace(FILLER_RE, ' ');
  const dash = /^\s*\d{7}\s*-\s*\d{3}\s*$/.test(rest);
  const stripped = rest.replace(/[\s\-./]/g, '');
  const badChars = /\D/.test(stripped);
  return { ...base, prefix, digits: badChars ? '' : stripped, badChars, dash };
}

/** Text without a typed grader prefix (spec M-07: a conflicting radio click removes the prefix). */
export function stripPrefix(text) {
  const raw = typeof text === 'string' ? text.trimStart() : '';
  for (const [re] of PREFIXES) if (re.test(raw)) return raw.replace(re, '');
  return raw;
}

/** Inference from the number alone: unique grader for the length (7-9 -> PSA, 13 -> CGC Cards); dash form -> CGC Comics. */
function inferFrom(digits, dash, family, rules) {
  if (!digits) return null;
  if (dash && (!family || family.includes(rules.DASH_FORM.grader))) return rules.DASH_FORM.grader;
  const fit = (family ?? rules.GRADER_IDS).filter((g) => rules.GRADERS[g].lengths.includes(digits.length));
  return fit.length === 1 ? fit[0] : null;
}

/**
 * Grader for a field: typed prefix > explicit radio > inference.
 * @returns {{grader:string|null, from:'prefix'|'explicit'|'inferred'|null, cgcBoth:boolean}}
 */
export function resolveGrader(analysis, explicit = null, rules = DEFAULT_RULES) {
  if (analysis.url?.ok) return { grader: analysis.url.grader, from: 'prefix', cgcBoth: false };
  const p = analysis.prefix;
  if (p && p !== 'cgc') return { grader: p, from: 'prefix', cgcBoth: false };
  const family = p === 'cgc' ? ['cgc-comics', 'cgc-cards'] : null;
  if (explicit && (!family || family.includes(explicit))) return { grader: explicit, from: 'explicit', cgcBoth: false };
  const inferred = inferFrom(analysis.digits, analysis.dash, family, rules);
  if (inferred) return { grader: inferred, from: 'inferred', cgcBoth: false };
  const cgcBoth = (p === 'cgc' && Boolean(analysis.digits))
    || (analysis.digits.length > 0 && ['cgc-comics', 'cgc-cards'].every((g) => rules.GRADERS[g].lengths.includes(analysis.digits.length)));
  return { grader: null, from: null, cgcBoth };
}

/**
 * Submit-time validation (order: empty -> characters -> length -> grader -> grader length).
 * The grader/length mismatch (`warn_length`) blocks here because only valid lengths build a URL (ADR §8).
 * @returns {{ok:true, grader:string, number:string} | {ok:false, error:string, subs:string[], focus:'input'|'grader'}}
 */
export function validateCert(text, explicit = null, rules = DEFAULT_RULES) {
  const fail = (error, subs = [], focus = 'input') => ({ ok: false, error, subs, focus });
  const a = analyzeCertInput(text);
  if (a.empty) return fail('err_empty');
  if (a.url) return a.url.ok ? { ok: true, grader: a.url.grader, number: a.url.number } : fail('err_link');
  if (a.badChars) return fail('err_chars');
  if (a.digits.length < MIN_DIGITS || a.digits.length > MAX_DIGITS) return fail('err_length', [String(MIN_DIGITS), String(MAX_DIGITS), String(a.digits.length)]);
  const { grader } = resolveGrader(a, explicit, rules);
  if (!grader) return fail('err_grader', [], 'grader');
  if (!isValidCert(grader, a.digits)) return fail('warn_length', [GRADER_NAME[grader]]);
  return { ok: true, grader, number: a.digits };
}

/** Grader display names are never translated (spec §6 rules). */
export const GRADER_NAME = Object.freeze({ psa: 'PSA', 'cgc-comics': 'CGC Comics', 'cgc-cards': 'CGC Cards' });

// ---------------------------------------------------------------- scanning steps (S1)

/**
 * Step states from the ordered list of pipeline stages seen so far.
 * @param {string[]} stages ScanProgress.stage values in arrival order
 */
export function stepStates(stages) {
  const seen = new Set(stages);
  const ocr = seen.has('ocr-init') || seen.has('ocr');
  const s = { load: 'active', barcode: 'waiting', text: 'waiting', match: 'waiting', textStarting: false };
  if (seen.has('barcode') || ocr || seen.has('parse')) { s.load = 'done'; s.barcode = 'active'; }
  if (ocr) { s.barcode = 'done'; s.text = 'active'; s.textStarting = seen.has('ocr-init') && !seen.has('ocr'); }
  if (seen.has('parse')) { s.barcode = 'done'; s.text = ocr ? 'done' : 'skipped'; s.match = 'active'; s.textStarting = false; }
  return s;
}

// ---------------------------------------------------------------- low-resolution offer (N1)

/** Host to offer "Sharper scans" for, or null (S3/S4 only, https screen captures, not granted/declined). */
export function sharperOfferHost(result, declinedHosts) {
  if (!result || !(result.status === 'confirm' || result.status === 'none')) return null;
  const info = result.imageInfo;
  if (!info || info.resolution !== 'screen' || !info.canRequestSharper || typeof info.origin !== 'string') return null;
  let host = null;
  try {
    const u = new URL(info.origin);
    if (u.protocol === 'https:') host = u.hostname;
  } catch { host = null; }
  if (!host || declinedHosts?.has(host)) return null;
  return host;
}

// ---------------------------------------------------------------- recent (relative time)

export function relativeTime(at, now, locale) {
  const diff = Math.round((at - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 45 * 60) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 26 * 86400) return rtf.format(Math.round(diff / 86400), 'day');
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(at));
}

// ---------------------------------------------------------------- auto-open de-dup (SEC-06)

/** At most one auto-open per job (context menu or A9 page job; re-runs reuse the job); per scan for blobs. */
export function autoOpenKey(input, scanId) {
  return (input?.kind === 'job' || input?.kind === 'page') && input.job?.id ? `job:${input.job.id}` : `scan:${scanId}`;
}
