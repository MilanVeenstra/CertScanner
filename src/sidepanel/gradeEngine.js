// Grade check plumbing for the panel: photos are decoded with the scanner's limits (acquire.js), capped in size and
// handed to a module worker that runs the measurement (pipeline/grade/gradeWorker.js), so the panel stays responsive.
import { acquireFromBlob, acquireFromJob } from '../pipeline/acquire.js';
import { ANALYZE_MAX_SIDE } from '../pipeline/grade/analyze.js';

export const GRADE_TIMEOUT_MS = 20_000;
/** Size of the photo shown when the corners are placed by hand. */
export const PREVIEW_SIDE = 900;

/**
 * @param {{workerUrl?:string, WorkerImpl?:typeof Worker}} [o]
 * @returns {{analyze:(key:string, o?:{image?:ImageData|null, quad?:number[][]|null, signal?:AbortSignal})=>Promise<object>,
 *   forget:(key:string)=>void, dispose:()=>void}}
 */
export function createGradeEngine({ workerUrl = globalThis.chrome?.runtime?.getURL('pipeline/grade/gradeWorker.js'), WorkerImpl = globalThis.Worker } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const failAll = (err) => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); } pending.clear(); };
  const stop = (w) => { w?.terminate(); if (worker === w) worker = null; };
  function ensure() {
    if (worker) return worker;
    const w = new WorkerImpl(workerUrl, { type: 'module' });
    w.onmessage = (e) => {
      const p = pending.get(e.data?.id);
      if (!p) return;
      pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.ok) p.resolve(e.data.result); else p.reject(new Error(e.data.error || 'failed'));
    };
    w.onerror = (e) => { e?.preventDefault?.(); failAll(new Error('worker')); stop(w); };
    worker = w;
    return w;
  }
  return {
    analyze(key, { image = null, quad = null, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const id = ++seq;
        const w = ensure();
        // A stuck measurement is stopped with its worker (the photos it kept are gone too: callers send them again).
        const timer = setTimeout(() => { if (pending.delete(id)) { reject(new Error('timeout')); stop(w); } }, GRADE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        signal?.addEventListener('abort', () => { if (pending.delete(id)) { clearTimeout(timer); reject(signal.reason); } }, { once: true });
        const msg = { id, key, quad };
        if (image) {
          msg.image = { buffer: image.data.buffer, width: image.width, height: image.height };
          w.postMessage(msg, [image.data.buffer]);
        } else {
          w.postMessage(msg);
        }
      });
    },
    forget(key) { worker?.postMessage({ forget: key }); },
    dispose() { failAll(new Error('disposed')); stop(worker); },
  };
}

/** Pixel size for analysis: the photo's own size, long side at most ANALYZE_MAX_SIDE. */
export function analysisSize(width, height, max = ANALYZE_MAX_SIDE) {
  const s = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/**
 * Decode a photo (blob, or a page image from a context-menu job) and prepare it: analysis pixels (transferable) and
 * a small preview. The bitmap is closed before returning.
 * @returns {Promise<{ok:true, image:ImageData, preview:Blob, size:{width:number, height:number}, info:object}
 *   | {ok:false, reason:string, origin?:string|null, canRequestSharper?:boolean}>}
 */
export async function preparePhoto(input, { signal, Canvas = globalThis.OffscreenCanvas } = {}) {
  const acq = input.kind === 'job' ? await acquireFromJob(input.job, { signal }) : await acquireFromBlob(input.blob, input.method, { signal });
  if (!acq.ok) return acq;
  const { bitmap } = acq;
  try {
    const size = analysisSize(bitmap.width, bitmap.height);
    const canvas = new Canvas(size.width, size.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    const image = ctx.getImageData(0, 0, size.width, size.height);
    const p = analysisSize(bitmap.width, bitmap.height, PREVIEW_SIDE);
    const small = new Canvas(p.width, p.height);
    small.getContext('2d').drawImage(bitmap, 0, 0, p.width, p.height);
    const preview = await small.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    return { ok: true, image, preview, size, info: acq.info, blob: acq.blob };
  } finally {
    bitmap.close();
  }
}

/** JPEG of an RGBA buffer (the upright card), long side at most `maxSide`. Canvas output carries no EXIF or GPS data. */
export async function cardJpeg(card, { maxSide = 2000, quality = 0.9, Canvas = globalThis.OffscreenCanvas } = {}) {
  const full = new Canvas(card.width, card.height);
  full.getContext('2d').putImageData(new ImageData(card.data, card.width, card.height), 0, 0);
  const s = Math.min(1, maxSide / Math.max(card.width, card.height));
  if (s === 1) return full.convertToBlob({ type: 'image/jpeg', quality });
  const out = new Canvas(Math.round(card.width * s), Math.round(card.height * s));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(full, 0, 0, out.width, out.height);
  return out.convertToBlob({ type: 'image/jpeg', quality });
}
