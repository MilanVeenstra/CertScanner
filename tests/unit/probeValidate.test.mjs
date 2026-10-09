import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProbeResult } from '../../src/pipeline/probeValidate.js';

const SRC = 'https://img.example.com/s-l500.jpg';
const MAX = 15 * 1024 * 1024;
const opts = { srcUrl: SRC, maxBytes: MAX };
const good = () => ({
  v: 1, found: true,
  rect: { x: 10, y: 20, width: 270, height: 422 }, rectIsTopLevel: true,
  viewport: { width: 1280, height: 720 }, dpr: 1,
  natural: { width: 544, height: 850 },
  srcsetBest: 'https://img.example.com/s-l1600.jpg',
  fetch: { ok: true, dataUrl: 'data:image/jpeg;base64,/9j/AAAA', url: 'https://img.example.com/s-l1600.jpg' },
});
const reject = (patch, msg) => {
  const raw = typeof patch === 'function' ? patch(good()) : { ...good(), ...patch };
  const r = validateProbeResult(raw, opts);
  assert.equal(r.ok, false, msg ?? JSON.stringify(patch));
};

test('accepts a well-formed result and returns a clean copy', () => {
  const r = validateProbeResult({ ...good(), extra: '<script>' }, opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, good());
  assert.equal('extra' in r.value, false);
});

test('accepts found:false and failed fetches', () => {
  assert.deepEqual(validateProbeResult({ v: 1, found: false }, opts), { ok: true, value: { v: 1, found: false } });
  for (const reason of ['cors', 'http', 'too-large', 'timeout']) {
    const r = validateProbeResult({ ...good(), fetch: { ok: false, reason } }, opts);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.fetch, { ok: false, reason });
  }
  // No fetch at all (capture mode)
  const noFetch = good();
  delete noFetch.fetch;
  assert.equal(validateProbeResult(noFetch, opts).ok, true);
});

test('rejects non-objects and wrong versions', () => {
  for (const raw of [null, undefined, 'x', 5, [], [good()]]) assert.equal(validateProbeResult(raw, opts).ok, false);
  reject({ v: 2 });
  reject({ found: 'yes' });
});

test('rejects non-finite or out-of-range geometry', () => {
  reject((g) => ({ ...g, rect: { ...g.rect, x: NaN } }));
  reject((g) => ({ ...g, rect: { ...g.rect, y: Infinity } }));
  reject((g) => ({ ...g, rect: { ...g.rect, width: 3 } }));
  reject((g) => ({ ...g, rect: { ...g.rect, height: 20001 } }));
  reject((g) => ({ ...g, rect: { ...g.rect, width: '270' } }));
  reject((g) => ({ ...g, rect: null }));
  reject((g) => ({ ...g, viewport: { width: 0, height: 720 } }));
  reject((g) => ({ ...g, viewport: { width: 1e9, height: 720 } }));
  reject({ dpr: 0 });
  reject({ dpr: -1 });
  reject({ dpr: 8.5 });
  reject({ dpr: NaN });
  reject((g) => ({ ...g, natural: { width: -5, height: 10 } }));
  reject({ rectIsTopLevel: 'true' });
});

test('rejects hostile data URLs', () => {
  const f = (dataUrl, url = SRC) => ({ fetch: { ok: true, dataUrl, url } });
  reject(f('javascript:alert(1)'));
  reject(f('data:image/png,notbase64'));
  reject(f('data:image/svg+xml;utf8,<svg onload=alert(1)>'));
  reject(f('https://evil.example/x.png'));
  reject(f(12345));
  reject(f('data:image/png;base64,' + 'A'.repeat(Math.ceil(MAX * 4 / 3) + 257)));
  // fetched URL must be the clicked image or its srcset candidate
  reject(f('data:image/png;base64,AAAA', 'https://evil.example/x.png'));
  reject({ fetch: { ok: false, reason: 'pwned' } });
  reject({ fetch: { ok: 'true', dataUrl: 'data:image/png;base64,AA', url: SRC } });
});

test('srcsetBest is kept only when it is same-origin with srcUrl', () => {
  const cross = validateProbeResult({ ...good(), srcsetBest: 'https://evil.example/big.jpg', fetch: { ok: false, reason: 'cors' } }, opts);
  assert.equal(cross.ok, true);
  assert.equal(cross.value.srcsetBest, null);
  const js = validateProbeResult({ ...good(), srcsetBest: 'javascript:alert(1)', fetch: { ok: false, reason: 'cors' } }, opts);
  assert.equal(js.value.srcsetBest, null);
  const long = validateProbeResult({ ...good(), srcsetBest: 'https://img.example.com/' + 'a'.repeat(9000), fetch: { ok: false, reason: 'cors' } }, opts);
  assert.equal(long.value.srcsetBest, null);
});

test('data: and blob: clicked images validate their fetch URL against srcUrl', () => {
  const blobSrc = 'blob:http://127.0.0.1:8080/0b0b5ef6-6a5e-4c6e-9d43-123456789abc';
  const r = validateProbeResult({ v: 1, found: true, rect: { x: 0, y: 0, width: 300, height: 461 }, rectIsTopLevel: true,
    viewport: { width: 1280, height: 720 }, dpr: 1, natural: { width: 680, height: 1044 }, srcsetBest: null,
    fetch: { ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', url: blobSrc } }, { srcUrl: blobSrc, maxBytes: MAX });
  assert.equal(r.ok, true);
});
