// A9 page scan orchestration (scanPage) with fake Chrome APIs and fake per-image acquire/scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPage } from '../../src/pipeline/pageScan.js';
import { aggregatePage, decidePage } from '../../src/core/pageAggregate.js';
import { settings } from './helpers.mjs';

const NOW = 1_760_000_000_000;
const job = (over = {}) => ({ v: 1, id: 'page-1', createdAt: NOW, kind: 'page', source: 'action', srcUrl: null, pageUrl: 'https://shop.example/item/1', frameId: 0, tabId: 3, windowId: 7, ...over });
const img = (n, over = {}) => ({ srcUrl: `https://img.example/${n}.jpg`, rect: { x: 0, y: 0, width: 300, height: 460 }, natural: { width: 680, height: 1044 }, srcsetBest: null, visibleFraction: 1, topmostAtCenter: true, ...over });
const envelope = (images, extra = {}) => ({ v: 1, viewport: { width: 1280, height: 900 }, dpr: 1, images, ...extra });
/** Node unrefs AbortSignal.timeout() timers; keep the loop alive while a budget test waits on one. */
const keepAlive = (msMax = 3000) => { const t = setTimeout(() => {}, msMax); return () => clearTimeout(t); };
const cand = (number, over = {}) => ({ grader: 'psa', graderOptions: ['psa'], number, confidence: 0.9, source: 'ocr', evidence: [], ...over });

function fakeChrome(images, { injectError = null, total } = {}) {
  const calls = [];
  return {
    calls,
    scripting: {
      executeScript: async (o) => {
        calls.push(o.func?.name);
        if (injectError) throw new Error(injectError);
        return [{ result: envelope(images, total === undefined ? {} : { total }) }];
      },
    },
  };
}

/** deps: acquire succeeds with a fake blob; scan returns per-URL candidates (or hangs for 'hang'). */
function deps(bySrc, { acquireFails = new Set(), log = [] } = {}) {
  return {
    warmUp: () => log.push(['warmUp']),
    acquire: async (j, o) => {
      log.push(['acquire', j.srcUrl, ...(o?.strategies ? [o.strategies.join('+')] : []), ...(o?.pageFetch ? [o.pageFetch] : [])]);
      // page fetch in 'srcset' mode loads the srcset candidate of the displayed image (job.srcUrl stays the displayed URL)
      const src = o?.pageFetch === 'srcset' ? `${j.srcUrl}#srcset` : j.srcUrl;
      if (acquireFails.has(src)) return { ok: false, reason: 'fetch-failed', origin: 'https://img.example', canRequestSharper: true };
      return { ok: true, bitmap: { close() {} }, blob: { size: 10, src }, info: { method: 'extension-fetch', resolution: 'full', width: 680, height: 1044, origin: 'https://img.example', canRequestSharper: false } };
    },
    capture: async () => ({ ok: true, bitmap: { width: 1280, height: 900, close() {} } }),
    crop: async (_shot, rect) => ({ size: 5, rect }),
    wrap: async (blob, method, resolution, origin) => ({ ok: true, bitmap: { close() {} }, blob, info: { method, resolution, width: blob.rect.width, height: blob.rect.height, origin, canRequestSharper: false } }),
    scan: async (input, { signal, onProgress }) => {
      const src = input.blob.src ?? `crop:${input.blob.rect?.x}`;
      log.push(['scan', src]);
      onProgress?.({ stage: 'acquire' });
      onProgress?.({ stage: 'ocr' });
      const r = bySrc[src];
      if (r === 'hang') {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { status: r?.length ? 'confirm' : 'none', candidates: r ?? [], warnings: [], imageInfo: null, timings: { totalMs: 1 } };
    },
  };
}

test('scanPage: restricted page never injects', async () => {
  const c = fakeChrome([img(1)]);
  const r = await scanPage(job({ pageUrl: 'chrome://version/' }), { settings: settings(), chromeApi: c, deps: deps({}) });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'restricted');
  assert.deepEqual(c.calls, []);
});

test('scanPage: discovery refused by Chrome -> restricted (with injectFailed)', async () => {
  const c = fakeChrome([], { injectError: 'Cannot access contents of the page.' });
  const r = await scanPage(job(), { settings: settings(), chromeApi: c, deps: deps({}) });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'restricted');
  assert.equal(r.error.injectFailed, true);
});

test('scanPage: progress per image, per-image steps, thumbnails, one confident number auto-opens', async () => {
  const progress = [];
  const steps = [];
  const thumbs = [];
  const c = fakeChrome([img(1), img(2), img(3)]);
  const r = await scanPage(job(), {
    settings: settings(), chromeApi: c,
    deps: deps({ 'https://img.example/1.jpg': [cand('01234567')], 'https://img.example/2.jpg': [], 'https://img.example/3.jpg': [cand('01234567', { confidence: 0.6 })] }),
    onProgress: (p) => progress.push(p.stage === 'page' ? `${p.index}/${p.total}` : p.stage),
    onImageProgress: (i, p) => steps.push(`${i}:${p.stage}`),
    onImage: (i) => thumbs.push(i),
  });
  assert.equal(r.status, 'auto-open');
  assert.equal(r.top.number, '01234567');
  assert.deepEqual(r.top.seenIn, [0, 2]);
  assert.deepEqual(progress, ['page-discover', '1/3', '2/3', '3/3']);
  assert.deepEqual(steps, ['0:acquire', '0:ocr', '1:acquire', '1:ocr', '2:acquire', '2:ocr']);
  assert.deepEqual(thumbs, [0, 1, 2]);
  assert.equal(r.discovered, 3);
  assert.equal(r.partial, null);
  assert.equal(r.timings.images.length, 3);
});

test('scanPage: at most 8 images, visible first; crop fallback only for visible images', async () => {
  const log = [];
  const many = Array.from({ length: 12 }, (_, i) => img(i, { visibleFraction: i < 2 ? 1 : 0 }));
  const c = fakeChrome(many);
  const fails = new Set(['https://img.example/0.jpg', 'https://img.example/5.jpg']);
  const r = await scanPage(job(), { settings: settings(), chromeApi: c, deps: deps({}, { acquireFails: fails, log }) });
  assert.equal(r.status, 'none');
  assert.equal(r.images.length, 8);
  assert.equal(r.discovered, 12);
  // image 0 is visible -> cropped from the screenshot; image 5 is off-screen -> skipped
  assert.equal(r.images[0].ok, true);
  assert.equal(r.images[0].method, 'capture');
  assert.equal(r.images.find((x) => x.index === 5).ok, false);
});

test('scanPage: two different confident numbers -> results list, never auto-open', async () => {
  const c = fakeChrome([img(1), img(2)]);
  const r = await scanPage(job(), { settings: settings(), chromeApi: c, deps: deps({ 'https://img.example/1.jpg': [cand('01234567')], 'https://img.example/2.jpg': [cand('4012345001', { grader: 'cgc-comics', graderOptions: ['cgc-comics'], confidence: 0.95 })] }) });
  assert.equal(r.status, 'page-results');
  assert.deepEqual(r.items.map((i) => i.number), ['4012345001', '01234567']);
});

test('scanPage: budget runs out mid-page -> partial results list (never auto-open), or timeout when nothing was read', async (t) => {
  t.after(keepAlive());
  const c = fakeChrome([img(1), img(2), img(3)]);
  const r = await scanPage(job(), {
    settings: settings(), chromeApi: c, budgetMs: 150,
    deps: deps({ 'https://img.example/1.jpg': [cand('01234567')], 'https://img.example/2.jpg': 'hang' }),
  });
  assert.equal(r.status, 'page-results');
  assert.deepEqual(r.partial, { checked: 1, total: 3 });
  assert.deepEqual(r.items.map((i) => i.number), ['01234567']);

  const none = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([img(1)]), budgetMs: 100, deps: deps({ 'https://img.example/1.jpg': 'hang' }) });
  assert.equal(none.status, 'error');
  assert.equal(none.error.code, 'timeout');
});

test('scanPage: Cancel settles promptly with aborted and discards partial results', async () => {
  const ctl = new AbortController();
  const c = fakeChrome([img(1), img(2)]);
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 60);
  const r = await scanPage(job(), { settings: settings(), chromeApi: c, signal: ctl.signal, deps: deps({ 'https://img.example/1.jpg': [cand('01234567')], 'https://img.example/2.jpg': 'hang' }) });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'aborted');
  assert.ok(Date.now() - t0 < 1000);
});

test('scanPage: per-image scans never auto-open on their own (autoOpen forced off)', async () => {
  let seen = null;
  const d = deps({ 'https://img.example/1.jpg': [cand('01234567')] });
  const inner = d.scan;
  d.scan = async (input, o) => { seen = o.settings.autoOpen; return inner(input, o); };
  await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([img(1)]), deps: d });
  assert.equal(seen, false);
});

// ---------------------------------------------------------------- S8: SEC-13, srcset, warm-up, O10, O11

test('SEC-13 T1: the only slab image is off-screen or covered -> results list, never auto-open', async () => {
  for (const hidden of [{ visibleFraction: 0, topmostAtCenter: false }, { visibleFraction: 1, topmostAtCenter: false }, { visibleFraction: 0.3, topmostAtCenter: true }]) {
    const c = fakeChrome([img(1, hidden)]);
    const r = await scanPage(job(), { settings: settings(), chromeApi: c, deps: deps({ 'https://img.example/1.jpg': [cand('81234567')] }) });
    assert.equal(r.status, 'page-results', JSON.stringify(hidden));
    assert.equal(r.top, null);
    assert.deepEqual(r.items.map((i) => i.number), ['81234567']);
  }
  const shown = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([img(1)]), deps: deps({ 'https://img.example/1.jpg': [cand('81234567')] }) });
  assert.equal(shown.status, 'auto-open');
});

test('SEC-20 rule 3: the displayed image is read first (page fetch limited to it); a confident read skips srcset', async () => {
  const log = [];
  const big = 'https://img.example/1-1600.jpg';
  const r = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([img(1, { srcsetBest: big })]), deps: deps({ 'https://img.example/1.jpg': [cand('01234567')] }, { log }) });
  assert.deepEqual(log.filter((x) => x[0] === 'acquire'), [['acquire', 'https://img.example/1.jpg', 'data-url+extension-fetch+page-fetch', 'displayed']]);
  assert.equal(r.status, 'auto-open');
  assert.equal(r.top.displayedConfidence, 0.9);
});

test('SEC-20 rule 3: srcset swap - displayed slab A unclear, srcset bytes read slab B -> list, B never auto-opens', async () => {
  const log = [];
  const big = 'https://img.example/1-4000.jpg';
  const r = await scanPage(job(), {
    settings: settings(), chromeApi: fakeChrome([img(1, { srcsetBest: big })]),
    deps: deps({ 'https://img.example/1.jpg': [cand('108114622', { confidence: 0.6 })], [big]: [cand('01234567', { confidence: 0.95 })] }, { log }),
  });
  assert.deepEqual(log.filter((x) => x[0] === 'acquire').map((x) => x.slice(1)), [
    ['https://img.example/1.jpg', 'data-url+extension-fetch+page-fetch', 'displayed'],
    [big, 'extension-fetch'],
  ]);
  assert.equal(r.status, 'page-results');
  const b = r.items.find((i) => i.number === '01234567');
  assert.ok(b.evidence.includes('src:srcset-best'));
  assert.equal(b.displayedConfidence, null);
  assert.deepEqual(r.images[0].srcset, { ok: true, method: 'extension-fetch', candidates: 1, ms: r.images[0].srcset.ms });
});

test('SEC-20 rule 3: a number read only from srcset bytes never auto-opens, even alone; page fetch of srcset when extension fetch fails', async () => {
  const log = [];
  const big = 'https://img.example/1-1600.jpg';
  const r = await scanPage(job(), {
    settings: settings(), chromeApi: fakeChrome([img(1, { srcsetBest: big })]),
    deps: deps({ 'https://img.example/1.jpg': [], 'https://img.example/1.jpg#srcset': [cand('01234567', { confidence: 0.95 })] }, { log, acquireFails: new Set([big]) }),
  });
  assert.deepEqual(log.filter((x) => x[0] === 'acquire').map((x) => x.slice(1)), [
    ['https://img.example/1.jpg', 'data-url+extension-fetch+page-fetch', 'displayed'],
    [big, 'extension-fetch'],
    ['https://img.example/1.jpg', 'page-fetch', 'srcset'],
  ]);
  assert.equal(r.status, 'page-results');
  assert.deepEqual(r.items.map((i) => i.number), ['01234567']);
  // The same number also read (unclearly) from the displayed bytes: the >= 0.80 read is still srcset-only.
  const merged = await scanPage(job(), {
    settings: settings(), chromeApi: fakeChrome([img(1, { srcsetBest: big })]),
    deps: deps({ 'https://img.example/1.jpg': [cand('01234567', { confidence: 0.6 })], [big]: [cand('01234567', { confidence: 0.95 })] }),
  });
  assert.equal(merged.status, 'page-results');
  assert.equal(merged.items[0].confidence, 0.95);
  assert.equal(merged.items[0].displayedConfidence, 0.6);
});

test('SEC-20 decidePage: auto-open needs a >= 0.80 read from displayed bytes', () => {
  const srcset = { evidence: ['len:8', 'src:srcset-best'] };
  assert.equal(decidePage(aggregatePage([{ index: 0, prominent: true, warnings: [], candidates: [cand('01234567', srcset)] }]), settings()).status, 'page-results');
  assert.equal(decidePage(aggregatePage([{ index: 0, prominent: true, warnings: [], candidates: [cand('01234567')] }]), settings()).status, 'auto-open');
  assert.equal(decidePage(aggregatePage([
    { index: 0, prominent: true, warnings: [], candidates: [cand('01234567', { confidence: 0.85 })] },
    { index: 0, prominent: true, warnings: [], candidates: [cand('01234567', { confidence: 0.95, ...srcset })] },
  ]), settings()).status, 'auto-open', 'displayed 0.85 + srcset 0.95 of the same number');
});

test('engines are warmed up once, right after discovery found a photo; not for pages without photos', async () => {
  const log = [];
  await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([img(1), img(2)]), deps: deps({}, { log }) });
  assert.deepEqual(log.slice(0, 2).map((x) => x[0]), ['warmUp', 'acquire']);
  assert.equal(log.filter((x) => x[0] === 'warmUp').length, 1);
  const none = [];
  const r = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([]), deps: deps({}, { log: none }) });
  assert.equal(r.status, 'none');
  assert.deepEqual(none, []);
});

test('O10: totalFound counts every slab-sized photo on the page, beyond the 24/8 caps', async () => {
  const many = Array.from({ length: 10 }, (_, i) => img(i));
  const r = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome(many, { total: 30 }), deps: deps({}) });
  assert.equal(r.images.length, 8);
  assert.equal(r.discovered, 10);
  assert.equal(r.totalFound, 30);
  const r2 = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome(many.slice(0, 3)), deps: deps({}) });
  assert.equal(r2.totalFound, 3);
});

test('O11: a refused discovery keeps a short copy of Chrome\'s message (restricted vs no access)', async () => {
  const r = await scanPage(job(), { settings: settings(), chromeApi: fakeChrome([], { injectError: `Cannot access contents of the page. ${'x'.repeat(500)}` }), deps: deps({}) });
  assert.equal(r.error.code, 'restricted');
  assert.equal(r.error.injectFailed, true);
  assert.match(r.error.injectError, /^Cannot access contents of the page\./);
  assert.ok(r.error.injectError.length <= 300);
});
