import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU_ID, SCAN_JOB_VERSION, JOB_TTL_MS, MAX_SRC_URL_CHARS, jobKey, createScanJob, parseScanJob } from '../../src/shared/jobContract.js';

const NOW = 1_760_000_000_000;
const info = (over = {}) => ({ menuItemId: MENU_ID, mediaType: 'image', srcUrl: 'https://img.example.com/a.jpg', pageUrl: 'https://shop.example.com/item/1', frameId: 0, ...over });
const tab = (over = {}) => ({ id: 42, windowId: 7, index: 3, url: 'https://shop.example.com/item/1', ...over });
const ID = '0b0b5ef6-6a5e-4c6e-9d43-123456789abc';

test('constants and key', () => {
  assert.equal(MENU_ID, 'certscanner-scan');
  assert.equal(SCAN_JOB_VERSION, 1);
  assert.equal(JOB_TTL_MS, 120_000);
  assert.equal(MAX_SRC_URL_CHARS, 2_000_000);
  assert.equal(jobKey(7), 'scanJob:7');
});

test('createScanJob maps OnClickData + Tab', () => {
  const job = createScanJob(info({ frameUrl: 'https://shop.example.com/frame' }), tab(), NOW, ID);
  assert.deepEqual(job, {
    v: 1, id: ID, createdAt: NOW, source: 'contextMenu', srcUrl: 'https://img.example.com/a.jpg',
    pageUrl: 'https://shop.example.com/item/1', frameUrl: 'https://shop.example.com/frame', frameId: 0, tabId: 42, windowId: 7, mediaType: 'image',
  });
  assert.deepEqual(parseScanJob(job, { now: NOW, windowId: 7 }), { ok: true, job });
});

test('createScanJob defaults frameId to 0 and frameUrl to null; falls back to tab.url', () => {
  const job = createScanJob(info({ frameId: undefined, pageUrl: undefined }), tab(), NOW, ID);
  assert.equal(job.frameId, 0);
  assert.equal(job.frameUrl, null);
  assert.equal(job.pageUrl, 'https://shop.example.com/item/1');
});

test('createScanJob turns oversize or unsupported srcUrl into null (-> too-large)', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(MAX_SRC_URL_CHARS);
  assert.equal(createScanJob(info({ srcUrl: big }), tab(), NOW, ID).srcUrl, null);
  assert.equal(createScanJob(info({ srcUrl: 'filesystem:https://x/y' }), tab(), NOW, ID).srcUrl, null);
  const okData = 'data:image/png;base64,AAAA';
  assert.equal(createScanJob(info({ srcUrl: okData }), tab(), NOW, ID).srcUrl, okData);
  const parsed = parseScanJob(createScanJob(info({ srcUrl: big }), tab(), NOW, ID), { now: NOW, windowId: 7 });
  assert.equal(parsed.ok, true);
});

test('createScanJob shortens a very long pageUrl to its origin', () => {
  const long = 'https://shop.example.com/' + 'a'.repeat(9000);
  const job = createScanJob(info({ pageUrl: long }), tab(), NOW, ID);
  assert.equal(job.pageUrl, 'https://shop.example.com/');
  assert.equal(parseScanJob(job, { now: NOW, windowId: 7 }).ok, true);
});

test('parseScanJob rejects bad shapes', () => {
  const good = createScanJob(info(), tab(), NOW, ID);
  const bad = (patch, reason = 'shape') => {
    const r = parseScanJob({ ...good, ...patch }, { now: NOW, windowId: 7 });
    assert.deepEqual(r, { ok: false, reason }, JSON.stringify(patch));
  };
  for (const raw of [null, undefined, 1, 'x', [], [good]]) assert.deepEqual(parseScanJob(raw, { now: NOW, windowId: 7 }), { ok: false, reason: 'shape' });
  bad({ v: 2 }, 'version');
  bad({ v: '1' }, 'version');
  bad({ windowId: 8 }, 'window');
  bad({ createdAt: NOW - JOB_TTL_MS - 1 }, 'stale');
  bad({ createdAt: NOW + 5001 }, 'stale');
  bad({ createdAt: NaN });
  bad({ createdAt: '1' });
  bad({ id: '' });
  bad({ id: 'x'.repeat(65) });
  bad({ id: 5 });
  bad({ srcUrl: 'javascript:alert(1)' });
  bad({ srcUrl: 'chrome://settings' });
  bad({ srcUrl: 'x'.repeat(MAX_SRC_URL_CHARS + 1) });
  bad({ srcUrl: 5 });
  bad({ pageUrl: 'x'.repeat(8193) });
  bad({ pageUrl: null });
  bad({ frameId: -1 });
  bad({ frameId: 1.5 });
  bad({ tabId: -1 });
  bad({ tabId: '42' });
  bad({ mediaType: 'video' });
  bad({ source: 'page' });
  bad({ frameUrl: 5 });
  // boundaries accepted
  assert.equal(parseScanJob({ ...good, createdAt: NOW - JOB_TTL_MS }, { now: NOW, windowId: 7 }).ok, true);
  assert.equal(parseScanJob({ ...good, createdAt: NOW + 5000 }, { now: NOW, windowId: 7 }).ok, true);
  assert.equal(parseScanJob({ ...good, srcUrl: null }, { now: NOW, windowId: 7 }).ok, true);
  for (const s of ['http://a/b.png', 'https://a/b.png', 'data:image/png;base64,AA', 'blob:https://a/uuid']) {
    assert.equal(parseScanJob({ ...good, srcUrl: s }, { now: NOW, windowId: 7 }).ok, true, s);
  }
});

test('parseScanJob returns a clean copy without extra fields', () => {
  const good = createScanJob(info(), tab(), NOW, ID);
  const r = parseScanJob({ ...good, extra: 'x', __proto__: { polluted: true } }, { now: NOW, windowId: 7 });
  assert.equal(r.ok, true);
  assert.equal('extra' in r.job, false);
  assert.equal(r.job.polluted, undefined);
  assert.equal(Object.getPrototypeOf(r.job), Object.prototype);
});
