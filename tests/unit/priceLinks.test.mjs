import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardQuery, slabQuery, gradeFromLines, ebaySearchUrl, isPriceUrl, POINT130_URL, ebayHostLabel, isEbaySite } from '../../src/core/priceLinks.js';

test('slab query: grader short name + cert number', () => {
  assert.equal(slabQuery('psa', '01234567'), 'PSA 01234567');
  assert.equal(slabQuery('cgc-comics', '4012345001'), 'CGC 4012345001');
  assert.equal(slabQuery('cgc-cards', '1401036622258'), 'CGC 1401036622258');
  assert.equal(slabQuery(null, '01234567'), null);
  assert.equal(slabQuery('psa', '12ab'), null);
});

test('grade from label lines', () => {
  assert.equal(gradeFromLines('psa', ['2023 POKEMON SV 151', 'GEM MT 10']), '10');
  assert.equal(gradeFromLines('psa', ['NM-MT 8']), '8');
  assert.equal(gradeFromLines('psa', ['MINT 9']), '9');
  assert.equal(gradeFromLines('cgc-comics', ['UNIVERSAL GRADE', 'CGC 9.8', 'Marvel Comics, 5/88']), '9.8');
  assert.equal(gradeFromLines('psa', ['CHARIZARD ex']), null);
});

test('card query from a PSA label drops the cert, grade line and noise', () => {
  const q = cardQuery({ grader: 'psa', number: '01234567', lines: ['GEM MT 10', '2023 POKEMON SV 151', 'CHARIZARD ex', '#199', '(T1TT', '01234567'] });
  assert.equal(q, '2023 POKEMON SV 151 CHARIZARD ex #199 PSA 10');
});

test('card query from a CGC comic label', () => {
  const q = cardQuery({ grader: 'cgc-comics', number: '4012345001', lines: ['UNIVERSAL GRADE', 'CGC 9.8', 'Amazing Spider-Man #300', 'Marvel Comics, 5/88', 'WHITE PAGES', 'CERTIFICATION # 4012345001'] });
  assert.equal(q, 'Amazing Spider-Man #300 Marvel Comics 5/88 CGC 9.8');
});

test('card query from real OCR output (lines out of order, split words, barcode read as text)', () => {
  const psa = cardQuery({ grader: 'psa', number: '01234567', lines: ['2023 POKEMON SV 151', 'GEM MT 10', 'CHARIZARD ex', 'PSA', '01234567', '#199', 'CED $$ CII——'] });
  assert.equal(psa, '2023 POKEMON SV 151 CHARIZARD ex #199 PSA 10');
  const cgc = cardQuery({ grader: 'cgc-comics', number: '4012345001', lines: ['CGC', 'UNIVERSAL GRADE', '4012345001', 'Amazing Spider-Man #300', 'Marvel Comics, 5/88', 'WHITE', 'PAGES', '8°'] });
  assert.equal(cgc, 'Amazing Spider-Man #300 Marvel Comics 5/88 CGC');
});

test('card query is null when the label gives too little', () => {
  assert.equal(cardQuery({ grader: 'psa', number: '01234567', lines: ['01234567', 'GEM MT 10'] }), null);
  assert.equal(cardQuery({ grader: 'psa', number: '01234567', lines: null }), null);
  assert.equal(cardQuery({ grader: null, number: '01234567', lines: ['CHARIZARD ex BASE SET'] }), null);
});

test('card query never contains long numbers (cert, barcodes, item ids)', () => {
  const q = cardQuery({ grader: 'psa', number: '108114622', lines: ['1986 FLEER', 'MICHAEL JORDAN', '#57', '108114622', '4012 3456 7890'] });
  assert.equal(q, '1986 FLEER MICHAEL JORDAN #57 PSA');
  assert.ok(!/\d{7,}/.test(q.replace(/\s/g, '')));
});

test('eBay links: sold and active, site switch, encoding', () => {
  assert.equal(ebaySearchUrl('com', 'PSA 01234567', { sold: true }), 'https://www.ebay.com/sch/i.html?_nkw=PSA+01234567&LH_Sold=1&LH_Complete=1');
  assert.equal(ebaySearchUrl('nl', 'Amazing Spider-Man #300 CGC 9.8'), 'https://www.ebay.nl/sch/i.html?_nkw=Amazing+Spider-Man+%23300+CGC+9.8');
  assert.equal(ebaySearchUrl('evil.example', 'x y'), 'https://www.ebay.com/sch/i.html?_nkw=x+y');
  assert.throws(() => ebaySearchUrl('com', '   '), RangeError);
  const long = ebaySearchUrl('com', 'a'.repeat(500));
  assert.ok(long.length < 200);
});

test('isPriceUrl only accepts the links this module builds', () => {
  assert.ok(isPriceUrl(ebaySearchUrl('de', 'PSA 1', { sold: true })));
  assert.ok(isPriceUrl(POINT130_URL));
  for (const bad of ['https://evil.example/sch/i.html', 'http://www.ebay.com/sch/i.html?_nkw=x', 'https://www.ebay.com/itm/123', 'https://user@www.ebay.com/sch/i.html', 'https://www.ebay.com:444/sch/i.html', 'https://130point.com/other', 'javascript:alert(1)', '']) {
    assert.equal(isPriceUrl(bad), false, bad);
  }
});

test('site helpers', () => {
  assert.equal(ebayHostLabel('co.uk'), 'ebay.co.uk');
  assert.equal(ebayHostLabel('nope'), 'ebay.com');
  assert.ok(isEbaySite('com.au'));
  assert.ok(!isEbaySite('__proto__'));
});
