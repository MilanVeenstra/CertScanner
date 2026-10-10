// Scan orchestrator (ADR-001 §6): acquire -> preprocess -> barcodes -> OCR passes -> parse -> route.
// The only composing module. Checks the abort signal between stages; results after an abort are discarded.
import { acquireFromBlob, acquireFromJob } from './acquire.js';
import { preprocess } from './preprocess.js';
import { detectBarcodes as defaultDetectBarcodes } from './barcode.js';
import { createOcrEngine, PSM } from './ocr.js';
import { analyze, hasValidRun } from '../core/certParser.js';
import { parseQrPayload } from '../core/certUrls.js';
import { decide } from '../core/routing.js';
import { raceAbort } from '../shared/raceAbort.js';

export const SCAN_TIMEOUT_MS = 25_000;
export const MAX_RECOGNIZE_CALLS = 8;
export const MAX_DIGIT_BOXES = 4;
export const MIN_DIGIT_LIKE = 5;
export const LANDSCAPE_RATIO = 1.15;
export const LOW_RES_LONG_SIDE = 500;

const DIGIT_LIKE_RE = /[0-9OoDQIl|SBZ]/g;
const digitLikeCount = (s) => (String(s).match(DIGIT_LIKE_RE) ?? []).length;
const now = () => performance.now();
const ms = (x) => Math.round(x);

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
export async function scan(input, { settings, signal, onProgress, acquire, onImage, engines } = {}) {
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
      const a = analyze({ pages, barcodes });
      for (const w of a.warnings) warnings.push(w);
      return finish(decide(a.candidates, settings, warnings), { candidates: a.candidates });
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
    const pages = [];
    let calls = 0;
    const can = () => calls < MAX_RECOGNIZE_CALLS;
    const step = () => progress('ocr', Math.min(1, calls / MAX_RECOGNIZE_CALLS));
    const recognize = async (fn) => {
      calls++;
      const page = await raceAbort(fn(), sig);
      check();
      pages.push(page);
      step();
      return page;
    };
    const passesFor = async (p) => {
      if (!can()) return;
      const text = await recognize(() => eng.ocr.recognizeText(p.ocrBlob, { signal: sig, rotation: p.rotation }));
      const boxes = digitBoxes(text);
      if (boxes.length) {
        for (const box of boxes) {
          if (!can()) break;
          const crop = await p.cropForDigits(box);
          await recognize(() => eng.ocr.recognizeDigits(crop, { signal: sig, rotation: p.rotation }));
        }
      } else {
        if (can()) await recognize(() => eng.ocr.recognizeDigits(p.ocrBlob, { psm: PSM.SPARSE_TEXT, rectangle: p.bands.top, signal: sig, rotation: p.rotation }));
        if (can()) {
          const bottom = await p.bandBlob('bottom', true);
          await recognize(() => eng.ocr.recognizeDigits(bottom, { psm: PSM.SPARSE_TEXT, signal: sig, rotation: (p.rotation + 180) % 360 }));
        }
      }
    };
    try {
      await passesFor(prep);
      if (!hasValidRun(pages) && prep.width > LANDSCAPE_RATIO * prep.height) {
        for (const deg of [90, 270]) {
          if (!can()) break;
          await passesFor(await prep.rotate(deg));
          if (hasValidRun(pages)) break;
        }
      }
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
