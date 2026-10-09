import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffDimensions, imageOriginOf, acquireFromJob } from '../../src/pipeline/acquire.js';
import { digitBoxes } from '../../src/pipeline/scanner.js';
import { toOcrPage } from '../../src/pipeline/ocr.js';
import { ocrScale, otsuThreshold, stretchContrast } from '../../src/pipeline/preprocess.js';
import { originPattern } from '../../src/sidepanel/permissionsUi.js';
import { pageProbe } from '../../src/pipeline/pageProbe.js';

test('sniffDimensions reads PNG, GIF and JPEG headers', () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0, 0, 0x2e, 0xe0], 16); // 12000
  png.set([0, 0, 0x03, 0x52], 20); // 850
  assert.deepEqual(sniffDimensions(png), { width: 12000, height: 850 });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x10, 0x00, 0x20, 0x00]);
  assert.deepEqual(sniffDimensions(gif), { width: 16, height: 32 });
  // JPEG: SOI, APP0 (len 4), SOF0 with height 406, width 260
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x96, 0x01, 0x04, 0x03, 0, 0, 0, 0]);
  assert.deepEqual(sniffDimensions(jpg), { width: 260, height: 406 });
  assert.equal(sniffDimensions(new Uint8Array([1, 2, 3])), null);
});

test('imageOriginOf handles http(s), blob and data URLs', () => {
  assert.equal(imageOriginOf('https://i.ebayimg.com/images/g/x/s-l500.jpg'), 'https://i.ebayimg.com');
  assert.equal(imageOriginOf('blob:http://127.0.0.1:8080/0b0b5ef6'), 'http://127.0.0.1:8080');
  assert.equal(imageOriginOf('data:image/png;base64,AAAA'), null);
  assert.equal(imageOriginOf('javascript:alert(1)'), null);
  assert.equal(imageOriginOf('not a url'), null);
});

test('digitBoxes: merges adjacent digit-ish words on a line, needs >= 5 digit-like chars, max 4', () => {
  const w = (text, lineId, x0, x1) => ({ text, confidence: 80, bbox: { x0, y0: lineId * 50, x1, y1: lineId * 50 + 30 }, lineText: '', lineId });
  const page = { words: [
    w('2023', 0, 0, 60), w('POKEMON', 0, 70, 200),
    w('4012346-', 1, 0, 120), w('002', 1, 130, 175),
    w('01234567', 2, 300, 420),
    w('#199', 3, 0, 50),
    w('O1234S67', 4, 0, 120),
  ] };
  const boxes = digitBoxes(page);
  assert.equal(boxes.length, 3);
  const dash = boxes.find((b) => b.top === 50);
  assert.deepEqual([dash.left, dash.width], [0, 175]); // "4012346-" + "002" merged
  assert.ok(!boxes.some((b) => b.top === 0));   // "2023" alone has 4 digits
  assert.ok(!boxes.some((b) => b.top === 150)); // "#199"
  assert.ok(boxes.some((b) => b.top === 200));  // fix-up-able token still gets a digits pass
  const many = { words: Array.from({ length: 9 }, (_, i) => w('12345678', i, 0, 100)) };
  assert.equal(digitBoxes(many).length, 4);
  assert.deepEqual(digitBoxes({}), []);
});

test('toOcrPage flattens tesseract blocks into words with line ids', () => {
  const data = { text: 'GEM MT 10\n01234567', confidence: 90, blocks: [{ paragraphs: [{ lines: [
    { text: 'GEM MT 10\n', words: [{ text: 'GEM', confidence: 91, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }, { text: 'MT', confidence: 90, bbox: {} }, { text: ' ', confidence: 0 }] },
    { text: '01234567', words: [{ text: '01234567', confidence: 88.5, bbox: { x0: 5, y0: 6, x1: 7, y1: 8 } }] },
  ] }] }] };
  const p = toOcrPage(data, 'text', 90);
  assert.equal(p.pass, 'text');
  assert.equal(p.rotation, 90);
  assert.deepEqual(p.words.map((x) => [x.text, x.lineId, x.lineText]), [['GEM', 0, 'GEM MT 10'], ['MT', 0, 'GEM MT 10'], ['01234567', 1, '01234567']]);
  assert.deepEqual(toOcrPage(null, 'digits').words, []);
});

test('preprocess math: scale policy, Otsu, contrast stretch', () => {
  assert.equal(ocrScale(544, 850), 2000 / 850);
  assert.equal(ocrScale(260, 406), 3);           // upscaling capped at 3x
  assert.equal(ocrScale(1200, 2000), 1);         // inside [1600, 2400]
  assert.equal(ocrScale(3000, 4000), 0.5);       // downscale to 2000
  const bimodal = new Uint8ClampedArray([...Array(50).fill(20), ...Array(50).fill(230)]);
  const t = otsuThreshold(bimodal);
  assert.ok(t >= 20 && t < 230);
  const s = stretchContrast(new Uint8ClampedArray([100, 110, 120, 130, 140, 150, 160]));
  assert.equal(s[0], 0);
  assert.equal(s[6], 255);
});

test('originPattern requests exactly one https host', () => {
  assert.equal(originPattern('https://i.ebayimg.com'), 'https://i.ebayimg.com/*');
  assert.equal(originPattern('https://i.ebayimg.com:8443'), 'https://i.ebayimg.com/*');
  assert.equal(originPattern('http://example.com'), null);
  assert.equal(originPattern('chrome://settings'), null);
  assert.equal(originPattern(null), null);
});

test('pageProbe is self-contained (serializable for executeScript)', () => {
  const src = pageProbe.toString();
  assert.match(src, /^async function pageProbe\(srcUrl, mode, maxBytes\)/);
  // No references to module-level identifiers: re-evaluating the source alone must yield a function.
  const fn = new Function(`return (${src});`)();
  assert.equal(typeof fn, 'function');
  assert.doesNotMatch(src, /\bimport\b|\brequire\(/);
});

test('pageProbe runs from its serialized source and reports found:false when the image is gone', async () => {
  const fn = new Function(`return (${pageProbe.toString()});`)();
  const saved = globalThis.document;
  globalThis.document = { images: [{ currentSrc: 'https://x.example/other.png', src: 'https://x.example/other.png', getAttribute: () => null }], baseURI: 'https://x.example/' };
  try {
    assert.deepEqual(await fn('https://x.example/a.png', 'inspect', 100), { v: 1, found: false });
  } finally {
    globalThis.document = saved;
  }
});

test('acquireFromJob: missing srcUrl reports why (too-large vs invalid-image), restricted first', async () => {
  const job = { v: 1, id: 'x', createdAt: 0, source: 'contextMenu', srcUrl: null, pageUrl: 'https://shop.example.com/', frameUrl: null, frameId: 0, tabId: 1, windowId: 1, mediaType: 'image' };
  const chromeApi = { permissions: { contains: async () => false } };
  assert.equal((await acquireFromJob({ ...job, srcIssue: 'too-long' }, { chromeApi })).reason, 'too-large');
  assert.equal((await acquireFromJob(job, { chromeApi })).reason, 'too-large'); // older jobs: ADR default
  assert.equal((await acquireFromJob({ ...job, srcIssue: 'unsupported' }, { chromeApi })).reason, 'invalid-image');
  assert.equal((await acquireFromJob({ ...job, srcIssue: 'unsupported', pageUrl: 'chrome://version/' }, { chromeApi })).reason, 'restricted');
});
