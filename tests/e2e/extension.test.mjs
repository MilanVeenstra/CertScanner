// CertScanner end-to-end journeys (ADR-001 §14, research §11 J1–J11) against the real extension.
//
// Prerequisite: `npm run build:e2e` (done by `npm run e2e`). Runs Playwright's bundled Chromium headless
// with dist-e2e/ loaded; everything except 127.0.0.1/localhost resolves to NOTFOUND, so grader pages are
// never contacted. Jobs are written to chrome.storage.session from the extension's own service worker,
// exactly like the context-menu handler does; the side panel runs as the popup-window fallback (?w=).
// Hard checks: zero wrong auto-opens; the foreign QR URL/host is never navigated or requested.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import bwipjs from 'bwip-js/node';
import * as E from './lib/env.mjs';
import { accessibleNames, chooseGrader, dropImage, expandOtherWays, getSetting, isVisible, pasteImage, setSetting, storageGet, stubPermissions, tabTo, tid } from './lib/panel.mjs';

const FIX = (f) => path.join(E.FIXTURES, f);
const fixtureManifest = JSON.parse(readFileSync(FIX('manifest.json'), 'utf8'));
const fixture = (file) => fixtureManifest.fixtures.find((f) => f.file === file);
const T = { timeout: 120_000 };

/** Every auto-opened URL in the whole run (hard check: each must match its fixture's expected URL). */
const autoOpens = [];
const foreignHost = 'evil.example';

describe('CertScanner e2e journeys', { concurrency: false }, () => {
  let servers;
  let env;
  let galleryPage;
  let galleryTab;
  let panel;

  async function newGraderTabsSince(before) {
    const ids = new Set(before.map((t) => t.id));
    return (await E.graderTabs(env)).filter((t) => !ids.has(t.id));
  }

  /** Run one job against the shared panel and return {result, opened, job}. */
  async function runJob({ srcUrl, pageUrl = galleryTab.url, tabId = galleryTab.id, windowId = galleryTab.windowId, frameId = 0, settle = 800 }) {
    const beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(panel.page);
    const job = await E.writeJob(env, { windowId, tabId, srcUrl, pageUrl, frameId });
    const result = await E.waitForScanEnd(panel.page, mark);
    await E.sleep(settle);
    const opened = await newGraderTabsSince(beforeTabs);
    if (result.state === 'auto-open') autoOpens.push({ srcUrl, urls: opened.map((t) => t.url) });
    return { result, opened, job };
  }

  async function upload(file, opts) {
    const beforeTabs = await E.graderTabs(env);
    const result = await E.uploadAndWait(panel.page, file, opts);
    await E.sleep(600);
    const opened = await newGraderTabsSince(beforeTabs);
    if (result.state === 'auto-open') autoOpens.push({ file: typeof file === 'string' ? path.basename(file) : file.name, urls: opened.map((t) => t.url) });
    return { result, opened };
  }

  async function showGallery(url = `${servers.A}/pages/gallery.html`) {
    await galleryPage.goto(url);
    await galleryPage.waitForSelector('html[data-ready]', { state: 'attached', timeout: 15000 });
    galleryTab = await E.findTab(env, url);
    await env.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), galleryTab.id);
  }

  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    env = await E.launchExtension();
    galleryPage = env.context.pages()[0] ?? await env.context.newPage();
    await showGallery();
    panel = await E.openPanel(env, galleryTab.windowId);
  });

  after(async () => {
    await env?.close();
    await servers?.close();
  });

  test('install: service worker, context menu, panel behaviour, no message listeners, §13 test ids', T, async () => {
    const sw = await env.sw.evaluate(async () => {
      let menu = 'missing';
      try { await chrome.contextMenus.update('certscanner-scan', {}); menu = 'present'; } catch (e) { menu = `missing: ${e.message}`; }
      const behavior = await chrome.sidePanel.getPanelBehavior();
      const options = await chrome.sidePanel.getOptions({});
      return {
        menu, behavior, options,
        onMessage: chrome.runtime.onMessage.hasListeners(),
        onMessageExternal: chrome.runtime.onMessageExternal.hasListeners(),
        onConnect: chrome.runtime.onConnect.hasListeners(),
        manifest: chrome.runtime.getManifest(),
      };
    });
    assert.equal(sw.menu, 'present', 'context menu item certscanner-scan registered on install');
    // A9: by default the toolbar icon scans the page (action.onClicked), so Chrome must not open the panel itself.
    assert.equal(sw.behavior.openPanelOnActionClick, false, 'A9 default: toolbar click scans the page (openPanelOnActionClick false)');
    assert.equal(sw.options.path, 'sidepanel/sidepanel.html');
    assert.deepEqual(Object.keys(sw.manifest.commands ?? {}), ['scan-page'], 'A9 keyboard command declared');
    assert.equal(sw.onMessage, false, 'no runtime.onMessage listener (ADR §10)');
    assert.equal(sw.onMessageExternal, false, 'no runtime.onMessageExternal listener');
    assert.equal(sw.onConnect, false, 'no runtime.onConnect listener');
    assert.deepEqual([...sw.manifest.permissions].sort(), ['activeTab', 'contextMenus', 'scripting', 'sidePanel', 'storage']);
    assert.deepEqual(sw.manifest.optional_host_permissions, ['https://*/*']);
    assert.deepEqual(sw.manifest.host_permissions, ['<all_urls>'], 'dist-e2e test patch only (release check proves dist/ has none)');
  });

  test('A9 setting scanOnToolbarClick: off → toolbar only opens the panel (behaviour true, "Open" tooltip); on → scans again', T, async () => {
    const page = panel.page;
    const behaviour = () => env.sw.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick);
    const title = () => env.sw.evaluate(() => chrome.action.getTitle({}));
    const en = JSON.parse(readFileSync(path.join(E.DIST_E2E, '_locales', 'en', 'messages.json'), 'utf8'));
    assert.equal(await getSetting(page, 'scanOnToolbarClick'), true, 'default on');
    assert.equal(await behaviour(), false);
    assert.equal(await title(), en.action_title.message, 'RM-6 tooltip: scan this page');
    await setSetting(page, 'scanOnToolbarClick', false);
    await E.poll(async () => (await storageGet(page, 'sync', 'settings'))?.scanOnToolbarClick === false, { message: 'scanOnToolbarClick saved' });
    await E.poll(async () => (await behaviour()) === true, { message: 'openPanelOnActionClick true after switching off' });
    assert.equal(await title(), en.action_title_open.message, 'tooltip: Open CertScanner');
    await setSetting(page, 'scanOnToolbarClick', true);
    await E.poll(async () => (await behaviour()) === false, { message: 'openPanelOnActionClick false after switching on' });
    assert.equal(await title(), en.action_title.message);
  });

  test('SEC-01 / A7: manifest declares incognito "not_allowed"', T, async () => {
    const m = await env.sw.evaluate(() => chrome.runtime.getManifest());
    assert.equal(m.incognito, 'not_allowed', 'ADR A7 / SEC-01: cannot run in incognito');
    assert.equal(await env.sw.evaluate(() => chrome.extension.isAllowedIncognitoAccess()), false);
  });

  test('side panel: §13 test ids, live region, window binding, accessible names, no message listeners', T, async () => {
    const page = panel.page;
    const ids = ['status-live', 'progress', 'preview', 'result-number', 'result-grader', 'candidate-list', 'grader-select', 'number-input',
      'open-button', 'copy-button', 'cancel-button', 'sharper-button', 'upload-input', 'manual-input', 'manual-submit', 'manual-error',
      'error-message', 'history-list', 'history-clear', 'setting-autoOpen', 'setting-openInBackground', 'setting-saveHistory',
      // A9 additions
      'page-scan-button', 'page-progress', 'page-result-list', 'setting-scanOnToolbarClick', 'shortcut-current', 'shortcut-button'];
    const missing = await page.evaluate((list) => list.filter((id) => !document.querySelector(`[data-testid="${id}"]`)), ids);
    assert.deepEqual(missing, [], `missing §13/A9 test ids: ${missing.join(', ')}`);
    const dupes = await page.evaluate((list) => list.filter((id) => document.querySelectorAll(`[data-testid="${id}"]`).length > 1), ids);
    assert.deepEqual(dupes, [], 'test ids are unique');
    assert.ok(await isVisible(page, 'page-scan-button'), 'A9 idle leads with "Scan this page"');
    const live = await page.locator(tid('status-live')).getAttribute('aria-live');
    assert.equal(live, 'polite');
    assert.equal(await page.evaluate(() => document.body.dataset.windowId), String(galleryTab.windowId), 'body[data-window-id] = ?w=');
    const pageListeners = await page.evaluate(() => chrome.runtime.onMessage.hasListeners() || chrome.runtime.onMessageExternal.hasListeners());
    assert.equal(pageListeners, false, 'panel registers no runtime message listeners');
    const names = await accessibleNames(page, ['manual-input', 'manual-submit', 'setting-autoOpen', 'setting-openInBackground', 'setting-saveHistory', 'history-clear']);
    for (const [id, n] of Object.entries(names)) assert.ok(n && n.length > 1, `${id} has an accessible name`);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  });

  test('J1 PSA happy path: context-menu job, same-origin image → auto-open psacard.com/cert/01234567 next to the source tab', T, async () => {
    await E.closeGraderTabs(env);
    const { result, opened, job } = await runJob({ srcUrl: `${servers.A}/psa-8digit-leading-zero.png` });
    assert.equal(result.state, 'auto-open');
    assert.equal(result.number, '01234567', 'leading zero kept');
    assert.equal(result.grader, 'psa');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].url, 'https://www.psacard.com/cert/01234567');
    assert.equal(opened[0].windowId, galleryTab.windowId);
    assert.equal(opened[0].openerTabId, galleryTab.id, 'opened with the source tab as opener');
    assert.equal(opened[0].index, galleryTab.index + 1, 'opened right after the source tab');
    assert.equal(await E.sessionGet(env, `scanJob:${galleryTab.windowId}`), null, 'job consumed (removed from session storage)');
    const history = await env.sw.evaluate(async () => (await chrome.storage.local.get('history')).history ?? null);
    assert.ok(history?.entries?.some((e) => e.grader === 'psa' && e.number === '01234567'), 'history entry written');
    assert.ok(!JSON.stringify(history).includes(job.srcUrl), 'history holds no image URL');
    assert.ok(!JSON.stringify(history).includes('data:image'), 'history holds no image data');
  });

  test('J2 CGC comic: cross-origin CORS image (:C) → auto-open cgccomics; dash form from no-CORS origin (:B) normalised', T, async () => {
    await E.closeGraderTabs(env);
    const a = await runJob({ srcUrl: `${servers.C}/cgc-comic-10digit.png` });
    assert.equal(a.result.state, 'auto-open');
    assert.deepEqual(a.opened.map((t) => t.url), ['https://www.cgccomics.com/certlookup/4012345001/']);
    await E.closeGraderTabs(env);
    const b = await runJob({ srcUrl: `${servers.B}/cgc-comic-dash.png` });
    assert.equal(b.result.number, '4012346002');
    assert.ok(['auto-open', 'confirm'].includes(b.result.state));
    if (b.result.state === 'auto-open') assert.deepEqual(b.opened.map((t) => t.url), ['https://www.cgccomics.com/certlookup/4012346002/']);
  });

  test('J3 CGC card: 13-digit image inside a same-origin iframe → cgccards; 10-digit with card wording (upload) → cgccards', T, async () => {
    await E.closeGraderTabs(env);
    const frames = await env.sw.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href }))
      .map((r) => ({ frameId: r.frameId, url: r.result })), galleryTab.id);
    const frame = frames.find((f) => f.url.endsWith('/pages/frame.html'));
    assert.ok(frame, 'same-origin frame found');
    const a = await runJob({ srcUrl: `${servers.A}/cgc-card-13digit.png`, frameId: frame.frameId });
    assert.equal(a.result.state, 'auto-open');
    assert.deepEqual(a.opened.map((t) => t.url), ['https://www.cgccards.com/certlookup/1401036622258/']);
    await E.closeGraderTabs(env);
    const b = await upload(path.join(E.BENCH, 'cgcd-c16.png'));
    assert.equal(b.result.number, '3901234567');
    assert.ok(['auto-open', 'confirm'].includes(b.result.state));
    if (b.result.state === 'auto-open') assert.deepEqual(b.opened.map((t) => t.url), ['https://www.cgccards.com/certlookup/3901234567/']);
    else assert.equal(b.result.grader, 'cgc-cards', 'card wording resolves the 10-digit grader');
  });

  test('J4 QR allow-listed (blob: image via page-fetch) → OCR skipped, URL rebuilt; foreign host never opened', T, async () => {
    await E.closeGraderTabs(env);
    const blobUrl = await galleryPage.evaluate(() => document.getElementById('img-blob').src);
    assert.match(blobUrl, /^blob:/);
    const a = await runJob({ srcUrl: blobUrl });
    assert.equal(a.result.state, 'auto-open');
    assert.deepEqual(a.opened.map((t) => t.url), ['https://www.cgccomics.com/certlookup/4012347003/']);
    const direct = await E.scanInPanel(panel.page, { kind: 'blob-url', url: `${servers.A}/cgc-comic-qr.png` });
    assert.equal(direct.candidates[0].source, 'qr-url');
    assert.equal(direct.timings.ocrMs, 0, 'allow-listed QR finishes the scan without OCR');

    await E.closeGraderTabs(env);
    const fx = fixture('qr-foreign-host.png');
    const b = await runJob({ srcUrl: `${servers.A}/qr-foreign-host.png`, settle: 2000 });
    assert.ok(fx.accept.includes(b.result.state), `foreign QR status ${b.result.state} in ${fx.accept}`);
    assert.notEqual(b.result.state, 'auto-open');
    assert.equal(b.opened.length, 0, 'nothing opened automatically');
    const directForeign = await E.scanInPanel(panel.page, { kind: 'blob-url', url: `${servers.A}/qr-foreign-host.png` });
    assert.notEqual(directForeign.status, 'auto-open');
    if (directForeign.candidates.length) {
      assert.ok(directForeign.warnings.some((w) => w.code === 'qr-untrusted-host'), 'qr-untrusted-host warning');
      assert.ok(directForeign.candidates.every((c) => c.confidence <= 0.5), 'untrusted QR digits capped at 0.50');
    }
    if (b.result.state === 'confirm') {
      // The user may still open the number, but only through the rebuilt official URL.
      if (!b.result.grader) await chooseGrader(panel.page, 'psa');
      const beforeTabs = await E.graderTabs(env);
      await panel.page.locator(tid('open-button')).click();
      await E.poll(async () => (await newGraderTabsSince(beforeTabs)).length === 1, { message: 'tab from confirm' });
      const [t] = await newGraderTabsSince(beforeTabs);
      assert.equal(t.url, 'https://www.psacard.com/cert/12345678', 'URL rebuilt from grader + digits');
    }
    const all = await E.allTabs(env);
    assert.ok(!all.some((t) => E.hostOf(t.url) === foreignHost || E.hostOf(t.pendingUrl ?? '') === foreignHost), 'evil.example never navigated');
    assert.ok(!env.net.some((n) => E.hostOf(n.url) === foreignHost), 'evil.example never requested');
  });

  test('J4b QR edge cases generated at test time: allow-listed host with unmatched path, look-alike host', T, async () => {
    const mk = (text) => bwipjs.toBuffer({ bcid: 'qrcode', text, scale: 4, eclevel: 'M', paddingwidth: 8, paddingheight: 8, backgroundcolor: 'FFFFFF' });
    const unmatched = await mk('https://www.psacard.com/certificate/lookup?id=23456789');
    const lookalike = await mk('https://www.psacard.com.evil.example/cert/34567890');
    await E.closeGraderTabs(env);
    const a = await upload({ name: 'qr-unmatched.png', mimeType: 'image/png', buffer: unmatched });
    assert.ok(['auto-open', 'confirm'].includes(a.result.state), `unmatched path → ${a.result.state}`);
    assert.equal(a.result.number, '23456789');
    if (a.result.state === 'auto-open') assert.deepEqual(a.opened.map((t) => t.url), ['https://www.psacard.com/cert/23456789'], 'rebuilt, never the QR URL');
    await E.closeGraderTabs(env);
    const b = await upload({ name: 'qr-lookalike.png', mimeType: 'image/png', buffer: lookalike });
    assert.notEqual(b.result.state, 'auto-open', 'look-alike host never auto-opens');
    assert.equal(b.opened.length, 0);
    assert.ok(!(await E.allTabs(env)).some((t) => t.url.includes('evil.example')));
  });

  test('J5 ambiguous 10 digits: confirm with the best guess preselected, no tab; the user can switch grader → opens rebuilt URL', T, async () => {
    await E.closeGraderTabs(env);
    const { result, opened } = await runJob({ srcUrl: `${servers.A}/ambiguous-10digit.png`, settle: 2000 });
    assert.equal(result.state, 'confirm');
    assert.equal(result.number, '5012345678');
    assert.equal(result.grader, 'cgc-comics', 'most likely grader preselected (no keywords: tie order)');
    assert.equal(opened.length, 0, 'no automatic tab');
    const beforeTabs = await E.graderTabs(env);
    await chooseGrader(panel.page, 'cgc-cards');
    await panel.page.locator(tid('open-button')).click();
    await E.poll(async () => (await newGraderTabsSince(beforeTabs)).length === 1, { message: 'tab after confirm' });
    const [t] = await newGraderTabsSince(beforeTabs);
    assert.equal(t.url, 'https://www.cgccards.com/certlookup/5012345678/');
    await E.poll(async () => (await panel.page.evaluate(() => document.body.dataset.state)) === 'opened', { message: 'state opened' });
  });

  test('J5b confirm → "Scan something else" returns to Idle without a tab; typed number → focus on the result heading', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    const { result } = await runJob({ srcUrl: `${servers.A}/ambiguous-10digit.png`, settle: 2000 });
    assert.equal(result.state, 'confirm');
    const beforeTabs = await E.graderTabs(env);
    await page.locator(tid('scan-other')).click();
    await E.poll(async () => (await page.evaluate(() => document.body.dataset.state)) === 'idle', { message: 'back to idle' });
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0, 'nothing opened');
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'idle', 'the dropped read is not restored');
    await expandOtherWays(page);
    await page.fill('#cert-input', '12345678');
    await page.click('#manual-submit');
    await E.poll(async () => (await page.evaluate(() => document.body.dataset.state)) === 'opened', { message: 'state opened' });
    const v = await page.evaluate(() => ({ focus: document.activeElement?.id, live: document.querySelector('[data-testid="price-data"]')?.getAttribute('aria-live') ?? null }));
    assert.equal(v.focus, 'task-heading', 'focus on the result heading, not lost with the folded form');
    assert.equal(v.live, null, 'the price box is not a live region');
  });

  test('J5c several possible numbers: one click on a row opens that number and shows the normal result', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    const r = await pasteImage(page, await readFile(path.join(E.BENCH, 'psa-c03-blur2.jpg')));
    assert.equal(r.state, 'confirm');
    assert.ok(r.candidates >= 2, `several numbers listed (${r.candidates})`);
    const pick = await page.evaluate(() => document.querySelector('[data-testid="candidate-1"] .cert')?.textContent);
    const beforeTabs = await E.graderTabs(env);
    await page.locator('[data-testid="candidate-1"] [data-ref="use"]').click();
    await E.poll(async () => (await page.evaluate(() => document.body.dataset.state)) === 'opened', { message: 'result after choosing' });
    const [t] = await newGraderTabsSince(beforeTabs);
    assert.equal(t?.url, `https://www.psacard.com/cert/${pick}`, 'the chosen number opened, nothing else');
    const v = await page.evaluate(() => ({
      task: document.getElementById('task').dataset.state,
      number: document.querySelector('[data-testid="result-number"]')?.textContent,
      value: Boolean(document.querySelector('.value [data-testid="price-data"]')),
      focus: document.activeElement?.id,
    }));
    assert.deepEqual(v, { task: 'result', number: pick, value: true, focus: 'task-heading' }, 'same result view as a sure scan');
  });

  test('J6 no number: non-slab image → none, no tab, upload and manual entry offered', T, async () => {
    await E.closeGraderTabs(env);
    const { result, opened } = await runJob({ srcUrl: `${servers.A}/non-slab.png`, settle: 1500 });
    assert.equal(result.state, 'none');
    assert.equal(opened.length, 0);
    await expandOtherWays(panel.page); // design: "Other ways to scan" folds away after a result
    assert.ok(await isVisible(panel.page, 'manual-input'), 'manual entry offered');
    assert.equal(await panel.page.locator(tid('upload-input')).count(), 1, 'upload offered');
  });

  test('A20 "This went wrong": confirm, none and result offer one local .zip (report JSON + the photo); nothing is requested; not after a restore', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    /** Click the report button and read the downloaded archive (stored entries, as scanReport.js writes them). */
    const saveReport = async () => {
      const netBefore = env.net.length;
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator(tid('report-button')).click()]);
      const buf = await readFile(await download.path());
      const files = {};
      const eocd = buf.length - 22;
      let cd = buf.readUInt32LE(eocd + 16);
      for (let i = 0; i < buf.readUInt16LE(eocd + 10); i++) {
        const size = buf.readUInt32LE(cd + 24);
        const nameLen = buf.readUInt16LE(cd + 28);
        const local = buf.readUInt32LE(cd + 42);
        const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
        const start = local + 30 + buf.readUInt16LE(local + 26);
        files[name] = buf.subarray(start, start + size);
        cd += 46 + nameLen;
      }
      const requested = env.net.slice(netBefore).filter((r) => /^https?:/.test(r.url));
      return { name: download.suggestedFilename(), files, requested };
    };
    const reportShown = () => page.evaluate(() => {
      const b = document.querySelector('[data-testid="report-button"]');
      return Boolean(b) && !b.closest('[hidden]') && b.getClientRects().length > 0;
    });

    // Confirm: the photo and the scan's own read.
    const file = FIX('ambiguous-10digit.png');
    const { result } = await upload(file);
    assert.equal(result.state, 'confirm');
    assert.ok(await reportShown(), 'offered on the confirm screen');
    const names = await accessibleNames(page, ['report-button']);
    assert.match(names['report-button'] ?? '', /This went wrong/);
    const r = await saveReport();
    assert.match(r.name, /^certscanner-report-\d{8}-\d{6}\.zip$/);
    assert.deepEqual(Object.keys(r.files).sort(), ['scan-image.png', 'scan-report.json']);
    assert.ok(r.files['scan-image.png'].equals(readFileSync(file)), 'the scanned photo, byte for byte');
    const report = JSON.parse(r.files['scan-report.json'].toString('utf8'));
    assert.equal(report.kind, 'certscanner-scan-report');
    assert.equal(report.scan.status, 'confirm');
    assert.equal(report.scan.candidates[0].number, '5012345678');
    assert.ok(report.scan.candidates[0].evidence.length > 0 && report.scan.passes.length > 0 && report.scan.timings.totalMs > 0);
    assert.ok(!JSON.stringify(report).includes('127.0.0.1'), 'no page or image address');
    assert.deepEqual(r.requested, [], 'nothing requested over the network');
    const hint = await page.evaluate(() => ({ hint: document.getElementById('report-hint')?.textContent ?? '', live: document.querySelector('[data-testid="status-live"]')?.textContent ?? '' }));
    assert.ok(hint.hint.includes(r.name) && /Nothing was sent/.test(hint.hint), hint.hint);

    // None and result: offered too.
    assert.equal((await upload(FIX('non-slab.png'))).result.state, 'none');
    assert.ok(await reportShown(), 'offered when nothing was found');
    const none = await saveReport();
    assert.equal(JSON.parse(none.files['scan-report.json'].toString('utf8')).scan.status, 'none');
    const auto = await upload(FIX('psa-9digit.png'));
    assert.equal(auto.result.state, 'auto-open');
    assert.ok(await reportShown(), 'offered on the result');
    await E.closeGraderTabs(env);

    // After a panel reload the photo is gone from memory: no report for the restored card.
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    assert.equal(await reportShown(), false, 'restored card: no photo, no report');
  });

  test('J7 fetch blocked (hotlink CDN): capture fallback reads the on-screen image; harness strategies → capture/screen', T, async () => {
    await E.closeGraderTabs(env);
    const img = `${servers.B}/hotlink/psa-8digit-leading-zero.png`;
    await showGallery(`${servers.A}/__e2e/page.html?img=${encodeURIComponent(img)}&w=400&id=img-hotlink`);
    assert.equal(await galleryPage.evaluate(() => document.documentElement.dataset.ready), '1', 'image renders in the page');
    const logStart = servers.log.length;
    const { result, opened } = await runJob({ srcUrl: img, pageUrl: galleryTab.url, tabId: galleryTab.id });
    const denied = servers.log.slice(logStart).filter((r) => r.server === 'B' && r.path.startsWith('/hotlink/') && r.dest !== 'image');
    assert.ok(denied.length >= 1, 'extension/page fetch was attempted and refused by the CDN');
    assert.ok(['auto-open', 'confirm', 'none'].includes(result.state), `capture result ${result.state}`);
    if (result.number) assert.equal(result.number, '01234567', 'never a wrong number from the capture');
    if (result.state === 'auto-open') assert.deepEqual(opened.map((t) => t.url), ['https://www.psacard.com/cert/01234567']);
    assert.equal(result.sharperVisible, false, 'http origin (and e2e grant): no "Sharper scans" offer');

    // ADR §14 harness case: strategies ['page-fetch','capture'] with a no-CORS (:B) image.
    await showGallery(`${servers.A}/__e2e/page.html?img=${encodeURIComponent(`${servers.B}/psa-8digit-leading-zero.png`)}&w=400&id=img-nocors`);
    const job = { v: 1, id: 'harness-capture', createdAt: Date.now(), source: 'contextMenu', srcUrl: `${servers.B}/psa-8digit-leading-zero.png`,
      pageUrl: E.minimizePageUrl(galleryTab.url), frameId: 0, tabId: galleryTab.id, windowId: galleryTab.windowId, mediaType: 'image' };
    const r = await E.scanInPanel(panel.page, { kind: 'job', job }, { acquire: { strategies: ['page-fetch', 'capture'] }, settings: { v: 1, autoOpen: false, openInBackground: false, saveHistory: false } });
    assert.equal(r.imageInfo?.method, 'capture', `acquired by ${r.imageInfo?.method} (${r.error?.code ?? 'ok'})`);
    assert.equal(r.imageInfo.resolution, 'screen');
    assert.equal(r.imageInfo.canRequestSharper, false, 'http: origin → canRequestSharper false (https only)');
    assert.ok(Math.abs(r.imageInfo.width - 400) <= 2, `cropped to the on-screen rect (${r.imageInfo.width}px)`);
    if (r.candidates[0]) assert.equal(r.candidates[0].number, '01234567');
    await showGallery();
  });

  test('J8 restricted pages: chrome://version and Chrome Web Store → restricted error, no uncaught errors', T, async () => {
    await E.closeGraderTabs(env);
    const errorsBefore = panel.errors.length;
    const idsBefore = new Set((await E.allTabs(env)).map((t) => t.id));
    const cv = await env.context.newPage();
    await cv.goto('chrome://version');
    // <all_urls> does not cover chrome://, so tab.url is hidden: find the new tab by id.
    const cvTab = await E.poll(async () => (await E.allTabs(env)).find((t) => !idsBefore.has(t.id)), { message: 'chrome://version tab' });
    cvTab.url = 'chrome://version/';
    const a = await runJob({ srcUrl: `${servers.A}/psa-8digit-leading-zero.png`, pageUrl: cvTab.url, tabId: cvTab.id, windowId: galleryTab.windowId });
    assert.equal(a.result.state, 'error');
    assert.ok(a.result.error.length > 0, 'error message shown');
    assert.equal(a.opened.length, 0);
    const b = await runJob({ srcUrl: 'https://lh3.googleusercontent.com/x.png', pageUrl: 'https://chromewebstore.google.com/detail/abc', tabId: galleryTab.id });
    assert.equal(b.result.state, 'error');
    assert.equal(b.result.error, a.result.error, 'same restricted message');
    assert.ok(!env.net.some((n) => n.url.includes('googleusercontent')), 'restricted job never fetched its image');
    await expandOtherWays(panel.page);
    assert.ok(await isVisible(panel.page, 'manual-input'));
    assert.deepEqual(panel.errors.slice(errorsBefore), [], 'no uncaught panel errors');
    await cv.close();
  });

  test('J9 keyboard-only manual entry: PSA 12345678 and 13-digit CGC → URLs; invalid input → inline aria-live error', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    await page.bringToFront();
    await page.evaluate(() => document.activeElement?.blur());
    // Keyboard only: unfold "Other ways to scan" (it folds away after each result) before reaching the field.
    const toManual = async () => {
      if (await page.locator(tid('other-ways-toggle')).getAttribute('aria-expanded') === 'false') {
        await tabTo(page, 'other-ways-toggle');
        await page.keyboard.press('Enter');
      }
      await tabTo(page, 'manual-input');
    };
    await toManual();
    let beforeTabs = await E.graderTabs(env);
    await page.keyboard.type('PSA 12345678');
    await page.keyboard.press('Enter');
    await E.poll(async () => (await newGraderTabsSince(beforeTabs)).length === 1, { message: 'manual PSA tab' });
    assert.equal((await newGraderTabsSince(beforeTabs))[0].url, 'https://www.psacard.com/cert/12345678');
    await E.poll(async () => (await page.evaluate(() => document.body.dataset.state)) === 'opened', { message: 'state opened' });

    beforeTabs = await E.graderTabs(env);
    await toManual();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1401234567890');
    await page.keyboard.press('Enter');
    await E.poll(async () => (await newGraderTabsSince(beforeTabs)).length === 1, { message: 'manual CGC cards tab' });
    assert.equal((await newGraderTabsSince(beforeTabs))[0].url, 'https://www.cgccards.com/certlookup/1401234567890/');

    beforeTabs = await E.graderTabs(env);
    await toManual();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await E.poll(async () => (await page.locator(tid('manual-error')).textContent()).trim().length > 0, { message: 'manual error text' });
    const a11y = await page.evaluate(() => {
      const input = document.querySelector('[data-testid="manual-input"]');
      const err = document.querySelector('[data-testid="manual-error"]');
      const live = err.closest('[aria-live]')?.getAttribute('aria-live') ?? err.getAttribute('role');
      return {
        invalid: input.getAttribute('aria-invalid'),
        describedBy: (input.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(err.id),
        live,
        focused: document.activeElement === input,
      };
    });
    assert.equal(a11y.invalid, 'true', 'aria-invalid on the field');
    assert.ok(a11y.describedBy, 'error linked with aria-describedby');
    assert.ok(['polite', 'assertive', 'alert', 'status'].includes(a11y.live), 'error is announced (live region)');
    assert.ok(a11y.focused, 'focus stays in the field');
    await E.sleep(500);
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0, 'invalid input opens nothing');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
  });

  test('J10 upload, paste and drop work offline; bad files show an error', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    await env.context.setOffline(true);
    try {
      assert.equal(await page.evaluate(() => navigator.onLine), false, 'panel sees the browser offline');
      const a = await upload(FIX('psa-9digit.png'));
      assert.equal(a.result.number, '108114622');
      assert.ok(['auto-open', 'confirm'].includes(a.result.state));
      if (a.result.state === 'auto-open') assert.deepEqual(a.opened.map((t) => t.url), ['https://www.psacard.com/cert/108114622']);
      await E.closeGraderTabs(env);
      const p = await pasteImage(page, await readFile(FIX('cgc-comic-10digit.png')));
      assert.equal(p.number, '4012345001', 'paste → same pipeline');
      await E.closeGraderTabs(env);
      const d = await dropImage(page, await readFile(FIX('cgc-card-13digit.png')));
      assert.equal(d.number, '1401036622258', 'drop → same pipeline');
      await E.closeGraderTabs(env);
    } finally {
      await env.context.setOffline(false);
    }
    const bad = await upload({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') });
    assert.equal(bad.result.state, 'error');
    assert.ok(bad.result.error.length > 0);
    const tiny = await upload({ name: 'tiny.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
    assert.equal(tiny.result.state, 'error', '1x1 image rejected');
  });

  test('two quick jobs: the first is cancelled, only the second result is shown and opened', T, async () => {
    await E.closeGraderTabs(env);
    const beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(panel.page);
    await E.writeJob(env, { windowId: galleryTab.windowId, tabId: galleryTab.id, srcUrl: `${servers.A}/psa-8digit-leading-zero.png`, pageUrl: galleryTab.url });
    await E.sleep(60);
    await E.writeJob(env, { windowId: galleryTab.windowId, tabId: galleryTab.id, srcUrl: `${servers.A}/cgc-comic-10digit.png`, pageUrl: galleryTab.url });
    const result = await E.waitForScanEnd(panel.page, mark);
    await E.sleep(4000);
    const opened = await newGraderTabsSince(beforeTabs);
    assert.equal(result.number, '4012345001');
    assert.deepEqual(opened.map((t) => t.url), ['https://www.cgccomics.com/certlookup/4012345001/'], 'only the second job opened');
    assert.equal(await panel.page.evaluate(() => document.body.dataset.state), 'auto-open');
  });

  test('panel reload: a consumed job never re-runs (after completion and mid-scan)', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    await runJob({ srcUrl: `${servers.A}/psa-9digit.png` });
    let beforeTabs = await E.graderTabs(env);
    await E.reloadPanel(page);
    await E.sleep(3000);
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0, 'no re-run after reload');
    assert.ok(!(await E.stateLog(page)).includes('scanning'), 'no scan started after reload');
    const restored = await E.readResult(page);
    console.log(`# panel reload after completion: state ${restored.state} number ${restored.number} (A5 last-result restore is a should)`);

    await E.closeGraderTabs(env);
    beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(page);
    await E.writeJob(env, { windowId: galleryTab.windowId, tabId: galleryTab.id, srcUrl: `${servers.A}/cgc-card-13digit.png`, pageUrl: galleryTab.url });
    await page.waitForFunction((m) => window.__cs.log.slice(m).some((e) => e.state === 'scanning'), mark, { polling: 10, timeout: 15000 });
    assert.equal(await E.sessionGet(env, `scanJob:${galleryTab.windowId}`), null, 'job removed as soon as it is taken');
    await E.reloadPanel(page);
    await E.sleep(5000);
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0, 'mid-scan reload: no re-run, nothing opened');
    assert.ok(!(await E.stateLog(page)).includes('scanning'), 'mid-scan reload: no scan after reload');
    assert.notEqual(await page.evaluate(() => document.body.dataset.state), 'scanning');
  });

  test('job contract: stale, wrong-window, wrong-version and malformed jobs are ignored and cleared; other windows untouched', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    const key = `scanJob:${galleryTab.windowId}`;
    const base = { windowId: galleryTab.windowId, tabId: galleryTab.id, srcUrl: `${servers.A}/psa-8digit-leading-zero.png`, pageUrl: galleryTab.url };
    const mark = await E.logMark(page);
    const beforeTabs = await E.graderTabs(env);
    for (const variant of [
      { ...base, ageMs: 10 * 60_000 },
      { ...base, overrides: { windowId: galleryTab.windowId + 1 } },
      { ...base, overrides: { v: 2 } },
      { ...base, overrides: { srcUrl: 'javascript:alert(1)' } },
      { ...base, overrides: { tabId: -1 } },
    ]) {
      await E.writeJob(env, variant);
      await E.poll(async () => (await E.sessionGet(env, key)) === null, { message: 'invalid job cleared', timeout: 5000 });
    }
    await env.sw.evaluate((k) => chrome.storage.session.set({ [k]: 'garbage' }), key);
    await E.poll(async () => (await E.sessionGet(env, key)) === null, { message: 'garbage cleared', timeout: 5000 });
    await E.sleep(1000);
    assert.ok(!(await E.stateLog(page, mark)).includes('scanning'), 'no scan started for invalid jobs');
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0);

    // A job for another window is not consumed by this panel; windows.onRemoved clears it.
    const other = await env.sw.evaluate(async () => (await chrome.windows.create({ url: 'about:blank', focused: false })).id);
    await E.writeJob(env, { ...base, windowId: other });
    await E.sleep(1500);
    assert.ok(await E.sessionGet(env, `scanJob:${other}`), 'other window job left alone');
    assert.ok(!(await E.stateLog(page, mark)).includes('scanning'));
    await env.sw.evaluate((w) => chrome.windows.remove(w), other);
    await E.poll(async () => (await E.sessionGet(env, `scanJob:${other}`)) === null, { message: 'onRemoved cleanup', timeout: 5000 });
  });

  test('settings and history persist across panel reload; "always ask" (autoOpen off) never auto-opens; background open', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    const historyCount = () => page.locator(`${tid('history-list')} > li`).count();
    assert.ok((await historyCount()) >= 1, 'history list shows earlier opens');
    const before = await historyCount();
    await setSetting(page, 'autoOpen', false);
    await E.poll(async () => (await storageGet(page, 'sync', 'settings'))?.autoOpen === false, { message: 'settings saved to storage.sync' });
    await E.reloadPanel(page);
    assert.equal(await getSetting(page, 'autoOpen'), false, 'autoOpen off survives reload');
    assert.equal(await historyCount(), before, 'history survives reload');
    const a = await upload(FIX('psa-8digit-leading-zero.png'));
    assert.equal(a.result.state, 'confirm', 'always ask → confirm');
    assert.equal(a.opened.length, 0, 'no automatic tab');

    await setSetting(page, 'autoOpen', true);
    await setSetting(page, 'openInBackground', true);
    const b = await upload(FIX('psa-8digit-leading-zero.png'));
    assert.equal(b.result.state, 'auto-open');
    assert.equal(b.opened.length, 1);
    assert.equal(b.opened[0].active, false, 'opened in the background');
    await setSetting(page, 'openInBackground', false);
    await E.reloadPanel(page);
    assert.equal(await getSetting(page, 'autoOpen'), true);
    assert.equal(await getSetting(page, 'openInBackground'), false);
    const stored = await storageGet(page, 'sync', 'settings');
    assert.deepEqual({ autoOpen: stored.autoOpen, openInBackground: stored.openInBackground, saveHistory: stored.saveHistory }, { autoOpen: true, openInBackground: false, saveHistory: true });
  });

  test('service worker stopped: restarts on the next event with its listeners; menu intact; hand-off works', T, async () => {
    await E.closeGraderTabs(env);
    const cdp = await env.context.newCDPSession(galleryPage);
    const status = [];
    cdp.on('ServiceWorker.workerVersionUpdated', (e) => {
      for (const v of e.versions) if (v.scriptURL.startsWith(`chrome-extension://${env.extensionId}/`)) status.push(v.runningStatus);
    });
    await cdp.send('ServiceWorker.enable');
    // A9 startup path: with scanOnToolbarClick off the behaviour is true; a stale false must be corrected by the
    // restarted worker's top-level applyPanelBehavior().
    await setSetting(panel.page, 'scanOnToolbarClick', false);
    await E.poll(async () => (await env.sw.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)) === true,
      { message: 'behaviour true with scanOnToolbarClick off' });
    await cdp.send('ServiceWorker.stopAllWorkers');
    await E.poll(() => status.at(-1) === 'stopped', { message: 'extension service worker stopped', timeout: 10000 });
    // Playwright does not surface the restarted worker: drive chrome.* from the panel (also a trusted context).
    env.setDriver(panel.page);
    await panel.page.evaluate(() => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }));
    assert.equal(await panel.page.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick), false, 'stale behaviour forced while the worker is stopped');
    assert.equal(status.at(-1), 'stopped', 'worker still stopped after forcing the stale behaviour');
    // Wake the worker with an event it listens for: closing a window fires windows.onRemoved, whose listener
    // (registered at top level on restart) must clear that window's job slot.
    const tmp = await panel.page.evaluate(async () => (await chrome.windows.create({ url: 'about:blank', focused: false })).id);
    await E.writeJob(env, { windowId: tmp, tabId: galleryTab.id, srcUrl: `${servers.A}/psa-8digit-leading-zero.png`, pageUrl: galleryTab.url });
    assert.ok(await E.sessionGet(env, `scanJob:${tmp}`), 'job slot written while the worker is stopped');
    await panel.page.evaluate((w) => chrome.windows.remove(w), tmp);
    await E.poll(() => status.at(-1) === 'running', { message: 'service worker restarted', timeout: 10000 });
    await E.poll(async () => (await E.sessionGet(env, `scanJob:${tmp}`)) === null, { message: 'restarted worker cleared the closed window\'s job', timeout: 10000 });
    const menu = await panel.page.evaluate(async () => { try { await chrome.contextMenus.update('certscanner-scan', {}); return true; } catch { return false; } });
    assert.ok(menu, 'context menu still registered');
    const behaviour = () => panel.page.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick);
    await E.poll(async () => (await behaviour()) === true, { message: 'restarted worker re-applied the setting (toolbar only opens the panel)', timeout: 10000 });
    await setSetting(panel.page, 'scanOnToolbarClick', true);
    await E.poll(async () => (await behaviour()) === false, { message: 'A9 default restored: toolbar scans the page', timeout: 10000 });
    const { result, opened } = await runJob({ srcUrl: `${servers.A}/cgc-comic-10digit.png` });
    assert.equal(result.state, 'auto-open');
    assert.deepEqual(opened.map((t) => t.url), ['https://www.cgccomics.com/certlookup/4012345001/']);
    await cdp.detach();
  });

  test('history: Clear history empties storage and the list; saveHistory off stops writing', T, async () => {
    await E.closeGraderTabs(env);
    const page = panel.page;
    const count = () => page.locator(`${tid('history-list')} > li`).count();
    assert.ok((await count()) >= 1);
    await page.locator(tid('history-clear')).evaluate((el) => el.click());
    await E.poll(async () => (await count()) === 0, { message: 'history list cleared' });
    assert.equal((await storageGet(page, 'local', 'history'))?.entries?.length ?? 0, 0, 'storage.local history empty');
    await E.reloadPanel(page);
    assert.equal(await count(), 0);
    await setSetting(page, 'saveHistory', false);
    await E.poll(async () => (await storageGet(page, 'sync', 'settings'))?.saveHistory === false, { message: 'saveHistory off saved' });
    const r = await upload(FIX('psa-8digit-leading-zero.png'));
    assert.equal(r.result.state, 'auto-open');
    await E.sleep(500);
    assert.equal((await storageGet(page, 'local', 'history'))?.entries?.length ?? 0, 0, 'nothing written with saveHistory off');
    await setSetting(page, 'saveHistory', true);
  });

  test('hard check: every auto-open in this run opened exactly the expected official URL', () => {
    for (const a of autoOpens) {
      assert.equal(a.urls.length, 1, `one tab per auto-open (${a.srcUrl ?? a.file})`);
      assert.ok(E.isGraderUrl(a.urls[0]), `auto-open went to a grader host: ${a.urls[0]}`);
    }
    assert.ok(!env.net.some((n) => E.hostOf(n.url) === foreignHost), 'foreign QR host never requested');
    console.log(`# panel errors during the journeys run: ${panel.errors.length ? panel.errors.join(' | ') : 'none'}`);
    assert.deepEqual(panel.errors.filter((e) => e.startsWith('pageerror')), [], 'no uncaught panel errors during the run');
    assert.deepEqual(panel.errors.filter((e) => /Content Security Policy|unsafe-eval|Refused to/i.test(e)), [], 'no CSP violations (vendor eval fallbacks stay silent)');
  });
});

describe('J7b "Sharper scans" offer for an https image read at screen resolution (permission prompt stubbed)', { concurrency: false }, () => {
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

  test('offer names only the image host; declining keeps manual entry working; no permission without the user', T, async () => {
    // Host "localhost" (self-signed, same server): a CORS-less https image the extension may not fetch.
    const img = `${tls.origin.replace('127.0.0.1', 'localhost')}/ambiguous-10digit.png`;
    const page0 = env.context.pages()[0];
    await page0.goto(`${servers.A}/__e2e/page.html?img=${encodeURIComponent(img)}&w=400&id=img-https`);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 10000 });
    const tab = await E.findTab(env, `${servers.A}/__e2e/page.html`);
    const p = await E.openPanel(env, tab.windowId);
    assert.ok(await stubPermissions(p.page, { grant: false }), 'chrome.permissions stubbed in the panel realm');
    const mark = await E.logMark(p.page);
    await E.writeJob(env, { windowId: tab.windowId, tabId: tab.id, srcUrl: img, pageUrl: tab.url });
    const r = await E.waitForScanEnd(p.page, mark);
    console.log(`# J7b capture of an https image: state ${r.state} number ${r.number} sharper=${r.sharperVisible} "${r.sharperText}"`);
    assert.ok(['confirm', 'none'].includes(r.state), `state ${r.state}`);
    assert.equal(r.sharperVisible, true, 'Sharper scans offered');
    assert.ok(r.sharperText.includes('localhost') && !r.sharperText.includes('127.0.0.1'), `offer names only the image host: "${r.sharperText}"`);
    await p.page.locator(tid('sharper-button')).click();
    await E.poll(() => p.page.evaluate(() => window.__perm.requests === 1), { message: 'permission requested' });
    assert.deepEqual(await p.page.evaluate(() => window.__perm.origins), [['https://localhost/*']], 'request scoped to the one image host');
    await E.sleep(800);
    assert.equal(await isVisible(p.page, 'sharper-button'), false, 'offer withdrawn after decline');
    assert.equal(await env.sw.evaluate(() => chrome.permissions.contains({ origins: ['https://localhost/*'] })), true,
      'informational: the e2e build holds <all_urls>; the stub decides what the panel sees');
    if (await p.page.locator('#other-ways').isHidden()) {
      // Confirm state: the task card itself holds the number form (design: "Other ways to scan" is hidden there).
      await p.page.locator(tid('number-input')).fill('01234567');
      await p.page.locator(`${tid('grader-select')} label:has(input[value="psa"])`).click();
      await p.page.locator(tid('open-button')).click();
    } else {
      await expandOtherWays(p.page);
      await p.page.locator(tid('manual-input')).fill('PSA 01234567');
      await p.page.locator(tid('manual-submit')).click();
    }
    await E.poll(async () => (await E.graderTabs(env)).some((t) => t.url === 'https://www.psacard.com/cert/01234567'), { message: 'manual entry after decline' });
    assert.deepEqual(p.errors.filter((e) => e.startsWith('pageerror')), []);
  });
});
