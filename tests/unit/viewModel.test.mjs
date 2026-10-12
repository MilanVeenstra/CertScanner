import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_DIGITS, MAX_DIGITS, displayUrl, methodKey, confirmReasons, errorView, analyzeCertInput, resolveGrader,
  validateCert, stripPrefix, stepStates, sharperOfferHost, relativeTime, previewText,
} from '../../src/sidepanel/viewModel.js';
import { settings } from './helpers.mjs';

const cand = (over = {}) => ({ grader: 'psa', graderOptions: ['psa'], number: '01234567', confidence: 0.89, source: 'ocr', evidence: [], ...over });
const result = (over = {}) => ({ jobId: null, status: 'confirm', candidates: [cand()], imageInfo: { method: 'upload', resolution: 'full', width: 544, height: 850, origin: null, canRequestSharper: false }, warnings: [], timings: {}, ...over });

test('limits come from the routing table', () => {
  assert.equal(MIN_DIGITS, 7);
  assert.equal(MAX_DIGITS, 13);
});

test('displayUrl drops scheme and www but keeps the exact path', () => {
  assert.equal(displayUrl('https://www.psacard.com/cert/01234567'), 'psacard.com/cert/01234567');
  assert.equal(displayUrl('https://www.cgccomics.com/certlookup/4012345001/'), 'cgccomics.com/certlookup/4012345001/');
  assert.equal(displayUrl('not a url'), '');
});

test('previewText builds the URL only for a valid grader + number', () => {
  assert.deepEqual(previewText('psa', '01234567'), { key: 'url_preview', subs: ['psacard.com/cert/01234567'] });
  assert.deepEqual(previewText(null, '01234567'), { key: 'url_preview_pending', subs: [] });
  assert.equal(previewText('cgc-comics', '01234567'), null);
});

test('methodKey maps sources and edits', () => {
  assert.equal(methodKey('ocr'), 'method_ocr');
  assert.equal(methodKey('barcode'), 'method_barcode');
  assert.equal(methodKey('qr-url'), 'method_qr');
  assert.equal(methodKey('manual'), 'method_typed');
  assert.equal(methodKey('ocr', { edited: true }), 'method_edited');
});

test('confirmReasons: priority order, at most two', () => {
  const two = result({ candidates: [cand({ number: '01234567', confidence: 0.79 }), cand({ number: '87654321', confidence: 0.79 })] });
  assert.deepEqual(confirmReasons(two, settings()).map((r) => r.key), ['reason_multiple', 'reason_uncertain']);
  assert.deepEqual(confirmReasons(two, settings())[0].subs, ['2']);
  const cgc = result({ candidates: [cand({ grader: null, graderOptions: ['cgc-comics', 'cgc-cards', 'psa'], number: '5012345678', confidence: 0.44 })] });
  assert.deepEqual(confirmReasons(cgc, settings()).map((r) => r.key), ['reason_grader_guess']);
  assert.deepEqual(confirmReasons(cgc, settings())[0].subs, ['CGC Comics'], 'best guess named and preselected');
  const unknown = result({ candidates: [cand({ grader: null, graderOptions: ['psa'], number: '12345678', confidence: 0.9 })] });
  assert.deepEqual(confirmReasons(unknown, settings()).map((r) => r.key), ['reason_grader_guess']);
  const none = result({ candidates: [cand({ grader: null, graderOptions: [], number: '12345678', confidence: 0.9 })] });
  assert.deepEqual(confirmReasons(none, settings()).map((r) => r.key), ['reason_grader_unknown']);
  const ask = result({ candidates: [cand()] });
  assert.deepEqual(confirmReasons(ask, settings({ autoOpen: false })).map((r) => r.key), ['reason_always_ask']);
  const screen = result({ candidates: [cand({ confidence: 0.9 })], imageInfo: { method: 'capture', resolution: 'screen', width: 270, height: 422, origin: 'https://i.ebayimg.com', canRequestSharper: true } });
  assert.deepEqual(confirmReasons(screen, settings({ autoOpen: false })).map((r) => r.key), ['reason_unclear', 'reason_always_ask']);
  // Off-site QR is its own warning block, not a reason; low confidence still explains it.
  const qr = result({ candidates: [cand({ source: 'barcode', confidence: 0.35, number: '12345678' })], warnings: [{ code: 'qr-untrusted-host', detail: 'evil.example' }] });
  assert.deepEqual(confirmReasons(qr, settings()).map((r) => r.key), ['reason_uncertain']);
});

test('A20 confirmReasons: an incomplete number names the label\'s grader instead of guessing one', () => {
  const short = result({ candidates: [cand({ grader: null, graderOptions: ['bgs', 'psa'], number: '00123456', confidence: 0.55, evidence: ['len:8', 'pass:text', 'conflict', 'incomplete'] })] });
  const r = confirmReasons(short, settings());
  assert.deepEqual(r.map((x) => x.key), ['reason_number_incomplete']);
  assert.deepEqual(r[0].subs, ['BGS']);
});

test('errorView maps scan errors to the spec E-states', () => {
  assert.deepEqual(errorView('restricted', { retryable: true }), { id: 'E1', tone: 'warning', heading: 'err_restricted_heading', body: 'err_restricted_body', bodySubs: [], actions: ['choose'] });
  assert.deepEqual(errorView('not-found', { retryable: true }).actions, ['retry', 'choose']);
  assert.deepEqual(errorView('not-found', { retryable: false }).actions, ['choose']);
  assert.equal(errorView('tab-changed', {}).id, 'E2');
  assert.deepEqual(errorView('too-large', {}), { id: 'E3', tone: 'warning', heading: 'err_too_large_heading', body: 'err_too_large_body', bodySubs: ['15 MB'], actions: ['choose'] });
  assert.equal(errorView('capture-failed', { retryable: true }).id, 'E4');
  assert.equal(errorView('fetch-failed', { retryable: true }).id, 'E4');
  assert.deepEqual(errorView('engine-failed', {}).actions, ['reload', 'type']);
  assert.equal(errorView('engine-failed', {}).tone, 'danger');
  assert.equal(errorView('file-type', {}).id, 'E6');
  assert.equal(errorView('invalid-image', {}).id, 'E7');
  assert.equal(errorView('dropped-link', {}).id, 'E8');
  assert.deepEqual(errorView('timeout', { retryable: true }), { id: 'E9', tone: 'danger', heading: 'err_generic_heading', body: 'err_generic_body', bodySubs: [], actions: ['retry', 'type'] });
  assert.equal(errorView('something-new', {}).id, 'E9');
  assert.deepEqual(errorView('timeout', { retryable: false }).actions, ['type']);
});

test('analyzeCertInput: prefixes, filler, separators, URLs', () => {
  assert.deepEqual(analyzeCertInput('PSA 01234567'), { empty: false, url: null, prefix: 'psa', digits: '01234567', badChars: false, dash: false });
  assert.equal(analyzeCertInput('cgc comics 4012345001').prefix, 'cgc-comics');
  assert.equal(analyzeCertInput('CGC Comic 4012345001').prefix, 'cgc-comics');
  assert.equal(analyzeCertInput('cgc cards 1401234567890').prefix, 'cgc-cards');
  assert.equal(analyzeCertInput('cgc card 1401234567890').prefix, 'cgc-cards');
  assert.equal(analyzeCertInput('cgc 4012345001').prefix, 'cgc');
  assert.equal(analyzeCertInput('PSA cert # 01234567').digits, '01234567');
  assert.equal(analyzeCertInput('psa no. 1234 5678').digits, '12345678');
  assert.equal(analyzeCertInput('nr. 1234567-001').digits, '1234567001');
  assert.equal(analyzeCertInput('1234567-001').dash, true);
  assert.equal(analyzeCertInput('12.34/56 78').digits, '12345678');
  assert.equal(analyzeCertInput('abc').badChars, true);
  assert.equal(analyzeCertInput('PSA 1234abcd').badChars, true);
  assert.equal(analyzeCertInput('   ').empty, true);
  assert.equal(analyzeCertInput('psacard').badChars, true); // not a prefix word
  const url = analyzeCertInput('https://www.psacard.com/cert/01234567');
  assert.deepEqual(url.url, { ok: true, grader: 'psa', number: '01234567' });
  assert.deepEqual(analyzeCertInput('https://evil.example/cert/12345678').url, { ok: false });
  assert.deepEqual(analyzeCertInput('cgccomics.com/certlookup/4012347003/').url, { ok: true, grader: 'cgc-comics', number: '4012347003' });
});

test('resolveGrader: typed prefix > explicit radio > inference', () => {
  const g = (text, explicit = null) => resolveGrader(analyzeCertInput(text), explicit);
  assert.deepEqual(g('PSA 4012345001', 'cgc-comics'), { grader: 'psa', from: 'prefix', cgcBoth: false });
  assert.deepEqual(g('4012345001', 'cgc-cards'), { grader: 'cgc-cards', from: 'explicit', cgcBoth: false });
  assert.deepEqual(g('01234567'), { grader: 'psa', from: 'inferred', cgcBoth: false });
  assert.deepEqual(g('108114622'), { grader: 'psa', from: 'inferred', cgcBoth: false });
  assert.deepEqual(g('1401234567890'), { grader: 'cgc-cards', from: 'inferred', cgcBoth: false });
  assert.deepEqual(g('4012345001'), { grader: null, from: null, cgcBoth: true });
  assert.deepEqual(g('cgc 4012345001'), { grader: null, from: null, cgcBoth: true });
  assert.deepEqual(g('cgc 1401234567890'), { grader: 'cgc-cards', from: 'inferred', cgcBoth: false });
  assert.deepEqual(g('cgc 4012345001', 'cgc-comics'), { grader: 'cgc-comics', from: 'explicit', cgcBoth: false });
  assert.deepEqual(g('4012345-001'), { grader: 'cgc-comics', from: 'inferred', cgcBoth: false });
  assert.deepEqual(g('https://www.cgccards.com/certlookup/4340250002/'), { grader: 'cgc-cards', from: 'prefix', cgcBoth: false });
  assert.deepEqual(g(''), { grader: null, from: null, cgcBoth: false });
});

test('validateCert: order empty -> chars -> length -> grader -> grader length', () => {
  const v = (text, explicit = null) => validateCert(text, explicit);
  assert.deepEqual(v(''), { ok: false, error: 'err_empty', subs: [], focus: 'input' });
  assert.deepEqual(v('abc'), { ok: false, error: 'err_chars', subs: [], focus: 'input' });
  assert.deepEqual(v('12345'), { ok: false, error: 'err_length', subs: ['7', '13', '5'], focus: 'input' });
  assert.deepEqual(v('PSA'), { ok: false, error: 'err_length', subs: ['7', '13', '0'], focus: 'input' });
  assert.deepEqual(v('cgc 4012345001'), { ok: false, error: 'err_grader', subs: [], focus: 'grader' });
  assert.deepEqual(v('https://evil.example/cert/12345678'), { ok: false, error: 'err_link', subs: [], focus: 'input' });
  assert.deepEqual(v('PSA 1401234567890'), { ok: false, error: 'warn_length', subs: ['PSA'], focus: 'input' });
  assert.deepEqual(v('PSA 12345678'), { ok: true, grader: 'psa', number: '12345678' });
  assert.deepEqual(v('cgc 1401234567890'), { ok: true, grader: 'cgc-cards', number: '1401234567890' });
  assert.deepEqual(v('cgc 4012345001', 'cgc-comics'), { ok: true, grader: 'cgc-comics', number: '4012345001' });
  assert.deepEqual(v('01234567'), { ok: true, grader: 'psa', number: '01234567' });
  assert.deepEqual(v('1234567-001', 'cgc-comics'), { ok: true, grader: 'cgc-comics', number: '1234567001' });
  assert.deepEqual(v('https://www.psacard.com/cert/01234567'), { ok: true, grader: 'psa', number: '01234567' });
  assert.equal(v('x'.repeat(100)).error, 'err_chars');
});

test('stripPrefix removes a typed grader prefix only', () => {
  assert.equal(stripPrefix('PSA 4012345001'), '4012345001');
  assert.equal(stripPrefix('cgc comics 4012345001'), '4012345001');
  assert.equal(stripPrefix('cgc 4012345001'), '4012345001');
  assert.equal(stripPrefix('4012345001'), '4012345001');
});

test('stepStates follows pipeline progress and marks skipped OCR', () => {
  assert.deepEqual(stepStates([]), { load: 'active', barcode: 'waiting', text: 'waiting', match: 'waiting', textStarting: false });
  assert.deepEqual(stepStates(['acquire', 'decode', 'barcode']), { load: 'done', barcode: 'active', text: 'waiting', match: 'waiting', textStarting: false });
  assert.deepEqual(stepStates(['acquire', 'decode', 'barcode', 'ocr-init']), { load: 'done', barcode: 'done', text: 'active', match: 'waiting', textStarting: true });
  assert.deepEqual(stepStates(['acquire', 'barcode', 'ocr-init', 'ocr']), { load: 'done', barcode: 'done', text: 'active', match: 'waiting', textStarting: false });
  assert.deepEqual(stepStates(['acquire', 'barcode', 'ocr', 'parse']), { load: 'done', barcode: 'done', text: 'done', match: 'active', textStarting: false });
  assert.deepEqual(stepStates(['acquire', 'barcode', 'parse']), { load: 'done', barcode: 'done', text: 'skipped', match: 'active', textStarting: false });
});

test('sharperOfferHost: only https screen captures, not granted/denied/dismissed', () => {
  const info = { method: 'capture', resolution: 'screen', width: 270, height: 422, origin: 'https://i.ebayimg.com', canRequestSharper: true };
  assert.equal(sharperOfferHost({ status: 'confirm', imageInfo: info }, new Set()), 'i.ebayimg.com');
  assert.equal(sharperOfferHost({ status: 'none', imageInfo: info }, new Set()), 'i.ebayimg.com');
  assert.equal(sharperOfferHost({ status: 'auto-open', imageInfo: info }, new Set()), null);
  assert.equal(sharperOfferHost({ status: 'confirm', imageInfo: info }, new Set(['i.ebayimg.com'])), null);
  assert.equal(sharperOfferHost({ status: 'confirm', imageInfo: { ...info, canRequestSharper: false } }, new Set()), null);
  assert.equal(sharperOfferHost({ status: 'confirm', imageInfo: { ...info, resolution: 'full' } }, new Set()), null);
  assert.equal(sharperOfferHost({ status: 'confirm', imageInfo: { ...info, origin: 'http://127.0.0.1:8080' } }, new Set()), null);
  assert.equal(sharperOfferHost({ status: 'confirm', imageInfo: null }, new Set()), null);
});

test('relativeTime uses Intl in the UI locale', () => {
  const now = 1_760_000_000_000;
  assert.equal(relativeTime(now - 30_000, now, 'en'), 'now');
  assert.equal(relativeTime(now - 5 * 60_000, now, 'en'), '5 minutes ago');
  assert.equal(relativeTime(now - 3 * 3600_000, now, 'en'), '3 hours ago');
  assert.equal(relativeTime(now - 2 * 86400_000, now, 'en'), '2 days ago');
  assert.equal(relativeTime(now - 5 * 60_000, now, 'nl'), '5 minuten geleden');
});
