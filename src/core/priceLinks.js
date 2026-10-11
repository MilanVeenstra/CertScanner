// Price & listing links (user request 2026-10-11: "prijsgeschiedenis en eBay listings"). Pure functions only.
// CertScanner never fetches prices itself: these build search links that open in a new tab when the user clicks.
// The query is the only thing that reaches the other site, and only on that click.

/** eBay sites the user can pick in Settings (key -> host). */
export const EBAY_SITES = Object.freeze({
  com: 'www.ebay.com',
  'co.uk': 'www.ebay.co.uk',
  de: 'www.ebay.de',
  nl: 'www.ebay.nl',
  fr: 'www.ebay.fr',
  ca: 'www.ebay.ca',
  'com.au': 'www.ebay.com.au',
});
export const DEFAULT_EBAY_SITE = 'com';
/** 130point has no documented search link: the panel copies the query and opens its sales page. */
export const POINT130_URL = 'https://130point.com/sales/';
export const PRICE_HOSTS = Object.freeze(new Set([...Object.values(EBAY_SITES), '130point.com']));

const GRADER_SHORT = Object.freeze({ psa: 'PSA', 'cgc-comics': 'CGC', 'cgc-cards': 'CGC' });
const MAX_QUERY = 120;
const MAX_WORDS = 12;

export const isEbaySite = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(EBAY_SITES, s);

/** "PSA 01234567": finds listings and past sales of this exact slab (sellers usually put the cert in the title). */
export function slabQuery(grader, number) {
  if (!GRADER_SHORT[grader] || typeof number !== 'string' || !/^\d{7,13}$/.test(number)) return null;
  return `${GRADER_SHORT[grader]} ${number}`;
}

// Label words that describe the slab, not the card; a line made only of these is skipped ("WHITE PAGES", "UNIVERSAL GRADE").
const SLAB_WORDS = new Set(['UNIVERSAL', 'GRADE', 'CERTIFICATION', 'CERT', '#', 'CERTIFIED', 'GUARANTY', 'COMPANY', 'PSA', 'CGC',
  'PSA/DNA', 'AUTHENTIC', 'WHITE', 'PAGES', 'OFF-WHITE', 'CREAM', 'TO', 'SIGNATURE', 'SERIES', 'QUALIFIED', 'RESTORED', 'CONSERVED']);
const isBoilerplate = (line) => line.split(' ').every((w) => SLAB_WORDS.has(w.toUpperCase()));
// Characters a label line normally has; several others ("$$", "——") mean OCR read a barcode or artwork as text.
const JUNK = /[^\p{L}\p{N}#&'\-./:+, ]/gu;
const PSA_GRADE = /\b(GEM MT|GEM MINT|MINT|NM-MT\+?|NM\+?|EX-MT\+?|EX\+?|VG-EX\+?|VG\+?|GOOD\+?|FR|FAIR|PR|POOR)\s*(10|[1-9](?:\.5)?)\b/i;
const CGC_GRADE = /(?<![\d.])(10(?:\.0)?|[0-9]\.[0-9])(?![\d.])/;

/** Grade printed on the label ("10", "9.8") or null. */
export function gradeFromLines(grader, lines) {
  for (const raw of lines) {
    const line = String(raw);
    if (grader === 'psa') {
      const m = PSA_GRADE.exec(line);
      if (m) return m[2];
    } else if (GRADER_SHORT[grader]) {
      const m = CGC_GRADE.exec(line);
      if (m && Number(m[1]) <= 10) return m[1];
    }
  }
  return null;
}

/**
 * Card description from the label text read by OCR, e.g. "2023 POKEMON SV 151 CHARIZARD ex #199 PSA 10".
 * Returns null when the label gives too little to search for (then the slab query is used).
 * @param {{grader:string, number:string, lines:unknown}} p
 */
export function cardQuery({ grader, number, lines }) {
  if (!GRADER_SHORT[grader] || !Array.isArray(lines)) return null;
  const clean = lines
    .filter((l) => typeof l === 'string')
    .slice(0, 24)
    .filter((l) => (l.match(JUNK) ?? []).length < 2)
    .map((l) => l.replace(/[^\p{L}\p{N}#&'\-./:+ ]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const grade = gradeFromLines(grader, clean);
  const words = [];
  for (const line of clean) {
    if (typeof number === 'string' && number && line.replace(/\D/g, '').includes(number)) continue; // the cert line
    if (/\d{7,}/.test(line.replace(/[\s-]/g, ''))) continue; // other long numbers (barcodes, item ids)
    if (isBoilerplate(line)) continue;
    if (PSA_GRADE.test(line) && line.split(' ').length <= 3) continue; // "GEM MT 10" on its own line
    if (grader !== 'psa' && CGC_GRADE.test(line) && line.split(' ').length <= 2) continue; // "9.8" / "CGC 9.8"
    const cardNo = /^#\s?\d{1,4}[A-Za-z]?$/.test(line); // "#199": the card number is worth keeping
    if (!cardNo && (line.match(/\p{L}/gu) ?? []).length < 2) continue; // OCR noise
    for (const w of line.split(' ')) {
      if (w.length < 2 && !/^[\p{N}#]$/u.test(w)) continue;
      if (/^(PSA|CGC)$/i.test(w)) continue;
      if (/\p{L}\d+\p{L}/u.test(w) && !/^\p{Lu}{1,3}\d+$/u.test(w)) continue; // OCR noise like "T1TT"
      words.push(w);
      if (words.length >= MAX_WORDS) break;
    }
    if (words.length >= MAX_WORDS) break;
  }
  if (words.filter((w) => /\p{L}{3,}/u.test(w)).length < 2) return null;
  const q = [...words, GRADER_SHORT[grader], grade].filter(Boolean).join(' ');
  return q.slice(0, MAX_QUERY).trim();
}

const normQuery = (q) => (typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '');

/** eBay search; sold=true shows sold and completed listings (eBay may ask the user to sign in for those). */
export function ebaySearchUrl(site, query, { sold = false } = {}) {
  const q = normQuery(query);
  if (!q) throw new RangeError('empty query');
  const host = EBAY_SITES[isEbaySite(site) ? site : DEFAULT_EBAY_SITE];
  const params = new URLSearchParams({ _nkw: q });
  if (sold) { params.set('LH_Sold', '1'); params.set('LH_Complete', '1'); }
  return `https://${host}/sch/i.html?${params.toString()}`;
}

/** True only for URLs this module builds (allow-listed host, https, no credentials or port). */
export function isPriceUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && PRICE_HOSTS.has(u.hostname)
      && (u.hostname === '130point.com' ? u.href === POINT130_URL : u.pathname === '/sch/i.html');
  } catch { return false; }
}

/** Host shown in the panel ("Opens ebay.com in a new tab"). */
export const ebayHostLabel = (site) => EBAY_SITES[isEbaySite(site) ? site : DEFAULT_EBAY_SITE].replace(/^www\./, '');
