import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCertUrl, parseQrPayload, isRestrictedPage, CERT_URL, QR_HOSTS } from '../../src/core/certUrls.js';

test('buildCertUrl builds the official URL per grader and keeps leading zeros', () => {
  assert.equal(buildCertUrl('psa', '01234567'), 'https://www.psacard.com/cert/01234567');
  assert.equal(buildCertUrl('psa', '108114622'), 'https://www.psacard.com/cert/108114622');
  assert.equal(buildCertUrl('cgc-comics', '4012345001'), 'https://www.cgccomics.com/certlookup/4012345001/');
  assert.equal(buildCertUrl('cgc-cards', '1401036622258'), 'https://www.cgccards.com/certlookup/1401036622258/');
  assert.equal(buildCertUrl('cgc-cards', '4340250002'), 'https://www.cgccards.com/certlookup/4340250002/');
});

test('buildCertUrl rejects bad lengths, non-digits and unknown graders with RangeError', () => {
  assert.throws(() => buildCertUrl('psa', '123456'), RangeError);          // 6
  assert.throws(() => buildCertUrl('psa', '1401036622258'), RangeError);   // 13 not PSA
  assert.throws(() => buildCertUrl('cgc-comics', '01234567'), RangeError); // 8 not comics
  assert.throws(() => buildCertUrl('cgc-cards', '123456789'), RangeError); // 9 not cards
  assert.throws(() => buildCertUrl('psa', '1234567a'), RangeError);
  assert.throws(() => buildCertUrl('psa', '1234 5678'), RangeError);
  assert.throws(() => buildCertUrl('psa', '../../x'), RangeError);
  assert.throws(() => buildCertUrl('bgs', '12345678'), RangeError);
  assert.throws(() => buildCertUrl('__proto__', '12345678'), RangeError);
  assert.throws(() => buildCertUrl('psa', 12345678), RangeError);
});

test('CERT_URL and QR_HOSTS tables match ADR §8', () => {
  assert.deepEqual(Object.keys(CERT_URL).sort(), ['bgs', 'cgc-cards', 'cgc-comics', 'psa']);
  assert.equal(QR_HOSTS.get('cgccards.uk'), 'cgc-cards');
  assert.equal(QR_HOSTS.get('www.beckett.com'), 'bgs');
  assert.equal(QR_HOSTS.size, 10);
  // Beckett: the lookup form (no per-number link), only for a valid 10-digit serial
  assert.equal(buildCertUrl('bgs', '0012345678'), 'https://www.beckett.com/grading/card-lookup');
  assert.throws(() => buildCertUrl('bgs', '12345678'), RangeError);
  assert.equal(parseQrPayload('https://www.beckett.com/grading/card-lookup?item_id=0012345678').number, '0012345678');
});

test('parseQrPayload: allow-listed hosts with matching paths', () => {
  assert.deepEqual(parseQrPayload('https://www.cgccomics.com/certlookup/4012347003/'),
    { kind: 'official', grader: 'cgc-comics', number: '4012347003', host: 'www.cgccomics.com', pathMatched: true });
  assert.deepEqual(parseQrPayload('https://www.psacard.com/cert/01234567'),
    { kind: 'official', grader: 'psa', number: '01234567', host: 'www.psacard.com', pathMatched: true });
  assert.deepEqual(parseQrPayload('https://psacard.com/cert/123535672/psa'),
    { kind: 'official', grader: 'psa', number: '123535672', host: 'psacard.com', pathMatched: true });
  assert.deepEqual(parseQrPayload('https://www.cgccards.com/CERTLOOKUP/1401036622258/10_0/'),
    { kind: 'official', grader: 'cgc-cards', number: '1401036622258', host: 'www.cgccards.com', pathMatched: true });
  // http is accepted (number trusted, URL rebuilt as https)
  assert.equal(parseQrPayload('http://www.psacard.com/cert/12345678').kind, 'official');
  // .uk host trusted for the number only
  assert.deepEqual(parseQrPayload('https://www.cgccards.uk/certlookup/6108376090'),
    { kind: 'official', grader: 'cgc-cards', number: '6108376090', host: 'www.cgccards.uk', pathMatched: true });
  assert.equal(parseQrPayload('https://cgccards.uk/certlookup/6108376090/').grader, 'cgc-cards');
  // Upper-case host is normalised by the URL parser
  assert.equal(parseQrPayload('HTTPS://WWW.PSACARD.COM/cert/12345678').kind, 'official');
});

test('parseQrPayload: missing scheme retried with https://', () => {
  assert.deepEqual(parseQrPayload('www.cgccomics.com/certlookup/4012347003/'),
    { kind: 'official', grader: 'cgc-comics', number: '4012347003', host: 'www.cgccomics.com', pathMatched: true });
  assert.equal(parseQrPayload('psacard.com/cert/12345678').kind, 'official');
  assert.equal(parseQrPayload('  cgccomics.com/certlookup/4012347003  ').kind, 'official');
});

test('parseQrPayload: allow-listed host, unmatched path with exactly one valid run', () => {
  assert.deepEqual(parseQrPayload('https://www.psacard.com/verify?cert=12345678'),
    { kind: 'official', grader: 'psa', number: '12345678', host: 'www.psacard.com', pathMatched: false });
  // two valid-length runs -> not trusted as a cert
  const two = parseQrPayload('https://www.psacard.com/a/12345678/b/87654321');
  assert.equal(two.kind, 'untrusted-url');
  // CGC comics path with a wrong length (8) does not match and 8 is not a comics length
  assert.equal(parseQrPayload('https://www.cgccomics.com/certlookup/12345678/').kind, 'untrusted-url');
});

test('parseQrPayload: foreign, lookalike, userinfo, port and odd schemes are untrusted', () => {
  assert.deepEqual(parseQrPayload('https://evil.example/cert/12345678'),
    { kind: 'untrusted-url', host: 'evil.example', digits: ['12345678'] });
  // userinfo trick: real host is evil.example
  const ui = parseQrPayload('https://www.psacard.com@evil.example/cert/12345678');
  assert.equal(ui.kind, 'untrusted-url');
  assert.equal(ui.host, 'evil.example');
  // userinfo on an allow-listed host
  assert.equal(parseQrPayload('https://user:pw@www.psacard.com/cert/12345678').kind, 'untrusted-url');
  // explicit port
  assert.equal(parseQrPayload('https://www.psacard.com:8443/cert/12345678').kind, 'untrusted-url');
  // lookalikes / suffix tricks
  assert.equal(parseQrPayload('https://www.psacard.com.evil.example/cert/12345678').kind, 'untrusted-url');
  assert.equal(parseQrPayload('https://wwwpsacard.com/cert/12345678').kind, 'untrusted-url');
  assert.equal(parseQrPayload('https://www.psacаrd.com/cert/12345678').kind, 'untrusted-url'); // Cyrillic a -> punycode
  assert.equal(parseQrPayload('https://cgccomics.co/certlookup/4012347003/').kind, 'untrusted-url');
  // non-http schemes
  assert.equal(parseQrPayload('javascript:alert(1)//www.psacard.com/cert/12345678').kind, 'not-url');
  assert.equal(parseQrPayload('ftp://www.psacard.com/cert/12345678').kind, 'not-url');
  assert.equal(parseQrPayload('data:text/html,https://www.psacard.com/cert/12345678').kind, 'not-url');
});

test('parseQrPayload: plain numbers and text are not URLs', () => {
  assert.deepEqual(parseQrPayload('81234567'), { kind: 'not-url' });
  assert.deepEqual(parseQrPayload('CERT 4012345001'), { kind: 'not-url' });
  assert.deepEqual(parseQrPayload(''), { kind: 'not-url' });
  assert.deepEqual(parseQrPayload(null), { kind: 'not-url' });
  assert.deepEqual(parseQrPayload('x'.repeat(5000)), { kind: 'not-url' });
});

test('isRestrictedPage', () => {
  for (const u of [
    'chrome://version', 'chrome-extension://abc/page.html', 'chrome-untrusted://x/', 'devtools://devtools/x',
    'edge://settings', 'about:blank', 'view-source:https://example.com/', 'file:///tmp/a.html',
    'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/detail/x',
    'not a url', '', null, undefined,
  ]) assert.equal(isRestrictedPage(u), true, String(u));
  for (const u of [
    'https://www.ebay.com/itm/1', 'http://127.0.0.1:8080/pages/gallery.html', 'https://chrome.google.com/other',
    'https://example.com/chromewebstore.google.com', 'data:text/html,hello',
  ]) assert.equal(isRestrictedPage(u), false, String(u));
});
