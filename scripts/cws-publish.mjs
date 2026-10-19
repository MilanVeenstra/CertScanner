#!/usr/bin/env node
// Upload a release ZIP to the Chrome Web Store and submit it for review, with the Chrome Web Store API v2 (v1.1 support
// ended on 2026-10-15). Run by .github/workflows/release.yml; the one-time setup is in docs/release/publishing.md.
//   node scripts/cws-publish.mjs certscanner-<version>.zip
// Env: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN (Google OAuth client; consent screen "In production", or the
//      refresh token expires after 7 days), CWS_PUBLISHER_ID, CWS_EXTENSION_ID.
//      Optional CWS_PUBLISH_TYPE: DEFAULT_PUBLISH (live as soon as it is approved, the default) or STAGED_PUBLISH (after
//      approval you press Publish in the dashboard within 30 days).
// Without the five settings nothing is sent: the step reports that the Store upload is not configured and succeeds.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const API = 'https://chromewebstore.googleapis.com';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REQUIRED = ['CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID'];
const PUBLISH_TYPES = new Set(['DEFAULT_PUBLISH', 'STAGED_PUBLISH']);
/** A submission in one of these states must be finished or cancelled (dashboard) before a new package is uploaded. */
const BUSY = new Set(['PENDING_REVIEW', 'STAGED']);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Exchange the OAuth refresh token for a short-lived access token. */
export async function accessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google OAuth token request failed (${res.status}): ${body.error_description ?? body.error ?? 'no access_token'}`);
  }
  return body.access_token;
}

export const itemName = (publisherId, itemId) => `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;

async function call(ctx, url, { method = 'GET', body, contentType } = {}) {
  const res = await ctx.fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${ctx.token}`, ...(contentType ? { 'content-type': contentType } : {}) },
    body,
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* the error below shows the text */ }
  if (!res.ok) throw new Error(`${method} ${url.slice(API.length)} failed (${res.status}): ${json.error?.message ?? text.slice(0, 300)}`);
  return json;
}

export const fetchStatus = (ctx) => call(ctx, `${API}/v2/${ctx.name}:fetchStatus`);

export const uploadPackage = (ctx, zip) => call(ctx, `${API}/upload/v2/${ctx.name}:upload`, { method: 'POST', body: zip, contentType: 'application/zip' });

export const publishItem = (ctx, publishType) => call(ctx, `${API}/v2/${ctx.name}:publish`, {
  method: 'POST', body: JSON.stringify({ publishType }), contentType: 'application/json',
});

/** Poll until the Store has processed the upload; resolves with the final upload state. */
export async function waitForUpload(ctx, { tries = 36, delayMs = 5000, sleep = wait } = {}) {
  for (let i = 0; i < tries; i++) {
    const s = await fetchStatus(ctx);
    if (s.lastAsyncUploadState !== 'IN_PROGRESS') return s.lastAsyncUploadState;
    await sleep(delayMs);
  }
  throw new Error('The Store is still processing the upload after 3 minutes; check the dashboard');
}

/**
 * Upload `zip` and submit it. Returns {skipped:true} when the Store settings are missing, else {state, version}.
 * @param {{env:Record<string,string|undefined>, zip:Uint8Array, fetchImpl?:typeof fetch, sleep?:(ms:number)=>Promise<void>, log?:(s:string)=>void}} o
 */
export async function release({ env, zip, fetchImpl = fetch, sleep = wait, log = console.log }) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    log(`Chrome Web Store upload not configured (missing ${missing.join(', ')}): skipped. See docs/release/publishing.md.`);
    return { skipped: true };
  }
  const publishType = env.CWS_PUBLISH_TYPE || 'DEFAULT_PUBLISH';
  if (!PUBLISH_TYPES.has(publishType)) throw new Error(`CWS_PUBLISH_TYPE must be DEFAULT_PUBLISH or STAGED_PUBLISH, not "${publishType}"`);
  const token = await accessToken({ clientId: env.CWS_CLIENT_ID, clientSecret: env.CWS_CLIENT_SECRET, refreshToken: env.CWS_REFRESH_TOKEN }, fetchImpl);
  const ctx = { fetchImpl, token, name: itemName(env.CWS_PUBLISHER_ID, env.CWS_EXTENSION_ID) };

  const before = await fetchStatus(ctx);
  const pending = before.submittedItemRevisionStatus?.state;
  if (BUSY.has(pending)) {
    throw new Error(`The Store still has a submission that is ${pending}. Wait for it, publish it, or cancel it in the dashboard, then re-run this job.`);
  }
  if (before.takenDown) throw new Error('The item is taken down in the Chrome Web Store; resolve that in the dashboard first.');

  const up = await uploadPackage(ctx, zip);
  const state = up.uploadState === 'IN_PROGRESS' ? await waitForUpload(ctx, { sleep }) : up.uploadState;
  if (state !== 'SUCCEEDED') throw new Error(`Upload ${state ?? 'failed'}: the Store did not accept the package (a version that is not higher than the last one is the usual cause).`);
  log(`Uploaded version ${up.crxVersion ?? '(processing)'} to ${env.CWS_EXTENSION_ID}.`);

  const pub = await publishItem(ctx, publishType);
  if (pub.state === 'REJECTED') throw new Error('The Store rejected the submission; see the dashboard for the reason.');
  log(`Submitted with ${publishType}: ${pub.state ?? 'submitted'}.${publishType === 'STAGED_PUBLISH' ? ' After approval, press Publish in the dashboard within 30 days.' : ' It goes live when the review approves it.'}`);
  return { state: pub.state ?? null, version: up.crxVersion ?? null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node scripts/cws-publish.mjs <release.zip>'); process.exit(2); }
  readFile(file)
    .then((zip) => release({ env: process.env, zip }))
    .catch((e) => { console.error(`::error::${e.message}`); process.exit(1); });
}
