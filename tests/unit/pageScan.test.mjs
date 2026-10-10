// A9 page scan: job contract, discovery validation, injected probe, aggregation/routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageJob, parseScanJob, PAGE_JOB_SOURCES } from '../../src/shared/jobContract.js';
import { validatePageImages, MAX_PAGE_IMAGES } from '../../src/pipeline/probeValidate.js';
import { pageImagesProbe } from '../../src/pipeline/pageImagesProbe.js';
import { aggregatePage, decidePage } from '../../src/core/pageAggregate.js';
import { settings } from './helpers.mjs';

const NOW = 1_760_000_000_000;
const tab = (over = {}) => ({ id: 42, windowId: 7, index: 0, url: 'https://www.ebay.com/itm/123?hash=abc#x', ...over });

// ---------------------------------------------------------------- job contract
test('createPageJob: kind page, srcUrl null, minimised pageUrl, no mediaType', () => {
  const job = createPageJob(tab(), NOW, 'id-1', 'action');
  assert.deepEqual(job, { v: 1, id: 'id-1', createdAt: NOW, kind: 'page', source: 'action', srcUrl: null, pageUrl: 'https://www.ebay.com/itm/123', frameId: 0, tabId: 42, windowId: 7 });
  assert.deepEqual(parseScanJob(job, { now: NOW, windowId: 7 }), { ok: true, job });
  assert.deepEqual([...PAGE_JOB_SOURCES].sort(), ['action', 'command', 'panel']);
  assert.equal(createPageJob(tab({ url: undefined }), NOW, 'id-2', 'command').pageUrl, ''); // no access -> restricted
});

test('parseScanJob validates page jobs and keeps image jobs (kind absent => image)', () => {
  const page = createPageJob(tab(), NOW, 'id-1', 'command');
  const bad = (patch) => assert.equal(parseScanJob({ ...page, ...patch }, { now: NOW, windowId: 7 }).ok, false, JSON.stringify(patch));
  bad({ source: 'contextMenu' });
  bad({ source: 'page' });
  bad({ srcUrl: 'https://img.example.com/a.jpg' });
  bad({ kind: 'video' });
  bad({ tabId: -1 });
  bad({ pageUrl: 5 });
  bad({ mediaType: 'image' });
  const image = { v: 1, id: 'x', createdAt: NOW, source: 'contextMenu', srcUrl: 'https://img.example.com/a.jpg', pageUrl: 'https://shop.example.com/', frameId: 0, tabId: 1, windowId: 7, mediaType: 'image' };
  assert.equal(parseScanJob(image, { now: NOW, windowId: 7 }).ok, true);
  assert.equal(parseScanJob({ ...image, kind: 'image' }, { now: NOW, windowId: 7 }).ok, true);
  assert.equal('kind' in parseScanJob({ ...image, kind: 'image' }, { now: NOW, windowId: 7 }).job, false);
  assert.equal(parseScanJob({ ...image, source: 'action' }, { now: NOW, windowId: 7 }).ok, false);
});

// ---------------------------------------------------------------- discovery validation
const img = (over = {}) => ({ srcUrl: 'https://i.ebayimg.com/images/a/s-l1600.jpg', rect: { x: 10, y: 20, width: 300, height: 461 }, natural: { width: 680, height: 1044 }, srcsetBest: null, visibleFraction: 1, ...over });
const env = (images) => ({ v: 1, viewport: { width: 1280, height: 900 }, dpr: 1, images });

test('validatePageImages accepts a well-formed result and returns clean copies sorted visible-first', () => {
  const r = validatePageImages(env([img({ visibleFraction: 0.2 }), img({ srcUrl: 'https://i.ebayimg.com/b.jpg', visibleFraction: 1, extra: 'x' })]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.images.map((i) => i.srcUrl), ['https://i.ebayimg.com/b.jpg', 'https://i.ebayimg.com/images/a/s-l1600.jpg']);
  assert.equal('extra' in r.value.images[0], false);
  assert.deepEqual(r.value.viewport, { width: 1280, height: 900 });
});

test('validatePageImages: hostile envelope is rejected', () => {
  for (const raw of [null, 'x', 5, [], { v: 2, viewport: { width: 1, height: 1 }, dpr: 1, images: [] }, { ...env([]), images: 'x' }, { ...env([]), dpr: 0 }, { ...env([]), dpr: 9 }, { ...env([]), viewport: { width: NaN, height: 1 } }]) {
    assert.equal(validatePageImages(raw).ok, false, JSON.stringify(raw));
  }
});

test('validatePageImages drops hostile images individually, enforces size rules, cap and dedupe', () => {
  const r = validatePageImages(env([
    img({ srcUrl: 'javascript:alert(1)' }),
    img({ srcUrl: 'chrome://settings' }),
    img({ srcUrl: 'x'.repeat(10) }),
    img({ srcUrl: 'https://a.example/1.jpg', rect: { x: NaN, y: 0, width: 300, height: 300 } }),
    img({ srcUrl: 'https://a.example/2.jpg', rect: { x: 0, y: 0, width: 100, height: 400 } }), // rendered short side < 120
    img({ srcUrl: 'https://a.example/3.jpg', natural: { width: 140, height: 900 } }),        // natural short side < 150
    img({ srcUrl: 'https://a.example/4.jpg', visibleFraction: 1.5 }),
    img({ srcUrl: 'https://a.example/5.svg' }),
    img({ srcUrl: 'data:image/svg+xml;base64,AAAA' }),
    img({ srcUrl: 'https://a.example/6.jpg', srcsetBest: 'https://evil.example/big.jpg' }),
    img({ srcUrl: 'https://a.example/6.jpg' }), // duplicate
    img({ srcUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
    img({ srcUrl: 'blob:https://a.example/0b0b5ef6' }),
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.images.map((i) => i.srcUrl), ['https://a.example/6.jpg', 'data:image/png;base64,iVBORw0KGgo=', 'blob:https://a.example/0b0b5ef6']);
  assert.equal(r.value.images[0].srcsetBest, null);
  const many = validatePageImages(env(Array.from({ length: 40 }, (_, i) => img({ srcUrl: `https://a.example/${i}.jpg` }))));
  assert.equal(many.value.images.length, MAX_PAGE_IMAGES);
  assert.equal(MAX_PAGE_IMAGES, 24);
});

// ---------------------------------------------------------------- injected probe
test('pageImagesProbe is self-contained and finds large, loaded, non-SVG images only', async () => {
  const src = pageImagesProbe.toString();
  assert.match(src, /^async function pageImagesProbe\(opts\)/);
  assert.doesNotMatch(src, /\bimport\b|\brequire\(/);
  const fn = new Function(`return (${src});`)();
  const mk = (srcUrl, rect, natural, extra = {}) => ({
    currentSrc: srcUrl, src: srcUrl, complete: true, naturalWidth: natural[0], naturalHeight: natural[1],
    getAttribute: (n) => (n === 'srcset' ? extra.srcset ?? null : null), parentElement: { tagName: 'DIV' },
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }),
  });
  const saved = { document: globalThis.document, window: globalThis.window, devicePixelRatio: globalThis.devicePixelRatio };
  globalThis.document = {
    baseURI: 'https://shop.example/', images: [
      mk('https://shop.example/a.jpg', [0, 0, 300, 460], [680, 1044]),
      mk('https://shop.example/b.jpg', [0, 1000, 300, 460], [680, 1044]), // below the fold
      mk('https://shop.example/icon.png', [0, 0, 40, 40], [80, 80]),
      mk('https://shop.example/logo.svg', [0, 0, 300, 300], [300, 300]),
      mk('https://shop.example/lazy.jpg', [0, 0, 300, 460], [0, 0]),
      mk('https://shop.example/a.jpg', [0, 0, 300, 460], [680, 1044]),
    ],
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 900, devicePixelRatio: 1 };
  try {
    const r = await fn({ minRendered: 120, minNatural: 150, max: 24 });
    assert.equal(r.v, 1);
    assert.deepEqual(r.images.map((i) => i.srcUrl), ['https://shop.example/a.jpg', 'https://shop.example/b.jpg']);
    assert.equal(r.images[0].visibleFraction, 1);
    assert.equal(r.images[1].visibleFraction, 0);
    assert.equal(validatePageImages(r).ok, true);
  } finally {
    Object.assign(globalThis, saved);
  }
});

// ---------------------------------------------------------------- aggregation + routing
const cand = (over = {}) => ({ grader: 'psa', graderOptions: ['psa'], number: '01234567', confidence: 0.89, source: 'ocr', evidence: [], ...over });
const per = (index, candidates, warnings = []) => ({ index, status: 'confirm', candidates, warnings });

test('aggregatePage merges by grader+number keeping the best confidence and its image', () => {
  const a = aggregatePage([per(0, [cand({ confidence: 0.6 })]), per(1, [cand({ confidence: 0.89 })]), per(2, [cand({ number: '4012345001', grader: 'cgc-comics', graderOptions: ['cgc-comics'], confidence: 0.95 })])]);
  assert.deepEqual(a.items.map((i) => [i.number, i.grader, i.confidence, i.imageIndex, i.seenIn]), [
    ['4012345001', 'cgc-comics', 0.95, 2, [2]],
    ['01234567', 'psa', 0.89, 1, [0, 1]],
  ]);
});

test('decidePage: one confident number on the page auto-opens', () => {
  const a = aggregatePage([per(0, [cand()]), per(1, [cand({ confidence: 0.7 })]), per(2, [])]);
  assert.equal(decidePage(a, settings()).status, 'auto-open');
  assert.equal(decidePage(a, settings()).item.number, '01234567');
  assert.equal(decidePage(a, settings({ autoOpen: false })).status, 'page-results');
});

test('decidePage: several different slabs -> results list, never auto-open', () => {
  const a = aggregatePage([per(0, [cand()]), per(1, [cand({ number: '4012345001', grader: 'cgc-comics', graderOptions: ['cgc-comics'], confidence: 0.95 })])]);
  assert.equal(decidePage(a, settings()).status, 'page-results');
});

test('decidePage: a competitor >= .50 in any image blocks; below .50 does not', () => {
  const block = aggregatePage([per(0, [cand()]), per(3, [cand({ number: '87654321', confidence: 0.5 })])]);
  assert.equal(decidePage(block, settings()).status, 'page-results');
  const ok = aggregatePage([per(0, [cand()]), per(3, [cand({ number: '87654321', confidence: 0.45 })])]);
  assert.equal(decidePage(ok, settings()).status, 'auto-open');
});

test('decidePage: same number with two graders is ambiguous; grader null never auto-opens', () => {
  const two = aggregatePage([per(0, [cand({ number: '4012345001', grader: 'cgc-comics', graderOptions: ['cgc-comics'], confidence: 0.95 })]), per(1, [cand({ number: '4012345001', grader: 'cgc-cards', graderOptions: ['cgc-cards'], confidence: 0.9 })])]);
  assert.equal(decidePage(two, settings()).status, 'page-results');
  const unknown = aggregatePage([per(0, [cand({ grader: null, graderOptions: ['cgc-comics', 'cgc-cards', 'psa'], number: '5012345678', confidence: 0.95 })])]);
  assert.equal(decidePage(unknown, settings()).status, 'page-results');
});

test('decidePage: off-site QR in the confident number\'s image blocks auto-open; nothing found -> none', () => {
  const qr = aggregatePage([per(0, [cand()], [{ code: 'qr-untrusted-host', detail: 'evil.example' }])]);
  assert.equal(decidePage(qr, settings()).status, 'page-results');
  assert.deepEqual(qr.warnings, [{ code: 'qr-untrusted-host', detail: 'evil.example' }]);
  assert.equal(decidePage(aggregatePage([per(0, []), per(1, [])]), settings()).status, 'none');
  assert.equal(decidePage(aggregatePage([]), settings()).status, 'none');
});
