// Grade check AI condition check: requests, permission gate, parsing and status mapping (no network: fetch is faked).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, VENDORS, AI_PERMISSIONS, CONDITION_SCHEMA, claudeBody, parseClaude, parseXimilar, checkCondition, testKey,
  saveKey, loadKey, clearKey, hasConsent, saveConsent, CONSENT_KEY,
} from '../../src/sidepanel/gradeAi.js';
import { GRADE_AI_CHOICES } from '../../src/shared/settings.js';
import { createScanJob, parseScanJob, GRADE_MENU_ID, MENU_ID } from '../../src/shared/jobContract.js';
import { analysisSize } from '../../src/sidepanel/gradeEngine.js';

const blob = (s = 'jpeg-bytes') => new Blob([s], { type: 'image/jpeg' });
const fakeChrome = ({ granted = true } = {}) => {
  const store = {};
  return {
    store,
    permissions: { contains: async () => granted },
    storage: {
      local: {
        get: async (k) => (k in store ? { [k]: store[k] } : {}),
        set: async (o) => { Object.assign(store, o); },
        remove: async (k) => { delete store[k]; },
      },
    },
  };
};
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
const claudeAnswer = (out, extra = {}) => json({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(out) }], ...extra });
const goodOut = {
  corners: { rating: 'minor', notes: 'white speck top-left' }, edges: { rating: 'none', notes: '' }, surface: { rating: 'unknown', notes: 'glare' },
  photo_issues: ['glare'], card: { name: 'Pikachu', number: '025/165' },
};

test('providers match the settings choices; every vendor has a permission and a key check', () => {
  assert.deepEqual(['off', ...Object.keys(PROVIDERS)], [...GRADE_AI_CHOICES]);
  assert.deepEqual(AI_PERMISSIONS, ['https://api.anthropic.com/*', 'https://api.ximilar.com/*']);
  assert.equal(VENDORS.anthropic.isKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(VENDORS.anthropic.isKey('sk-proj-abc'), false);
  assert.equal(VENDORS.ximilar.isKey('0123456789abcdef0123456789abcdef01234567'), true);
  assert.equal(VENDORS.ximilar.isKey('short'), false);
});

test('Claude request: browser header, API version, JSON schema output, images first; Sonnet gets server-side fallback', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return claudeAnswer(goodOut); };
  const r = await checkCondition({ provider: 'claude-sonnet', key: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', front: blob(), back: blob('b'), centering: 'front left/right 55/45', language: 'nl' }, { fetchImpl, chromeApi: fakeChrome() });
  assert.equal(r.status, 'ok');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(init.headers['anthropic-version'], '2026-10-21');
  assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'claude-sonnet-5-5');
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config.format, { type: 'json_schema', schema: CONDITION_SCHEMA });
  assert.deepEqual(body.messages[0].content.map((c) => c.type), ['image', 'image', 'text']);
  assert.equal(body.messages[0].content[0].source.media_type, 'image/jpeg');
  assert.match(body.messages[0].content[2].text, /Dutch/);
  assert.equal('temperature' in body, false, 'API 2026-10-21 rejects sampling parameters');
  // Haiku: no fallback beta (none exists for it).
  const h = claudeBody({ model: PROVIDERS['claude-haiku'].model, images: ['x'], prompt: 'p' });
  assert.equal('fallbacks' in h, false);
});

test('nothing is sent without host access; key errors and limits map to statuses', async () => {
  let sent = 0;
  const fetchImpl = async () => { sent++; return json({}); };
  assert.equal((await checkCondition({ provider: 'claude-haiku', key: 'k', front: blob() }, { fetchImpl, chromeApi: fakeChrome({ granted: false }) })).status, 'no-permission');
  assert.equal(sent, 0);
  for (const [status, want] of [[401, 'auth'], [403, 'forbidden'], [429, 'limit'], [413, 'too-large'], [529, 'overloaded'], [500, 'error']]) {
    const r = await checkCondition({ provider: 'claude-haiku', key: 'k', front: blob() }, { fetchImpl: async () => json({ type: 'error' }, status), chromeApi: fakeChrome() });
    assert.equal(r.status, want, String(status));
  }
  const refused = await checkCondition({ provider: 'claude-haiku', key: 'k', front: blob() }, { fetchImpl: async () => json({ stop_reason: 'refusal', content: [] }), chromeApi: fakeChrome() });
  assert.equal(refused.status, 'refused');
});

test('parseClaude: ratings to scores, notes clipped, bad answers rejected', () => {
  const r = parseClaude({ content: [{ type: 'text', text: JSON.stringify(goodOut) }] });
  assert.deepEqual(r.condition, { corners: 9, edges: 10, surface: null });
  assert.equal(r.ratings.surface, 'unknown');
  assert.deepEqual(r.card, { name: 'Pikachu', number: '025/165' });
  assert.equal(parseClaude({ content: [{ type: 'text', text: '{"corners":{"rating":"great"}}' }] }), null);
  assert.equal(parseClaude({ content: [{ type: 'text', text: 'not json' }] }), null);
  const long = parseClaude({ content: [{ type: 'text', text: JSON.stringify({ ...goodOut, corners: { rating: 'minor', notes: 'x'.repeat(5000) } }) }] });
  assert.ok(long.notes.corners.length <= 280);
});

test('Ximilar: async request (submit, poll, read); worst side per area; grades as numbers or {grade}', async () => {
  const calls = [];
  const answers = [
    json({ id: 'req-1', status: 'CREATED' }),
    json({ status: 'IN_PROGRESS' }),
    json({ status: 'DONE' }),
    json({ response: { records: [
      { _id: 'front', grades: { corners: 9.5, edges: { grade: 9 }, surface: 9, centering: 9.5, final: 9 } },
      { _id: 'back', grades: { corners: 8.5, edges: 9.5, surface: 9.5, final: 8.5 } },
    ] } }),
  ];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return answers.shift(); };
  const r = await checkCondition({ provider: 'ximilar', key: '0123456789abcdef0123456789abcdef', front: blob(), back: blob('b') }, { fetchImpl, chromeApi: fakeChrome(), sleep: async () => {} });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.result.condition, { corners: 8.5, edges: 9, surface: 9 });
  assert.equal(r.result.final, 8.5);
  assert.equal(calls[0].url, 'https://api.ximilar.com/account/v2/request/');
  assert.equal(calls[0].init.headers.Authorization, 'Token 0123456789abcdef0123456789abcdef');
  const sub = JSON.parse(calls[0].init.body);
  assert.equal(sub.type, 'card-grader');
  assert.equal(sub.endpoint, 'grade');
  assert.deepEqual(sub.records.map((x) => [x._id, x.Side, typeof x._base64, '_url' in x]), [['front', 'Front', 'string', false], ['back', 'Back', 'string', false]]);
  assert.equal(calls[1].url, 'https://api.ximilar.com/account/v2/request/req-1/status');
  assert.equal(parseXimilar({ records: [{ _status: { code: 400, text: 'no card' } }] }), null);
});

test('keys and consent stay in local storage; removing a key forgets the consent', async () => {
  const c = fakeChrome();
  await assert.rejects(saveKey('anthropic', 'nope', c), RangeError);
  await saveKey('anthropic', ' sk-ant-api03-abcdefghijklmnopqrstuvwxyz ', c);
  assert.equal(await loadKey('anthropic', c), 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  assert.equal(await hasConsent('anthropic', c), false);
  await saveConsent('anthropic', c, 123);
  assert.equal(await hasConsent('anthropic', c), true);
  assert.equal(c.store[CONSENT_KEY].anthropic.at, 123);
  await clearKey('anthropic', c);
  assert.equal(await loadKey('anthropic', c), null);
  assert.equal(await hasConsent('anthropic', c), false);
});

test('testKey: Anthropic lists one model (free); Ximilar keys are saved unchecked', async () => {
  const seen = [];
  const ok = await testKey('anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', { fetchImpl: async (u, init) => { seen.push([u, init.headers['x-api-key']]); return json({ data: [] }); }, chromeApi: fakeChrome() });
  assert.equal(ok, 'ok');
  assert.equal(seen[0][0], 'https://api.anthropic.com/v1/models?limit=1');
  assert.equal(await testKey('anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', { fetchImpl: async () => json({}, 401), chromeApi: fakeChrome() }), 'auth');
  assert.equal(await testKey('ximilar', '0123456789abcdef0123456789abcdef', { fetchImpl: async () => { throw new Error('no call'); }, chromeApi: fakeChrome() }), 'unchecked');
  assert.equal(await testKey('ximilar', '0123456789abcdef0123456789abcdef', { chromeApi: fakeChrome({ granted: false }) }), 'no-permission');
});

test('context menu "Estimate card grade" marks the job; the panel keeps the mark', () => {
  assert.notEqual(GRADE_MENU_ID, MENU_ID);
  const tab = { id: 5, windowId: 2, url: 'https://shop.example/item?id=1' };
  const job = createScanJob({ srcUrl: 'https://img.example/card.jpg', pageUrl: tab.url, frameId: 0 }, tab, 1000, 'id-1', { purpose: 'grade' });
  assert.equal(job.purpose, 'grade');
  assert.equal(parseScanJob(job, { now: 1001, windowId: 2 }).job.purpose, 'grade');
  const plain = createScanJob({ srcUrl: 'https://img.example/card.jpg' }, tab, 1000, 'id-2');
  assert.equal('purpose' in plain, false);
  assert.equal('purpose' in parseScanJob({ ...plain, purpose: 'evil' }, { now: 1001, windowId: 2 }).job, false);
});

test('analysisSize caps the long side and never upscales', () => {
  assert.deepEqual(analysisSize(4000, 3000), { width: 2800, height: 2100 });
  assert.deepEqual(analysisSize(800, 600), { width: 800, height: 600 });
});
