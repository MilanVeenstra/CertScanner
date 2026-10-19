import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isStoreVersion, withVersion } from '../../scripts/version.mjs';
import { release, API, TOKEN_URL } from '../../scripts/cws-publish.mjs';

test('store versions: 1-4 integers 0-65535, no leading zeros, not all zero', () => {
  for (const ok of ['0.1.0', '1', '1.2.3.4', '65535.0.0', '0.0.1']) assert.equal(isStoreVersion(ok), true, ok);
  for (const bad of ['', '0', '0.0.0', '01.2', '1.2.3.4.5', '1.65536', 'v1.0.0', '1.0.0-beta', '1..2', null]) assert.equal(isStoreVersion(bad), false, String(bad));
});

test('withVersion changes only the version in the manifest text', async () => {
  const raw = await readFile(new URL('../../src/manifest.json', import.meta.url), 'utf8');
  const next = withVersion(raw, '0.2.0');
  assert.equal(JSON.parse(next).version, '0.2.0');
  assert.equal(next.replace('"version": "0.2.0"', ''), raw.replace(/"version": "[^"]*"/, ''), 'formatting and other keys unchanged');
  assert.throws(() => withVersion(raw, '0.2.0-beta'), RangeError);
});

test('the manifest and package.json carry the same version (npm run check enforces it too)', async () => {
  const m = JSON.parse(await readFile(new URL('../../src/manifest.json', import.meta.url), 'utf8'));
  const p = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(m.version, p.version);
});

const ENV = { CWS_CLIENT_ID: 'cid', CWS_CLIENT_SECRET: 'secret', CWS_REFRESH_TOKEN: 'rt', CWS_PUBLISHER_ID: 'pub-1', CWS_EXTENSION_ID: 'abcdefghijklmnopabcdefghijklmnop' };
const ITEM = 'publishers/pub-1/items/abcdefghijklmnopabcdefghijklmnop';

/** fetch stub: answers by URL suffix; records every call. */
function stub(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const key = Object.keys(answers).find((k) => url.endsWith(k));
    const a = typeof answers[key] === 'function' ? answers[key]() : answers[key];
    if (!a) throw new Error(`unexpected ${url}`);
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('Store upload: missing settings skip it without any request', async () => {
  const logs = [];
  const { calls, fetchImpl } = stub({});
  const r = await release({ env: { ...ENV, CWS_REFRESH_TOKEN: '' }, zip: new Uint8Array([1]), fetchImpl, log: (s) => logs.push(s) });
  assert.deepEqual(r, { skipped: true });
  assert.equal(calls.length, 0);
  assert.match(logs[0], /not configured \(missing CWS_REFRESH_TOKEN\)/);
});

test('Store upload: token, status check, upload (polled until done), then submit for review with API v2', async () => {
  let polls = 0;
  const { calls, fetchImpl } = stub({
    [TOKEN_URL]: { body: { access_token: 'at-1' } },
    ':fetchStatus': () => (calls.some((c) => c.url.includes('/upload/'))
      ? { body: { lastAsyncUploadState: ++polls < 2 ? 'IN_PROGRESS' : 'SUCCEEDED' } }
      : { body: { publishedItemRevisionStatus: { state: 'PUBLISHED' } } }),
    ':upload': { body: { uploadState: 'IN_PROGRESS', crxVersion: '0.2.0' } },
    ':publish': { body: { state: 'PENDING_REVIEW' } },
  });
  const zip = new Uint8Array([80, 75, 3, 4]);
  const r = await release({ env: ENV, zip, fetchImpl, sleep: async () => {}, log: () => {} });
  assert.deepEqual(r, { state: 'PENDING_REVIEW', version: '0.2.0' });
  const [token, before, up, ...rest] = calls;
  assert.equal(token.method, 'POST');
  assert.match(token.body, /grant_type=refresh_token/);
  assert.equal(before.url, `${API}/v2/${ITEM}:fetchStatus`);
  assert.equal(before.headers.authorization, 'Bearer at-1');
  assert.equal(up.url, `${API}/upload/v2/${ITEM}:upload`);
  assert.equal(up.body, zip);
  const publish = rest.at(-1);
  assert.equal(publish.url, `${API}/v2/${ITEM}:publish`);
  assert.deepEqual(JSON.parse(publish.body), { publishType: 'DEFAULT_PUBLISH' });
  assert.equal(polls, 2, 'polled until the upload finished');
});

test('Store upload: a submission still in review stops the job before uploading', async () => {
  const { calls, fetchImpl } = stub({
    [TOKEN_URL]: { body: { access_token: 'at' } },
    ':fetchStatus': { body: { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } } },
  });
  await assert.rejects(release({ env: ENV, zip: new Uint8Array([1]), fetchImpl, log: () => {} }), /still has a submission that is PENDING_REVIEW/);
  assert.ok(!calls.some((c) => c.url.includes(':upload')));
});

test('Store upload: a failed upload or an OAuth error is reported with the reason', async () => {
  const failed = stub({
    [TOKEN_URL]: { body: { access_token: 'at' } },
    ':fetchStatus': { body: {} },
    ':upload': { body: { uploadState: 'FAILED' } },
  });
  await assert.rejects(release({ env: ENV, zip: new Uint8Array([1]), fetchImpl: failed.fetchImpl, log: () => {} }), /Upload FAILED/);
  const oauth = stub({ [TOKEN_URL]: { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } } });
  await assert.rejects(release({ env: ENV, zip: new Uint8Array([1]), fetchImpl: oauth.fetchImpl, log: () => {} }), /expired or revoked/);
  await assert.rejects(release({ env: { ...ENV, CWS_PUBLISH_TYPE: 'NOW' }, zip: new Uint8Array([1]), fetchImpl: oauth.fetchImpl, log: () => {} }), /DEFAULT_PUBLISH or STAGED_PUBLISH/);
});
