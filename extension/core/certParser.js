// Pure candidate extraction and scoring (ADR-001 §7). No chrome, no DOM.
// Input text (OCR, barcodes, QR) is attacker-craftable: only digit strings leave this module.
import { DEFAULT_RULES } from './certRules.js';
import { parseQrPayload } from './certUrls.js';

const MAX_TEXT_CHARS = 20_000;
const MAX_WORDS = 2_000;
const MAX_BARCODES = 16;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round2 = (x) => Math.round(x * 100 + 1e-6) / 100;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const termCache = new WeakMap();
function termRegex(rules, term) {
  let byRules = termCache.get(rules);
  if (!byRules) { byRules = new Map(); termCache.set(rules, byRules); }
  let re = byRules.get(term);
  if (!re) {
    re = term instanceof RegExp ? term : new RegExp(`(?<![A-Z0-9])${escapeRe(term).replace(/ /g, ' +')}(?![A-Z0-9])`);
    byRules.set(term, re);
  }
  return re;
}

/** Uppercase, collapse whitespace (keeps line structure out of the way of multi-word terms). */
export function normalizeText(text) {
  return str(text).slice(0, MAX_TEXT_CHARS).toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Keyword score per grader on (already OCR'd) text.
 * @returns {Record<string, {score:number, terms:string[]}>}
 */
export function keywordScores(text, rules = DEFAULT_RULES, extra = {}) {
  const t = normalizeText(text);
  const out = {};
  for (const g of rules.GRADER_IDS) {
    let score = 0;
    const terms = [];
    for (const [term, weight] of rules.KEYWORDS[g] ?? []) {
      if (termRegex(rules, term).test(t)) {
        score += weight;
        terms.push(term instanceof RegExp ? (t.match(term)?.[0] ?? 'grade') : term);
      }
    }
    if (extra[g]) { score += extra[g].weight; terms.push(extra[g].term); }
    out[g] = { score: round2(Math.min(1, score)), terms };
  }
  return out;
}

/** Apply OCR_FIXUPS to a token of >= 6 chars with >= 75% digits. */
export function fixToken(token, rules = DEFAULT_RULES) {
  if (token.length < 6) return { text: token, fixed: false };
  const digits = (token.match(/\d/g) ?? []).length;
  if (digits / token.length < 0.75) return { text: token, fixed: false };
  let fixed = false;
  let out = '';
  for (const ch of token) {
    const rep = Object.prototype.hasOwnProperty.call(rules.OCR_FIXUPS, ch) ? rules.OCR_FIXUPS[ch] : null;
    if (rep !== null) { out += rep; fixed = true; } else out += ch;
  }
  return { text: out, fixed };
}

/** Group an OcrPage's words into lines: [{text, words:[{text, confidence, fixed, start, end}]}]. */
function pageLines(page, rules) {
  const words = Array.isArray(page.words) ? page.words.slice(0, MAX_WORDS) : [];
  const lines = new Map();
  let fallbackId = 0;
  for (const w of words) {
    if (!isObj(w)) continue;
    const text = str(w.text).trim();
    if (!text) continue;
    const key = Number.isInteger(w.lineId) ? `id:${w.lineId}` : (typeof w.lineText === 'string' ? `t:${w.lineText}` : `n:${fallbackId++}`);
    if (!lines.has(key)) lines.set(key, { raw: str(w.lineText), words: [] });
    lines.get(key).words.push({ raw: text, confidence: clamp(num(w.confidence, 0), 0, 100) });
  }
  // Pages without word data (e.g. a test or a degraded engine): fall back to text lines.
  if (lines.size === 0 && str(page.text)) {
    const conf = clamp(num(page.confidence, 0), 0, 100);
    str(page.text).slice(0, MAX_TEXT_CHARS).split(/\r?\n/).forEach((line, i) => {
      const ws = line.split(/\s+/).filter(Boolean).map((raw) => ({ raw, confidence: conf }));
      if (ws.length) lines.set(`l:${i}`, { raw: line, words: ws });
    });
  }
  const out = [];
  for (const line of lines.values()) {
    let text = '';
    for (const w of line.words) {
      const { text: fixedText, fixed } = fixToken(w.raw, rules);
      if (text) text += ' ';
      w.start = text.length;
      text += fixedText;
      w.end = text.length;
      w.fixed = fixed;
    }
    out.push({ text, raw: line.raw || line.words.map((w) => w.raw).join(' '), words: line.words });
  }
  return out;
}

function confFor(line, start, end) {
  const hit = line.words.filter((w) => w.start < end && w.end > start);
  if (!hit.length) return { conf: 0, fixed: false };
  return { conf: hit.reduce((s, w) => s + w.confidence, 0) / hit.length, fixed: hit.some((w) => w.fixed) };
}

/** Loose dash form: the ADR regex, tolerant of single spaces OCR puts around the dash. */
function dashRegex(rules) {
  return new RegExp(rules.DASH_FORM.re.source.replace(')-(', ') ?- ?('), 'g');
}

/** Extract reads from one OcrPage. */
function readsFromPage(page, rules, validLengths) {
  const pass = page.pass === 'digits' ? 'digits' : 'text';
  const reads = [];
  let dashSeen = false;
  for (const line of pageLines(page, rules)) {
    const covered = [];
    const certLabel = rules.CERT_LABEL_RE.test(normalizeText(line.raw));
    for (const m of line.text.matchAll(dashRegex(rules))) {
      const start = m.index;
      const end = start + m[0].length;
      covered.push([start, end]);
      const c = confFor(line, start, end);
      reads.push({ number: m[1] + m[2], kind: 'ocr', key: `ocr:${pass}`, pass, conf: c.conf, fixed: c.fixed, certLabel, dash: true });
      dashSeen = true;
    }
    for (const m of line.text.matchAll(/\d+/g)) {
      const start = m.index;
      const end = start + m[0].length;
      if (covered.some(([a, b]) => start < b && end > a)) continue;
      if (!validLengths.has(m[0].length)) continue;
      const c = confFor(line, start, end);
      reads.push({ number: m[0], kind: 'ocr', key: `ocr:${pass}`, pass, conf: c.conf, fixed: c.fixed, certLabel, dash: false });
    }
  }
  return { reads, dashSeen };
}

/** Extract reads + warnings from barcode results. */
function readsFromBarcodes(barcodes, rules, validLengths) {
  const reads = [];
  const warnings = [];
  (Array.isArray(barcodes) ? barcodes.slice(0, MAX_BARCODES) : []).forEach((b, i) => {
    if (!isObj(b) || typeof b.text !== 'string') return;
    const format = str(b.format).replace(/[^\w-]/g, '').slice(0, 32) || 'unknown';
    const key = `barcode:${i}`;
    const qr = parseQrPayload(b.text);
    if (qr.kind === 'official') {
      reads.push({ number: qr.number, kind: 'qr-url', key, base: qr.pathMatched ? rules.SCORE.base['qr-url'] : rules.SCORE.base['qr-url-unmatched-path'],
        grader: qr.grader, evidence: [`qr-host:${qr.host}`, ...(qr.pathMatched ? [] : ['qr-path-unmatched'])] });
    } else if (qr.kind === 'untrusted-url') {
      if (!warnings.some((w) => w.detail === qr.host)) warnings.push({ code: 'qr-untrusted-host', detail: qr.host });
      for (const d of qr.digits) {
        if (validLengths.has(d.length)) reads.push({ number: d, kind: 'barcode', key, untrusted: true, evidence: [`qr-untrusted:${qr.host}`] });
      }
    } else {
      const runs = b.text.slice(0, 256).match(/\d+/g) ?? [];
      for (const d of new Set(runs)) {
        if (validLengths.has(d.length)) reads.push({ number: d, kind: 'barcode', key, evidence: [`barcode:${format}`] });
      }
    }
  });
  return { reads, warnings };
}

const MAX_HINT_CHARS = 400;

/** Brand families named in (normalized) text. */
function brandsIn(text, rules) {
  return Object.keys(rules.BRANDS ?? {}).filter((b) => rules.BRANDS[b].test(text));
}

/** 'cards' | 'comics' | null from card/comic wording. */
function typeOf(text, rules) {
  const score = (list) => (list ?? []).reduce((s, [term, w]) => s + (termRegex(rules, term).test(text) ? w : 0), 0);
  const cards = score(rules.TYPE_WORDS?.cards);
  const comics = score(rules.TYPE_WORDS?.comics);
  if (Math.abs(cards - comics) < 0.2) return null;
  return cards > comics ? 'cards' : 'comics';
}

/**
 * Keyword scores for one number: the label's scores plus the number's shape (BGS "00…" serials), a brand named only
 * in the page title / image alt text (used when the label shows no brand), and card-vs-comic wording (CGC only).
 */
function scoresForNumber(kw, number, ctx, rules) {
  const out = Object.fromEntries(Object.entries(kw).map(([g, v]) => [g, { score: v.score, terms: [...v.terms] }]));
  const bump = (g, w, term) => { if (out[g]) out[g] = { score: round2(Math.min(1, out[g].score + w)), terms: [...out[g].terms, term] }; };
  for (const p of rules.NUMBER_PRIORS ?? []) if (p.re.test(number)) bump(p.grader, p.weight, p.term);
  if (!ctx.labelBrands.length && ctx.hintBrands.length === 1) {
    const b = ctx.hintBrands[0];
    for (const g of rules.BRAND_GRADERS[b]) bump(g, rules.HINT_WEIGHT.brand, `hint:${b}`);
  }
  const brands = ctx.labelBrands.length ? ctx.labelBrands : ctx.hintBrands;
  if (ctx.type && brands.every((b) => b === 'cgc')) bump(ctx.type === 'cards' ? 'cgc-cards' : 'cgc-comics', rules.HINT_WEIGHT.type, `type:${ctx.type}`);
  return out;
}

function rankGraders(graders, kw, length, rules) {
  const tie = rules.TIE_ORDER[length] ?? rules.TIE_ORDER.default;
  return [...graders].sort((a, b) => (kw[b].score - kw[a].score) || (tie.indexOf(a) - tie.indexOf(b)));
}

/**
 * Full analysis: candidates plus warnings derived from the inputs.
 * @param {{pages?:import('./types.js').OcrPage[], barcodes?:import('./types.js').BarcodeRead[], hints?:string}} input
 *   hints: page title / image alt text (page-controlled; it only helps choose between graders that fit a number)
 * @returns {{candidates:import('./types.js').CertCandidate[], warnings:import('./types.js').ScanWarning[], keywords:Record<string,{score:number,terms:string[]}>}}
 */
export function analyze(input, rules = DEFAULT_RULES) {
  const { SCORE } = rules;
  const pages = isObj(input) && Array.isArray(input.pages) ? input.pages.filter(isObj) : [];
  const barcodes = isObj(input) && Array.isArray(input.barcodes) ? input.barcodes : [];
  const validLengths = new Set(rules.ALL_LENGTHS);

  const reads = [];
  let dashSeen = false;
  for (const page of pages) {
    const r = readsFromPage(page, rules, validLengths);
    reads.push(...r.reads);
    dashSeen ||= r.dashSeen;
  }
  const bc = readsFromBarcodes(barcodes, rules, validLengths);
  reads.push(...bc.reads);

  const allText = pages.filter((p) => p.pass !== 'digits').map((p) => str(p.text)).join('\n');
  const extra = dashSeen ? { [rules.DASH_FORM.grader]: { weight: rules.DASH_FORM.weight, term: 'dash-form' } } : {};
  const kw = keywordScores(allText, rules, extra);
  const maxKw = Math.max(0, ...rules.GRADER_IDS.map((g) => kw[g].score));
  const hintText = normalizeText(isObj(input) ? str(input.hints).slice(0, MAX_HINT_CHARS) : '');
  const labelText = normalizeText(allText);
  const ctx = {
    labelBrands: brandsIn(labelText, rules),
    hintBrands: brandsIn(hintText, rules),
    type: typeOf(`${labelText} ${hintText}`, rules),
  };

  // Merge reads per digit string.
  const byNumber = new Map();
  for (const r of reads) {
    if (!byNumber.has(r.number)) byNumber.set(r.number, []);
    byNumber.get(r.number).push(r);
  }

  const scored = [];
  for (const [number, rs] of byNumber) {
    const evidence = [`len:${number.length}`];
    const add = (e) => { if (!evidence.includes(e)) evidence.push(e); };
    const ocrReads = rs.filter((r) => r.kind === 'ocr');
    const qrReads = rs.filter((r) => r.kind === 'qr-url');
    const bcReads = rs.filter((r) => r.kind === 'barcode');
    const allUntrusted = qrReads.length === 0 && ocrReads.length === 0 && bcReads.length > 0 && bcReads.every((r) => r.untrusted);

    // 1. Start
    const bases = [];
    let source = 'ocr';
    if (ocrReads.length) {
      const meanConf = ocrReads.reduce((s, r) => s + r.conf, 0) / ocrReads.length;
      const o = SCORE.base.ocr;
      bases.push(o.min + o.span * clamp((meanConf - o.confLo) / (o.confHi - o.confLo), 0, 1));
    }
    if (bcReads.length) {
      const trusted = bcReads.some((r) => !r.untrusted);
      bases.push(trusted ? SCORE.base.barcode : Math.min(SCORE.base.barcode, SCORE.thresholds.untrustedQrCap));
      source = 'barcode';
    }
    if (qrReads.length) {
      bases.push(Math.max(...qrReads.map((r) => r.base)));
      source = 'qr-url';
    }
    let score = Math.max(...bases);
    for (const p of new Set(ocrReads.map((r) => r.pass))) add(`pass:${p}`);
    for (const r of [...qrReads, ...bcReads]) r.evidence.forEach(add);

    // 2. Read quality
    const keys = new Set(rs.map((r) => r.key));
    if (keys.size >= 2) score += SCORE.bonus.secondRead;
    if (ocrReads.some((r) => r.certLabel)) { score += SCORE.bonus.certLabel; add('cert-label'); }
    if (ocrReads.some((r) => r.dash)) add('dash-form');
    if (ocrReads.length && !qrReads.length && !bcReads.length && ocrReads.every((r) => r.fixed)) { score -= SCORE.penalty.ocrFixup; add('fixup'); }
    else if (ocrReads.some((r) => r.fixed)) add('fixup');

    // 3. Grader
    let grader = null;
    let graderOptions;
    if (qrReads.length) {
      grader = qrReads[0].grader;
      graderOptions = [grader];
    } else {
      const F = rules.GRADER_IDS.filter((g) => rules.GRADERS[g].lengths.includes(number.length));
      if (!F.length) continue;
      const kwN = scoresForNumber(kw, number, ctx, rules);
      graderOptions = rankGraders(F, kwN, number.length, rules);
      if (F.length === 1) {
        grader = F[0];
        const conflict = rules.GRADER_IDS.some((g) => g !== grader && kw[g].score >= SCORE.resolve.conflictKeyword)
          && kw[grader].score < SCORE.resolve.slabVocabularyMin;
        if (conflict) { score -= SCORE.penalty.keywordConflict; add('conflict'); } else score += SCORE.bonus.lengthUnique;
      } else {
        const [best, second] = graderOptions;
        const bestScore = kwN[best].score;
        const secondScore = second ? kwN[second].score : 0;
        if (bestScore >= SCORE.resolve.minKeyword && bestScore - secondScore >= SCORE.resolve.minMargin - 1e-9) {
          grader = best;
          score += SCORE.bonus.keywordResolved;
        } else {
          score -= SCORE.penalty.graderUnresolved;
        }
      }
      if (grader) kwN[grader].terms.forEach((t) => add(`kw:${t}`));
    }

    // 4. Slab vocabulary
    if (source !== 'qr-url' && maxKw < SCORE.resolve.slabVocabularyMin) score -= SCORE.penalty.noSlabVocabulary;

    if (allUntrusted) score = Math.min(score, SCORE.thresholds.untrustedQrCap);
    scored.push({ grader, graderOptions, number, pre: score, source, evidence, allUntrusted });
  }

  // 5. Competition (based on pre-competition scores, so order does not matter)
  const candidates = scored.map((c) => {
    const competitors = scored.filter((o) => o !== c && o.pre >= SCORE.thresholds.competitor).length;
    let s = c.pre - competitors * SCORE.penalty.competitor;
    if (c.allUntrusted) s = Math.min(s, SCORE.thresholds.untrustedQrCap);
    return { grader: c.grader, graderOptions: c.graderOptions, number: c.number, confidence: round2(clamp(s, 0, 1)), source: c.source, evidence: c.evidence };
  });

  // 6. Final
  const final = candidates
    .filter((c) => c.confidence >= SCORE.thresholds.show)
    .sort((a, b) => (b.confidence - a.confidence) || (a.number < b.number ? -1 : 1))
    .slice(0, SCORE.thresholds.maxCandidates);
  return { candidates: final, warnings: bc.warnings, keywords: kw };
}

/** ADR §6 contract: text + barcodes -> CertCandidate[] */
export function parseCandidates(input, rules = DEFAULT_RULES) {
  return analyze(input, rules).candidates;
}

/** True when any page holds a digit run of a valid length (scanner: decides on rotation passes). */
export function hasValidRun(pages, rules = DEFAULT_RULES) {
  const validLengths = new Set(rules.ALL_LENGTHS);
  return (Array.isArray(pages) ? pages : []).some((p) => isObj(p) && readsFromPage(p, rules, validLengths).reads.length > 0);
}
