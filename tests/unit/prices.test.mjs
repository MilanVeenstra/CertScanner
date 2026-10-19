import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchUrl, isPcUrl } from '../../src/core/pricecharting.js';
import { parsePsaCert } from '../../src/sidepanel/psaApi.js';
import { cardNoFrom, isPriceUrl } from '../../src/core/priceLinks.js';

test('PriceCharting: only the search link, which the panel opens on a click (A25)', () => {
  assert.equal(searchUrl('2023 POKEMON CHARIZARD ex 199'), 'https://www.pricecharting.com/search-products?q=POKEMON+CHARIZARD+ex+199&type=prices');
  assert.ok(isPcUrl(searchUrl('Pikachu')) && isPriceUrl(searchUrl('Pikachu')));
  for (const bad of ['https://www.pricecharting.com/game/a/b', 'http://www.pricecharting.com/search-products?q=x', 'https://evil.example/search-products', 'https://u@www.pricecharting.com/search-products']) {
    assert.equal(isPcUrl(bad), false, bad);
  }
  assert.throws(() => searchUrl(' 2023 '), RangeError);
});

test('PSA API cert -> card name, grade, population and search terms', () => {
  const card = parsePsaCert({ PSACert: { CertNumber: '81234567', Year: '2023', Brand: 'POKEMON SV 151', CardNumber: '199', Subject: 'CHARIZARD ex', Variety: 'SPECIAL ILLUSTRATION RARE', CardGrade: 'GEM MT 10', TotalPopulation: 1234, PopulationHigher: 0 } });
  assert.equal(card.query, 'POKEMON CHARIZARD ex 199');
  assert.equal(card.title, '2023 POKEMON SV 151 CHARIZARD ex #199');
  assert.equal(card.grade, '10');
  assert.equal(card.population, 1234);
  assert.equal(parsePsaCert({ PSACert: { Subject: 'CHARIZARD-HOLO', Brand: 'POKEMON GAME', CardNumber: '4', Variety: '1ST EDITION', CardGrade: 'NM-MT 8', YearIssued: '1999' } }).query, 'POKEMON CHARIZARD-HOLO 4 1ST EDITION');
  assert.equal(parsePsaCert({ PSACert: {} }), null);
  assert.equal(parsePsaCert('nope'), null);
});

test('card number from search terms', () => {
  assert.equal(cardNoFrom('POKEMON CHARIZARD ex 199'), '199');
  assert.equal(cardNoFrom('FLEER MICHAEL JORDAN 57'), '57');
  assert.equal(cardNoFrom('Pokemon Sword Shield Pikachu Holo'), null);
});

test('PSA lookup needs a saved key and api.psacard.com access', async () => {
  const { fetchPsaCert } = await import('../../src/sidepanel/psaApi.js');
  let fetched = 0;
  const fetchImpl = async () => { fetched++; };
  assert.deepEqual(await fetchPsaCert('81234567', { token: null, fetchImpl }), { ok: false, reason: 'no-token' });
  assert.deepEqual(await fetchPsaCert('81234567', { token: 'test-token-1234567890', fetchImpl, chromeApi: { permissions: { contains: async () => false } } }), { ok: false, reason: 'no-permission' });
  assert.equal(fetched, 0);
  const allowed = { permissions: { contains: async () => true } };
  const blocked = async () => new Response('<html><title>Attention Required!</title></html>', { status: 403, headers: { 'content-type': 'text/html' } });
  assert.deepEqual(await fetchPsaCert('81234568', { token: 'test-token-1234567890', fetchImpl: blocked, chromeApi: allowed }), { ok: false, reason: 'blocked' });
  const server = async () => new Response('{}', { status: 500 });
  assert.deepEqual(await fetchPsaCert('81234569', { token: 'test-token-1234567890', fetchImpl: server, chromeApi: allowed }), { ok: false, reason: 'server' });
});

test('PSA daily limit: calls counted, answers kept for the session, no calls for the rest of the day after a quota answer', async () => {
  const { fetchPsaCert, testPsaKey, psaCallsToday } = await import('../../src/sidepanel/psaApi.js');
  const area = () => { const m = {}; return { get: async (k) => ({ [k]: m[k] }), set: async (o) => { Object.assign(m, o); }, remove: async (k) => { delete m[k]; } }; };
  const chromeApi = { permissions: { contains: async () => true }, storage: { local: area(), session: area() } };
  const token = 'test-token-1234567890';
  let calls = 0;
  const card = async () => { calls++; return new Response(JSON.stringify({ PSACert: { Subject: 'CHARIZARD ex', Brand: 'POKEMON', CardNumber: '199', CardGrade: 'GEM MT 10' } }), { status: 200 }); };
  assert.equal((await fetchPsaCert('91234567', { token, fetchImpl: card, chromeApi })).ok, true);
  assert.equal(calls, 1);
  assert.equal(await psaCallsToday(chromeApi), 1);
  // A reopened panel has an empty in-memory cache; the session copy answers without a call.
  const again = await import(`../../src/sidepanel/psaApi.js?fresh=${Date.now()}`);
  assert.equal((await again.fetchPsaCert('91234567', { token, fetchImpl: card, chromeApi })).card.subject, 'CHARIZARD ex');
  assert.equal(calls, 1, 'no second call for the same cert');
  const quota = async () => { calls++; return new Response('"API calls quota exceeded! maximum admitted 100 per Day."', { status: 403, headers: { 'content-type': 'application/json' } }); };
  assert.deepEqual(await fetchPsaCert('91234568', { token, fetchImpl: quota, chromeApi }), { ok: false, reason: 'limit' }, 'quota text counts as the limit, even with a 403');
  assert.equal(calls, 2);
  assert.deepEqual(await fetchPsaCert('91234569', { token, fetchImpl: card, chromeApi }), { ok: false, reason: 'limit' });
  assert.equal(calls, 2, 'paused: no call for the rest of the day');
  assert.equal(await psaCallsToday(chromeApi), 2);
  assert.equal((await testPsaKey(token, { fetchImpl: card, chromeApi })).result, 'ok', 'saving a key still checks it');
  assert.equal((await fetchPsaCert('91234569', { token, fetchImpl: card, chromeApi })).ok, true, 'a working answer lifts the pause');
  assert.equal(await psaCallsToday(chromeApi), 4);
});

test('BGS: subgrades are cut out of a line (name kept)', async () => {
  const { cardInfo: info } = await import('../../src/core/priceLinks.js');
  const lines = ['BGS BECKETT GRADING SERVICES', '2023 SV 151 CENTERING 9.5', 'FIRE LIZARD ex #199 CORNERS 9.5', 'GEM MINT EDGES 10', '9.5 SURFACE 9.5', '0012345678'];
  assert.deepEqual(info({ grader: 'bgs', number: '0012345678', lines }), { desc: 'FIRE LIZARD ex 199', grade: '9.5' });
});
