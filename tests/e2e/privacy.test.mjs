// J11 privacy / egress (research §11 J11, security-review SEC-10 runtime proof).
// Two builds: dist-e2e (context-menu jobs + upload) and the release build (upload only; it has no host
// access, so it cannot fetch page images without a real activeTab click). Evidence comes from two
// independent logs: Playwright's request events (tabs, extension pages, workers, service worker) and
// Chrome's browser-wide NetLog (--log-net-log), which also sees tabs created by chrome.tabs.create.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { readPage, tid } from './lib/panel.mjs';

const FIX = (f) => path.join(E.FIXTURES, f);
const T = { timeout: 180_000 };
const foreignHost = 'evil.example';
const OFFICIAL = {
  psa01234567: 'https://www.psacard.com/cert/01234567',
  comic4012345001: 'https://www.cgccomics.com/certlookup/4012345001/',
  comicQr4012347003: 'https://www.cgccomics.com/certlookup/4012347003/',
  card1401036622258: 'https://www.cgccards.com/certlookup/1401036622258/',
};

function checkNetLog(reqs, { allowedOrigins, expectedGrader }) {
  const ok = (u) => u.startsWith('chrome') || u.startsWith('blob:') || u.startsWith('data:') || allowedOrigins.has(new URL(u).origin) || E.isGraderUrl(u);
  const renderer = reqs.filter((r) => r.renderer);
  assert.deepEqual(renderer.filter((r) => !ok(r.url)).map((r) => r.url), [], 'renderer/extension traffic only to local origins and official grader pages');
  const grader = reqs.filter((r) => E.isGraderUrl(r.url));
  for (const g of grader) {
    assert.equal(g.requestType, 'main frame', `${g.url} is a tab navigation, not a fetch`);
    assert.equal(g.netError, 'ERR_NAME_NOT_RESOLVED', `${g.url} blocked by host-resolver-rules`);
  }
  assert.deepEqual([...new Set(grader.map((g) => g.url))].sort(), [...expectedGrader].sort(), 'exactly the opened official pages');
  assert.ok(!reqs.some((r) => E.hostOf(r.url) === foreignHost), 'foreign QR host absent from the browser-wide log');
  const nonLocal = reqs.filter((r) => !['127.0.0.1', 'localhost'].includes(E.hostOf(r.url)));
  for (const r of nonLocal) assert.ok(r.netError && r.netError !== 'OK', `${r.url} must not have succeeded (no egress)`);
  const background = [...new Set(nonLocal.filter((r) => !r.renderer).map((r) => `${E.hostOf(r.url)} [${r.annotationName}]`))];
  // Requests the extension itself initiated (fetches from the panel/worker): only local fixture origins, never elsewhere.
  const byExtension = reqs.filter((r) => (r.initiator ?? '').startsWith('chrome-extension://') && /^https?:/.test(r.url));
  assert.deepEqual(byExtension.filter((r) => !allowedOrigins.has(new URL(r.url).origin)).map((r) => r.url), [], 'extension-initiated requests stay on the page/image origins');
  return { total: reqs.length, renderer: renderer.length, grader: grader.length, background, byExtension: byExtension.length };
}

function checkPlaywrightLog(env, allowedOrigins) {
  const ok = (u) => u.startsWith(`chrome-extension://${env.extensionId}/`) || u.startsWith('blob:') || u.startsWith('data:')
    || allowedOrigins.has(new URL(u).origin) || E.isGraderUrl(u);
  assert.deepEqual(env.net.filter((n) => !ok(n.url)).map((n) => `${n.url} (${n.where})`), [], 'unexpected requests in extension/page contexts');
  assert.ok(env.net.filter((n) => n.where === 'service-worker').every((n) => n.url.startsWith(`chrome-extension://${env.extensionId}/`)),
    'service worker only loads its own files');
  assert.deepEqual(env.net.filter((n) => /jsdelivr|unpkg|cdnjs|googleapis|gstatic/i.test(n.url)).map((n) => n.url), [], 'no CDN requests');
}

describe('J11 privacy on dist-e2e: jobs + upload', { concurrency: false }, () => {
  let servers;
  let env;
  let dir;
  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    dir = await mkdtemp(path.join(os.tmpdir(), 'certscanner-netlog-'));
    env = await E.launchExtension({ args: [`--log-net-log=${path.join(dir, 'netlog.json')}`, '--net-log-capture-mode=Default'] });
  });
  after(async () => {
    await env?.close();
    await servers?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('only chrome-extension://, local fixture origins and (DNS-blocked) official pages are requested', T, async () => {
    const page0 = env.context.pages()[0];
    await page0.goto(`${servers.A}/pages/gallery.html`);
    await page0.waitForSelector('html[data-ready]', { state: 'attached' });
    const tab = await E.findTab(env, `${servers.A}/pages/gallery.html`);
    const p = await E.openPanel(env, tab.windowId);
    const run = async (srcUrl) => {
      const mark = await E.logMark(p.page);
      await E.writeJob(env, { windowId: tab.windowId, tabId: tab.id, srcUrl, pageUrl: tab.url });
      return E.waitForScanEnd(p.page, mark);
    };
    const r1 = await run(`${servers.A}/psa-8digit-leading-zero.png`);
    const r2 = await run(`${servers.C}/cgc-comic-10digit.png`);
    const r3 = await run(`${servers.A}/qr-foreign-host.png`);
    const r4 = await E.uploadAndWait(p.page, FIX('cgc-card-13digit.png'));
    assert.deepEqual([r1.state, r2.state, r4.state], ['auto-open', 'auto-open', 'auto-open']);
    assert.notEqual(r3.state, 'auto-open');
    // A9 page scan of the whole gallery (page job shaped like sw.js createPageJob; no tab opens).
    const mark5 = await E.logMark(p.page);
    await E.writePageJob(env, { windowId: tab.windowId, tabId: tab.id, pageUrl: tab.url });
    const r5 = await E.waitForScanEnd(p.page, mark5, { timeout: 60000 });
    assert.equal(r5.state, 'page-results');
    await E.sleep(1500);
    const local = new Set([servers.A, servers.B, servers.C]);
    checkPlaywrightLog(env, local);
    await env.close();
    const summary = checkNetLog(E.parseNetLog(await readFile(path.join(dir, 'netlog.json'), 'utf8')), {
      allowedOrigins: local, expectedGrader: [OFFICIAL.psa01234567, OFFICIAL.comic4012345001, OFFICIAL.card1401036622258],
    });
    console.log(`# J11 dist-e2e NetLog: ${summary.total} URL requests, renderer ${summary.renderer}, extension-initiated ${summary.byExtension}, grader navigations ${summary.grader}; Chromium background services (not extension, all DNS-blocked): ${summary.background.join(', ') || 'none'}`);
  });
});

describe('J11 privacy on the release build (no host access): upload + A9 panel button without access', { concurrency: false }, () => {
  let env;
  let servers;
  let dir;
  let variant = null;
  let releaseDir;
  let identity;
  before(async () => {
    const e2eBuild = E.assertBuilt();
    const distInfo = path.join(E.ROOT, 'dist', 'build-info.json');
    const rel = existsSync(distInfo) ? JSON.parse(readFileSync(distInfo, 'utf8')) : null;
    if (rel?.target === 'release' && rel.gitCommit === e2eBuild.gitCommit && rel.gitDirty === e2eBuild.gitDirty) {
      releaseDir = path.join(E.ROOT, 'dist');
      identity = `dist/ (release, ${rel.gitCommit?.slice(0, 7)}${rel.gitDirty ? '+dirty' : ''}, built ${rel.builtAt})`;
    } else {
      // dist/ and dist-e2e/ differ only in manifest host_permissions + build-info (security review round 1).
      variant = await E.makeVariant((m) => { delete m.host_permissions; });
      releaseDir = variant.dir;
      identity = `release-equivalent copy of dist-e2e with host_permissions removed (dist/ missing or from another source state)`;
    }
    dir = await mkdtemp(path.join(os.tmpdir(), 'certscanner-netlog-rel-'));
    servers = await E.startServers();
    env = await E.launchExtension({ extensionPath: releaseDir, args: [`--log-net-log=${path.join(dir, 'netlog.json')}`, '--net-log-capture-mode=Default'] });
  });
  after(async () => {
    await env?.close();
    await servers?.close();
    await rm(dir, { recursive: true, force: true });
    await variant?.cleanup();
  });

  test('release manifest has no host access; panel page scan without access reads nothing; uploads request nothing but the opened official pages', T, async () => {
    console.log(`# J11 release build under test: ${identity}`);
    const perms = await env.sw.evaluate(() => chrome.permissions.getAll());
    assert.deepEqual(perms.origins, [], 'no host access at install');
    const manifest = await env.sw.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.host_permissions, undefined);
    const windowId = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    // A9: a web page is open; the panel's "Scan this page" without access → page-access state, nothing is read.
    const page0 = env.context.pages()[0];
    await page0.goto(`${servers.A}/pages/gallery.html`);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 15000 });
    const p = await E.openPanel(env, windowId);
    const logStart = servers.log.length;
    await p.page.locator(tid('page-scan-button')).click();
    await E.poll(async () => (await readPage(p.page)).task === 'page-access', { message: 'page-access', timeout: 10000 });
    await E.sleep(1000);
    assert.deepEqual(servers.log.slice(logStart).filter((r) => r.path !== '/favicon.ico'), [], 'no request to the page origins after the click');
    const a = await E.uploadAndWait(p.page, FIX('psa-8digit-leading-zero.png'));
    const b = await E.uploadAndWait(p.page, FIX('cgc-comic-qr.png'));
    const c = await E.uploadAndWait(p.page, FIX('qr-foreign-host.png'));
    assert.deepEqual([a.state, b.state], ['auto-open', 'auto-open']);
    assert.notEqual(c.state, 'auto-open');
    await E.sleep(1500);
    const local = new Set([servers.A, servers.B, servers.C]);
    checkPlaywrightLog(env, local);
    await env.close();
    const reqs = E.parseNetLog(await readFile(path.join(dir, 'netlog.json'), 'utf8'));
    const summary = checkNetLog(reqs, { allowedOrigins: local, expectedGrader: [OFFICIAL.psa01234567, OFFICIAL.comicQr4012347003] });
    assert.equal(summary.byExtension, 0, 'release build: the extension initiated no http(s) request at all');
    console.log(`# J11 release NetLog: ${summary.total} URL requests, renderer ${summary.renderer}, extension-initiated ${summary.byExtension}, grader navigations ${summary.grader}; Chromium background services (not extension, all DNS-blocked): ${summary.background.join(', ') || 'none'}`);
  });
});
