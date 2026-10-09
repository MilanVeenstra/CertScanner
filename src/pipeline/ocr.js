// Tesseract engine singleton (ADR-001 §6). Every path is overridden to packaged files:
// workerPath, corePath and langPath point inside the extension, so no CDN is ever contacted.
// Requires the classic script vendor/tesseract/tesseract.min.js (global Tesseract).

export const PSM = Object.freeze({ SINGLE_BLOCK: '6', SINGLE_LINE: '7', SPARSE_TEXT: '11' });
export const DIGIT_WHITELIST = '0123456789-';

class OcrError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
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

  function clearIdle() { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
  function scheduleIdle() { clearIdle(); idleTimer = setTimeout(() => { dispose(); }, idleMs); }

  function warmUp() {
    if (workerP) return workerP;
    if (!Tesseract?.createWorker) return Promise.reject(new OcrError('engine-missing'));
    const t0 = performance.now();
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
    workerP = withTimeout(created, initTimeoutMs, 'init-timeout').then((w) => {
      worker = w;
      lastInitMs = performance.now() - t0;
      scheduleIdle();
      return w;
    }, (e) => {
      workerP = null;
      created.then((w) => w.terminate()).catch(() => {});
      throw e instanceof OcrError ? e : new OcrError('init-failed', e);
    });
    return workerP;
  }

  async function dispose() {
    clearIdle();
    const w = worker;
    worker = null;
    workerP = null;
    if (w) await w.terminate().catch(() => {});
  }

  /** Serialized setParameters + recognize (mutex). */
  function run(image, params, { rectangle, signal, pass, rotation, onProgress } = {}) {
    const job = queue.then(async () => {
      signal?.throwIfAborted();
      const w = await warmUp();
      clearIdle();
      signal?.throwIfAborted();
      progressCb = onProgress ?? null;
      try {
        await w.setParameters({ user_defined_dpi: '300', ...params });
        const res = await withTimeout(w.recognize(image, rectangle ? { rectangle } : {}, { text: true, blocks: true }), recognizeTimeoutMs, 'recognize-timeout');
        signal?.throwIfAborted();
        return toOcrPage(res.data, pass, rotation);
      } catch (e) {
        if (e instanceof OcrError && e.code === 'recognize-timeout') await dispose(); // stuck worker: start fresh next time
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
    /** Sparse text pass (keywords + numbers). */
    recognizeText(image, opts = {}) {
      return run(image, { tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '' }, { ...opts, pass: 'text' });
    },
    /** Digits pass: single line by default, whitelist 0-9 and '-'. */
    recognizeDigits(image, { psm = PSM.SINGLE_LINE, ...opts } = {}) {
      return run(image, { tessedit_pageseg_mode: psm, tessedit_char_whitelist: DIGIT_WHITELIST }, { ...opts, pass: 'digits' });
    },
  };
}
