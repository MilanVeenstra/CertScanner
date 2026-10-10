// A9 page scan orchestration (scanPage) with fake Chrome APIs and fake per-image acquire/scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPage } from '../../src/pipeline/pageScan.js';
import { settings } from './helpers.mjs';

const NOW = 1_760_000_000_000;
const job = (over = {}) => ({ v: 1, id: 'page-1', createdAt: NOW, kind: 'page', source: 'action', srcUrl: null, pageUrl: 'https://shop.example/item/1', frameId: 0, tabId: 3, windowId: 7, ...over });
const img = (n, over = {}) => ({ srcUrl: `https://img.example/${n}.jpg`, rect: { x: 0, y: 0, width: 300, height: 460 }, natural: { width: 680, height: 1044 }, srcsetBest: null, visibleFraction: 1, ...over });
const envelope = (images) => ({ v: 1, viewport: { width: 1280, height: 900 }, dpr: 1, images });
/** Node unrefs AbortSignal.timeout() timers; keep the loop alive while a budget test waits on one. */
const keepAlive = (msMax = 3000) => { const t = setTimeout(() => {}, msMax); return () => clearTimeout(t); };
const cand = (number, over = {}) => ({ grader: 'psa', graderOptions: ['psa'], number, confidence: 0.9, source: 'ocr', evidence: [], ...over });

function fakeChrome(images, { injectError = null } = {}) {
  const calls = [];
  return {
    calls,
    scripting: {
      executeScript: async (o) => {
        calls.push(o.func?.name);
        if (injectError) throw new Error(injectError);
        return [{ result: envelope(images) }];
      },
    },
  };
}

/** deps: acquire succeeds with a fake blob; scan returns per-URL candidates (or hangs for 'hang'). */
function deps(bySrc, { acquireFails = new Set(), log = [] } = {}) {
  return {
    acquire: async (j) => {
      log.push(['acquire', j.srcUrl]);
      if (acquireFails.has(j.srcUrl)) return { ok: false, reason: 'fetch-failed', origin: 'https://img.example', canRequestSharper: true };
      return { ok: true, bitmap: { close() {} }, blob: { size: 10, src: j.srcUrl }, info: { method: 'extension-fetch', resolution: 'full', width: 680, height: 1044, origin: 'https://img.example', canRequestSharper: false } };
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
