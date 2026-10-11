// Pure URL builders, QR payload parsing and restricted-page detection (ADR-001 §5, §8).
// No chrome, no DOM. Decoded URLs are never navigated: only buildCertUrl() output is opened.
import { GRADERS } from './certRules.js';

export const CERT_URL = Object.freeze({
  psa: (n) => `https://www.psacard.com/cert/${n}`,
  'cgc-comics': (n) => `https://www.cgccomics.com/certlookup/${n}/`,
  'cgc-cards': (n) => `https://www.cgccards.com/certlookup/${n}/`,
  // Beckett has no documented link per serial number: its lookup form opens and the panel copies the number.
  bgs: () => 'https://www.beckett.com/grading/card-lookup',
});

/** Graders whose official page shows the cert directly; the others open a lookup form (never auto-opened). */
export const hasDirectUrl = (grader) => grader !== 'bgs';

export const QR_HOSTS = new Map([
  ['psacard.com', 'psa'], ['www.psacard.com', 'psa'],
  ['cgccomics.com', 'cgc-comics'], ['www.cgccomics.com', 'cgc-comics'],
  ['cgccards.com', 'cgc-cards'], ['www.cgccards.com', 'cgc-cards'],
  ['cgccards.uk', 'cgc-cards'], ['www.cgccards.uk', 'cgc-cards'],
  ['beckett.com', 'bgs'], ['www.beckett.com', 'bgs'],
]);

export const QR_PATHS = Object.freeze({
  psa: /^\/cert\/(\d{7,10})(?:\/|$)/i,
  'cgc-comics': /^\/certlookup\/(\d{10})(?:\/|$)/i,
  'cgc-cards': /^\/certlookup\/(\d{10}|\d{13})(?:\/|$)/i,
  // Path of the QR on 2026 BGS labels is not documented; a single 10-digit run elsewhere in the URL is used instead.
  bgs: /^\/grading\/card-lookup\/(\d{10})(?:\/|$)/i,
});

const MAX_QR_CHARS = 4096;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** True when `number` is a digit string of a valid length for `grader`. */
export function isValidCert(grader, number) {
  return typeof grader === 'string' && hasOwn(GRADERS, grader) && typeof number === 'string'
    && /^\d+$/.test(number) && GRADERS[grader].lengths.includes(number.length);
}

/**
 * Official verification URL for a grader + number.
 * @throws {RangeError} unless /^\d+$/ and the length is valid for the grader
 */
export function buildCertUrl(grader, number) {
  if (!isValidCert(grader, number)) throw new RangeError('invalid grader or cert number');
  return CERT_URL[grader](number);
}

function tryParseUrl(text) {
  try { return new URL(text); } catch { return null; }
}

/** Host-like start without a scheme, e.g. "www.cgccomics.com/certlookup/…". */
const SCHEMELESS_HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * @param {unknown} text decoded QR/barcode text (attacker-controlled)
 * @returns {{kind:'official', grader:import('./types.js').Grader, number:string, host:string, pathMatched:boolean}
 *   | {kind:'untrusted-url', host:string, digits:string[]} | {kind:'not-url'}}
 */
export function parseQrPayload(text) {
  if (typeof text !== 'string') return { kind: 'not-url' };
  const raw = text.trim();
  if (!raw || raw.length > MAX_QR_CHARS || /\s/.test(raw)) return { kind: 'not-url' };
  let url = null;
  if (SCHEME_RE.test(raw) && !/^\d/.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return { kind: 'not-url' };
    url = tryParseUrl(raw);
  } else if (SCHEMELESS_HOST_RE.test(raw)) {
    url = tryParseUrl(`https://${raw}`);
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return { kind: 'not-url' };

  const host = url.hostname.toLowerCase();
  const rest = `${url.pathname}${url.search}`;
  const allDigits = rest.match(/\d+/g) ?? [];
  const grader = QR_HOSTS.get(host);
  const clean = url.username === '' && url.password === '' && url.port === '';
  if (grader && clean) {
    const m = QR_PATHS[grader].exec(url.pathname);
    if (m) return { kind: 'official', grader, number: m[1], host, pathMatched: true };
    const valid = [...new Set(allDigits.filter((d) => GRADERS[grader].lengths.includes(d.length)))];
    if (valid.length === 1) return { kind: 'official', grader, number: valid[0], host, pathMatched: false };
  }
  const digits = [...new Set(allDigits.filter((d) => d.length >= 7 && d.length <= 13))].slice(0, 8);
  return { kind: 'untrusted-url', host, digits };
}

const RESTRICTED_SCHEMES = new Set(['chrome:', 'chrome-extension:', 'chrome-untrusted:', 'devtools:', 'edge:', 'about:', 'view-source:', 'file:']);

/** Pages where Chrome does not allow extensions to read content (ADR §5 strategy 0). */
export function isRestrictedPage(pageUrl) {
  if (typeof pageUrl !== 'string' || !pageUrl) return true;
  const url = tryParseUrl(pageUrl);
  if (!url) return true;
  if (RESTRICTED_SCHEMES.has(url.protocol)) return true;
  const host = url.hostname.toLowerCase();
  if (host === 'chromewebstore.google.com') return true;
  if (host === 'chrome.google.com' && /^\/webstore(\/|$)/i.test(url.pathname)) return true;
  return false;
}
