import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ebayHost, ebayPermission, isEbayUrl, ebayUrls, parseEbayPrice, parseSoldDate, titleMatches, ebayOverview } from '../../src/core/ebaySold.js';

test('eBay sales: hosts, permission, search links without cert digits', () => {
  assert.equal(ebayHost('nl'), 'www.ebay.nl');
  assert.equal(ebayHost('nope'), 'www.ebay.com', 'unknown site falls back to ebay.com');
  assert.equal(ebayPermission('co.uk'), 'https://www.ebay.co.uk/*');
  assert.ok(isEbayUrl('https://www.ebay.com/sch/i.html?_nkw=x', 'com'));
  for (const bad of ['http://www.ebay.com/sch/i.html', 'https://www.ebay.de/sch/i.html', 'https://ebay.com.evil.example/']) assert.equal(isEbayUrl(bad, 'com'), false, bad);
  const u = ebayUrls('com', { grader: 'psa', desc: '2023 POKEMON CHARIZARD ex 199', grade: '10' });
  assert.equal(u.query, '2023 POKEMON CHARIZARD ex 199 PSA 10');
  const sold = new URL(u.sold);
  assert.equal(sold.pathname, '/sch/i.html');
  assert.equal(sold.searchParams.get('LH_Sold'), '1');
  assert.equal(sold.searchParams.get('_sop'), '13', 'newest first');
  assert.match(sold.searchParams.get('_nkw'), /-lot -proxy$/);
  const active = new URL(u.active);
  assert.equal(active.searchParams.get('LH_BIN'), '1');
  assert.equal(active.searchParams.get('_sop'), '15', 'cheapest first');
  assert.equal(active.searchParams.get('LH_Sold'), null);
  assert.equal(ebayUrls('com', { grader: 'psa', desc: '', grade: '10' }), null);
});

test('eBay sales: prices in the site formats; ranges are not one price', () => {
  assert.deepEqual(parseEbayPrice('$612.99'), { value: 612.99, currency: 'USD' });
  assert.deepEqual(parseEbayPrice('US $1,050.00', 'nl'), { value: 1050, currency: 'USD' });
  assert.deepEqual(parseEbayPrice('£1,050.00', 'co.uk'), { value: 1050, currency: 'GBP' });
  assert.deepEqual(parseEbayPrice('EUR 612,99', 'nl'), { value: 612.99, currency: 'EUR' });
  assert.deepEqual(parseEbayPrice('1.050,00 EUR', 'de'), { value: 1050, currency: 'EUR' });
  assert.deepEqual(parseEbayPrice('C $80.00', 'ca'), { value: 80, currency: 'CAD' });
  assert.deepEqual(parseEbayPrice('AU $95.50', 'com.au'), { value: 95.5, currency: 'AUD' });
  for (const bad of ['$600.00 to $700.00', '€ 5,00 - € 9,00', 'Free shipping', '', null]) assert.equal(parseEbayPrice(bad), null, String(bad));
});

test('eBay sales: sold dates in English, Dutch, German and French', () => {
  assert.equal(parseSoldDate('Oct 9, 2026'), '2026-10-09');
  assert.equal(parseSoldDate('9 okt 2026'), '2026-10-09');
  assert.equal(parseSoldDate('9. Okt. 2026'), '2026-10-09');
  assert.equal(parseSoldDate('9 févr. 2026'), '2026-02-09');
  assert.equal(parseSoldDate('3 mrt 2026'), '2026-03-03');
  assert.equal(parseSoldDate('Feb 31, 2026'), null, 'no such day');
  assert.equal(parseSoldDate('yesterday'), null);
});

test('eBay sales: only single copies of this card in this grade count', () => {
  const psa10 = { grader: 'psa', grade: '10', cardNo: '199' };
  assert.ok(titleMatches('2023 Pokemon 151 Charizard ex #199 PSA 10 GEM MINT', psa10));
  assert.ok(titleMatches('Charizard ex 199/165 PSA GEM MT 10', psa10));
  assert.ok(!titleMatches('Charizard ex #199 PSA 9 MINT', psa10), 'other grade');
  assert.ok(!titleMatches('Charizard ex #199 PSA 10 lot of 3', psa10), 'lot');
  assert.ok(!titleMatches('Charizard ex #199 PSA 10 BGS 9.5', psa10), 'two graders');
  assert.ok(!titleMatches('Charizard ex #199 PSA 10 and PSA 9', psa10), 'two grades');
  assert.ok(!titleMatches('Charizard ex #223 PSA 10', psa10), 'other card number');
  assert.ok(!titleMatches('Charizard ex #1990 PSA 10', psa10), 'number is a whole token');
  assert.ok(!titleMatches('Charizard ex #199 PSA 100', psa10));
  assert.ok(titleMatches('Charizard BGS 9.5 Gem Mint', { grader: 'bgs', grade: '9.5' }));
  assert.ok(titleMatches('Charizard Beckett 9.5', { grader: 'bgs', grade: '9.5' }));
  assert.ok(!titleMatches('Charizard BGS 9', { grader: 'bgs', grade: '9.5' }));
  assert.ok(titleMatches('Amazing Spider-Man 300 CGC 9.8', { grader: 'cgc-comics', grade: '9.8' }));
  assert.ok(!titleMatches('', psa10));
});

test('eBay sales: overview = matching sales newest first, median, cheapest Buy It Now, one currency', () => {
  const usd = (value) => ({ value, currency: 'USD' });
  const sale = (id, title, value, soldDate, currency = 'USD') => ({ id, url: `https://www.ebay.com/itm/${id}`, title, price: { value, currency }, soldDate });
  const sold = [
    sale('100000001', 'Charizard ex #199 PSA 10', 600, '2026-10-07'),
    sale('100000002', 'Charizard ex #199 PSA 10', 625, '2026-10-09'),
    sale('100000003', 'Charizard ex #199 PSA 9', 215, '2026-10-08'),
    sale('100000004', 'Charizard ex #199 PSA 10', 610, '2026-10-05'),
    sale('100000005', 'Charizard ex #199 PSA 10', 590, '2026-10-02'),
    sale('100000006', 'Charizard ex #199 PSA 10', 500, '2026-10-10', 'GBP'),
    sale('100000007', 'Charizard ex #199 PSA 10', 640, null),
  ];
  const active = [
    { id: '200000001', title: 'Charizard ex #199 PSA 10', price: usd(699) },
    { id: '200000002', title: 'Charizard ex #199 PSA 10', price: usd(649.99) },
    { id: '200000003', title: 'Charizard ex #199 PSA 9', price: usd(230) },
    { id: '200000004', title: 'Charizard ex #199 PSA 10', price: null },
  ];
  const o = ebayOverview({ sold, active }, { grader: 'psa', grade: '10', desc: 'POKEMON CHARIZARD ex 199', site: 'com' });
  assert.equal(o.currency, 'USD');
  assert.equal(o.count, 4, 'PSA 9, other currency and undated sale left out');
  assert.deepEqual(o.sales.map((x) => x.soldDate), ['2026-10-09', '2026-10-07', '2026-10-05', '2026-10-02']);
  assert.equal(o.last.price.value, 625);
  assert.equal(o.median, 605);
  assert.equal(o.forSale.count, 2);
  assert.equal(o.forSale.low.price.value, 649.99);
  const none = ebayOverview({ sold: [], active: [] }, { grader: 'psa', grade: '10', desc: 'X 1', site: 'com' });
  assert.deepEqual([none.count, none.last, none.median, none.forSale], [0, null, null, null]);
});
