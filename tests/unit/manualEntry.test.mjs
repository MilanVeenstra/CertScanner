import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManualEntry } from '../../src/core/manualEntry.js';

const ok = (input) => {
  const r = parseManualEntry(input);
  assert.equal(r.ok, true, `${input} -> ${JSON.stringify(r)}`);
  return r;
};
const err = (input) => {
  const r = parseManualEntry(input);
  assert.equal(r.ok, false, `${input} -> ${JSON.stringify(r)}`);
  return r.error;
};

test('grader word + number', () => {
  assert.deepEqual(ok('PSA 12345678'), { ok: true, grader: 'psa', graderOptions: ['psa'], number: '12345678' });
  assert.equal(ok('psa 01234567').number, '01234567');
  assert.equal(ok('PSA #01234567').number, '01234567');
  assert.equal(ok('PSA cert: 108114622').grader, 'psa');
  assert.equal(ok('cgc cards 1401234567890').grader, 'cgc-cards');
  assert.equal(ok('CGC Card 4340250002').grader, 'cgc-cards');
  assert.equal(ok('CGC comics 4012345001').grader, 'cgc-comics');
  assert.equal(ok('cgc comic 4012345001').grader, 'cgc-comics');
  assert.equal(ok('  PSA   1234 5678 ').number, '12345678');
});

test('number only: length decides when unique, else options', () => {
  assert.equal(ok('12345678').grader, 'psa');
  assert.equal(ok('1401234567890').grader, 'cgc-cards');
  const ten = ok('5012345678');
  assert.equal(ten.grader, null);
  assert.deepEqual(ten.graderOptions, ['cgc-comics', 'cgc-cards', 'psa']);
  const cgc10 = ok('CGC 5012345678');
  assert.equal(cgc10.grader, null);
  assert.deepEqual(cgc10.graderOptions, ['cgc-comics', 'cgc-cards']);
  assert.equal(ok('CGC 1401234567890').grader, 'cgc-cards');
});

test('dash form joins to 10 digits and means CGC comics', () => {
  const r = ok('4012345-001');
  assert.equal(r.number, '4012345001');
  assert.equal(r.grader, 'cgc-comics');
});

test('official URL is accepted; other URLs are refused', () => {
  const r = ok('https://www.psacard.com/cert/01234567');
  assert.equal(r.grader, 'psa');
  assert.equal(r.number, '01234567');
  assert.equal(ok('www.cgccomics.com/certlookup/4012347003/').grader, 'cgc-comics');
  assert.equal(ok('https://www.cgccards.uk/certlookup/6108376090').grader, 'cgc-cards');
  assert.equal(err('https://evil.example/cert/12345678'), 'untrusted-url');
  assert.equal(err('https://www.psacard.com@evil.example/cert/12345678'), 'untrusted-url');
});

test('errors', () => {
  assert.equal(err(''), 'empty');
  assert.equal(err('   '), 'empty');
  assert.equal(err(null), 'empty');
  assert.equal(err('hello'), 'no-number');
  assert.equal(err('PSA'), 'no-number');
  assert.equal(err('PSA 123'), 'bad-length');
  assert.equal(err('123456'), 'bad-length');
  assert.equal(err('PSA 1401234567890'), 'bad-length');
  assert.equal(err('CGC comics 12345678'), 'bad-length');
  assert.equal(err('CGC 123456789'), 'bad-length');
  assert.equal(err('12345678901234567890'), 'bad-length');
  assert.equal(err('PSA 1234abcd5678'), 'invalid');
  assert.equal(err('<img src=x onerror=alert(1)> 12345678'), 'invalid');
  assert.equal(err('x'.repeat(3000)), 'too-long');
});
