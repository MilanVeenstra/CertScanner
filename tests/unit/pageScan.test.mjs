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

/**
 * Fake DOM for pageImagesProbe. `hits`: element -> [x, y, w, h], in paint order (first = topmost); elementsFromPoint
 * lists only these (like Chrome, it never reports pointer-events:none elements). `extra`: further elements that
 * querySelectorAll('*') returns (e.g. pointer-events:none overlays). `styles`: element -> computed-style overrides,
 * with optional '::before' / '::after' objects.
 */
const BASE_STYLE = { opacity: '1', pointerEvents: 'auto', filter: 'none', clipPath: 'none', clip: 'auto', maskImage: 'none', webkitMaskImage: 'none', mask: 'none', mixBlendMode: 'normal', backgroundImage: 'none', backgroundColor: 'rgba(0, 0, 0, 0)', backdropFilter: 'none', position: 'static', transform: 'none' };
function withFakeDom({ images, hits = new Map(), styles = new Map(), extra = [], elementCount = null }, fn) {
  const saved = { document: globalThis.document, window: globalThis.window };
  const all = [...new Set([...images, ...hits.keys(), ...extra])];
  globalThis.document = {
    baseURI: 'https://shop.example/', images,
    elementsFromPoint: (x, y) => [...hits].filter(([, b]) => x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3]).map(([el]) => el),
    querySelectorAll: () => (elementCount ? Array.from({ length: elementCount }, () => fakeEl([0, 0, 0, 0])) : all),
  };
  globalThis.window = {
    innerWidth: 1280, innerHeight: 900, devicePixelRatio: 1,
    getComputedStyle: (el, pseudo) => (pseudo ? { content: 'none', ...BASE_STYLE, ...(styles.get(el)?.[pseudo] ?? {}) } : { ...BASE_STYLE, ...(styles.get(el) ?? {}) }),
  };
  return Promise.resolve().then(fn).finally(() => Object.assign(globalThis, saved));
}
const probeFn = () => new Function(`return (${pageImagesProbe.toString()});`)();
function fakeEl(rect, { tagName = 'DIV', parent = null, children = [] } = {}) {
  const el = {
    tagName, parentElement: parent, namespaceURI: 'http://www.w3.org/1999/xhtml',
    getBoundingClientRect: () => ({ left: rect[0], top: rect[1], width: rect[2], height: rect[3] }),
    contains: (x) => x === el || children.includes(x),
    checkVisibility: () => true,
  };
  return el;
}
function fakeImg(srcUrl, rect, { natural = [680, 1044], visible = true, parent = null } = {}) {
  const img = fakeEl(rect, { tagName: 'IMG', parent: parent ?? { tagName: 'DIV', parentElement: null } });
  Object.assign(img, { currentSrc: srcUrl, src: srcUrl, complete: true, naturalWidth: natural[0], naturalHeight: natural[1], getAttribute: () => null, checkVisibility: () => visible });
  return img;
}
const topOf = async (env) => withFakeDom(env, async () => (await probeFn()({})).images.map((i) => i.topmostAtCenter));

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

test('SEC-13 probe: on top only when the image itself is hit first; covered, off-screen and faint images are not', async () => {
  const top = fakeImg('https://shop.example/top.jpg', [0, 0, 300, 460]);
  const covered = fakeImg('https://shop.example/covered.jpg', [400, 0, 300, 460]);
  const cover = fakeEl([400, 0, 300, 460]);
  const faint = fakeImg('https://shop.example/faint.jpg', [0, 500, 300, 380]);
  const offscreen = fakeImg('https://shop.example/off.jpg', [0, 2000, 300, 460]);
  const partly = fakeImg('https://shop.example/partly.jpg', [1100, 0, 300, 460]); // 180 of 300 px visible
  const hits = new Map([[top, [0, 0, 300, 460]], [cover, [400, 0, 300, 460]], [covered, [400, 0, 300, 460]], [faint, [0, 500, 300, 380]], [partly, [1100, 0, 180, 460]]]);
  const styles = new Map([[faint, { opacity: '0.3' }]]);
  await withFakeDom({ images: [top, covered, faint, offscreen, partly], hits, styles }, async () => {
    const r = await probeFn()({});
    const by = Object.fromEntries(r.images.map((i) => [i.srcUrl.split('/').pop(), i.topmostAtCenter]));
    assert.deepEqual(by, { 'top.jpg': true, 'covered.jpg': false, 'faint.jpg': false, 'off.jpg': false, 'partly.jpg': true });
    const v = validatePageImages(r);
    assert.equal(v.ok, true);
    assert.equal(v.value.images.find((i) => i.srcUrl.endsWith('covered.jpg')).topmostAtCenter, false);
  });
});

test('SEC-13/20 probe: an ancestor hit first never counts (pseudo-element cover, or the image has pointer-events:none)', async () => {
  const wrapCovered = fakeEl([0, 0, 300, 460]);
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460], { parent: wrapCovered });
  wrapCovered.contains = (x) => x === wrapCovered || x === img;
  assert.deepEqual(await topOf({ images: [img], hits: new Map([[wrapCovered, [0, 0, 300, 460]], [img, [0, 0, 300, 460]]]) }), [false]);
  const wrap = fakeEl([0, 0, 300, 460]);
  const inert = fakeImg('https://shop.example/inert.jpg', [0, 0, 300, 460], { parent: wrap });
  wrap.contains = (x) => x === wrap || x === inert;
  assert.deepEqual(await topOf({ images: [inert], hits: new Map([[wrap, [0, 0, 300, 460]]]), styles: new Map([[inert, { pointerEvents: 'none' }]]) }), [false]);
});

// ---------------------------------------------------------------- SEC-20 (S9)

test('SEC-20 rule 1: filter, clip-path, clip, masks, blend modes on the image or any ancestor -> not prominent', async () => {
  const cases = [
    ['filter', { filter: 'opacity(0)' }], ['clip-path', { clipPath: 'inset(49% 49% 49% 49%)' }], ['clip', { clip: 'rect(0px, 2px, 2px, 0px)' }],
    ['mask-image', { maskImage: 'url("m.png")' }], ['-webkit-mask-image', { webkitMaskImage: 'linear-gradient(black, transparent)' }],
    ['mask shorthand', { mask: 'url("m.svg") center / contain' }], ['mix-blend-mode', { mixBlendMode: 'multiply' }],
  ];
  for (const [name, style] of cases) {
    for (const where of ['image', 'ancestor']) {
      const outer = fakeEl([0, 0, 1280, 900]);
      const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460], { parent: outer });
      const styles = new Map([[where === 'image' ? img : outer, style]]);
      assert.deepEqual(await topOf({ images: [img], hits: new Map([[img, [0, 0, 300, 460]]]), styles }), [false], `${name} on the ${where}`);
    }
  }
  const outer = fakeEl([0, 0, 1280, 900]);
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460], { parent: outer });
  const hits = new Map([[img, [0, 0, 300, 460]]]);
  assert.deepEqual(await topOf({ images: [img], hits, styles: new Map([[outer, { opacity: '0.85' }]]) }), [false], 'cumulative opacity 0.85');
  assert.deepEqual(await topOf({ images: [img], hits, styles: new Map([[outer, { opacity: '0.95' }]]) }), [true], 'cumulative opacity 0.95');
  assert.deepEqual(await topOf({ images: [img], hits, styles: new Map([[outer, { filter: 'none', clipPath: 'none', mask: 'none 0% 0% / auto' }]]) }), [true], 'none values pass');
});

test('SEC-20 rule 2: the image must be on top at >= 4 of 5 points (centre + 25 %/75 % of the visible part)', async () => {
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 400, 400]);
  const right = fakeEl([250, 0, 150, 400]);   // covers (300,100) and (300,300)
  const corner = fakeEl([250, 0, 150, 200]);  // covers (300,100) only
  const window2px = fakeEl([0, 0, 400, 400]); // e.g. an ancestor clip leaving the image visible only around the centre
  assert.deepEqual(await topOf({ images: [img], hits: new Map([[right, [250, 0, 150, 400]], [img, [0, 0, 400, 400]]]) }), [false], '3 of 5');
  assert.deepEqual(await topOf({ images: [img], hits: new Map([[corner, [250, 0, 150, 200]], [img, [0, 0, 400, 400]]]) }), [true], '4 of 5');
  assert.deepEqual(await topOf({ images: [img], hits: new Map([[img, [199, 199, 2, 2]], [window2px, [0, 0, 400, 400]]]) }), [false], '2 px window at the centre');
});

test('SEC-20 rule 2: painting pointer-events:none elements over the image count as covering (hit tests skip them)', async () => {
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460]);
  const hits = new Map([[img, [0, 0, 300, 460]]]);
  const overlay = fakeEl([0, 0, 300, 460]);
  const run = (style, extra = [overlay]) => topOf({ images: [img], hits, extra, styles: new Map([[overlay, { pointerEvents: 'none', ...style }]]) });
  assert.deepEqual(await run({ backgroundImage: 'url("slab-a.png")' }), [false], 'background image overlay');
  assert.deepEqual(await run({ backgroundColor: 'rgb(255, 255, 255)' }), [false], 'opaque colour overlay');
  assert.deepEqual(await run({ '::after': { content: '""', backgroundImage: 'url("slab-a.png")' } }), [false], 'painted ::after');
  assert.deepEqual(await run({ backdropFilter: 'opacity(0)' }), [false], 'backdrop-filter');
  const imgOverlay = fakeEl([0, 0, 300, 460], { tagName: 'IMG' });
  assert.deepEqual(await topOf({ images: [img], hits, extra: [imgOverlay], styles: new Map([[imgOverlay, { pointerEvents: 'none' }]]) }), [false], '<img> overlay');
  // Not covering: transparent containers (toast layers), elements away from the sample points, invisible ones.
  assert.deepEqual(await run({}), [true], 'transparent pointer-events:none container');
  const badge = fakeEl([0, 0, 40, 20]);
  assert.deepEqual(await topOf({ images: [img], hits, extra: [badge], styles: new Map([[badge, { pointerEvents: 'none', backgroundColor: 'rgb(200, 0, 0)' }]]) }), [true], 'corner badge');
  const gone = fakeEl([0, 0, 300, 460]);
  gone.checkVisibility = () => false;
  assert.deepEqual(await topOf({ images: [img], hits, extra: [gone], styles: new Map([[gone, { pointerEvents: 'none', backgroundImage: 'url(a)' }]]) }), [true], 'opacity:0 overlay');
  // The image's own ancestor painting a background below it is not a cover.
  const wrap = fakeEl([0, 0, 300, 460]);
  const inner = fakeImg('https://shop.example/c.jpg', [0, 0, 300, 460], { parent: wrap });
  wrap.contains = (x) => x === wrap || x === inner;
  assert.deepEqual(await topOf({ images: [inner], hits: new Map([[inner, [0, 0, 300, 460]]]), extra: [wrap], styles: new Map([[wrap, { pointerEvents: 'none', backgroundColor: 'rgb(0, 0, 0)' }]]) }), [true], 'own ancestor');
});

test('SEC-20 rule 2: a positioned painted pseudo-element of a 0x0 pointer-events:none element covers its containing block', async () => {
  const wrap = fakeEl([0, 0, 300, 460]);
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460], { parent: wrap });
  const dot = fakeEl([10, 10, 0, 0], { parent: wrap });
  wrap.contains = (x) => x === wrap || x === img || x === dot;
  const hits = new Map([[img, [0, 0, 300, 460]]]);
  const styles = (pos) => new Map([[wrap, { position: 'relative' }], [dot, { pointerEvents: 'none', '::after': { content: '""', position: pos, backgroundImage: 'url("slab-a.png")' } }]]);
  assert.deepEqual(await topOf({ images: [img], hits, extra: [wrap, dot], styles: styles('absolute') }), [false], 'absolute ::after');
  assert.deepEqual(await topOf({ images: [img], hits, extra: [wrap, dot], styles: styles('fixed') }), [false], 'fixed ::after');
  assert.deepEqual(await topOf({ images: [img], hits, extra: [wrap, dot], styles: styles('static') }), [true], 'in-flow ::after of a 0x0 element paints nothing over the image');
});

test('SEC-20 rule 2: documents too large to check for pointer-events:none covers are not vouched for', async () => {
  const img = fakeImg('https://shop.example/b.jpg', [0, 0, 300, 460]);
  assert.deepEqual(await topOf({ images: [img], hits: new Map([[img, [0, 0, 300, 460]]]), elementCount: 30001 }), [false]);
  assert.deepEqual(await topOf({ images: [img], hits: new Map([[img, [0, 0, 300, 460]]]), elementCount: 3000 }), [true]);
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
