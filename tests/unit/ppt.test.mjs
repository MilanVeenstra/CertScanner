import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPokemon, pptSearch, pptUrl, gradeKey, keyLabel, parsePptCards, bestPptCard, pptResult, PPT_PERMISSION } from '../../src/core/ppt.js';
import { loadPptPrices, isPptToken, testPptKey } from '../../src/sidepanel/pptApi.js';
import { testPsaKey } from '../../src/sidepanel/psaApi.js';

const json = JSON.parse(readFileSync(new URL('../fixtures/pokemonpricetracker/cards-charizard.json', import.meta.url), 'utf8'));
const TOKEN = 'ppt_test_token_1234567890';

test('PokemonPriceTracker: which slabs, search words, request, grade keys', () => {
  assert.ok(isPokemon({ lines: ['2023 POKEMON SV 151', 'CHARIZARD ex'] }));
  assert.ok(isPokemon({ desc: 'Pokémon Sword & Shield Pikachu' }));
  assert.ok(isPokemon({ brand: 'POKEMON SCARLET & VIOLET 151' }));
  assert.ok(!isPokemon({ lines: ['2018 PANINI PRIZM', 'LUKA DONCIC'], desc: 'PANINI LUKA DONCIC 280' }));
  assert.equal(pptSearch('POKEMON CHARIZARD ex 199'), 'CHARIZARD ex 199');
  assert.equal(pptSearch('2022 Pokemon Pikachu - Holo #25'), 'Pikachu 25');
  assert.equal(pptUrl('CHARIZARD ex 199'), 'https://www.pokemonpricetracker.com/api/v2/cards?search=CHARIZARD+ex+199&limit=2&includeEbay=true');
  assert.equal(PPT_PERMISSION, 'https://www.pokemonpricetracker.com/*');
  assert.equal(gradeKey('psa', '10'), 'psa10');
  assert.equal(gradeKey('bgs', '9.5'), 'bgs9_5');
  assert.equal(gradeKey('cgc-cards', '10'), 'cgc10');
  assert.equal(gradeKey('cgc-comics', '9.8'), null, 'comics are not on PokemonPriceTracker');
  assert.equal(gradeKey('psa', ''), null);
  assert.equal(keyLabel('psa10'), 'PSA 10');
  assert.equal(keyLabel('cgc9_5'), 'CGC 9.5');
  assert.equal(keyLabel('tag10'), 'TAG 10');
  assert.equal(keyLabel('junk'), null);
});

test('PokemonPriceTracker: response parsed defensively, card picked by number, result per grade', () => {
  const cards = parsePptCards(json);
  assert.equal(cards.length, 2);
  const c = bestPptCard(cards, { desc: 'POKEMON CHARIZARD ex 199', cardNo: '199' });
  assert.equal(c.set, 'Scarlet & Violet 151', 'the #199 card, not the first result (#223)');
  assert.deepEqual(Object.keys(c.grades).sort(), ['bgs9_5', 'cgc10', 'psa10', 'psa9'], 'unknown keys and unusable prices dropped');
  assert.equal(bestPptCard(cards, { desc: 'CHARIZARD ex 4', cardNo: '4' }), null, 'no card with that number');
  const r = pptResult(c, { grader: 'psa', grade: '10' });
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'ppt');
  assert.equal(r.name, 'Charizard ex #199/165');
  assert.deepEqual(r.current, { label: 'PSA 10', price: 601.5 }, 'the smart market price for the grade');
  assert.equal(r.lastSold, null, 'no single sales in this plan');
  assert.deepEqual(r.soldSummary, { median: 598, count: 42, lastDate: '2026-10-09' });
  assert.deepEqual(r.prices.map((p) => p.label), ['Ungraded', 'PSA 9', 'PSA 10', 'BGS 9.5', 'CGC 10']);
  const b = pptResult(c, { grader: 'bgs', grade: '9.5' });
  assert.deepEqual(b.current, { label: 'BGS 9.5', price: 255 });
  assert.equal(pptResult(c, { grader: 'psa', grade: '7' }).current, null, 'no sales in that grade');
  // Plans that return single sales: newest first becomes "last sold".
  const sold = parsePptCards({ data: [{ name: 'Pikachu', cardNumber: '25', ebay: { salesByGrade: { psa9: { medianPrice: 80 } }, soldListings: { psa9: [
    { title: 'PSA 9 Pikachu', price: 79, soldDate: '2026-10-01' }, { title: 'PSA 9 Pikachu holo', price: 85.5, soldDate: '2026-10-07T12:00:00Z' }, { title: '<b>x</b>', price: -3, soldDate: '2026-10-08' },
  ] } } }] })[0];
  const s = pptResult(sold, { grader: 'psa', grade: '9' });
  assert.deepEqual(s.lastSold, { date: '2026-10-07', title: 'PSA 9 Pikachu holo', price: 85.5 });
  assert.equal(s.sales.rows.length, 2, 'the sale without a valid price is dropped');
  assert.equal(s.soldSummary, null);
  assert.deepEqual(parsePptCards(null), []);
  assert.deepEqual(parsePptCards({ data: 'x' }), []);
});

test('PokemonPriceTracker client: key, permission, one request per card name, error codes', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization, credentials: init.credentials }); return new Response(JSON.stringify(json), { status: 200 }); };
  const chromeApi = { permissions: { contains: async ({ origins }) => origins[0] === PPT_PERMISSION } };
  assert.ok(isPptToken(TOKEN));
  assert.ok(!isPptToken('short'));
  assert.equal((await loadPptPrices({ desc: 'POKEMON CHARIZARD ex 199', cardNo: '199', grader: 'psa', grade: '10', token: 'x' }, { fetchImpl, chromeApi })).status, 'no-token');
  const r = await loadPptPrices({ desc: 'POKEMON CHARIZARD ex 199', cardNo: '199', grader: 'psa', grade: '10', token: TOKEN }, { fetchImpl, chromeApi });
  assert.equal(r.current.price, 601.5);
  const r9 = await loadPptPrices({ desc: 'POKEMON CHARIZARD ex 199', cardNo: '199', grader: 'psa', grade: '9', token: TOKEN }, { fetchImpl, chromeApi });
  assert.equal(r9.current.price, 205);
  assert.equal(calls.length, 1, 'a grade change reuses the answer (no extra credits)');
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.equal(calls[0].credentials, 'omit', 'no cookies');
  assert.ok(!calls[0].url.includes('01234567'), 'no cert number is sent');
  const status = (code) => loadPptPrices({ desc: `POKEMON MEW ${code}`, grader: 'psa', grade: '10', token: TOKEN }, { fetchImpl: async () => new Response('{}', { status: code }), chromeApi });
  assert.equal((await status(401)).status, 'auth');
  assert.equal((await status(429)).status, 'limit');
  assert.equal((await status(500)).status, 'error');
  const noPerm = await loadPptPrices({ desc: 'POKEMON MEW 151', grader: 'psa', grade: '10', token: TOKEN }, { fetchImpl, chromeApi: { permissions: { contains: async () => false } } });
  assert.equal(noPerm.status, 'no-permission');
});

test('PokemonPriceTracker: other answer shapes are still read; every miss says why', async () => {
  // Same data under other names: a bare array, cardName/number, grades under another key.
  const alt = [{ cardName: 'Charizard ex', number: '199', setName: 'SV 151', marketPrice: 120,
    graded: { PSA10: { medianPrice: 600, count: 3 }, 'cgc9.5': { averagePrice: 300 } } }];
  const cards = parsePptCards(alt);
  assert.equal(cards.length, 1);
  assert.deepEqual(Object.keys(cards[0].grades).sort(), ['cgc9_5', 'psa10']);
  const deep = parsePptCards({ data: [{ name: 'Mew', cardNumber: '151', stats: { market: { psa9: { medianPrice: 50 } } } }] });
  assert.equal(deep[0].grades.psa9.median, 50, 'grade map found a few levels deep');
  const noNumbers = parsePptCards({ data: [{ name: 'Charizard ex', ebay: { salesByGrade: { psa10: { medianPrice: 600 } } } }] });
  assert.equal(bestPptCard(noNumbers, { desc: 'CHARIZARD ex 199', cardNo: '199' })?.name, 'Charizard ex', 'answer without numbers: matched by name');

  const chromeApi = { permissions: { contains: async () => true } };
  const reply = (body, status = 200) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  const load = (fetchImpl, p = {}) => loadPptPrices({ desc: 'POKEMON CHARIZARD ex 199', cardNo: '199', grader: 'psa', grade: '10', token: TOKEN, ...p }, { fetchImpl, chromeApi });
  assert.equal((await load(reply({ data: [] }), { desc: 'POKEMON ZZZ 1' })).status, 'not-found');
  const nm = await load(reply(json), { desc: 'POKEMON CHARIZARD ex 4', cardNo: '4' });
  assert.equal(nm.status, 'no-match');
  assert.equal(nm.search, 'CHARIZARD ex 4');
  const ng = await load(reply(json), { grade: '6' });
  assert.equal(ng.status, 'no-grade');
  assert.equal(ng.result.prices.length, 5, 'the other grades come along');
  assert.equal((await load(reply({ data: [{ id: 1 }] }), { desc: 'POKEMON ODD 9' })).status, 'format');

  // Key checks right after saving.
  const seen = [];
  const ok = async (url, init) => { seen.push({ url, auth: init.headers.Authorization }); return new Response(JSON.stringify({ data: [{ name: 'Pikachu' }] }), { status: 200 }); };
  assert.equal(await testPptKey(TOKEN, { fetchImpl: ok, chromeApi }), 'ok');
  assert.equal(seen[0].url, 'https://www.pokemonpricetracker.com/api/v2/cards?search=pikachu&limit=1', 'one card, no eBay data: 1 credit');
  assert.equal(await testPptKey(TOKEN, { fetchImpl: reply('{}', 401), chromeApi }), 'auth');
  assert.equal(await testPptKey(TOKEN, { fetchImpl: reply('{}', 429), chromeApi }), 'limit');
  assert.equal(await testPptKey(TOKEN, { fetchImpl: reply({ data: [] }), chromeApi }), 'format');
  const psa = (fetchImpl) => testPsaKey('psa_test_token_123456', { fetchImpl, chromeApi });
  const page = (status, headers = { 'content-type': 'text/html' }) => async () => new Response('<!DOCTYPE html><title>Just a moment...</title>', { status, headers });
  assert.deepEqual(await psa(reply('{}', 404)), { result: 'ok', status: 404 }, 'the test number need not exist');
  assert.deepEqual(await psa(reply('{}', 401)), { result: 'auth', status: 401 });
  assert.deepEqual(await psa(reply('{"Message":"Authorization has been denied for this request."}', 403)), { result: 'auth', status: 403 });
  assert.deepEqual(await psa(page(403)), { result: 'blocked', status: 403 }, "a bot-check page is PSA's site protection, not a refused key");
  assert.deepEqual(await psa(page(403, { 'cf-mitigated': 'challenge' })), { result: 'blocked', status: 403 });
  assert.deepEqual(await psa(reply('{}', 500)), { result: 'server', status: 500 }, "PSA's docs: 500 = invalid credentials or a server error");
  assert.deepEqual(await psa(reply('{}', 429)), { result: 'limit', status: 429 });
  assert.deepEqual(await psa(async () => { throw new TypeError('offline'); }), { result: 'error', status: 0 });
  let init = null;
  await psa(async (url, i) => { init = i; return new Response('{}', { status: 200 }); });
  assert.equal(init.credentials, 'include', "the browser's psacard.com cookies go along, like a visit");
  assert.equal(init.headers.Authorization, 'bearer psa_test_token_123456');
});
