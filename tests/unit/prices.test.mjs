import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice, searchUrl, isPcUrl, gradeLabels, pickPrice, pickSales } from '../../src/core/pricecharting.js';
import { parsePsaCert } from '../../src/sidepanel/psaApi.js';
import { cardNoFrom, isPriceUrl } from '../../src/core/priceLinks.js';

test('PriceCharting: prices, search link, allowed pages', () => {
  assert.equal(parsePrice('$1,050.00'), 1050);
  assert.equal(parsePrice(' $612.99 +$1.10'), 612.99);
  assert.equal(parsePrice('N/A'), null);
  assert.equal(searchUrl('2023 POKEMON CHARIZARD ex 199'), 'https://www.pricecharting.com/search-products?q=POKEMON+CHARIZARD+ex+199&type=prices');
  assert.ok(isPcUrl('https://www.pricecharting.com/game/pokemon-scarlet-&-violet-151/charizard-ex-199'));
  for (const bad of ['http://www.pricecharting.com/game/a/b', 'https://evil.example/game/a/b', 'https://www.pricecharting.com/offers', 'https://u@www.pricecharting.com/game/a/b']) {
    assert.equal(isPcUrl(bad), false, bad);
  }
  assert.ok(isPriceUrl('https://www.pricecharting.com/game/a/b'), 'the product page may be opened from the panel');
});

test('PriceCharting: grade labels, picking the slab grade (never another grade)', () => {
  assert.deepEqual(gradeLabels('psa', '10'), ['PSA 10', 'Grade 10']);
  assert.deepEqual(gradeLabels('bgs', '9.5'), ['Grade 9.5']);
  assert.equal(gradeLabels('cgc-comics', '9.8')[0], '9.8');
  assert.deepEqual(gradeLabels('psa', ''), []);
  const prices = [{ label: 'Ungraded', price: 118 }, { label: 'Grade 9', price: 212 }, { label: 'PSA 10', price: 612 }];
  assert.equal(pickPrice(prices, gradeLabels('psa', '10')).price, 612);
  assert.equal(pickPrice(prices, gradeLabels('psa', '9')).price, 212);
  assert.equal(pickPrice(prices, gradeLabels('bgs', '10')), null);
  const sales = { Ungraded: [{ price: 1 }], 'PSA 10 (25)': [{ price: 600 }] };
  assert.equal(pickSales(sales, ['PSA 10']).rows[0].price, 600);
  assert.equal(pickSales(sales, ['Grade 9']), null);
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

test('prices are only fetched after the user allowed www.pricecharting.com', async () => {
  const { loadPrices } = await import('../../src/sidepanel/priceData.js');
  let fetched = 0;
  const chromeApi = { permissions: { contains: async () => false } };
  const r = await loadPrices({ query: 'POKEMON CHARIZARD ex 199', grader: 'psa', grade: '10' }, { chromeApi, fetchImpl: async () => { fetched++; } });
  assert.equal(r.status, 'no-permission');
  assert.equal(fetched, 0);
});

test('PSA lookup needs a saved key and api.psacard.com access', async () => {
  const { fetchPsaCert } = await import('../../src/sidepanel/psaApi.js');
  let fetched = 0;
  const fetchImpl = async () => { fetched++; };
  assert.deepEqual(await fetchPsaCert('81234567', { token: null, fetchImpl }), { ok: false, reason: 'no-token' });
  assert.deepEqual(await fetchPsaCert('81234567', { token: 'test-token-1234567890', fetchImpl, chromeApi: { permissions: { contains: async () => false } } }), { ok: false, reason: 'no-permission' });
  assert.equal(fetched, 0);
});
