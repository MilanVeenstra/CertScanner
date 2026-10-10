// A9 page scan: discover the slab-sized images on the page, acquire each without scrolling, run the existing
// scanner per image, aggregate, route. Runs in the side panel under the trigger's activeTab grant.
import { acquireFromJob, captureViewport, cropToBlob, acquiredFromBlob, imageOriginOf } from './acquire.js';
import { pageImagesProbe } from './pageImagesProbe.js';
import { validatePageImages, MAX_PAGE_IMAGES, PAGE_MIN_RENDERED, PAGE_MIN_NATURAL } from './probeValidate.js';
import { scan } from './scanner.js';
import { aggregatePage, decidePage } from '../core/pageAggregate.js';
import { isRestrictedPage } from '../core/certUrls.js';
import { raceAbort } from '../shared/raceAbort.js';

export const PAGE_SCAN_IMAGES = 8;
export const PAGE_SCAN_BUDGET_MS = 30_000;
export const CAPTURE_MIN_VISIBLE = 0.9;

const now = () => performance.now();
const ms = (x) => Math.round(x);

/**
 * @param {import('../core/types.js').PageScanJob} job
 * @param {{settings:object, signal?:AbortSignal, onProgress?:(p:{stage:'page-discover'}|{stage:'page', index:number, total:number})=>void,
 *   onImage?:(index:number, blob:Blob)=>void, engines?:object, chromeApi?:typeof chrome, maxImages?:number, budgetMs?:number}} opts
 * @returns {Promise<{jobId:string, kind:'page', status:'auto-open'|'page-results'|'none'|'error', items:object[], top:object|null,
 *   warnings:object[], images:object[], discovered:number, error?:{code:string}, timings:object}>}
 */
export async function scanPage(job, { settings, signal, onProgress, onImage, engines, chromeApi = globalThis.chrome, maxImages = PAGE_SCAN_IMAGES, budgetMs = PAGE_SCAN_BUDGET_MS } = {}) {
  const t0 = now();
  const timings = { discoverMs: 0, captureMs: 0, totalMs: 0, images: [] };
  const sig = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)].filter(Boolean));
  const stopCode = () => (signal?.aborted ? 'aborted' : 'timeout');
  const progress = (p) => { try { onProgress?.(p); } catch { /* UI only */ } };
  const base = { jobId: job.id, kind: 'page', items: [], top: null, warnings: [], images: [], discovered: 0 };
  const finish = (status, extra = {}) => ({ ...base, status, ...extra, timings: { ...timings, totalMs: ms(now() - t0) } });
  let shot = null;
  try {
    if (isRestrictedPage(job.pageUrl)) return finish('error', { error: { code: 'restricted' } });

    // 1. Discovery (main frame only).
    progress({ stage: 'page-discover' });
    let t = now();
    let found;
    try {
      const res = await raceAbort(chromeApi.scripting.executeScript({
        target: { tabId: job.tabId, frameIds: [0] }, world: 'ISOLATED', func: pageImagesProbe,
        args: [{ minRendered: PAGE_MIN_RENDERED, minNatural: PAGE_MIN_NATURAL, max: MAX_PAGE_IMAGES }],
      }), sig);
      const v = validatePageImages(res?.[0]?.result);
      found = v.ok ? v.value : { viewport: { width: 1, height: 1 }, dpr: 1, images: [] };
    } catch (e) {
      if (sig.aborted) throw e;
      return finish('error', { error: { code: 'restricted' } }); // no access to this page (or Chrome refuses it)
    }
    timings.discoverMs = ms(now() - t);
    const selected = found.images.slice(0, maxImages);
    if (!selected.length) return finish('none', { discovered: 0 });

    // 2. One viewport screenshot, only if some image is (nearly) fully visible. No scrolling in page mode.
    if (selected.some((i) => i.visibleFraction >= CAPTURE_MIN_VISIBLE)) {
      t = now();
      const c = await captureViewport(job, { signal: sig, chromeApi });
      if (c.ok) shot = c.bitmap;
      timings.captureMs = ms(now() - t);
    }

    // 3. Per image: acquire (data URL -> extension fetch -> page fetch -> crop), then the existing scanner.
    const perImage = [];
    const images = [];
    for (let k = 0; k < selected.length; k++) {
      if (sig.aborted) throw sig.reason;
      const im = selected[k];
      progress({ stage: 'page', index: k + 1, total: selected.length });
      const ti = now();
      const imageJob = { v: 1, id: `${job.id}#${k}`, createdAt: job.createdAt, source: 'contextMenu', srcUrl: im.srcUrl, pageUrl: job.pageUrl, frameId: 0, tabId: job.tabId, windowId: job.windowId, mediaType: 'image' };
      let acq = await acquireFromJob(imageJob, { signal: sig, strategies: ['data-url', 'extension-fetch', 'page-fetch'], chromeApi });
      if (!acq.ok && (acq.reason === 'aborted' || acq.reason === 'timeout')) throw sig.reason ?? new DOMException('aborted', 'AbortError');
      if (!acq.ok && shot && im.visibleFraction >= CAPTURE_MIN_VISIBLE) {
        const blob = await cropToBlob(shot, im.rect, found.viewport);
        if (blob) acq = await acquiredFromBlob(blob, 'capture', 'screen', imageOriginOf(im.srcUrl), Boolean(acq.canRequestSharper));
      }
      const acquireMs = ms(now() - ti);
      if (!acq.ok) {
        images.push({ index: k, ok: false, reason: acq.reason, acquireMs });
        continue;
      }
      try { onImage?.(k, acq.blob, acq.info); } catch { /* preview only */ }
      const ts = now();
      const r = await scan({ kind: 'blob', blob: acq.blob, method: 'upload' }, {
        settings: { ...settings, autoOpen: false }, signal: sig, engines, acquire: async () => acq,
      });
      if (r.status === 'error') {
        if (sig.aborted) throw sig.reason;
        images.push({ index: k, ok: false, reason: r.error?.code ?? 'engine-failed', acquireMs, scanMs: ms(now() - ts) });
        continue;
      }
      perImage.push({ index: k, candidates: r.candidates, warnings: r.warnings });
      images.push({ index: k, ok: true, method: acq.info.method, resolution: acq.info.resolution, candidates: r.candidates.length, acquireMs, scanMs: ms(now() - ts), timings: r.timings });
    }
    timings.images = images.map(({ index, acquireMs, scanMs }) => ({ index, acquireMs, scanMs }));

    // 4. Aggregate + route.
    const agg = aggregatePage(perImage);
    const decision = decidePage(agg, settings);
    return finish(decision.status, { items: agg.items, top: decision.item, warnings: agg.warnings, images, discovered: found.images.length });
  } catch (e) {
    if (sig.aborted) return finish('error', { error: { code: stopCode() } });
    return finish('error', { error: { code: 'engine-failed' } });
  } finally {
    try { shot?.close(); } catch { /* closed */ }
  }
}
