// Price & listing links (user request 2026-10-11: "prijsgeschiedenis en eBay listings"). Pure functions only.
// These build search links that open in a new tab on a click, and the card search terms the panel uses to read
// prices (src/sidepanel/priceData.js). The query is the only thing that reaches the other site.
import { isPcUrl } from './pricecharting.js';

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
/**
 * Population reports (how many copies exist per grade). None has a documented search link, so the panel copies the
 * card name and opens the report. Beckett's report has no stable public address and is left out.
 */
export const POP_URLS = Object.freeze({
  psa: 'https://www.psacard.com/pop',
  'cgc-comics': 'https://www.cgccomics.com/population-report/',
  'cgc-cards': 'https://www.cgccards.com/population-report/',
});
const POP_HREFS = new Set(Object.values(POP_URLS));
const EBAY_HOSTS = new Set(Object.values(EBAY_SITES));

const GRADER_SHORT = Object.freeze({ psa: 'PSA', 'cgc-comics': 'CGC', 'cgc-cards': 'CGC', bgs: 'BGS' });
const MAX_QUERY = 120;
const MAX_WORDS = 12;
const MAX_DESC = 100;

const halves = (from) => Array.from({ length: from * 2 - 1 }, (_, i) => String(from - i / 2));
/** Grades each grader prints on its labels, best first (the panel's grade list). */
export const GRADE_SCALES = Object.freeze({
  psa: Object.freeze(halves(10).filter((g) => g !== '9.5')),
  'cgc-cards': Object.freeze(halves(10)),
  bgs: Object.freeze(halves(10)),
  'cgc-comics': Object.freeze(['10', '9.9', '9.8', '9.6', '9.4', '9.2', '9.0', '8.5', '8.0', '7.5', '7.0', '6.5', '6.0', '5.5', '5.0',
    '4.5', '4.0', '3.5', '3.0', '2.5', '2.0', '1.8', '1.5', '1.0', '0.5']),
});

/** The scale entry equal to a read grade ("9" -> "9.0" for comics), or null. */
export function matchGrade(grader, grade) {
  const scale = GRADE_SCALES[grader];
  if (!scale || grade == null || grade === '') return null;
  const n = Number(grade);
  return scale.find((g) => Number(g) === n) ?? null;
}

/** "PSA" / "CGC" / "BGS". */
export const graderShort = (grader) => GRADER_SHORT[grader] ?? '';

/** Short grader + grade as sellers write it: "PSA 10", "CGC 9.8". */
export const gradeLabel = (grader, grade) => (GRADER_SHORT[grader] ? `${GRADER_SHORT[grader]} ${grade}` : String(grade));

export const isEbaySite = (s) => typeof s === 'string' && Object.prototype.hasOwnProperty.call(EBAY_SITES, s);

/** "PSA 01234567": finds listings and past sales of this exact slab (sellers usually put the cert in the title). */
export function slabQuery(grader, number) {
  if (!GRADER_SHORT[grader] || typeof number !== 'string' || !/^\d{7,13}$/.test(number)) return null;
  return `${GRADER_SHORT[grader]} ${number}`;
}

// Label words that describe the slab, not the card; a line made only of these is skipped ("WHITE PAGES", "UNIVERSAL GRADE").
const SLAB_WORDS = new Set(['UNIVERSAL', 'GRADE', 'CERTIFICATION', 'CERT', '#', 'CERTIFIED', 'GUARANTY', 'COMPANY', 'PSA', 'CGC',
  'PSA/DNA', 'AUTHENTIC', 'WHITE', 'PAGES', 'OFF-WHITE', 'CREAM', 'TO', 'SIGNATURE', 'SERIES', 'QUALIFIED', 'RESTORED', 'CONSERVED',
  'BECKETT', 'GRADING', 'SERVICES', 'BGS', 'BVG', 'BLACK', 'LABEL',
  // grade words printed apart from the number ("GEM MINT" / "10" on two lines)
  'GEM', 'MINT', 'MT', 'PRISTINE', 'NM-MT', 'NM/MINT', 'NEAR', 'EX-MT', 'EX/NM', 'EXCELLENT', 'VG-EX', 'VG/EX', 'VERY', 'GOOD', 'FAIR', 'POOR']);
const isBoilerplate = (line) => line.split(' ').every((w) => SLAB_WORDS.has(w.toUpperCase()));
// Characters a label line normally has; several others ("$$", "——") mean OCR read a barcode or artwork as text.
const JUNK = /[^\p{L}\p{N}#&'\-./:+, ]/gu;
const PSA_GRADE = /\b(GEM MT|GEM MINT|MINT|NM-MT\+?|NM\+?|EX-MT\+?|EX\+?|VG-EX\+?|VG\+?|GOOD\+?|FR|FAIR|PR|POOR)\s*(10|[1-9](?:\.5)?)\b/i;
const CGC_CARD_GRADE = /\b(PRISTINE|GEM MINT|MINT\+?|NM\/MINT\+?|NEAR MINT\+?|EX\/NM\+?|EXCELLENT\+?|VG\/EX\+?|VERY GOOD\+?|GOOD\+?|FAIR|POOR)\s*(10|[1-9](?:\.5)?)\b/i;
const CGC_GRADE = /(?<![\d.])(10(?:\.0)?|[0-9]\.[0-9])(?![\d.])/;
// "CENTERING 9.5": a BGS subgrade pair. OCR often puts it on the same line as the card name or the overall grade,
// so the pair is cut out of the line instead of dropping the whole line.
const SUBGRADE_PAIR = /\b(CENTERING|CORNERS|EDGES|SURFACE)\b\s*:?\s*(10(?:\.0)?|\d(?:\.5)?)?/gi;
const withoutSubgrades = (line) => String(line).replace(SUBGRADE_PAIR, ' ').replace(/\s+/g, ' ').trim();

/** Grade printed on the label ("10", "9.8") or null. */
export function gradeFromLines(grader, lines) {
  for (const raw of lines) {
    const line = withoutSubgrades(raw); // BGS "CENTERING 9.5 CORNERS 10 ...": not the overall grade
    if (!line) continue;
    if (grader === 'psa' || grader === 'cgc-cards' || grader === 'bgs') {
      const m = grader === 'psa' ? PSA_GRADE.exec(line)
        : CGC_CARD_GRADE.exec(line) ?? (grader === 'bgs' ? PSA_GRADE.exec(line) : null); // BGS also prints "NM-MT+ 8.5"
      if (m) return m[2];
    }
    if (grader !== 'psa' && GRADER_SHORT[grader]) {
      const m = CGC_GRADE.exec(line);
      if (m && Number(m[1]) <= 10) return m[1];
    }
  }
  return null;
}

const YEAR_START = /^(?:19|20)\d{2}\b\s*/;
const CARD_NO = /#\s?(\d{1,4}[A-Za-z]?)\b/;
const PUBLISHER_LINE = /\bCOMICS?\b|\b(?:1[0-2]|0?[1-9])\/\d{2}(?!\d)/i; // "Marvel Comics, 5/88"
const VARIETY = /\b(1ST EDITION|SHADOWLESS)\b/i; // changes the price a lot, so it stays in the search
// Rarity wording that sellers abbreviate ("SIR"); with a card number it only narrows the search too much.
const RARITY = new Set(['RARE', 'SPECIAL', 'ILLUSTRATION', 'ULTRA', 'SECRET', 'HYPER', 'DOUBLE']);
const MAX_NAME_WORDS = 6;

const okWord = (w) => !(w.length < 2 && !/^\p{N}$/u.test(w))
  && !/^(PSA|CGC|GC|CG|BGS|BECKETT)$/i.test(w) // brand (also OCR fragments of the CGC logo)
  && !(/\p{L}\d+\p{L}/u.test(w) && !/^\p{Lu}{1,3}\d+$/u.test(w)); // OCR noise like "T1TT"

/**
 * Search terms for THIS card from the label text read by OCR: brand + name + card number (+ 1st Edition / Shadowless),
 * e.g. "POKEMON CHARIZARD ex 199", "FLEER MICHAEL JORDAN 57", "Amazing Spider-Man 300", and the grade ("10", "9.8").
 * Year, set codes and rarity words are left out because listing titles often omit them; without a card number the
 * set name is kept instead. desc is null when the label gives too little to search for.
 * @param {{grader:string, number:string, lines:unknown}} p
 * @returns {{desc:string|null, grade:string|null}}
 */
export function cardInfo({ grader, number, lines }) {
  if (!GRADER_SHORT[grader] || !Array.isArray(lines)) return { desc: null, grade: null };
  const clean = lines
    .filter((l) => typeof l === 'string')
    .slice(0, 24)
    .filter((l) => (l.match(JUNK) ?? []).length < 2)
    .map((l) => withoutSubgrades(l.replace(/[^\p{L}\p{N}#&'\-./:+ ]/gu, ' ')))
    .filter(Boolean);
  const grade = gradeFromLines(grader, clean);
  let brand = null;
  let cardNo = null;
  const setWords = [];
  const variety = [];
  const name = [];
  for (const line of clean) {
    if (typeof number === 'string' && number && line.replace(/\D/g, '').includes(number)) continue; // the cert line
    if (/\d{7,}/.test(line.replace(/[\s-]/g, ''))) continue; // other long numbers (barcodes, item ids)
    if (isBoilerplate(line)) continue;
    if ((PSA_GRADE.test(line) || CGC_CARD_GRADE.test(line)) && line.split(' ').length <= 3) continue; // "GEM MT 10"
    if (grader !== 'psa' && CGC_GRADE.test(line) && line.split(' ').length <= 2) continue; // "9.8" / "CGC 9.8"
    const no = CARD_NO.exec(line);
    if (no && !cardNo) cardNo = no[1];
    const v = VARIETY.exec(line);
    if (v && !variety.includes(v[1].toUpperCase())) variety.push(v[1].toUpperCase());
    const rest = line.replace(CARD_NO, ' ').replace(VARIETY, ' ').replace(/\s+/g, ' ').trim();
    if (YEAR_START.test(rest)) { // set line: "2023 POKEMON SV 151" -> brand "POKEMON"
      const words = rest.replace(YEAR_START, '').split(' ').filter((w) => okWord(w) && !SLAB_WORDS.has(w.toUpperCase()));
      const first = words.find((w) => /^\p{L}{3,}$/u.test(w));
      if (first && !brand) brand = first;
      for (const w of words) if (w !== first && !/^\p{Lu}{1,2}$/u.test(w)) setWords.push(w); // "SV" set codes dropped
      continue;
    }
    if (PUBLISHER_LINE.test(rest)) continue;
    if ((rest.match(/\p{L}/gu) ?? []).length < 2) continue; // OCR noise
    for (const w of rest.split(' ')) {
      if (name.length >= MAX_NAME_WORDS) break;
      if (okWord(w) && !SLAB_WORDS.has(w.toUpperCase())) name.push(w);
    }
  }
  const named = name.filter((w) => /\p{L}{3,}/u.test(w));
  if (!named.length || (named.length + (brand ? 1 : 0) < 2 && !cardNo)) return { desc: null, grade: matchGrade(grader, grade) };
  const words = cardNo
    ? [brand, ...name.filter((w) => !RARITY.has(w.toUpperCase())), cardNo, ...variety]
    : [brand, ...setWords, ...name, ...variety];
  const desc = words.filter(Boolean).join(' ').slice(0, MAX_DESC).trim();
  return { desc, grade: matchGrade(grader, grade) };
}

/** Card + grade as one search, e.g. "2023 POKEMON SV 151 CHARIZARD ex #199 PSA 10" (null without a card description). */
export function cardQuery(p) {
  const { desc, grade } = cardInfo(p);
  return desc ? gradeQuery(p.grader, desc, grade) : null;
}

/** "<card> PSA 10"; without a grade "<card> PSA" (all grades). Null when the card is empty. */
export function gradeQuery(grader, desc, grade) {
  const d = normQuery(desc).slice(0, MAX_DESC).trim();
  if (!d || !GRADER_SHORT[grader]) return null;
  return [d, GRADER_SHORT[grader], matchGrade(grader, grade)].filter(Boolean).join(' ');
}

const normQuery = (q) => (typeof q === 'string' ? q.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '');

/** Leaves out lots and proxies so a card search lists single copies of this card only. */
const CARD_EXCLUDE = ' -lot -proxy';

/**
 * eBay search; sold=true shows sold and completed listings (eBay may ask the user to sign in for those).
 * single=true adds CARD_EXCLUDE (card searches; not needed for a cert-number search).
 */
export function ebaySearchUrl(site, query, { sold = false, single = false } = {}) {
  const base = normQuery(query);
  if (!base) throw new RangeError('empty query');
  const q = single ? `${base}${CARD_EXCLUDE}` : base;
  const host = EBAY_SITES[isEbaySite(site) ? site : DEFAULT_EBAY_SITE];
  const params = new URLSearchParams({ _nkw: q });
  if (sold) { params.set('LH_Sold', '1'); params.set('LH_Complete', '1'); }
  return `https://${host}/sch/i.html?${params.toString()}`;
}

/** Card number in search terms ("POKEMON CHARIZARD ex 199" -> "199"), else null. */
export function cardNoFrom(desc) {
  const words = String(desc ?? '').trim().split(/\s+/);
  for (let i = words.length - 1; i >= 0; i--) if (/^#?\d{1,4}[A-Za-z]?$/.test(words[i])) return words[i].replace('#', '');
  return null;
}

/**
 * True only for the links the panel opens (https, no credentials or port): PriceCharting's search, the population
 * reports and eBay searches.
 */
export function isPriceUrl(url) {
  if (isPcUrl(url)) return true; // PriceCharting product/search page shown in the panel
  if (POP_HREFS.has(url)) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || !EBAY_HOSTS.has(u.hostname)) return false;
    return u.pathname === '/sch/i.html';
  } catch { return false; }
}

/** Host shown in the panel ("Opens ebay.com in a new tab"). */
export const ebayHostLabel = (site) => EBAY_SITES[isEbaySite(site) ? site : DEFAULT_EBAY_SITE].replace(/^www\./, '');
