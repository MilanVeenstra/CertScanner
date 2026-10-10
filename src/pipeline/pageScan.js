// A9 page scan: discover the slab-sized images on the page, acquire each without scrolling, run the existing
// scanner per image, aggregate, route. Runs in the side panel under the trigger's activeTab grant (or an
// optional per-host grant).
import { acquireFromJob, captureViewport, cropToBlob, acquiredFromBlob, imageOriginOf } from './acquire.js';
import { pageImagesProbe } from './pageImagesProbe.js';
import { validatePageImages, MAX_PAGE_IMAGES, PAGE_MIN_RENDERED, PAGE_MIN_NATURAL } from './probeValidate.js';
import { scan, getEngines } from './scanner.js';
import { warmUpBarcodes } from './barcode.js';
import { aggregatePage, decidePage, isProminent } from '../core/pageAggregate.js';
import { isRestrictedPage } from '../core/certUrls.js';
import { raceAbort } from '../shared/raceAbort.js';

export const PAGE_SCAN_IMAGES = 8;
export const PAGE_SCAN_BUDGET_MS = 30_000;
export const CAPTURE_MIN_VISIBLE = 0.9;

const now = () => performance.now();
const ms = (x) => Math.round(x);

/** Production adapters; unit tests replace them through `deps`. */
const DEFAULT_DEPS = Object.freeze({
  acquire: (imageJob, o) => acquireFromJob(imageJob, o),
  capture: (job, o) => captureViewport(job, o),
  crop: (shot, rect, viewport) => cropToBlob(shot, rect, viewport),
  wrap: (blob, method, resolution, origin, sharper) => acquiredFromBlob(blob, method, resolution, origin, sharper),
  scan: (input, o) => scan(input, o),
  /** Start the OCR worker and the barcode module while the first image is being fetched (perf rec. 3b). */
  warmUp: (engines) => {
    const eng = engines ?? getEngines();
    Promise.resolve().then(() => eng.ocr.warmUp()).catch(() => {});
    if (!engines) warmUpBarcodes().catch(() => {});
  },
});

/** Message of a refused injection, kept short (it tells restricted pages apart from a missing grant). */
const injectMessage = (e) => String(e?.message ?? '').slice(0, 300);

/**
 * @param {import('../core/types.js').PageScanJob} job
 * @param {{settings:object, signal?:AbortSignal,
 *   onProgress?:(p:{stage:'page-discover'}|{stage:'page', index:number, total:number})=>void,
 *   onImageProgress?:(index:number, p:import('../core/types.js').ScanProgress)=>void,
 *   onImage?:(index:number, blob:Blob, info:import('../core/types.js').ImageInfo)=>void, engines?:object, chromeApi?:typeof chrome,
 *   maxImages?:number, budgetMs?:number, deps?:Partial<typeof DEFAULT_DEPS>}} opts  deps: test-only overrides
 * @returns {Promise<{jobId:string, kind:'page', status:'auto-open'|'page-results'|'none'|'error', items:object[], top:object|null,
 *   warnings:object[], images:object[], discovered:number, totalFound:number, partial:{checked:number, total:number}|null,
 *   error?:{code:string, injectFailed?:boolean, injectError?:string}, timings:object}>}
 *   `partial` is set when the page budget ran out after some images were read: the list is shown, never auto-opened.
 *   `totalFound` counts every slab-sized photo on the page (before the 24/8 caps, O10).
 *   Engines are warmed up once discovery found a photo (not when the panel opens).
 */
export async function scanPage(job, {
  settings, signal, onProgress, onImageProgress, onImage, engines, chromeApi = globalThis.chrome,
  maxImages = PAGE_SCAN_IMAGES, budgetMs = PAGE_SCAN_BUDGET_MS, deps = {},
} = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const t0 = now();
  const timings = { discoverMs: 0, captureMs: 0, totalMs: 0, images: [] };
  const sig = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)].filter(Boolean));
  const stopCode = () => (signal?.aborted ? 'aborted' : 'timeout');
  const progress = (p) => { try { onProgress?.(p); } catch { /* UI only */ } };
  const base = { jobId: job.id, kind: 'page', items: [], top: null, warnings: [], images: [], discovered: 0, totalFound: 0, partial: null };
  const finish = (status, extra = {}) => ({
    ...base, status, ...extra,
    timings: { ...timings, images: images.map(({ index, acquireMs, scanMs }) => ({ index, acquireMs, scanMs })), totalMs: ms(now() - t0) },
  });
  const perImage = [];
  const images = [];
  let found = null;
  let selected = [];
  let shot = null;
  try {
    if (isRestrictedPage(job.pageUrl)) return finish('error', { error: { code: 'restricted' } });

    // 1. Discovery (main frame only).
    progress({ stage: 'page-discover' });
    let t = now();
    try {
      const res = await raceAbort(chromeApi.scripting.executeScript({
        target: { tabId: job.tabId, frameIds: [0] }, world: 'ISOLATED', func: pageImagesProbe,
        args: [{ minRendered: PAGE_MIN_RENDERED, minNatural: PAGE_MIN_NATURAL, max: MAX_PAGE_IMAGES }],
      }), sig);
      const v = validatePageImages(res?.[0]?.result);
      found = v.ok ? v.value : { viewport: { width: 1, height: 1 }, dpr: 1, images: [], total: 0 };
    } catch (e) {
      if (sig.aborted) throw e;
      // No access to this page (grant gone, or Chrome refuses it). The message tells the two apart (O11).
      return finish('error', { error: { code: 'restricted', injectFailed: true, injectError: injectMessage(e) } });
    }
    timings.discoverMs = ms(now() - t);
    selected = found.images.slice(0, maxImages);
    if (!selected.length) return finish('none', { discovered: 0 });
    base.discovered = found.images.length;
    base.totalFound = found.total ?? found.images.length;
    try { d.warmUp(engines); } catch { /* warm-up is best effort */ }

    // 2. One viewport screenshot, only if some image is (nearly) fully visible. No scrolling in page mode.
    if (selected.some((i) => i.visibleFraction >= CAPTURE_MIN_VISIBLE)) {
      t = now();
      const c = await d.capture(job, { signal: sig, chromeApi });
      if (c.ok) shot = c.bitmap;
      timings.captureMs = ms(now() - t);
    }

    // 3. Per image: acquire (data URL -> extension fetch -> page fetch -> crop), then the existing scanner.
    for (let k = 0; k < selected.length; k++) {
      if (sig.aborted) throw sig.reason;
      const im = selected[k];
      progress({ stage: 'page', index: k + 1, total: selected.length });
      const ti = now();
      const imageJob = { v: 1, id: `${job.id}#${k}`, createdAt: job.createdAt, source: 'contextMenu', srcUrl: im.srcUrl, pageUrl: job.pageUrl, frameId: 0, tabId: job.tabId, windowId: job.windowId, mediaType: 'image' };
      let acq = null;
      // Largest same-origin srcset candidate first (extension fetch; page fetch already prefers it), else the shown image.
      if (im.srcsetBest && im.srcsetBest !== im.srcUrl) {
        acq = await d.acquire({ ...imageJob, srcUrl: im.srcsetBest }, { signal: sig, strategies: ['extension-fetch'], chromeApi });
        if (!acq.ok && (acq.reason === 'aborted' || acq.reason === 'timeout') && sig.aborted) throw sig.reason;
        if (!acq.ok) acq = null;
      }
      acq ??= await d.acquire(imageJob, { signal: sig, strategies: ['data-url', 'extension-fetch', 'page-fetch'], chromeApi });
      if (!acq.ok && (acq.reason === 'aborted' || acq.reason === 'timeout') && sig.aborted) throw sig.reason;
      if (!acq.ok && shot && im.visibleFraction >= CAPTURE_MIN_VISIBLE) {
        const blob = await d.crop(shot, im.rect, found.viewport);
        if (blob) acq = await d.wrap(blob, 'capture', 'screen', imageOriginOf(im.srcUrl), Boolean(acq.canRequestSharper));
      }
      const acquireMs = ms(now() - ti);
      if (!acq.ok) {
        images.push({ index: k, ok: false, reason: acq.reason, acquireMs });
        continue;
      }
      try { onImage?.(k, acq.blob, acq.info); } catch { /* preview only */ }
      const ts = now();
      const r = await d.scan({ kind: 'blob', blob: acq.blob, method: 'upload' }, {
        settings: { ...settings, autoOpen: false }, signal: sig, engines, acquire: async () => acq,
        onProgress: (p) => { try { onImageProgress?.(k, p); } catch { /* UI only */ } },
      });
      if (r.status === 'error') {
        if (sig.aborted) throw sig.reason;
        images.push({ index: k, ok: false, reason: r.error?.code ?? 'engine-failed', acquireMs, scanMs: ms(now() - ts) });
        continue;
      }
      perImage.push({ index: k, candidates: r.candidates, warnings: r.warnings, prominent: isProminent(im) });
      images.push({ index: k, ok: true, method: acq.info.method, resolution: acq.info.resolution, candidates: r.candidates.length, acquireMs, scanMs: ms(now() - ts), timings: r.timings });
    }

    // 4. Aggregate + route.
    const agg = aggregatePage(perImage);
    const decision = decidePage(agg, settings);
    return finish(decision.status, { items: agg.items, top: decision.item, warnings: agg.warnings, images });
  } catch (e) {
    if (sig.aborted && !signal?.aborted && perImage.length) {
      // Page budget ran out: show what was read so far, never auto-open on a partly checked page.
      const agg = aggregatePage(perImage);
      if (agg.items.length) {
        return finish('page-results', {
          items: agg.items, warnings: agg.warnings, images,
          partial: { checked: perImage.length, total: selected.length },
        });
      }
    }
    if (sig.aborted) return finish('error', { error: { code: stopCode() } });
    return finish('error', { error: { code: 'engine-failed' } });
  } finally {
    try { shot?.close(); } catch { /* closed */ }
  }
}
