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

/**
 * Extract reads from one OcrPage.
 * `variant` (scanner.js, A20) names how the image was binarised ('sauvola', 'leptonica', label 'bin' / 'plain'): a read
 * of a differently binarised image is an independent read, a second read of the same image is not.
 */
function readsFromPage(page, rules, validLengths) {
  const pass = page.pass === 'digits' ? 'digits' : 'text';
  const label = page.labelPass === true; // read from the enlarged label pass (scanner.js), not the full image
  const variant = typeof page.variant === 'string' && /^[a-z]{1,16}$/.test(page.variant) ? page.variant : null;
  const key = `ocr:${pass}${label ? ':label' : ''}${variant ? `:${variant}` : ''}`;
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
      reads.push({ number: m[1] + m[2], kind: 'ocr', key, pass, label, variant, conf: c.conf, fixed: c.fixed, certLabel, dash: true });
      dashSeen = true;
    }
    for (const m of line.text.matchAll(/\d+/g)) {
      const start = m.index;
      const end = start + m[0].length;
      if (covered.some(([a, b]) => start < b && end > a)) continue;
      if (!validLengths.has(m[0].length)) continue;
      const c = confFor(line, start, end);
      reads.push({ number: m[0], kind: 'ocr', key, pass, label, variant, conf: c.conf, fixed: c.fixed, certLabel, dash: false });
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

/** Variants of the second-opinion passes (scanner.js): the full image binarised differently inside Tesseract. */
const SECOND_OPINIONS = new Set(['sauvola', 'leptonica']);
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
const guessOf = (c) => c.grader ?? c.graderOptions?.[0] ?? null;

/**
 * One number, not two (A20). In place on the scored list:
 * - near-duplicates: same length, <= nearDup.maxDiff digits different, same grader guess, and the weaker one read
 *   only once by OCR. The host absorbs it when more independent reads agree on the host (and the host's reads are
 *   not below the base floor), or when both were read once and the engine is clearly surer of the host
 *   (>= hostConf, by >= margin). The absorbed read counts as the host's second read. A number read twice is never
 *   absorbed, so two slabs with close numbers stay two candidates.
 * - incomplete reads: a number flagged 'incomplete' (no grader fits its length on that label) whose digits appear
 *   inside a complete number of the label's grader is the same print, read short. Read from another image than the
 *   complete number, it also counts as that image agreeing (a label-only number then needs no exact second read:
 *   the plain label read "0012345678" where the black/white one lost a zero).
 * Label-only numbers read from one image that nothing completed are dropped at the end.
 */
function mergeReads(scored, rules) {
  const { nearDup, base } = rules.SCORE;
  const absorbs = (host, c) => {
    if (!nearDup || !c.ocrOnly || c.reads !== 1 || host === c || host.labelSingle || c.labelSingle) return false;
    if (host.number.length !== c.number.length || hamming(host.number, c.number) > nearDup.maxDiff || guessOf(host) !== guessOf(c)) return false;
    // A read strong enough to compete stays its own number: two text passes can misread the same digit the same way
    // while the digit crop reads it right (bench-real cgcd-c17-thumb250), so merging it could hide the right number.
    if (c.pre >= rules.SCORE.thresholds.competitor) return false;
    if (host.reads >= 2) return host.meanConf >= base.ocr.confLo;
    return host.meanConf >= nearDup.hostConf && host.meanConf - c.meanConf >= nearDup.margin;
  };
  const order = [...scored].sort((a, b) => (b.reads - a.reads) || (b.meanConf - a.meanConf) || (b.pre - a.pre));
  const gone = new Set();
  for (const host of order) {
    if (gone.has(host)) continue;
    for (const c of order) {
      if (gone.has(c) || !absorbs(host, c)) continue;
      gone.add(c);
      // A capped number (label pass, second opinion) stays capped: a read that disagrees on a digit does not
      // confirm the disputed digit. The merge shows one number instead of two, but never opens a page by itself:
      // its bonus stops below the auto-open bar.
      const below = rules.SCORE.thresholds.autoOpen - 0.01;
      if (host.reads < 2) { host.pre = Math.min(host.cap, Math.max(host.pre, Math.min(host.pre + rules.SCORE.bonus.secondRead, below))); host.reads = 2; }
      host.evidence.push(`near-dup:${c.number}`);
    }
  }
  for (const c of scored) {
    if (gone.has(c) || !c.evidence.includes('incomplete') || !c.ocrOnly) continue;
    const full = scored.find((m) => !gone.has(m) && m !== c && m.grader === c.graderOptions[0] && m.number.length > c.number.length && m.number.includes(c.number));
    if (!full) continue;
    gone.add(c);
    full.evidence.push(`completes:${c.number}`);
    if (full.labelSingle && [...c.images].some((im) => !full.images.has(im))) full.labelSingle = false;
  }
  for (let i = scored.length - 1; i >= 0; i--) if (gone.has(scored[i]) || scored[i].labelSingle) scored.splice(i, 1);
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
  const minConf = SCORE.read?.minConf ?? 0;
  for (const [number, rs] of byNumber) {
    const evidence = [`len:${number.length}`];
    const add = (e) => { if (!evidence.includes(e)) evidence.push(e); };
    // Reads below the confidence floor are whitelist fall-backs: they are not reads of this number (A20).
    const ocrReads = rs.filter((r) => r.kind === 'ocr' && r.conf >= minConf);
    const qrReads = rs.filter((r) => r.kind === 'qr-url');
    const bcReads = rs.filter((r) => r.kind === 'barcode');
    if (!ocrReads.length && !qrReads.length && !bcReads.length) continue;
    const allUntrusted = qrReads.length === 0 && ocrReads.length === 0 && bcReads.length > 0 && bcReads.every((r) => r.untrusted);

    // 1. Start
    const bases = [];
    let source = 'ocr';
    const meanConf = ocrReads.length ? ocrReads.reduce((s, r) => s + r.conf, 0) / ocrReads.length : 100;
    if (ocrReads.length) {
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
    // Independent reads only: a second-opinion *text* pass (Sauvola / Leptonica) of a number the default text pass
    // also read is the same engine on the same pixels and repeats its misreads (bench-real cgcd-c17-thumb250: both
    // read 2038475610 where the digit crop read the right 2938475610). Confirmation then has to come from a digit
    // crop, a label image, a barcode or a QR code.
    const plainText = ocrReads.some((r) => r.pass === 'text' && !r.label && !r.variant);
    const keys = new Set([...ocrReads, ...qrReads, ...bcReads]
      .filter((r) => !(plainText && r.kind === 'ocr' && r.pass === 'text' && !r.label && SECOND_OPINIONS.has(r.variant)))
      .map((r) => r.key));
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
        // The label clearly names another grader, and no grader of this length: most likely an incomplete read (glare
        // or a lost leading zero). Offer the label's grader first with the number to correct, instead of preselecting
        // the grader that merely fits the length (A20; PSA "00123456" on a Beckett label).
        const strong = rules.GRADER_IDS.filter((g) => g !== F[0] && kw[g].score >= SCORE.resolve.conflictKeyword)
          .sort((a, b) => kw[b].score - kw[a].score)[0];
        if (strong && kw[F[0]].score < SCORE.resolve.slabVocabularyMin) {
          graderOptions = [strong, F[0]];
          score -= SCORE.penalty.keywordConflict;
          add('conflict');
          add('incomplete');
        } else {
          grader = F[0];
          score += SCORE.bonus.lengthUnique;
        }
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
    const noVocabulary = maxKw < SCORE.resolve.slabVocabularyMin;
    if (source !== 'qr-url' && noVocabulary) score -= SCORE.penalty.noSlabVocabulary;

    if (allUntrusted) score = Math.min(score, SCORE.thresholds.untrustedQrCap);
    const ocrOnly = ocrReads.length > 0 && !qrReads.length && !bcReads.length;
    // Images the number was read from: a label-pass image by its binarisation, any other page by its pass key.
    const images = new Set(ocrReads.map((r) => (r.label ? `label:${r.variant ?? r.pass}` : r.key)));
    // Read only by the label pass (a retry on images the full-image passes could not read): never enough to open a
    // page by itself, and shown only when the label is a slab label (slab words) and two differently binarised
    // images of it agree on the number (A20): two reads of one image repeat its errors (2901234567 for 3901234567).
    // A single-image read may still be completed by the other image's incomplete read (mergeReads).
    const labelOnly = ocrOnly && ocrReads.every((r) => r.label);
    let cap = Infinity;
    if (labelOnly) {
      if (noVocabulary) continue;
      cap = SCORE.thresholds.autoOpen - 0.01;
      add('label-pass');
    }
    // Read only by a second-opinion pass (Sauvola / Leptonica Otsu), once: one read of an image that the default
    // binarisation read differently. Shown, but it does not open a page by itself (A20).
    const secondOpinionOnly = ocrOnly && keys.size < 2 && ocrReads.every((r) => !r.label && SECOND_OPINIONS.has(r.variant));
    if (secondOpinionOnly) { cap = SCORE.thresholds.autoOpen - 0.01; add('second-opinion'); }
    score = Math.min(score, cap);
    scored.push({ grader, graderOptions, number, pre: score, cap, source, evidence, allUntrusted, meanConf, reads: keys.size, ocrOnly, images,
      labelSingle: labelOnly && images.size < 2 });
  }

  mergeReads(scored, rules);

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
  // signals: what the scanner needs to decide on extra passes (A20 second opinions): the strongest label vocabulary.
  const signals = { maxKeyword: maxKw };
  return { candidates: final, warnings: bc.warnings, keywords: kw, signals };
}

/** ADR §6 contract: text + barcodes -> CertCandidate[] */
export function parseCandidates(input, rules = DEFAULT_RULES) {
  return analyze(input, rules).candidates;
}

