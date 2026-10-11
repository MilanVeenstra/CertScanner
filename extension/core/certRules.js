// Shared contract (ADR-001 §7). Changes need an ADR amendment.
// Pure data: no chrome, no DOM. Imported by the parser, routing, URL builders and unit tests.

export const RULES_VERSION = 2; // v2: Beckett (BGS) added

/** Valid cert-number lengths per grader. */
export const GRADERS = Object.freeze({
  psa: Object.freeze({ lengths: Object.freeze([7, 8, 9, 10]) }),
  'cgc-comics': Object.freeze({ lengths: Object.freeze([10]) }),
  'cgc-cards': Object.freeze({ lengths: Object.freeze([10, 13]) }),
  // Beckett serial numbers: 10 digits, often with leading zeros ("0012345678").
  bgs: Object.freeze({ lengths: Object.freeze([10]) }),
});

/** Ranking for ties when the keyword scores cannot separate graders (D4). */
export const TIE_ORDER = Object.freeze({
  default: Object.freeze(['psa', 'cgc-comics', 'cgc-cards', 'bgs']),
  10: Object.freeze(['cgc-comics', 'cgc-cards', 'psa', 'bgs']),
});

/**
 * [term, weight]; whole-word match on normalized UPPERCASE text; each term counted once;
 * per-grader sum capped at 1.
 */
export const KEYWORDS = Object.freeze({
  psa: [['PSA', 0.6], ['PSA/DNA', 0.6], ['GEM MT', 0.5], ['NM-MT', 0.5], ['EX-MT', 0.4], ['VG-EX', 0.4]],
  'cgc-comics': [
    ['CGC', 0.4], ['CERTIFIED GUARANTY', 0.5], ['UNIVERSAL GRADE', 0.7], ['SIGNATURE SERIES', 0.6],
    ['WHITE PAGES', 0.6], ['OFF-WHITE', 0.5], ['QUALIFIED', 0.4], ['RESTORED', 0.4], ['CONSERVED', 0.4],
    [/\b9\.[2468]\b/, 0.4],
  ],
  'cgc-cards': [['CGC', 0.4], ['CERTIFIED GUARANTY', 0.5], ['GEM MINT', 0.5], ['PRISTINE', 0.6], ['NM/MINT', 0.5], ['MINT+', 0.3]],
  // BGS labels print the brand and four subgrades.
  bgs: [['BECKETT', 0.7], ['BGS', 0.7], ['BVG', 0.6], ['BLACK LABEL', 0.4], ['CENTERING', 0.4], ['CORNERS', 0.3], ['EDGES', 0.3], ['SURFACE', 0.3]],
});

/** "4012345-001" style cert numbers, joined to 10 digits. */
export const DASH_FORM = Object.freeze({ re: /(?<!\d)(\d{7})-(\d{3})(?!\d)/, grader: 'cgc-comics', weight: 0.4 });

/** Character fix-ups, only applied in tokens of >= 6 chars with >= 75% digits. */
export const OCR_FIXUPS = Object.freeze({ O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' });

export const CERT_LABEL_RE = /\b(CERT(IFICATION)?|#)\b/;

export const SCORE = Object.freeze({
  base: { 'qr-url': 0.95, 'qr-url-unmatched-path': 0.85, barcode: 0.80, ocr: { min: 0.40, span: 0.30, confLo: 50, confHi: 90 } },
  bonus: { secondRead: 0.15, certLabel: 0.05, lengthUnique: 0.05, keywordResolved: 0.10 },
  penalty: { ocrFixup: 0.15, keywordConflict: 0.15, graderUnresolved: 0.20, noSlabVocabulary: 0.20, competitor: 0.10 },
  resolve: { minKeyword: 0.4, minMargin: 0.3, slabVocabularyMin: 0.3, conflictKeyword: 0.6 },
  thresholds: { autoOpen: 0.80, show: 0.30, competitor: 0.50, maxCandidates: 5, untrustedQrCap: 0.50 },
});

/** All graders in canonical order. */
export const GRADER_IDS = Object.freeze(['psa', 'cgc-comics', 'cgc-cards', 'bgs']);

/** Union of every valid length, sorted. */
export const ALL_LENGTHS = Object.freeze([...new Set(GRADER_IDS.flatMap((g) => GRADERS[g].lengths))].sort((a, b) => a - b));

export const DEFAULT_RULES = Object.freeze({
  RULES_VERSION, GRADERS, TIE_ORDER, KEYWORDS, DASH_FORM, OCR_FIXUPS, CERT_LABEL_RE, SCORE, GRADER_IDS, ALL_LENGTHS,
});
