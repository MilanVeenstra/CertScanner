import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastResultKey, makeLastResult, parseLastResult, LAST_RESULT_TTL_MS } from '../../src/shared/lastResult.js';

const NOW = 1_760_000_000_000;
const scan = {
  jobId: 'abc', status: 'confirm',
  candidates: [{ grader: null, graderOptions: ['cgc-comics', 'cgc-cards', 'psa'], number: '5012345678', confidence: 0.44, source: 'ocr', evidence: ['len:10', 'pass:text'] }],
  imageInfo: { method: 'extension-fetch', resolution: 'full', width: 544, height: 850, origin: 'https://img.example.com', canRequestSharper: false },
  warnings: [{ code: 'qr-untrusted-host', detail: 'evil.example' }], timings: { totalMs: 900 },
};

test('key', () => assert.equal(lastResultKey(7), 'lastResult:7'));

test('makeLastResult keeps only what the task card needs (no image data, no page URL)', () => {
  const v = makeLastResult({ task: 'confirm', body: 'confirm', result: scan, opened: null, imageHost: 'img.example.com' }, NOW);
  assert.deepEqual(v, {
    v: 1, savedAt: NOW, task: 'confirm', body: 'confirm', imageHost: 'img.example.com',
    candidates: [{ grader: null, graderOptions: ['cgc-comics', 'cgc-cards', 'psa'], number: '5012345678', confidence: 0.44, source: 'ocr' }],
    warnings: [{ code: 'qr-untrusted-host', detail: 'evil.example' }],
    resolution: 'full', error: null, opened: null,
  });
  assert.deepEqual(parseLastResult(v, { now: NOW + 1000 }), { ok: true, value: v });
});

test('opened results round-trip', () => {
  const v = makeLastResult({ task: 'result', body: 'auto-open', result: { ...scan, status: 'auto-open', warnings: [] }, opened: { grader: 'psa', number: '01234567', method: 'ocr', url: 'https://www.psacard.com/cert/01234567', background: false }, imageHost: null }, NOW);
  const p = parseLastResult(v, { now: NOW });
  assert.equal(p.ok, true);
  assert.deepEqual(p.value.opened, { grader: 'psa', number: '01234567', method: 'ocr', background: false });
});

test('a BGS result whose lookup was not opened yet round-trips with lookupPending (restored after a reopen)', () => {
  const opened = { grader: 'bgs', number: '0012345678', method: 'ocr', url: 'https://www.beckett.com/grading/card-lookup', background: false, lookupPending: true };
  const p = parseLastResult(makeLastResult({ task: 'result', body: 'opened', result: { ...scan, warnings: [] }, opened, imageHost: null }, NOW), { now: NOW });
  assert.equal(p.ok, true);
  assert.deepEqual(p.value.opened, { grader: 'bgs', number: '0012345678', method: 'ocr', background: false, lookupPending: true });
  const psa = makeLastResult({ task: 'result', body: 'opened', result: scan, opened: { ...opened, grader: 'psa', number: '01234567' }, imageHost: null }, NOW);
  assert.equal(psa.opened.lookupPending, undefined, 'only Beckett has a lookup form');
});

test('errors round-trip with their code only', () => {
  const v = makeLastResult({ task: 'error', body: 'error', result: null, error: { code: 'restricted' }, opened: null, imageHost: null }, NOW);
  assert.deepEqual(parseLastResult(v, { now: NOW }).value.error, { code: 'restricted' });
});

test('parseLastResult rejects stale, malformed and hostile values', () => {
  const good = makeLastResult({ task: 'confirm', body: 'confirm', result: scan, opened: null, imageHost: 'img.example.com' }, NOW);
  const bad = (patch) => assert.equal(parseLastResult({ ...good, ...patch }, { now: NOW }).ok, false, JSON.stringify(patch));
  for (const raw of [null, undefined, 'x', [], 5]) assert.equal(parseLastResult(raw, { now: NOW }).ok, false);
  assert.equal(parseLastResult(good, { now: NOW + LAST_RESULT_TTL_MS + 1 }).ok, false);
  bad({ v: 2 });
  bad({ task: 'scanning' });
  bad({ body: 'hacked' });
  bad({ candidates: [{ grader: 'psa', number: '<img>', confidence: 1, source: 'ocr', graderOptions: ['psa'] }] });
  bad({ candidates: [{ grader: 'psa', number: '1401036622258', confidence: 1, source: 'ocr', graderOptions: ['psa'] }] });
  bad({ candidates: 'x' });
  bad({ imageHost: 'a b' });
  bad({ warnings: [{ code: 'x' }] });
  bad({ error: { code: 'pwned' } });
  bad({ opened: { grader: 'psa', number: '12', method: 'ocr', background: false } });
  bad({ savedAt: 'yesterday' });
});

// ---------------------------------------------------------------- SEC-18
test('SEC-18: clearAllLastResults removes every window\'s last result and nothing else', async () => {
  const { lastResultKeys, clearAllLastResults } = await import('../../src/shared/lastResult.js');
  const data = { 'lastResult:7': { v: 1 }, 'lastResult:12': { v: 1 }, 'scanJob:7': { v: 1 }, sharperDeclined: ['a'], 'seenJobs:7': ['x'] };
  assert.deepEqual(lastResultKeys(data).sort(), ['lastResult:12', 'lastResult:7']);
  assert.deepEqual(lastResultKeys(undefined), []);
  const removed = [];
  const area = {
    get: async (k) => { assert.equal(k, null); return { ...data }; },
    remove: async (keys) => { removed.push(...keys); for (const k of keys) delete data[k]; },
  };
  await clearAllLastResults(area);
  assert.deepEqual(removed.sort(), ['lastResult:12', 'lastResult:7']);
  assert.deepEqual(Object.keys(data).sort(), ['scanJob:7', 'seenJobs:7', 'sharperDeclined']);
  await clearAllLastResults({ get: async () => { throw new Error('gone'); }, remove: async () => {} }); // never throws
});
