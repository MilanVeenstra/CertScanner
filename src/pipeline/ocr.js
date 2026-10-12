// Tesseract engine singleton (ADR-001 §6). Every path is overridden to packaged files:
// workerPath, corePath and langPath point inside the extension, so no CDN is ever contacted.
// Requires the classic script vendor/tesseract/tesseract.min.js (global Tesseract).

export const PSM = Object.freeze({ SINGLE_BLOCK: '6', SINGLE_LINE: '7', SPARSE_TEXT: '11' });
export const DIGIT_WHITELIST = '0123456789-';
/** Tesseract 5 `thresholding_method` values (A20): the default Otsu, Leptonica's Otsu, and Sauvola (local). */
export const THRESHOLDING = Object.freeze({ otsu: '0', leptonicaOtsu: '1', sauvola: '2' });
const PASS_PARAMS = new Set(['thresholding_method']);
/** Only the binarisation method can be changed per call; page segmentation and whitelist stay owned by the pass. */
const passParams = (params) => Object.fromEntries(Object.entries(params ?? {}).filter(([k, v]) => PASS_PARAMS.has(k) && Object.values(THRESHOLDING).includes(v)));

class OcrError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. `onAbort` runs synchronously inside the abort event
 * (before the rejection is seen), so the engine can drop its stuck worker before the next scan asks for one.
 */
function raceSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  if (signal.aborted) { onAbort(); return Promise.reject(signal.reason); }
  let listener;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      listener = () => { onAbort(); reject(signal.reason); };
      signal.addEventListener('abort', listener, { once: true });
    }),
  ]).finally(() => signal.removeEventListener('abort', listener));
}

function withTimeout(promise, ms, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new OcrError(code)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Flatten tesseract.js blocks -> OcrPage words. */
export function toOcrPage(data, pass, rotation = 0) {
  const words = [];
  let lineId = 0;
  for (const block of data?.blocks ?? []) {
    for (const par of block?.paragraphs ?? []) {
      for (const line of par?.lines ?? []) {
        const lineText = String(line?.text ?? '').trim();
        for (const w of line?.words ?? []) {
          const text = String(w?.text ?? '').trim();
          if (!text) continue;
          const b = w.bbox ?? {};
          words.push({ text, confidence: Number(w.confidence) || 0, bbox: { x0: b.x0 | 0, y0: b.y0 | 0, x1: b.x1 | 0, y1: b.y1 | 0 }, lineText, lineId });
        }
        lineId++;
      }
    }
  }
  return { text: String(data?.text ?? ''), confidence: Number(data?.confidence) || 0, pass, rotation, words };
}

/**
 * The worker is created lazily, terminated after `idleMs` without work, and also terminated (then lazily recreated)
 * when a scan is cancelled or times out while a recognize call is still running: a stuck or orphaned recognize
 * would otherwise hold the single worker and delay the next scan by up to `recognizeTimeoutMs` (perf rec. 3a).
 * @param {{getURL?:(p:string)=>string, idleMs?:number, initTimeoutMs?:number, recognizeTimeoutMs?:number, Tesseract?:any}} [opts]
 */
export function createOcrEngine({
  getURL = (p) => globalThis.chrome.runtime.getURL(p),
  idleMs = 180_000,
  initTimeoutMs = 10_000,
  recognizeTimeoutMs = 8_000,
  Tesseract = globalThis.Tesseract,
} = {}) {
  let workerP = null;
  let worker = null;
  let idleTimer = null;
  let queue = Promise.resolve();
  let progressCb = null;
  let lastInitMs = 0;
  let generation = 0; // bumped by dispose(): a worker that finishes starting after a dispose is terminated at once
  let terminations = 0;

  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
  function scheduleIdle() { clearIdle(); idleTimer = setTimeout(() => { dispose(); }, idleMs); }

  function warmUp() {
    if (workerP) return workerP;
    if (!Tesseract?.createWorker) return Promise.reject(new OcrError('engine-missing'));
    const t0 = performance.now();
    const gen = generation;
    const created = Tesseract.createWorker('eng', 1, {
      workerPath: getURL('vendor/tesseract/worker.min.js'),
      corePath: getURL('vendor/tesseract/tesseract-core-simd-lstm.js'),
      langPath: getURL('vendor/tesseract/lang'),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (m) => { if (progressCb && m && typeof m.progress === 'number') progressCb(m); },
      errorHandler: () => {},
    });
    const p = withTimeout(created, initTimeoutMs, 'init-timeout').then((w) => {
      if (gen !== generation) {
        w.terminate().catch(() => {});
        throw new OcrError('disposed');
      }
      worker = w;
      lastInitMs = performance.now() - t0;
      scheduleIdle();
      return w;
    }, (e) => {
      if (workerP === p) workerP = null;
      created.then((w) => w.terminate()).catch(() => {});
      throw e instanceof OcrError ? e : new OcrError('init-failed', e);
    });
    workerP = p;
    return p;
  }

  /** Synchronous part first (callers may start a new warmUp right after), then the async terminate. */
  function dispose() {
    clearIdle();
    generation++;
    const w = worker;
    worker = null;
    workerP = null;
    if (!w) return Promise.resolve();
    terminations++;
    return w.terminate().then(() => {}, () => {});
  }

  /** Serialized setParameters + recognize (mutex). */
  function run(image, params, { rectangle, signal, pass, rotation, onProgress } = {}) {
    const job = queue.then(async () => {
      signal?.throwIfAborted();
      // Read a Blob's bytes up front: tesseract.js reads a Blob asynchronously inside recognize(), and a terminate()
      // during that read made its later postMessage hit a null worker (unhandled rejection after Cancel).
      const input = image instanceof Blob ? new Uint8Array(await image.arrayBuffer()) : image;
      signal?.throwIfAborted();
      const w = await warmUp();
      clearIdle();
      signal?.throwIfAborted();
      progressCb = onProgress ?? null;
      // Abort while this worker is busy: drop it (only if it is still the current one) so the next scan starts fresh.
      const dropIfCurrent = () => { if (worker === w) dispose(); };
      try {
        // Tesseract keeps variables between calls: the binarisation method is set on every call, so a second-opinion
        // pass (A20: Sauvola / Leptonica Otsu) never leaks into the next scan's passes.
        await w.setParameters({ user_defined_dpi: '300', thresholding_method: THRESHOLDING.otsu, ...params });
        signal?.throwIfAborted();
        const rec = w.recognize(input, rectangle ? { rectangle } : {}, { text: true, blocks: true });
        rec.catch(() => {}); // settles after terminate(); never unhandled
        const res = await withTimeout(raceSignal(rec, signal, dropIfCurrent), recognizeTimeoutMs, 'recognize-timeout');
        signal?.throwIfAborted();
        return toOcrPage(res.data, pass, rotation);
      } catch (e) {
        if (e instanceof OcrError && e.code === 'recognize-timeout') dropIfCurrent(); // stuck worker: start fresh next time
        throw e;
      } finally {
        progressCb = null;
        if (worker) scheduleIdle();
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    warmUp,
    dispose,
    get initMs() { return lastInitMs; },
    get ready() { return Boolean(worker); },
    /** Workers terminated so far (idle, abort, timeout, dispose); diagnostics and tests. */
    get terminations() { return terminations; },
    /** Sparse text pass (keywords + numbers). `params`: {thresholding_method} for a second opinion (A20). */
    recognizeText(image, { params, ...opts } = {}) {
      return run(image, { tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '', ...passParams(params) }, { ...opts, pass: 'text' });
    },
    /** Digits pass: single line by default, whitelist 0-9 and '-'. */
    recognizeDigits(image, { psm = PSM.SINGLE_LINE, whitelist = DIGIT_WHITELIST, params, ...opts } = {}) {
      return run(image, { tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist, ...passParams(params) }, { ...opts, pass: 'digits' });
    },
  };
}
