import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCandidates, analyze, keywordScores } from '../../src/core/certParser.js';
import { decide } from '../../src/core/routing.js';
import { ocrPage, digitsPage, settings } from './helpers.mjs';

const PSA_LABEL = ['2023 POKEMON SV 151', 'GEM MT 10', 'CHARIZARD ex', '#199', '01234567'];

test('keywordScores: whole-word, once per term, capped at 1', () => {
  const s = keywordScores('CGC 9.8 WHITE PAGES UNIVERSAL GRADE CGC CGC');
  assert.equal(s['cgc-comics'].score, 1);
  assert.equal(s['cgc-cards'].score, 0.4);
  assert.equal(s.psa.score, 0);
  assert.equal(keywordScores('PSAX').psa.score, 0);          // not a whole word
  assert.equal(keywordScores('psa gem mt 10').psa.score, 1); // case-normalised, .6 + .5 capped
  assert.equal(keywordScores('GEM  MT\n10').psa.score, 0.5); // whitespace normalised
  assert.equal(keywordScores('MINT 9').psa.score, 0);
  assert.equal(keywordScores('GEM MINT 10').psa.score, 0);
  assert.equal(keywordScores('GEM MINT 10')['cgc-cards'].score, 0.5);
  assert.deepEqual(keywordScores('PSA').psa.terms, ['PSA']);
});

test('J1: PSA 8 digits, conf 88, both passes, GEM MT -> .885 -> auto-open, leading zero kept', () => {
  const cands = parseCandidates({ pages: [ocrPage(PSA_LABEL), digitsPage('01234567')], barcodes: [] });
  assert.equal(cands.length, 1);
  const [c] = cands;
  assert.equal(c.number, '01234567');
  assert.equal(c.grader, 'psa');
  assert.equal(c.source, 'ocr');
  assert.equal(c.confidence, 0.89); // .685 + .15 + .05 = .885, rounded to 2 dp
  assert.ok(c.evidence.includes('len:8'));
  assert.ok(c.evidence.includes('pass:text') && c.evidence.includes('pass:digits'));
  assert.ok(c.evidence.includes('kw:GEM MT'));
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('J1 variant: the "PSA" brand word missing still resolves PSA via GEM MT', () => {
  const cands = parseCandidates({ pages: [ocrPage(['GEM MT 10', '01234567']), digitsPage('01234567')] });
  assert.equal(cands[0].grader, 'psa');
  assert.ok(cands[0].confidence >= 0.8);
});

test('single pass only (no second read) stays below the auto-open gate', () => {
  const cands = parseCandidates({ pages: [ocrPage(PSA_LABEL)] });
  assert.equal(cands[0].confidence, 0.74); // .685 + .05
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('J3: 13 digits -> cgc-cards, .885, auto-open', () => {
  const page = ocrPage(['CGC', '2022 Pokemon Sword & Shield', 'Pikachu - Holo', 'GEM MINT', '10', '1401036622258']);
  const cands = parseCandidates({ pages: [page, digitsPage('1401036622258')] });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].grader, 'cgc-cards');
  assert.equal(cands[0].number, '1401036622258');
  assert.equal(cands[0].confidence, 0.89);
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('J2: 10 digits with UNIVERSAL GRADE -> cgc-comics, .935, auto-open', () => {
  const page = ocrPage(['UNIVERSAL GRADE', 'Amazing Spider-Man #300', 'Marvel Comics, 5/88', '4012345001']);
  const cands = parseCandidates({ pages: [page, digitsPage('4012345001')] });
  assert.equal(cands[0].grader, 'cgc-comics');
  assert.equal(cands[0].confidence, 0.94); // .935 rounded
  assert.deepEqual(cands[0].graderOptions[0], 'cgc-comics');
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('full CGC comic label (brand, 9.8, WHITE PAGES) resolves cgc-comics', () => {
  const page = ocrPage(['CGC', '9.8', 'WHITE', 'PAGES', 'UNIVERSAL GRADE', 'Amazing Spider-Man #300', 'Marvel Comics, 5/88', '4012345001']);
  const cands = parseCandidates({ pages: [page, digitsPage('4012345001')] });
  assert.equal(cands[0].grader, 'cgc-comics');
  assert.ok(cands[0].evidence.includes('kw:UNIVERSAL GRADE'));
});

test('J5: 10 digits, no keywords -> .435, grader null, options comics/cards/psa/bgs, confirm', () => {
  const cands = parseCandidates({ pages: [ocrPage(['5012345678']), digitsPage('5012345678')] });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].grader, null);
  assert.deepEqual(cands[0].graderOptions, ['cgc-comics', 'cgc-cards', 'psa', 'bgs']);
  assert.equal(cands[0].confidence, 0.44); // .835 - .20 - .20 = .435
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('10 digits with only "CGC" stays unresolved between comics and cards (D4)', () => {
  const cands = parseCandidates({ pages: [ocrPage(['CGC', '5012345678']), digitsPage('5012345678')] });
  assert.equal(cands[0].grader, null);
  assert.deepEqual(cands[0].graderOptions, ['cgc-comics', 'cgc-cards', 'psa', 'bgs']);
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('BGS label: brand and subgrades resolve bgs, but the lookup form is never auto-opened', () => {
  const label = ['BECKETT GRADING SERVICES', '2023 POKEMON SV 151', 'CHARIZARD EX #199', 'GEM MINT 9.5',
    'CENTERING 9.5 CORNERS 9.5 EDGES 10 SURFACE 9.5', '0012345678'];
  const cands = parseCandidates({ pages: [ocrPage(label), digitsPage('0012345678')] });
  assert.equal(cands[0].grader, 'bgs');
  assert.equal(cands[0].number, '0012345678', 'leading zeros kept');
  assert.ok(cands[0].confidence >= 0.8);
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('10 digits with card wording resolves cgc-cards', () => {
  const cands = parseCandidates({ pages: [ocrPage(['CGC', 'PRISTINE 10', '4340250002']), digitsPage('4340250002')] });
  assert.equal(cands[0].grader, 'cgc-cards');
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('Barcode only, no slab vocabulary -> .65 confirm', () => {
  const cands = parseCandidates({ pages: [], barcodes: [{ format: 'Code128', text: '81234567', engine: 'zxing' }] });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].source, 'barcode');
  assert.equal(cands[0].grader, 'psa');
  assert.equal(cands[0].confidence, 0.65);
  assert.ok(cands[0].evidence.includes('barcode:Code128'));
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('Barcode + OCR of the same number counts as two reads', () => {
  const cands = parseCandidates({
    pages: [ocrPage(['PSA', '81234567'])],
    barcodes: [{ format: 'Code128', text: '81234567', engine: 'zxing' }],
  });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].source, 'barcode');
  assert.equal(cands[0].confidence, 1); // .80 + .15 + .05 clamped
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('PSA back-label barcode with the brand word missed still auto-opens via barcode + OCR', () => {
  const cands = parseCandidates({
    pages: [ocrPage(['81234567']), digitsPage('81234567')],
    barcodes: [{ format: 'Code128', text: '81234567', engine: 'zxing' }],
  });
  assert.equal(cands[0].confidence, 0.8); // .80 + .15 + .05 - .20
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('Allow-listed QR -> qr-url .95, grader from host, auto-open', () => {
  const a = analyze({ pages: [], barcodes: [{ format: 'QRCode', text: 'https://www.cgccomics.com/certlookup/4012347003/', engine: 'zxing' }] });
  assert.deepEqual(a.warnings, []);
  const [c] = a.candidates;
  assert.equal(c.source, 'qr-url');
  assert.equal(c.grader, 'cgc-comics');
  assert.equal(c.number, '4012347003');
  assert.equal(c.confidence, 0.95);
  assert.ok(c.evidence.includes('qr-host:www.cgccomics.com'));
  assert.equal(decide(a.candidates, settings(), a.warnings), 'auto-open');
});

test('Allow-listed QR with an unmatched path -> .85 and qr-path-unmatched', () => {
  const [c] = parseCandidates({ barcodes: [{ format: 'QRCode', text: 'https://www.psacard.com/verify?c=12345678', engine: 'zxing' }] });
  assert.equal(c.source, 'qr-url');
  assert.equal(c.confidence, 0.85);
  assert.ok(c.evidence.includes('qr-path-unmatched'));
});

test('Untrusted QR host: digits only, source barcode, capped at .50, warning, never auto-open', () => {
  const a = analyze({ pages: [ocrPage(['SCAN TO VERIFY'])], barcodes: [{ format: 'QRCode', text: 'https://evil.example/cert/12345678', engine: 'zxing' }] });
  assert.deepEqual(a.warnings, [{ code: 'qr-untrusted-host', detail: 'evil.example' }]);
  for (const c of a.candidates) {
    assert.equal(c.source, 'barcode');
    assert.ok(c.confidence <= 0.5);
    assert.ok(c.evidence.includes('qr-untrusted:evil.example'));
  }
  assert.notEqual(decide(a.candidates, settings(), a.warnings), 'auto-open');
});

test('Untrusted QR digits never exceed the cap even with slab vocabulary and a second read', () => {
  const a = analyze({
    pages: [],
    barcodes: [
      { format: 'QRCode', text: 'https://evil.example/cert/12345678', engine: 'zxing' },
      { format: 'QRCode', text: 'https://evil.example/c/12345678?x=1', engine: 'native' },
    ],
  });
  assert.ok(a.candidates.every((c) => c.confidence <= 0.5));
});

test('Untrusted QR warning blocks auto-open of an otherwise confident printed number', () => {
  const a = analyze({
    pages: [ocrPage(PSA_LABEL), digitsPage('01234567')],
    barcodes: [{ format: 'QRCode', text: 'https://evil.example/x/99999999', engine: 'zxing' }],
  });
  assert.equal(a.candidates[0].number, '01234567');
  assert.equal(decide(a.candidates, settings(), a.warnings), 'confirm');
});

test('Dash form 4012346-002 -> 4012346002 cgc-comics, no stray 7-digit PSA candidate', () => {
  const page = ocrPage(['CGC', '9.8', 'WHITE PAGES', 'UNIVERSAL GRADE', '4012346-002']);
  const cands = parseCandidates({ pages: [page, digitsPage('4012346-002')] });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].number, '4012346002');
  assert.equal(cands[0].grader, 'cgc-comics');
  assert.ok(cands[0].evidence.includes('dash-form'));
  assert.equal(decide(cands, settings(), []), 'auto-open');
});

test('Dash form split by OCR spaces around the dash is still joined', () => {
  const cands = parseCandidates({ pages: [ocrPage(['UNIVERSAL GRADE', '4012346 - 002']), digitsPage('4012346-002')] });
  assert.equal(cands[0].number, '4012346002');
  assert.ok(!cands.some((c) => c.number === '4012346'));
});

test('Dash form alone is cgc-comics evidence', () => {
  const cands = parseCandidates({ pages: [ocrPage(['4012346-002']), digitsPage('4012346-002')] });
  assert.equal(cands[0].grader, 'cgc-comics');
});

test('OCR fix-ups apply only to long digit-heavy tokens and cost .15 when every read needed one', () => {
  const cands = parseCandidates({ pages: [ocrPage(['GEM MT 10', 'O1234S67']), digitsPage('O1234S67')] });
  assert.equal(cands[0].number, '01234567');
  assert.ok(cands[0].evidence.includes('fixup'));
  assert.equal(cands[0].confidence, 0.74); // .885 - .15
  // One clean read: no fix-up penalty
  const mixed = parseCandidates({ pages: [ocrPage(['GEM MT 10', 'O1234567']), digitsPage('01234567')] });
  assert.equal(mixed[0].confidence, 0.89);
  // Short or letter-heavy tokens are not fixed
  assert.deepEqual(parseCandidates({ pages: [ocrPage(['SOLO BOSS IS', 'ABCDE12345'])] }), []);
});

test('Competition: two numbers >= .50 each lose .10 and nothing auto-opens', () => {
  const page = ocrPage(['GEM MT 10', '01234567', '87654321']);
  const cands = parseCandidates({ pages: [page, digitsPage('01234567'), digitsPage('87654321')] });
  assert.equal(cands.length, 2);
  for (const c of cands) assert.equal(c.confidence, 0.79); // .885 - .10
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('Keyword conflict: 8-digit number on a CGC-comics label is penalised', () => {
  const cands = parseCandidates({ pages: [ocrPage(['UNIVERSAL GRADE', 'WHITE PAGES', '12345678']), digitsPage('12345678')] });
  assert.equal(cands[0].grader, 'psa');
  assert.ok(cands[0].evidence.includes('conflict'));
  assert.equal(cands[0].confidence, 0.69); // .685 + .15 - .15
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('Low confidence OCR scales the base and drops below .30', () => {
  const lo = parseCandidates({ pages: [ocrPage(['5012345678'], { conf: 40 })] });
  assert.deepEqual(lo, []); // .40 - .20 - .20 = 0
  const mid = parseCandidates({ pages: [ocrPage(['GEM MT', '01234567'], { conf: 70 })] });
  assert.equal(mid[0].confidence, 0.6); // .40 + .30*.5 + .05
});

test('cert-label bonus when the number line carries CERT/CERTIFICATION', () => {
  const cands = parseCandidates({ pages: [ocrPage(['UNIVERSAL GRADE', 'CERTIFICATION 4012345001'])] });
  assert.ok(cands[0].evidence.includes('cert-label'));
  assert.equal(cands[0].confidence, 0.84); // .685 + .10 + .05
});

test('Invalid lengths and non-slab text produce no candidates', () => {
  assert.deepEqual(parseCandidates({ pages: [ocrPage(['2023 POKEMON SV 151', '#199', '123456', '12345678901'])] }), []);
  assert.deepEqual(parseCandidates({ pages: [], barcodes: [] }), []);
  assert.deepEqual(parseCandidates({}), []);
  assert.deepEqual(parseCandidates({ pages: [ocrPage([])] }), []);
});

test('Same number in two words of one pass counts as one read', () => {
  const cands = parseCandidates({ pages: [ocrPage(['GEM MT 10', '01234567', '01234567'])] });
  assert.equal(cands[0].confidence, 0.74);
});

test('At most 5 candidates, sorted by confidence', () => {
  const nums = ['11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '77777777'];
  const cands = parseCandidates({ barcodes: nums.map((t) => ({ format: 'Code128', text: t, engine: 'zxing' })) });
  assert.ok(cands.length <= 5);
  for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].confidence >= cands[i].confidence);
});

test('Hostile inputs are tolerated', () => {
  const evil = { text: null, confidence: NaN, words: [{ text: 12345678, confidence: 'x', bbox: null, lineText: undefined }] };
  assert.doesNotThrow(() => parseCandidates({ pages: [evil, null, 'x'], barcodes: [null, { text: 5 }, { format: 'QRCode', text: 'x'.repeat(100000) }] }));
});

test('automatic grader: BGS serial shape, CGC comic/card wording, page hints', () => {
  const p = (lines, number, hints) => parseCandidates({ pages: [ocrPage([...lines, number]), digitsPage(number)], hints })[0];
  assert.equal(p([], '0012345678').grader, 'bgs', 'zero-padded 10-digit serial -> Beckett');
  assert.equal(p(['CGC', 'Marvel Comics, 5/88'], '4012345001').grader, 'cgc-comics');
  assert.equal(p(['CGC', '2022 Pokemon Sword & Shield', 'Pikachu'], '4340250002').grader, 'cgc-cards');
  assert.equal(p([], '5012345678', 'Charizard ex #199 PSA 10 | eBay').grader, 'psa', 'brand from the page title');
  assert.equal(p([], '5012345678', 'Amazing Spider-Man #300 CGC 9.8 Marvel Comics').grader, 'cgc-comics');
  assert.equal(p(['CGC', 'UNIVERSAL GRADE'], '4012345001', 'PSA 10 BGS 9.5 lot').grader, 'cgc-comics', 'the label brand wins over hints');
  const unsure = p(['Pikachu Pokemon'], '5012345678');
  assert.equal(unsure.grader, null, 'card wording alone does not decide');
  assert.equal(unsure.graderOptions[0], 'cgc-cards', '... but ranks CGC Cards first (best guess)');
});
