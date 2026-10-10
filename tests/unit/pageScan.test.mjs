// A9 page scan: job contract, discovery validation, injected probe, aggregation/routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageJob, parseScanJob, PAGE_JOB_SOURCES } from '../../src/shared/jobContract.js';
import { validatePageImages, MAX_PAGE_IMAGES } from '../../src/pipeline/probeValidate.js';
import { pageImagesProbe } from '../../src/pipeline/pageImagesProbe.js';
import { aggregatePage, decidePage, isProminent, PROMINENT_MIN_VISIBLE } from '../../src/core/pageAggregate.js';
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
const per = (index, candidates, warnings = [], prominent = true) => ({ index, status: 'confirm', candidates, warnings, prominent });

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

// ---------------------------------------------------------------- SEC-13 / SEC-19 / O10 (S8)

/** Fake DOM for pageImagesProbe: images with geometry, CSS visibility, hit-test result and opacity. */
function withFakeDom({ images, hits = new Map(), styles = new Map() }, fn) {
  const saved = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    baseURI: 'https://shop.example/', images,
    elementsFromPoint: (x, y) => {
      for (const [el, box] of hits) if (x >= box[0] && x < box[0] + box[2] && y >= box[1] && y < box[1] + box[3]) return [el];
      return [];
    },
  };
  globalThis.window = {
    innerWidth: 1280, innerHeight: 900, devicePixelRatio: 1,
    getComputedStyle: (el) => ({ opacity: '1', pointerEvents: 'auto', ...(styles.get(el) ?? {}) }),
  };
  return Promise.resolve().then(fn).finally(() => Object.assign(globalThis, saved));
}
const probeFn = () => new Function(`return (${pageImagesProbe.toString()});`)();
function fakeImg(srcUrl, rect, { natural = [680, 1044], visible = true, parent = null } = {}) {
  return {
    currentSrc: srcUrl, src: srcUrl, complete: true, naturalWidth: natural[0], naturalHeight: natural[1],
    getAttribute: () => null, parentElement: parent ?? { tagName: 'DIV', parentElement: null },
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }),
    checkVisibility: () => visible,
  };
}

test('SEC-13 probe: CSS-hidden images are skipped (checkVisibility with opacity and visibility checks)', async () => {
  let opts = null;
  const hidden = fakeImg('https://shop.example/slab-b.jpg', [0, 0, 300, 460], { visible: false });
  hidden.checkVisibility = (o) => { opts = o; return false; };
  const shown = fakeImg('https://shop.example/slab-a.jpg', [400, 0, 300, 460]);
  await withFakeDom({ images: [hidden, shown], hits: new Map([[shown, [400, 0, 300, 460]]]) }, async () => {
    const r = await probeFn()({});
    assert.deepEqual(r.images.map((i) => i.srcUrl), ['https://shop.example/slab-a.jpg']);
    assert.equal(opts.checkOpacity, true);
    assert.equal(opts.checkVisibilityCSS, true);
  });
});

test('SEC-13 probe: topmostAtCenter = the image is hit first at the centre of its visible part and is mostly opaque', async () => {
  const top = fakeImg('https://shop.example/top.jpg', [0, 0, 300, 460]);
  const covered = fakeImg('https://shop.example/covered.jpg', [400, 0, 300, 460]);
  const cover = { contains: () => false };
  const wrap = { tagName: 'A', parentElement: null, contains: (el) => el === inert };
  const inert = fakeImg('https://shop.example/inert.jpg', [800, 0, 300, 460], { parent: wrap });
  const faint = fakeImg('https://shop.example/faint.jpg', [0, 500, 300, 380]);
  const offscreen = fakeImg('https://shop.example/off.jpg', [0, 2000, 300, 460]);
  const partly = fakeImg('https://shop.example/partly.jpg', [1100, 0, 300, 460]); // 180 of 300 px visible
  const hits = new Map([[top, [0, 0, 300, 460]], [cover, [400, 0, 300, 460]], [wrap, [800, 0, 300, 460]], [faint, [0, 500, 300, 380]], [partly, [1100, 0, 180, 460]]]);
  const styles = new Map([[inert, { pointerEvents: 'none' }], [faint, { opacity: '0.3' }]]);
  await withFakeDom({ images: [top, covered, inert, faint, offscreen, partly], hits, styles }, async () => {
    const r = await probeFn()({});
    const by = Object.fromEntries(r.images.map((i) => [i.srcUrl.split('/').pop(), i.topmostAtCenter]));
    assert.deepEqual(by, { 'top.jpg': true, 'covered.jpg': false, 'inert.jpg': true, 'faint.jpg': false, 'off.jpg': false, 'partly.jpg': true });
    const v = validatePageImages(r);
    assert.equal(v.ok, true);
    assert.equal(v.value.images.find((i) => i.srcUrl.endsWith('covered.jpg')).topmostAtCenter, false);
  });
});

test('SEC-13 probe: an ancestor hit first does not count when the image itself is hit-testable (pseudo-element cover)', async () => {
  const wrap = { tagName: 'DIV', parentElement: null, contains: (el) => el === img };
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460], { parent: wrap });
  await withFakeDom({ images: [img], hits: new Map([[wrap, [0, 0, 300, 460]]]) }, async () => {
    const r = await probeFn()({});
    assert.equal(r.images[0].topmostAtCenter, false);
  });
});

test('SEC-19 probe + validation: only raster data: images; total counts every qualifying image before the cap', async () => {
  const imgs = [
    fakeImg('data:text/html;base64,PGgxPg==', [0, 0, 300, 460]),
    fakeImg('data:image/svg+xml;base64,AAAA', [0, 0, 300, 460]),
    fakeImg('data:image/png;base64,iVBORw0KGgo=', [0, 0, 300, 460]),
    ...Array.from({ length: 5 }, (_, i) => fakeImg(`https://shop.example/${i}.jpg`, [0, 0, 300, 460])),
  ];
  await withFakeDom({ images: imgs }, async () => {
    const r = await probeFn()({ max: 3 });
    assert.equal(r.images.length, 3);
    assert.equal(r.total, 6);
    assert.ok(!r.images.some((i) => /^data:(text|image\/svg)/.test(i.srcUrl)));
  });
  const env2 = (images, extra = {}) => ({ v: 1, viewport: { width: 1280, height: 900 }, dpr: 1, images, ...extra });
  const v = validatePageImages(env2([
    img({ srcUrl: 'data:text/html;base64,PGgxPg==' }),
    img({ srcUrl: 'data:application/octet-stream;base64,AAAA' }),
    img({ srcUrl: 'data:image/jpeg;base64,/9j/' }),
  ], { total: 40 }));
  assert.deepEqual(v.value.images.map((i) => i.srcUrl), ['data:image/jpeg;base64,/9j/']);
  assert.equal(v.value.total, 40);
  assert.equal(validatePageImages(env2([img()], { total: -1 })).value.total, 1);
  assert.equal(validatePageImages(env2([img()], { total: 'many' })).value.total, 1);
  assert.equal(validatePageImages(env2([img(), img({ srcUrl: 'https://i.ebayimg.com/2.jpg' })], { total: 1 })).value.total, 2);
});

test('SEC-13 validation: topmostAtCenter must be boolean; missing counts as not topmost', () => {
  const env2 = (images) => ({ v: 1, viewport: { width: 1280, height: 900 }, dpr: 1, images });
  const v = validatePageImages(env2([
    img({ srcUrl: 'https://a.example/1.jpg', topmostAtCenter: true }),
    img({ srcUrl: 'https://a.example/2.jpg', topmostAtCenter: 'yes' }),
    img({ srcUrl: 'https://a.example/3.jpg' }),
  ]));
  assert.deepEqual(v.value.images.map((i) => [i.srcUrl, i.topmostAtCenter]), [['https://a.example/1.jpg', true], ['https://a.example/3.jpg', false]]);
});

test('SEC-13 isProminent: >= 50 % in the viewport and topmost at its centre', () => {
  assert.equal(PROMINENT_MIN_VISIBLE, 0.5);
  assert.equal(isProminent({ visibleFraction: 1, topmostAtCenter: true }), true);
  assert.equal(isProminent({ visibleFraction: 0.5, topmostAtCenter: true }), true);
  assert.equal(isProminent({ visibleFraction: 0.49, topmostAtCenter: true }), false);
  assert.equal(isProminent({ visibleFraction: 1, topmostAtCenter: false }), false);
  assert.equal(isProminent({ visibleFraction: 1 }), false);
  assert.equal(isProminent(null), false);
});

test('SEC-13 T1: slab A shown as CSS background (not an image), invisible/covered <img> of slab B -> list, never auto-open', () => {
  // Only the hidden image B is scanned (A is a CSS background, which discovery never reads).
  const b = aggregatePage([per(0, [cand({ number: '81234567', confidence: 0.9 })], [], false)]);
  assert.equal(b.items[0].prominent, false);
  assert.equal(decidePage(b, settings()).status, 'page-results');
  // The same number also read from a prominent image: the user can see that slab, so it may auto-open.
  const seen = aggregatePage([per(0, [cand({ number: '81234567', confidence: 0.9 })], [], false), per(1, [cand({ number: '81234567', confidence: 0.6 })], [], true)]);
  assert.equal(seen.items[0].prominent, true);
  assert.equal(decidePage(seen, settings()).status, 'auto-open');
  // A missing flag is not prominent.
  assert.equal(decidePage(aggregatePage([{ index: 0, candidates: [cand()], warnings: [] }]), settings()).status, 'page-results');
});
