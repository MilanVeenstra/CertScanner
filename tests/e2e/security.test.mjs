// Runtime checks for docs/quality/security-review.md round 1: SEC-03 (hang budgets), SEC-04 (decode
// bomb), SEC-06 (Sharper re-run opens at most one tab), SEC-01 (incognito not allowed, manifest level).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { isVisible, stubPermissions, tid } from './lib/panel.mjs';

const manifest = JSON.parse(readFileSync(path.join(E.FIXTURES, 'manifest.json'), 'utf8'));
const busySpec = manifest.pages.find((p) => p.kind === 'hostile-busy-loop');
const bomb = manifest.securityFixtures.find((f) => f.finding === 'SEC-04');
const T = { timeout: 150_000 };

/** Wait for a terminal state after `mark`, but never longer than `capMs`; returns {result|null, ms}. */
async function settle(page, mark, capMs) {
  const t0 = Date.now();
  try {
    const result = await E.waitForScanEnd(page, mark, { timeout: capMs });
    return { result, ms: Date.now() - t0 };
  } catch {
    return { result: null, ms: Date.now() - t0 };
  }
}

describe('SEC-03 hostile busy page / SEC-04 decode bomb (dist-e2e)', { concurrency: false }, () => {
  let servers;
  let env;
  let panel;
  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    env = await E.launchExtension();
    const windowId = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    panel = await E.openPanel(env, windowId);
  });
  after(async () => {
    await env?.close();
    await servers?.close();
  });

  /** Open the busy page on the `localhost` site (own renderer) with a hotlink image (forces the page probe). */
  async function busyTab(ms = 45000) {
    const port = new URL(servers.A).port;
    const img = `${servers.B}/hotlink/${busySpec.fixture}`;
    const url = `http://localhost:${port}/${busySpec.page}?img=${encodeURIComponent(img)}&delay=300&ms=${ms}`;
    const page = await env.context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 10000 });
    await E.sleep(700); // busy loop running now
    const tab = await E.findTab(env, `http://localhost:${port}/pages/busy.html`);
    await env.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), tab.id);
    return { page, tab, img };
  }

  test(`SEC-03 scan on a page that blocks its main thread settles with an error within ${busySpec.expected.maxSettleMs} ms`, T, async () => {
    const { tab, img } = await busyTab();
    const mark = await E.logMark(panel.page);
    await E.writeJob(env, { windowId: tab.windowId, tabId: tab.id, srcUrl: img, pageUrl: tab.url });
    const { result, ms } = await settle(panel.page, mark, 40000);
    console.log(`# SEC-03 busy page: settled=${!!result} state=${result?.state ?? 'scanning'} after ${ms} ms (budget ${busySpec.expected.maxSettleMs} ms)`);
    assert.ok(result, `scan did not settle within 40 s (observed ${ms} ms)`);
    assert.equal(result.state, 'error');
    assert.ok(ms <= busySpec.expected.maxSettleMs, `settled after ${ms} ms > ${busySpec.expected.maxSettleMs} ms`);
    await env.sw.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tab.id);
  });

  test('SEC-03 scan() on the busy page reports error code "timeout" (pipeline level)', T, async () => {
    const { tab, img } = await busyTab();
    const job = { v: 1, id: 'sec03-direct', createdAt: Date.now(), source: 'contextMenu', srcUrl: img, pageUrl: E.minimizePageUrl(tab.url),
      frameId: 0, tabId: tab.id, windowId: tab.windowId, mediaType: 'image' };
    const t0 = Date.now();
    const r = await Promise.race([
      E.scanInPanel(panel.page, { kind: 'job', job }),
      E.sleep(40000).then(() => null),
    ]);
    const ms = Date.now() - t0;
    console.log(`# SEC-03 scan(): ${r ? `${r.status}/${r.error?.code} acquireMs=${r.timings.acquireMs} totalMs=${r.timings.totalMs}` : 'unsettled'} after ${ms} ms`);
    assert.ok(r, `scan() unsettled after ${ms} ms`);
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, 'timeout');
    assert.ok(ms <= busySpec.expected.maxSettleMs, `scan() settled after ${ms} ms`);
    await env.sw.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tab.id);
  });

  test(`SEC-03 Cancel during a hung acquisition settles within ${busySpec.expected.cancelSettleMs} ms`, T, async () => {
    const { tab, img } = await busyTab();
    const page = panel.page;
    const mark = await E.logMark(page);
    await E.writeJob(env, { windowId: tab.windowId, tabId: tab.id, srcUrl: img, pageUrl: tab.url });
    await page.waitForFunction((m) => window.__cs.log.slice(m).some((e) => e.state === 'scanning'), mark, { timeout: 10000 });
    await E.sleep(2000);
    const cancelMark = await E.logMark(page);
    const t0 = Date.now();
    if (await isVisible(page, 'cancel-button')) await page.locator(tid('cancel-button')).click();
    else await page.keyboard.press('Escape');
    let ms;
    let state;
    try {
      await page.waitForFunction((m) => window.__cs.log.slice(m).some((e) => e.state !== 'scanning'), cancelMark, { timeout: 30000, polling: 20 });
      ms = Date.now() - t0;
      state = await page.evaluate(() => document.body.dataset.state);
    } catch {
      ms = Date.now() - t0;
      state = 'scanning';
    }
    console.log(`# SEC-03 cancel: state ${state} after ${ms} ms (budget ${busySpec.expected.cancelSettleMs} ms)`);
    assert.notEqual(state, 'scanning', `still scanning ${ms} ms after Cancel`);
    assert.ok(ms <= busySpec.expected.cancelSettleMs, `Cancel settled after ${ms} ms`);
    assert.equal((await E.graderTabs(env)).length, 0, 'nothing opened');
    await env.sw.evaluate((id) => chrome.tabs.remove(id).catch(() => {}), tab.id);
  });

  test(`SEC-04 decode bomb (${bomb.file}, ${bomb.declared.width}x${bomb.declared.height}) → error "too-large" within ${bomb.expected.maxSettleMs} ms`, T, async () => {
    const file = path.join(E.FIXTURES, bomb.file);
    const r = await E.uploadAndWait(panel.page, { name: 'bomb.bmp', mimeType: 'image/bmp', buffer: readFileSync(file) }, { timeout: 30000 });
    console.log(`# SEC-04 upload: state ${r.state} after ${r.wallMs} ms`);
    assert.equal(r.state, 'error');
    const direct = await E.scanInPanel(panel.page, { kind: 'blob-b64', b64: readFileSync(file).toString('base64'), type: 'image/bmp' });
    console.log(`# SEC-04 scan(): ${direct.status}/${direct.error?.code} acquireMs=${direct.timings.acquireMs} totalMs=${direct.timings.totalMs}`);
    assert.equal(direct.error?.code, 'too-large');
    assert.ok(r.wallMs <= bomb.expected.maxSettleMs, `upload settled after ${r.wallMs} ms`);
    assert.ok(direct.timings.totalMs <= bomb.expected.maxSettleMs, `scan() took ${direct.timings.totalMs} ms`);
  });
});

describe('SEC-06 / J7 accept path: Sharper re-run after a screen-resolution read opens at most one tab per job', { concurrency: false }, () => {
  let servers;
  let tls;
  let env;
  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    tls = await E.startHttpsImageServer();
    env = await E.launchExtension({ args: ['--ignore-certificate-errors'] });
  });
  after(async () => {
    await env?.close();
    await servers?.close();
    await tls?.close();
  });

  test('small on-screen image → confirm/none with offer → grant (stubbed) → full-resolution re-run auto-opens once; rescan opens nothing more', T, async () => {
    const img = `${tls.origin}/psa-8digit-leading-zero.png`;
    const page0 = env.context.pages()[0];
    await page0.goto(`${servers.A}/__e2e/page.html?img=${encodeURIComponent(img)}&w=110&id=img-https-small`);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 10000 });
    const tab = await E.findTab(env, `${servers.A}/__e2e/page.html`);
    const p = await E.openPanel(env, tab.windowId);
    assert.ok(await stubPermissions(p.page, { grant: true }), 'chrome.permissions stubbed in the panel realm');
    const want = 'https://www.psacard.com/cert/01234567';
    const count = async () => (await E.graderTabs(env)).filter((t) => t.url === want).length;
    const mark = await E.logMark(p.page);
    await E.writeJob(env, { windowId: tab.windowId, tabId: tab.id, srcUrl: img, pageUrl: tab.url });
    const first = await E.waitForScanEnd(p.page, mark);
    await E.sleep(800);
    console.log(`# SEC-06 first (capture) scan: ${first.state} ${first.number} sharper=${first.sharperVisible} tabs=${await count()}`);
    assert.ok(first.sharperVisible, `precondition: Sharper offered after a screen-resolution read (state ${first.state})`);
    const fetchesBefore = tls.log.filter((r) => r.dest !== 'image').length;
    const mark2 = await E.logMark(p.page);
    await p.page.locator(tid('sharper-button')).click();
    const second = await E.waitForScanEnd(p.page, mark2);
    await E.sleep(1500);
    console.log(`# SEC-06 after grant: requests=${await p.page.evaluate(() => window.__perm.requests)} rerun=${second.state} ${second.number} tabs=${await count()}`);
    assert.ok(tls.log.filter((r) => r.dest !== 'image').length > fetchesBefore, 'full-resolution fetch of the image after the grant');
    assert.equal(second.number, '01234567');
    assert.ok((await count()) <= 1, 'at most one tab after the re-run');
    let reruns = 0;
    for (let i = 0; i < 2; i++) {
      const id = await p.page.evaluate(() => {
        const b = [...document.querySelectorAll('[data-testid="rescan-button"], [data-testid="retry-button"]')].find((x) => !x.hidden && !x.closest('[hidden]') && x.getClientRects().length);
        return b ? b.dataset.testid : null;
      });
      if (!id) break;
      const m = await E.logMark(p.page);
      await p.page.locator(tid(id)).click();
      await E.waitForScanEnd(p.page, m);
      reruns++;
      await E.sleep(1000);
    }
    console.log(`# SEC-06 extra re-runs of the same job: ${reruns}; tabs=${await count()}`);
    assert.ok((await count()) <= 1, 'the same cert opened at most once for one job');
  });
});
