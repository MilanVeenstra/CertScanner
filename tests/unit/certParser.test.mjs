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
  assert.equal(decide(cands, settings(), [], undefined, { lookupOk: true }), 'auto-open', 'clear BGS read: the panel shows the result and prices at once');
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

// A20 changed this case: before, PSA was preselected because it is the only grader for 8 digits. On a label that
// clearly names another grader the read is most likely incomplete (glare, a lost leading zero), so the grader stays
// open with the label's grader offered first and the number left to correct.
test('Keyword conflict: 8-digit number on a CGC-comics label is penalised and left without a grader (incomplete)', () => {
  const cands = parseCandidates({ pages: [ocrPage(['UNIVERSAL GRADE', 'WHITE PAGES', '12345678']), digitsPage('12345678')] });
  assert.equal(cands[0].grader, null);
  assert.deepEqual(cands[0].graderOptions, ['cgc-comics', 'psa']);
  assert.ok(cands[0].evidence.includes('conflict') && cands[0].evidence.includes('incomplete'));
  assert.equal(cands[0].confidence, 0.69); // .685 + .15 - .15 (no length bonus)
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

test('a number read only by the label pass is never auto-opened (two reads of one crop)', () => {
  const label = ['BGS', 'BECKETT GRADING SERVICES', 'CENTERING 9.5', '0012345678'];
  const page = { ...ocrPage(label), labelPass: true };
  const digits = { ...digitsPage('2901234567'), labelPass: true };
  const cands = parseCandidates({ pages: [ocrPage(['CGC', 'GEM MINT 10', 'Sea Dragon - Holo']), { ...ocrPage(['2901234567']), labelPass: true }, digits] });
  assert.ok(cands[0].confidence < 0.8 && cands[0].evidence.includes('label-pass'));
  assert.equal(decide(cands, settings(), []), 'confirm');
  assert.ok(parseCandidates({ pages: [page] }).every((c) => c.confidence < 0.8));
});

// ------------------------------------------------------------------ A20 (scan-accuracy round 2026-10-12)
const tag = (page, extra) => ({ ...page, ...extra });
const BGS_WORDS = ['BECKETT GRADING SERVICES', 'BGS', 'CENTERING 9.5 CORNERS 9.5'];

test('A20 confidence floor: a whitelist fall-back (conf < 20) neither stands alone nor counts as a second read', () => {
  // "2023 SV 151" read through a digits whitelist fuses into a 7-digit PSA-length run at confidence 0.
  assert.deepEqual(parseCandidates({ pages: [ocrPage(BGS_WORDS), digitsPage('2023151', 0)] }), []);
  const cands = parseCandidates({ pages: [ocrPage(['GEM MT 10', '01234567']), digitsPage('01234567', 5)] });
  assert.equal(cands[0].confidence, 0.74, 'one real read: .685 + .05, no second-read bonus');
  assert.equal(decide(cands, settings(), []), 'confirm');
});

test('A20 label pass: two reads of one black/white image are not shown; the plain image agreeing is (capped, confirm)', () => {
  const full = ocrPage(BGS_WORDS);
  const bin = tag(digitsPage('0012345678'), { labelPass: true, variant: 'bin' });
  const binText = tag(ocrPage(['0012345678']), { labelPass: true, variant: 'bin' });
  assert.deepEqual(parseCandidates({ pages: [full, bin, binText] }), [], 'same image twice: not independent');
  const plain = tag(ocrPage([...BGS_WORDS, '0012345678']), { labelPass: true, variant: 'plain' });
  const cands = parseCandidates({ pages: [full, bin, plain] });
  assert.equal(cands.length, 1);
  assert.equal(cands[0].number, '0012345678');
  assert.equal(cands[0].grader, 'bgs');
  assert.ok(cands[0].confidence < 0.8 && cands[0].evidence.includes('label-pass'));
  assert.equal(decide(cands, settings(), []), 'confirm');
  // Two images agreeing but not a single slab word anywhere: not shown.
  assert.deepEqual(parseCandidates({ pages: [ocrPage(['SOME PHOTO']), bin, tag(ocrPage(['0012345678']), { labelPass: true, variant: 'plain' })] }), []);
});

test('A20 label pass: an incomplete read of the other image completes the number (lost leading zero)', () => {
  const full = ocrPage(BGS_WORDS);
  const bin = tag(digitsPage('012345678'), { labelPass: true, variant: 'bin' }); // 9 digits: no grader of that length on a BGS label
  const plain = tag(ocrPage([...BGS_WORDS, '0012345678']), { labelPass: true, variant: 'plain' });
  const cands = parseCandidates({ pages: [full, bin, plain] });
  assert.deepEqual(cands.map((c) => c.number), ['0012345678'], 'the truncated PSA-length read is not offered');
  assert.equal(cands[0].grader, 'bgs');
  assert.ok(cands[0].evidence.includes('completes:012345678') && cands[0].confidence < 0.8);
  // An unrelated number in the other image completes nothing.
  const other = tag(digitsPage('987654321'), { labelPass: true, variant: 'bin' });
  assert.deepEqual(parseCandidates({ pages: [full, other, plain] }), [], 'two unrelated one-image reads: nothing shown');
});

test('A20 second opinion: a number read once by a Sauvola/Leptonica pass is shown but never opens a page by itself', () => {
  const first = ocrPage(['CGC', 'GEM MINT 10', 'Celebrations']);
  const sauvola = tag(ocrPage(['CGC', 'GEM MINT 10', '3901234567'], { conf: 94 }), { variant: 'sauvola' });
  const one = parseCandidates({ pages: [first, sauvola] });
  assert.equal(one[0].number, '3901234567');
  assert.equal(one[0].grader, 'cgc-cards');
  assert.equal(one[0].confidence, 0.79);
  assert.ok(one[0].evidence.includes('second-opinion'));
  assert.equal(decide(one, settings(), []), 'confirm');
  // Confirmed by a read of another image (its digit crop, or the other binarisation): two reads, may open.
  const two = parseCandidates({ pages: [first, sauvola, digitsPage('3901234567', 90)] });
  assert.ok(two[0].confidence >= 0.8 && !two[0].evidence.includes('second-opinion'));
  const lept = tag(ocrPage(['3901234567'], { conf: 92 }), { variant: 'leptonica' });
  assert.ok(parseCandidates({ pages: [first, sauvola, lept] })[0].confidence >= 0.8);
});

test('A20 near-duplicates: a competing read stays its own number (merging could hide the right one)', () => {
  const label = ['CGC', 'GEM MINT 10'];
  // Text 2038475610 (81) vs digit crop 2938475610 (95): both are real reads; the surer one first, nothing opens.
  const cands = parseCandidates({ pages: [ocrPage([...label, '2038475610'], { conf: [88, 88, 81] }), digitsPage('2938475610', 95)] });
  assert.deepEqual(cands.map((c) => c.number), ['2938475610', '2038475610']);
  assert.ok(!cands[0].evidence.some((e) => e.startsWith('near-dup')));
  assert.equal(decide(cands, settings(), []), 'confirm');
  // Two text passes agreeing on a misread don't swallow the digit crop's different read either (bench-real
  // cgcd-c17-thumb250: default + Sauvola text read 2038…, the crop read 2938…).
  const sv = tag(ocrPage(['2038475610'], { conf: 82 }), { variant: 'sauvola' });
  const two = parseCandidates({ pages: [ocrPage([...label, '2038475610'], { conf: [88, 88, 80] }), sv, digitsPage('2938475610', 95)] });
  assert.deepEqual(two.map((c) => c.number).sort(), ['2038475610', '2938475610']);
  assert.equal(decide(two, settings(), []), 'confirm');
});

test('A20 a second-opinion text read of the same number is no second read; a digit crop is', () => {
  const label = ['CGC', 'NM/MINT 8.5'];
  // Default + Sauvola text both misread 2038475610, the digit crop reads 2938475610: the crop ranks first.
  const sv = tag(ocrPage(['2038475610'], { conf: 90 }), { variant: 'sauvola' });
  const c = parseCandidates({ pages: [ocrPage([...label, '2038475610'], { conf: [88, 88, 86] }), sv, digitsPage('2938475610', 95)] });
  assert.equal(c[0].number, '2938475610');
  assert.equal(decide(c, settings(), []), 'confirm');
  // Default text + digit crop agree: a real second read, as before.
  const ok = parseCandidates({ pages: [ocrPage([...label, '2938475610'], { conf: [88, 88, 90] }), digitsPage('2938475610', 95)] });
  assert.ok(ok[0].confidence >= 0.8);
});

test('A20 near-duplicates: only a weak stray read (below the competitor bar) is absorbed, and never opens a page', () => {
  // No slab words, text 2038475610 at 60 (score < .50) vs crop 2938475610 at 95: one number, still confirmed.
  const cands = parseCandidates({ pages: [ocrPage(['2038475610'], { conf: 60 }), digitsPage('2938475610', 95)] });
  assert.deepEqual(cands.map((c) => c.number), ['2938475610']);
  assert.ok(cands[0].evidence.includes('near-dup:2038475610'));
  assert.ok(cands[0].confidence < 0.8, 'the absorbed read is no second read of the disputed digit');
  assert.equal(decide(cands, settings(), []), 'confirm');
  // Two slabs with consecutive certs, each read twice: two numbers, nothing opens.
  const pair = parseCandidates({ pages: [ocrPage(['PSA', 'GEM MT 10', '12345678', '12345679']), digitsPage('12345678'), digitsPage('12345679')] });
  assert.deepEqual(pair.map((c) => c.number).sort(), ['12345678', '12345679']);
  assert.equal(decide(pair, settings(), []), 'confirm');
});

test('A20 near-duplicates: a different grader guess is not merged, and a second-opinion read stays capped', () => {
  // "00…" is a Beckett serial shape, "10…" is not: same length, one digit apart, different guesses.
  const a = analyze({ pages: [ocrPage(['GRADED', '0012345678'], { conf: [88, 95] }), digitsPage('1012345678', 80)] });
  assert.equal(a.candidates[0].number, '0012345678');
  assert.ok(!a.candidates[0].evidence.some((e) => e.startsWith('near-dup')), 'Beckett guess vs CGC guess: not one number');
  assert.equal(a.candidates[0].confidence, 0.6, 'no second-read bonus: .70 + .10 (serial shape) - .20 (no slab words)');
  // Sauvola alone read 3901234567 (capped at .79); the default text read 3901234561: two numbers, nothing opens.
  const first = ocrPage(['CGC', 'GEM MINT 10', '3901234561'], { conf: [88, 88, 75] });
  const sauvola = tag(ocrPage(['3901234567'], { conf: 95 }), { variant: 'sauvola' });
  const capped = parseCandidates({ pages: [first, sauvola] });
  assert.ok(capped.some((c) => c.number === '3901234567' && c.confidence < 0.8));
  assert.equal(decide(capped, settings(), []), 'confirm');
});

test('A20 incomplete read: the complete number of the label\'s grader takes its place (glare ate the leading zeros)', () => {
  const words = ['BECKETT GRADING SERVICES', 'CENTERING 10 CORNERS 10 EDGES 10'];
  const otsu = ocrPage([...words, '09876543'], { conf: [88, 88, 87] });
  const shortOnly = parseCandidates({ pages: [otsu] });
  assert.equal(shortOnly[0].grader, null, 'alone: no grader preselected');
  assert.deepEqual(shortOnly[0].graderOptions, ['bgs', 'psa']);
  assert.ok(shortOnly[0].evidence.includes('incomplete'));
  const lept = tag(ocrPage(['0009876543'], { conf: 96 }), { variant: 'leptonica' });
  const cands = parseCandidates({ pages: [otsu, lept] });
  assert.deepEqual(cands.map((x) => x.number), ['0009876543']);
  assert.equal(cands[0].grader, 'bgs');
  assert.ok(cands[0].evidence.includes('completes:09876543'));
});
