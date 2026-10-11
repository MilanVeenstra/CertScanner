import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POP_URLS, cardQuery, cardInfo, gradeQuery, matchGrade, GRADE_SCALES, slabQuery, gradeFromLines, ebaySearchUrl, pricechartingUrl, psaAuctionUrl, isPriceUrl, POINT130_URL, ebayHostLabel, isEbaySite } from '../../src/core/priceLinks.js';

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
  assert.equal(q, 'POKEMON CHARIZARD ex 199 PSA 10', 'brand + name + card number + grade: only this card');
});

test('card query from a CGC comic label', () => {
  const q = cardQuery({ grader: 'cgc-comics', number: '4012345001', lines: ['UNIVERSAL GRADE', 'CGC 9.8', 'Amazing Spider-Man #300', 'Marvel Comics, 5/88', 'WHITE PAGES', 'CERTIFICATION # 4012345001'] });
  assert.equal(q, 'Amazing Spider-Man 300 CGC 9.8', 'publisher/date line left out');
});

test('card query from real OCR output (lines out of order, split words, barcode read as text)', () => {
  const psa = cardQuery({ grader: 'psa', number: '01234567', lines: ['2023 POKEMON SV 151', 'GEM MT 10', 'CHARIZARD ex', 'PSA', '01234567', '#199', 'CED $$ CII——'] });
  assert.equal(psa, 'POKEMON CHARIZARD ex 199 PSA 10');
  const cgc = cardQuery({ grader: 'cgc-comics', number: '4012345001', lines: ['CGC', 'UNIVERSAL GRADE', '4012345001', 'Amazing Spider-Man #300', 'Marvel Comics, 5/88', 'WHITE', 'PAGES', '8°'] });
  assert.equal(cgc, 'Amazing Spider-Man 300 CGC');
});

test('card info splits the card from the grade (CGC cards: grade words and number on separate lines)', () => {
  assert.deepEqual(cardInfo({ grader: 'cgc-cards', number: '1401036622258', lines: ['CGC', '2022 Pokemon Sword & Shield', 'Pikachu - Holo', 'GEM MINT', '10', '1401036622258'] }),
    { desc: 'Pokemon Sword Shield Pikachu Holo', grade: '10' }, 'no card number: the set name is kept');
  assert.deepEqual(cardInfo({ grader: 'psa', number: '108114622', lines: ['1986 FLEER', 'MICHAEL JORDAN', '#57', 'MINT 9', 'PSA', '108114622'] }),
    { desc: 'FLEER MICHAEL JORDAN 57', grade: '9' });
  assert.deepEqual(cardInfo({ grader: 'psa', number: '01234567', lines: null }), { desc: null, grade: null });
});

test('grade scales and grade queries', () => {
  assert.equal(GRADE_SCALES.psa[0], '10');
  assert.ok(!GRADE_SCALES.psa.includes('9.5') && GRADE_SCALES.psa.includes('8.5') && GRADE_SCALES.psa.includes('1'));
  assert.ok(GRADE_SCALES['cgc-cards'].includes('9.5'));
  assert.equal(matchGrade('cgc-comics', '9'), '9.0');
  assert.equal(matchGrade('cgc-comics', '10.0'), '10');
  assert.equal(matchGrade('psa', '9.5'), null);
  assert.equal(gradeQuery('psa', 'CHARIZARD ex #199', '10'), 'CHARIZARD ex #199 PSA 10');
  assert.equal(gradeQuery('psa', 'CHARIZARD ex #199', ''), 'CHARIZARD ex #199 PSA', 'all grades');
  assert.equal(gradeQuery('cgc-comics', 'Amazing Spider-Man #300', '9.8'), 'Amazing Spider-Man #300 CGC 9.8');
  assert.equal(gradeQuery('psa', '   ', '10'), null);
});

test('PriceCharting and PSA auction price links', () => {
  assert.equal(pricechartingUrl('2023 POKEMON SV 151 CHARIZARD ex #199'), 'https://www.pricecharting.com/search-products?q=POKEMON+SV+151+CHARIZARD+ex+%23199&type=prices');
  assert.equal(psaAuctionUrl('MICHAEL JORDAN #57'), 'https://www.psacard.com/auctionprices/search?q=MICHAEL+JORDAN+%2357');
  assert.throws(() => pricechartingUrl(' '), RangeError);
  assert.ok(isPriceUrl(pricechartingUrl('Pikachu')) && isPriceUrl(psaAuctionUrl('Pikachu')));
  assert.ok(!isPriceUrl('https://www.psacard.com/cert/01234567'), 'cert pages go through openCert, not the price opener');
  assert.ok(!isPriceUrl('https://www.pricecharting.com/game/x'));
});

test('rarity words are dropped, 1st Edition and parallels are kept', () => {
  assert.equal(cardInfo({ grader: 'psa', number: '01234567', lines: ['2023 POKEMON SV 151', 'CHARIZARD ex', 'SPECIAL ILLUSTRATION RARE', '#199', 'GEM MT 10'] }).desc, 'POKEMON CHARIZARD ex 199');
  assert.equal(cardInfo({ grader: 'psa', number: '01234567', lines: ['1999 POKEMON GAME', 'CHARIZARD-HOLO', '1ST EDITION', '#4', 'NM-MT 8'] }).desc, 'POKEMON CHARIZARD-HOLO 4 1ST EDITION');
  assert.equal(cardInfo({ grader: 'psa', number: '01234567', lines: ['2018 PANINI PRIZM', 'LUKA DONCIC', 'SILVER', '#280', 'GEM MT 10'] }).desc, 'PANINI LUKA DONCIC SILVER 280');
});

test('card query is null when the label gives too little', () => {
  assert.equal(cardQuery({ grader: 'psa', number: '01234567', lines: ['01234567', 'GEM MT 10'] }), null);
  assert.equal(cardQuery({ grader: 'psa', number: '01234567', lines: null }), null);
  assert.equal(cardQuery({ grader: null, number: '01234567', lines: ['CHARIZARD ex BASE SET'] }), null);
});

test('card query never contains long numbers (cert, barcodes, item ids)', () => {
  const q = cardQuery({ grader: 'psa', number: '108114622', lines: ['1986 FLEER', 'MICHAEL JORDAN', '#57', '108114622', '4012 3456 7890'] });
  assert.equal(q, 'FLEER MICHAEL JORDAN 57 PSA');
  assert.ok(!/\d{7,}/.test(q.replace(/\s/g, '')));
});

test('eBay links: sold and active, site switch, encoding', () => {
  assert.equal(ebaySearchUrl('com', 'PSA 01234567', { sold: true }), 'https://www.ebay.com/sch/i.html?_nkw=PSA+01234567&LH_Sold=1&LH_Complete=1');
  assert.equal(ebaySearchUrl('nl', 'Amazing Spider-Man #300 CGC 9.8'), 'https://www.ebay.nl/sch/i.html?_nkw=Amazing+Spider-Man+%23300+CGC+9.8');
  assert.equal(ebaySearchUrl('evil.example', 'x y'), 'https://www.ebay.com/sch/i.html?_nkw=x+y');
  assert.throws(() => ebaySearchUrl('com', '   '), RangeError);
  assert.equal(ebaySearchUrl('com', 'POKEMON CHARIZARD ex 199 PSA 10', { sold: true, single: true }),
    'https://www.ebay.com/sch/i.html?_nkw=POKEMON+CHARIZARD+ex+199+PSA+10+-lot+-proxy&LH_Sold=1&LH_Complete=1');
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

test('BGS: grade from the label (not the subgrades), card without brand or subgrades', () => {
  const lines = ['BECKETT GRADING SERVICES', '2023 POKEMON SV 151', 'CHARIZARD EX #199', 'GEM MINT 9.5', 'CENTERING 10 CORNERS 9.5 EDGES 9.5 SURFACE 9', '0012345678'];
  assert.deepEqual(cardInfo({ grader: 'bgs', number: '0012345678', lines }), { desc: 'POKEMON CHARIZARD EX 199', grade: '9.5' });
  assert.equal(slabQuery('bgs', '0012345678'), 'BGS 0012345678');
  assert.equal(gradeQuery('bgs', 'CHARIZARD EX #199', '10'), 'CHARIZARD EX #199 BGS 10');
});

test('population report links are allow-listed exactly', () => {
  for (const u of Object.values(POP_URLS)) assert.ok(isPriceUrl(u), u);
  assert.ok(!isPriceUrl('https://www.psacard.com/pop/other'));
  assert.equal(POP_URLS.bgs, undefined);
});
