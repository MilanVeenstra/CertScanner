// Scan orchestrator (ADR-001 §6): acquire -> preprocess -> barcodes -> OCR passes -> parse -> route.
// The only composing module. Checks the abort signal between stages; results after an abort are discarded.
import { acquireFromBlob, acquireFromJob } from './acquire.js';
import { preprocess, labelImage } from './preprocess.js';
import { detectBarcodes as defaultDetectBarcodes } from './barcode.js';
import { createOcrEngine, PSM, THRESHOLDING } from './ocr.js';
import { analyze } from '../core/certParser.js';
import { DEFAULT_RULES } from '../core/certRules.js';
import { parseQrPayload } from '../core/certUrls.js';
import { decide } from '../core/routing.js';
import { raceAbort } from '../shared/raceAbort.js';

export const SCAN_TIMEOUT_MS = 25_000;
// 10 (A20, was 8): room for the orientation probe and a second opinion; only weak or sideways photos get near it.
export const MAX_RECOGNIZE_CALLS = 10;
/** Second opinions (A20) start only while the OCR time of this scan is below this: noisy photos are slow already. */
export const SECOND_OPINION_MAX_MS = 1200;
/** Orientation probe: words the engine reads with at least this confidence count towards an orientation's score. */
const PROBE_WORD_CONF = 60;
export const MAX_DIGIT_BOXES = 4;
export const MIN_DIGIT_LIKE = 5;
export const LANDSCAPE_RATIO = 1.15;
export const LOW_RES_LONG_SIDE = 500;

const DIGIT_LIKE_RE = /[0-9OoDQIl|SBZ]/g;
const digitLikeCount = (s) => (String(s).match(DIGIT_LIKE_RE) ?? []).length;
const now = () => performance.now();
const ms = (x) => Math.round(x);

/** Text lines of the full-image OCR pass (in memory only; feeds the price & listing search terms). */
const LABEL_WORD_CONF = 60;
function labelLines(pages) {
  const page = pages.find((p) => p?.labelPass && p.pass === 'text') ?? pages.find((p) => p && p.pass === 'text' && !p.rotation) ?? pages.find((p) => p && p.pass === 'text');
  if (!page) return [];
  // Words with their line ids: keep only words OCR is fairly sure of (artwork below the label reads as "lf yr rr").
  if (Array.isArray(page.words) && page.words.length) {
    const lines = new Map();
    for (const w of page.words) {
      if (!w || typeof w.text !== 'string' || !(w.confidence >= LABEL_WORD_CONF)) continue;
      if (!lines.has(w.lineId)) lines.set(w.lineId, []);
      lines.get(w.lineId).push(w.text);
    }
    return [...lines.values()].map((ws) => ws.join(' ').trim().slice(0, 80)).filter(Boolean).slice(0, 24);
  }
  if (typeof page.text !== 'string') return [];
  return page.text.split('\n').map((l) => l.trim().slice(0, 80)).filter(Boolean).slice(0, 24);
}

/**
 * Card name pass (runs after a result, in the background): OCR of the label at text size, top band first and the
 * bottom band turned around when the top gives no text. Returns label text lines (in memory only).
 * Also used when the number came from a QR code or barcode, where scan() skips OCR.
 * @param {Blob} blob the scanned photo
 * @returns {Promise<string[]>}
 */
export async function readLabel(blob, { signal, engines, accept = (lines) => lines.length > 0, decimalGrade = false } = {}) {
  if (!(blob instanceof Blob)) return [];
  const eng = engines ?? getEngines();
  const sig = signal ?? new AbortController().signal;
  const bitmap = await createImageBitmap(blob);
  try {
    let best = [];
    let bestImg = null;
    for (const which of ['top', 'bottom']) {
      signal?.throwIfAborted();
      const img = await labelImage(bitmap, { which });
      const page = await raceAbort(eng.ocr.recognizeText(img, { signal }), sig);
      const lines = labelLines([page]);
      if (accept(lines)) { best = lines; bestImg = img; break; }
      if (lines.length > best.length) { best = lines; bestImg = img; }
    }
    // CGC/BGS grades are decimals in a big box ("9.8") that the text pass often misreads: one digits-only pass with
    // '.' allowed adds the grade as its own line when the text pass found none.
    if (decimalGrade && bestImg && !best.some((l) => DECIMAL_GRADE.test(l))) {
      const page = await raceAbort(eng.ocr.recognizeDigits(bestImg, { psm: PSM.SPARSE_TEXT, whitelist: '0123456789.', signal }), sig);
      const g = String(page.text ?? '').split(/\s+/).map((t) => DECIMAL_GRADE.exec(t)?.[1]).find((v) => v && Number(v) <= 10);
      if (g) best = [...best, g];
    }
    return best;
  } finally {
    try { bitmap.close(); } catch { /* closed */ }
  }
}

/** Width of the label images in scan(): smaller than readLabel's, since only the big print matters here. */
const LABEL_PASS_WIDTH = 1100;
/**
 * The second label read: the plain (gray) label image, binarised by Tesseract's Sauvola. On 131 fixtures it agreed
 * with the black/white digits read on 100 right numbers and on 4 wrong ones (the same image read as text: 14 wrong).
 */
const LABEL_PLAIN_PARAMS = Object.freeze({ thresholding_method: THRESHOLDING.sauvola });

/** Second opinions (A20): the full image binarised differently inside Tesseract; `variant` keys the reads apart. */
const SECOND_OPINION_ORDER = Object.freeze([
  Object.freeze({ variant: 'sauvola', method: THRESHOLDING.sauvola }),
  Object.freeze({ variant: 'leptonica', method: THRESHOLDING.leptonicaOtsu }),
]);

/** Sum of the confidences of the words read fairly surely: ranks the 90° and 270° probes of a sideways photo. */
export function probeScore(page) {
  return (page?.words ?? []).reduce((acc, w) => acc + (w?.confidence >= PROBE_WORD_CONF ? w.confidence : 0), 0);
}
/**
 * What each recognize call read (A20): kept in memory with the result for the panel's "This went wrong" report, never
 * stored. Text is cut to 200 characters per pass.
 */
function passSummary(pages) {
  return pages.slice(0, MAX_RECOGNIZE_CALLS).map((p) => ({
    pass: p.pass, variant: p.variant ?? null, label: p.labelPass === true, rotation: p.rotation ?? 0, ms: p.ms ?? null,
    confidence: Math.round(Number(p.confidence) || 0), text: String(p.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
  }));
}

/** A valid-length digit run in a word the engine is not guessing at (not a whitelist fall-back). */
function hasSolidRun(page) {
  const minConf = DEFAULT_RULES.SCORE.read.minConf;
  return (page?.words ?? []).some((w) => w?.confidence >= minConf && (String(w.text).match(/\d+/g) ?? []).some((d) => DEFAULT_RULES.ALL_LENGTHS.includes(d.length)));
}
const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
const DECIMAL_GRADE = /(?<![\d.])(10\.0|\d\.\d)(?![\d.])/;

let defaultEngines = null;
/** Lazily created engines shared by every scan in this panel. */
export function getEngines() {
  if (!defaultEngines) defaultEngines = { ocr: createOcrEngine(), detectBarcodes: defaultDetectBarcodes };
  return defaultEngines;
}
export function disposeEngines() {
  const e = defaultEngines;
  defaultEngines = null;
  return e?.ocr.dispose();
}

/**
 * Word/line boxes worth a digits pass: runs of adjacent digit-ish words on one line with >= 5 digit-like chars.
 * @param {import('../core/types.js').OcrPage} page
 * @returns {{left:number, top:number, width:number, height:number, digits:number}[]}
 */
export function digitBoxes(page) {
  const byLine = new Map();
  for (const w of page?.words ?? []) {
    if (!byLine.has(w.lineId)) byLine.set(w.lineId, []);
    byLine.get(w.lineId).push(w);
  }
  const boxes = [];
  for (const words of byLine.values()) {
    let run = null;
    const flush = () => {
      if (run && run.digits >= MIN_DIGIT_LIKE) {
        boxes.push({ left: run.x0, top: run.y0, width: run.x1 - run.x0, height: run.y1 - run.y0, digits: run.digits });
      }
      run = null;
    };
    for (const w of words) {
      const text = String(w.text);
      const d = digitLikeCount(text);
      const digitish = (d >= 1 && d / text.length >= 0.5) || /^[-–]$/.test(text);
      if (!digitish) { flush(); continue; }
      const b = w.bbox;
      const h = b.y1 - b.y0;
      if (run && b.x0 - run.x1 > 1.5 * Math.max(h, run.y1 - run.y0)) flush();
      if (!run) run = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, digits: 0 };
      run.x0 = Math.min(run.x0, b.x0); run.y0 = Math.min(run.y0, b.y0);
      run.x1 = Math.max(run.x1, b.x1); run.y1 = Math.max(run.y1, b.y1);
      run.digits += d;
    }
    flush();
  }
  return boxes.filter((b) => b.width > 0 && b.height > 0).sort((a, b) => b.digits - a.digits).slice(0, MAX_DIGIT_BOXES);
}

class ScanStop extends Error {
  constructor(code) { super(code); this.code = code; }
}

/**
 * @param {{kind:'job', job:import('../core/types.js').ScanJob} | {kind:'blob', blob:Blob, method?:'upload'|'paste'|'drop'}} input
 * @param {{settings?:import('../core/types.js').Settings, signal?:AbortSignal,
 *   onProgress?:(p:import('../core/types.js').ScanProgress)=>void,
 *   acquire?:((input:any, o:{signal:AbortSignal})=>Promise<import('../core/types.js').AcquireResult>) | {strategies?:string[]},
 *   onImage?:(blob:Blob, info:import('../core/types.js').ImageInfo)=>void,
 *   engines?:{ocr:ReturnType<typeof createOcrEngine>, detectBarcodes:typeof defaultDetectBarcodes}}} [opts]
 * @returns {Promise<import('../core/types.js').ScanResult>}
 */
export async function scan(input, { settings, signal, onProgress, acquire, onImage, engines, hints = '' } = {}) {
  const t0 = now();
  const timings = { acquireMs: 0, preprocessMs: 0, barcodeMs: 0, ocrInitMs: 0, ocrMs: 0, totalMs: 0 };
  const timeout = AbortSignal.timeout(SCAN_TIMEOUT_MS);
  const sig = AbortSignal.any([signal, timeout].filter(Boolean));
  const jobId = input?.kind === 'job' ? input.job?.id ?? null : null;
  const warnings = [];
  let imageInfo = null;
  let bitmap = null;
  const progress = (stage, fraction) => { try { onProgress?.(fraction === undefined ? { stage } : { stage, fraction }); } catch { /* UI errors never break a scan */ } };
  const finish = (status, extra = {}) => ({
    jobId, status, candidates: [], imageInfo, warnings, ...extra, timings: { ...timings, totalMs: ms(now() - t0) },
  });
  const stopCode = () => (signal?.aborted ? 'aborted' : 'timeout');
  const check = () => { if (sig.aborted) throw new ScanStop(stopCode()); };

  try {
    const eng = engines ?? getEngines();
    progress('acquire');
    const warm = eng.ocr.warmUp().then(() => null, (e) => e || new Error('ocr'));

    let t = now();
    let acq;
    // SEC-03: the acquire call itself is raced so Cancel and the 25 s budget always settle.
    if (typeof acquire === 'function') acq = await raceAbort(acquire(input, { signal: sig }), sig);
    else if (input?.kind === 'job') acq = await raceAbort(acquireFromJob(input.job, { signal: sig, ...(acquire ?? {}) }), sig);
    else acq = await raceAbort(acquireFromBlob(input?.blob, input?.method ?? 'upload', { signal: sig }), sig);
    timings.acquireMs = ms(now() - t);
    if (!acq.ok) {
      if (acq.reason === 'aborted' || acq.reason === 'timeout') throw new ScanStop(sig.aborted ? stopCode() : acq.reason);
      return finish('error', { error: { code: acq.reason, ...(acq.origin ? { origin: acq.origin } : {}), canRequestSharper: Boolean(acq.canRequestSharper) } });
    }
    bitmap = acq.bitmap;
    imageInfo = acq.info;
    if (Math.max(imageInfo.width, imageInfo.height) < LOW_RES_LONG_SIDE) warnings.push({ code: 'low-resolution' });
    try { onImage?.(acq.blob, imageInfo); } catch { /* preview only */ }
    check();

    progress('decode');
    t = now();
    const prep = await raceAbort(preprocess(bitmap), sig);
    timings.preprocessMs = ms(now() - t);
    check();

    progress('barcode');
    t = now();
    let barcodes = [];
    try {
      barcodes = await raceAbort(eng.detectBarcodes(prep.imageData, { signal: sig }), sig);
    } catch {
      check();
      barcodes = [];
    }
    timings.barcodeMs = ms(now() - t);
    check();

    const trustedQr = barcodes.some((b) => { const q = parseQrPayload(b.text); return q.kind === 'official' && q.pathMatched; });
    const route = (pages) => {
      progress('parse');
      const a = analyze({ pages, barcodes, hints });
      for (const w of a.warnings) warnings.push(w);
      return finish(decide(a.candidates, settings, warnings), { candidates: a.candidates, labelText: labelLines(pages), passes: passSummary(pages) });
    };
    if (trustedQr) return route([]);

    progress('ocr-init');
    t = now();
    const initError = await Promise.race([warm, new Promise((r) => sig.addEventListener('abort', () => r(null), { once: true }))]);
    timings.ocrInitMs = ms(now() - t);
    check();
    if (initError) {
      warnings.push({ code: 'ocr-unavailable' });
      const r = route([]);
      return r.candidates.length ? r : finish('error', { error: { code: initError.code === 'init-timeout' ? 'timeout' : 'engine-failed' } });
    }

    progress('ocr', 0);
    t = now();
    const ocrStart = t;
    const pages = [];
    let calls = 0;
    /** `reserve`: calls kept for later steps (the label pass needs two to show a number). */
    const can = (reserve = 0) => calls + reserve < MAX_RECOGNIZE_CALLS;
    const step = () => progress('ocr', Math.min(1, calls / MAX_RECOGNIZE_CALLS));
    const recognize = async (fn, tags = null) => {
      calls++;
      const started = now();
      const page = await raceAbort(fn(), sig);
      check();
      page.ms = ms(now() - started);
      if (tags) Object.assign(page, tags);
      pages.push(page);
      step();
      return page;
    };
    const cropped = [];
    /** `onlyNew`: crops only, of boxes not cropped before (second opinions, orientation probes): no whole-band pass. */
    const digitPassesFor = async (p, text, { reserve = 0, onlyNew = false } = {}) => {
      const boxes = digitBoxes(text).filter((b) => !onlyNew || !cropped.some((c) => c.rotation === p.rotation && overlaps(c, b)));
      if (boxes.length) {
        for (const box of boxes) {
          if (!can(reserve)) break;
          cropped.push({ ...box, rotation: p.rotation });
          const crop = await p.cropForDigits(box);
          await recognize(() => eng.ocr.recognizeDigits(crop, { signal: sig, rotation: p.rotation }));
        }
      } else if (!onlyNew) {
        if (can()) await recognize(() => eng.ocr.recognizeDigits(p.ocrBlob, { psm: PSM.SPARSE_TEXT, rectangle: p.bands.top, signal: sig, rotation: p.rotation }));
        if (can()) {
          const bottom = await p.bandBlob('bottom', true);
          await recognize(() => eng.ocr.recognizeDigits(bottom, { psm: PSM.SPARSE_TEXT, signal: sig, rotation: (p.rotation + 180) % 360 }));
        }
      }
    };
    const analysis = () => analyze({ pages, barcodes, hints });
    /** Second-opinion pages run so far (A20), in order. */
    const opinions = [];
    const opinion = async (p, o) => {
      const page = await recognize(() => eng.ocr.recognizeText(p.ocrBlob, { signal: sig, rotation: p.rotation, params: { thresholding_method: o.method } }), { variant: o.variant });
      opinions.push(page);
      return page;
    };
    const AUTO_OPEN = DEFAULT_RULES.SCORE.thresholds.autoOpen;
    /** No number, or the grader is unknown: the label pass may still settle it. */
    const unresolved = () => { const top = analysis().candidates[0]; return !top || top.grader === null; };
    /** Nothing the panel could open by itself yet. */
    const weak = () => { const top = analysis().candidates[0]; return !top || top.grader === null || top.confidence < AUTO_OPEN; };
    /**
     * Worth a second opinion: the photo shows slab words or a barcode. A number without any slab word can't open a
     * page anyway (no-vocabulary penalty), so a document or a plain number gets none (the label pass still looks for
     * the words).
     */
    const slabEvidence = () => analysis().signals.maxKeyword >= DEFAULT_RULES.SCORE.resolve.slabVocabularyMin || barcodes.length > 0;
    // Label pass: when the passes so far found no number or can't tell the grader (small, low-contrast or coloured
    // labels such as BGS gold), read the label band itself: black/white (adaptive threshold) digits, then text for the
    // grader words. A number only the label pass reads is shown only when two differently binarised images of the
    // label agree on it (certParser, A20), and never opens a page by itself.
    const labelPass = async (rotation) => {
      if (!can() || !bitmap) return;
      const bin = await labelImage(bitmap, { which: 'top', binarize: true, width: LABEL_PASS_WIDTH, rotation });
      const binPage = await recognize(() => eng.ocr.recognizeDigits(bin, { psm: PSM.SPARSE_TEXT, signal: sig }), { labelPass: true, variant: 'bin' });
      const plainText = async () => {
        const plain = await labelImage(bitmap, { which: 'top', width: LABEL_PASS_WIDTH, rotation });
        await recognize(() => eng.ocr.recognizeText(plain, { signal: sig, params: LABEL_PLAIN_PARAMS }), { labelPass: true, variant: 'plain' });
      };
      if (!can()) return;
      if (analysis().candidates.length) {
        // A number is read; only the grader words are missing. The black/white image as text reads them through
        // glare (same image as the digits read, so it adds words, never a second read of a number); the plain image
        // only if they are still missing.
        await recognize(() => eng.ocr.recognizeText(bin, { signal: sig }), { labelPass: true, variant: 'bin' });
        if (can() && unresolved()) await plainText();
      } else if (hasSolidRun(binPage)) {
        // A number only the label shows: the plain image has to read it too (certParser), and brings the words.
        await plainText();
      }
    };
    try {
      if (can()) {
        const text = await recognize(() => eng.ocr.recognizeText(prep.ocrBlob, { signal: sig, rotation: prep.rotation }));
        // Slab words but not a digit group in sight (gold label, a few degrees of tilt): the default binarisation lost
        // the number, so the Sauvola opinion replaces the whole-band digit passes (which read nothing on such photos)
        // and its boxes get the digit crops. Nothing there either: the label pass below still looks.
        if (!digitBoxes(text).length && weak() && slabEvidence() && can()) {
          const sv = await opinion(prep, SECOND_OPINION_ORDER[0]);
          await digitPassesFor(prep, sv, { onlyNew: true });
        } else {
          await digitPassesFor(prep, text);
        }
      }
      let view = prep; // orientation the later passes read
      // Orientation probe (A20): decided on numbers the parser would show, not on any digit run (a whitelist
      // fall-back at confidence 0 used to stop the search before 270°). One text pass per side, stopping at the side
      // that reads a number; digit crops then on that side, or, when neither read one, first on the side whose words
      // read best.
      if (!analysis().candidates.length && prep.width > LANDSCAPE_RATIO * prep.height) {
        const probes = [];
        for (const deg of [90, 270]) {
          if (!can()) break;
          const p = await prep.rotate(deg);
          const page = await recognize(() => eng.ocr.recognizeText(p.ocrBlob, { signal: sig, rotation: deg }));
          probes.push({ p, score: probeScore(page), page });
          if (analysis().candidates.length) break;
        }
        const ranked = analysis().candidates.length ? probes.slice(-1) : probes.slice().sort((a, b) => b.score - a.score);
        // The chosen side always gets its digit crops (its text pass alone is one read); the other only if the first
        // still shows nothing.
        for (const [i, pr] of ranked.entries()) {
          if ((i > 0 && analysis().candidates.length) || !can()) break;
          view = pr.p;
          await digitPassesFor(pr.p, pr.page, { reserve: 1, onlyNew: true });
          if (analysis().candidates.length) break;
        }
        if (!analysis().candidates.length && ranked.length) view = ranked[0].p;
      }
      // Second opinion (A20): the same image binarised differently inside Tesseract (Sauvola, then Leptonica's Otsu)
      // reads glare-cut, gold-label and tilted numbers the default Otsu misses. Only for a weak result on a photo that
      // shows a slab at all, and only while the scan is still quick.
      const quick = () => now() - ocrStart < SECOND_OPINION_MAX_MS;
      if (weak() && can() && slabEvidence() && quick()) {
        // Sauvola (local) first; Leptonica's Otsu first for an incomplete read, since it keeps the leading zeros a
        // glare streak takes from the default Otsu. The other one only when the first read no number at all and an
        // earlier pass did find one to complete or confirm.
        const incomplete = analysis().candidates[0]?.evidence.includes('incomplete');
        const order = incomplete ? SECOND_OPINION_ORDER.slice().reverse() : SECOND_OPINION_ORDER;
        for (const o of order) {
          if (opinions.some((p) => p.variant === o.variant)) continue;
          if (opinions.length && (opinions.some(hasSolidRun) || !analysis().candidates.length)) break;
          if (!weak() || !can() || !quick()) break;
          const page = await opinion(view, o);
          if (opinions.length === 1 && weak()) await digitPassesFor(view, page, { reserve: 3, onlyNew: true });
        }
      }
      // A landscape photo that read nothing in any orientation: its top band is no label, skip the label pass.
      const lost = !analysis().candidates.length && prep.width > LANDSCAPE_RATIO * prep.height && !slabEvidence();
      if (unresolved() && !lost) await labelPass(view.rotation);
    } catch (e) {
      if (e instanceof ScanStop || sig.aborted) throw new ScanStop(stopCode());
      if (!pages.length) {
        warnings.push({ code: 'ocr-unavailable' });
        const r = route([]);
        return r.candidates.length ? r : finish('error', { error: { code: e?.code === 'recognize-timeout' ? 'timeout' : 'engine-failed' } });
      }
      // Keep what earlier passes found.
    }
    timings.ocrMs = ms(now() - t);
    return route(pages);
  } catch (e) {
    if (e instanceof ScanStop) return finish('error', { error: { code: e.code } });
    if (sig.aborted) return finish('error', { error: { code: stopCode() } });
    return finish('error', { error: { code: 'engine-failed' } });
  } finally {
    try { bitmap?.close(); } catch { /* already closed */ }
  }
}
