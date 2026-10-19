// A9 page scan end-to-end (ADR-001 A9; docs/implementation/frontend-handoff.md "S7 page scan") on the real extension.
//
// What is real and what is simulated:
// - The toolbar icon (action.onClicked) and the Alt+Shift+S command grant activeTab and call sidePanel.open() inside a
//   user gesture. Automation cannot produce either. Page jobs are therefore written to chrome.storage.session
//   `scanJob:<windowId>` from the extension's own service worker in the exact shape of sw.js createPageJob(), and
//   dist-e2e's host_permissions <all_urls> stands in for the activeTab grant. Real icon/shortcut use is manual (PS1/PS2).
// - The panel's own "Scan this page" button (trigger 3) is a real click on the real panel.
// - Discovery, acquisition, OCR, aggregation, routing, tab opening, history and the UI are the shipped code.
// Hard checks: no wrong auto-open; listing page-text numbers never open; evil.example (off-site QR) never requested.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { isVisible, readPage, stubPermissions, tid } from './lib/panel.mjs';

const T = { timeout: 180_000 };
const manifest = JSON.parse(readFileSync(path.join(E.FIXTURES, 'manifest.json'), 'utf8'));
const listing = manifest.pages.find((p) => p.kind === 'single-slab-listing');
const fixtureByFile = new Map(manifest.fixtures.map((f) => [f.file, f]));
const FOREIGN_HOST = 'evil.example';
const FOREIGN_QR_DIGITS = '12345678'; // qr-foreign-host.png: off-site QR digits; may be listed (with a warning) or not
// A9 discovery thresholds (ADR-001 A9), used only by the diagnostic discovery call below.
const A9_PROBE_OPTS = { minRendered: 120, minNatural: 150, max: 24 };
const PAGE_SCAN_IMAGES = 8; // A9 budget: up to 8 images, visible first

function messages(dist, lang) {
  return JSON.parse(readFileSync(path.join(dist, '_locales', lang, 'messages.json'), 'utf8'));
}

/** chrome.i18n-style substitution of named placeholders ($NAME$ -> content "$1" -> subs[0]). */
function msg(m, key, subs = []) {
  const e = m[key];
  if (!e) throw new Error(`missing message ${key}`);
  let s = e.message;
  for (const [name, ph] of Object.entries(e.placeholders ?? {})) {
    const v = ph.content.replace(/\$(\d)/g, (_, d) => subs[Number(d) - 1] ?? '');
    s = s.replace(new RegExp(`\\$${name}\\$`, 'gi'), v);
  }
  return s;
}

const displayUrl = (u) => { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname}`; };

/** Gallery image URL → fixture file (data: is psa-lowres.jpg, blob: is cgc-comic-qr.png, see manifest.pages). */
function fixtureOf(srcUrl) {
  if (srcUrl.startsWith('data:')) return 'psa-lowres.jpg';
  if (srcUrl.startsWith('blob:')) return 'cgc-comic-qr.png';
  try { return decodeURIComponent(new URL(srcUrl).pathname.split('/').pop()); } catch { return null; }
}

/** Diagnostic: run the extension's own discovery probe in the tab from the panel realm (same call as scanPage). */
async function discover(panelPage, tabId) {
  return panelPage.evaluate(async ({ tabId, opts }) => {
    const { pageImagesProbe } = await import(chrome.runtime.getURL('pipeline/pageImagesProbe.js'));
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: pageImagesProbe, args: [opts] });
    return r.result;
  }, { tabId, opts: A9_PROBE_OPTS });
}

/** Diagnostic: scanPage() in the panel realm (same module instance and engines as the UI); it never opens tabs itself. */
async function scanPageDirect(panelPage, job) {
  return panelPage.evaluate(async (job) => {
    const { scanPage } = await import(chrome.runtime.getURL('pipeline/pageScan.js'));
    const r = await scanPage(job, { settings: { v: 1, autoOpen: true, openInBackground: false, saveHistory: false, scanOnToolbarClick: true } });
    return JSON.parse(JSON.stringify({
      status: r.status, discovered: r.discovered, images: r.images, timings: r.timings, partial: r.partial,
      items: r.items.map((i) => ({ number: i.number, grader: i.grader, confidence: i.confidence, source: i.source, imageIndex: i.imageIndex, seenIn: i.seenIn })),
    }));
  }, job);
}

describe('A9 page scan on dist-e2e (page jobs shaped like sw.js createPageJob; <all_urls> stands in for activeTab)', { concurrency: false }, () => {
  let servers;
  let env;
  let en;
  let tabPage;
  let tab;
  let panel;
  let panelWindow;
  const autoOpens = [];

  async function show(url) {
    await tabPage.goto(url);
    await tabPage.waitForSelector('html[data-ready]', { state: 'attached', timeout: 15000 });
    tab = await E.findTab(env, url);
    await env.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), tab.id);
    return tab;
  }

  async function newGraderTabsSince(beforeTabs) {
    const ids = new Set(beforeTabs.map((t) => t.id));
    return (await E.graderTabs(env)).filter((t) => !ids.has(t.id));
  }

  const historyEntries = async () => (await env.sw.evaluate(async () => (await chrome.storage.local.get('history')).history ?? null))?.entries ?? [];

  /** Write one page job for the panel's window and wait for the page scan to settle. */
  async function runPage({ target = tab, pageUrl = target.url, source = 'action', settle = 1500, overrides = {}, expectUrl = listing.expected.default.url } = {}) {
    const beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(panel.page);
    const t0 = Date.now();
    const job = await E.writePageJob(env, { windowId: panelWindow, tabId: target.id, pageUrl, source, overrides });
    await E.waitForScanEnd(panel.page, mark, { timeout: 60000 });
    const uiMs = Date.now() - t0;
    await E.sleep(settle);
    const view = await readPage(panel.page);
    const opened = await newGraderTabsSince(beforeTabs);
    if (view.body === 'auto-open') autoOpens.push({ page: pageUrl, urls: opened.map((t) => t.url), expect: expectUrl });
    return { job, view, opened, uiMs, states: await E.stateLog(panel.page, mark) };
  }

  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    env = await E.launchExtension();
    en = messages(E.DIST_E2E, 'en');
    tabPage = env.context.pages()[0] ?? await env.context.newPage();
    await show(`${servers.A}/pages/gallery.html`);
    panelWindow = tab.windowId;
    panel = await E.openPanel(env, panelWindow);
  });

  after(async () => {
    await env?.close();
    await servers?.close();
  });

  test('P1 gallery: page job (toolbar trigger) → page-results with the number of every scanned photo; no auto-open, no tab; evil.example never requested', T, async () => {
    await E.closeGraderTabs(env);
    const disc = await discover(panel.page, tab.id);
    const scanned = disc.images.slice(0, PAGE_SCAN_IMAGES);
    const fully = disc.images.filter((i) => i.visibleFraction >= 0.9);
    console.log(`# P1 discovery: viewport ${disc.viewport.width}x${disc.viewport.height} dpr ${disc.dpr}; ${disc.images.length} slab-sized images; scanned (first ${PAGE_SCAN_IMAGES}): ${scanned.map((i) => `${fixtureOf(i.srcUrl)}@${i.visibleFraction.toFixed(2)}`).join(', ')}`);
    assert.ok(fully.length <= PAGE_SCAN_IMAGES && fully.every((i) => scanned.includes(i)), 'A9: (nearly) fully visible photos are scanned first');
    assert.ok(!disc.images.some((i) => fixtureOf(i.srcUrl) === 'cgc-comic-10digit.png'), 'lazy image below the fold (not loaded) is not discovered');

    const expected = new Map(); // number → grader (null = unresolved)
    for (const im of scanned) {
      const f = fixtureByFile.get(fixtureOf(im.srcUrl));
      if (f?.expected?.number) expected.set(f.expected.number, f.expected.grader);
    }
    // Rows may only carry numbers printed on the scanned photos (plus the off-site QR digits, read as PSA length).
    const known = new Map([...expected, [FOREIGN_QR_DIGITS, 'psa']]);
    const historyBefore = (await historyEntries()).length;

    const r = await runPage({ settle: 2000 });
    console.log(`# P1 gallery: ${r.view.body} in ${r.uiMs} ms (first scan in a fresh panel); rows: ${r.view.rows.map((x) => `${x.grader ?? '?'}:${x.number}${x.note ? ' [note]' : ''}`).join(', ')}`);
    assert.equal(r.view.body, 'page-results');
    assert.equal(r.view.task, 'page-results');
    assert.equal(r.view.heading, msg(en, 'page_results_heading'));
    assert.ok(r.view.listVisible, 'page-result-list visible');
    assert.ok(!r.states.includes('auto-open'), 'several numbers on the page: never auto-open');
    assert.equal(r.opened.length, 0, 'no tab opened');
    const numbers = r.view.rows.map((x) => x.number);
    assert.equal(new Set(numbers).size, numbers.length, 'one row per distinct number');
    for (const [n] of expected) assert.ok(numbers.includes(n), `number ${n} of a scanned photo is listed`);
    for (const row of r.view.rows) {
      assert.ok(known.has(row.number), `row ${row.number} comes from a gallery photo (no stray/wrong number)`);
      const g = known.get(row.number);
      if (row.grader) {
        assert.equal(row.grader, g, `${row.number}: grader ${row.grader} (expected ${g})`);
        assert.ok(row.open && !row.choose, `${row.number}: Open offered`);
        assert.equal(row.path, displayUrl(E.CERT_URL[row.grader](row.number)), `${row.number}: exact official path shown`);
      } else {
        assert.ok(row.choose && !row.open, `${row.number}: grader unknown → "Choose grader", no Open`);
      }
      assert.ok(row.thumb, `${row.number}: row thumbnail`);
      assert.ok(row.copy, `${row.number}: Copy offered`);
    }
    const amb = r.view.rows.find((x) => x.number === '5012345678');
    if (expected.has('5012345678')) assert.equal(amb?.grader ?? null, null, 'ambiguous 10 digits: no grader guessed');
    const qrRow = r.view.rows.find((x) => x.number === FOREIGN_QR_DIGITS);
    if (qrRow) {
      assert.ok(qrRow.note.includes(FOREIGN_HOST) && qrRow.noteTone === 'warning', 'off-site QR row carries the warning');
    }
    assert.equal(r.view.summary[0], msg(en, 'page_results_summary', [String(r.view.rows.length)]));
    // O10: more slab-sized photos than the 8-photo budget → "Checked 8 of <total> photos." (total = the probe's `total`).
    const total = disc.total;
    console.log(`# P1 O10 summary: ${JSON.stringify(r.view.summary)} (probe total ${total}, images returned ${disc.images.length})`);
    assert.ok(Number.isInteger(total) && total > PAGE_SCAN_IMAGES, `the gallery has more slab-sized photos (${total}) than the ${PAGE_SCAN_IMAGES}-photo budget`);
    assert.equal(r.view.summary.length, 2, 'count line + coverage line');
    assert.equal(r.view.summary[1], msg(en, 'page_results_capped', [String(PAGE_SCAN_IMAGES), String(total)]), 'O10 "Checked 8 of N photos." line');
    // Perf 5: row thumbnails are <= 240 px copies, not the full photos.
    const thumbs = await panel.page.evaluate(async () => Promise.all([...document.querySelectorAll('[data-testid="page-result-list"] [data-ref="thumb"]')]
      .filter((i) => i.getAttribute('src')).map(async (i) => { await i.decode().catch(() => {}); return { w: i.naturalWidth, h: i.naturalHeight, blob: i.src.startsWith('blob:') }; })));
    console.log(`# P1 row thumbnails: ${thumbs.map((t) => `${t.w}x${t.h}`).join(', ')}`);
    assert.equal(thumbs.length, r.view.rows.length, 'one thumbnail per row');
    for (const t of thumbs) assert.ok(t.blob && t.w > 0 && Math.max(t.w, t.h) <= 240, `row thumbnail ${t.w}x${t.h} is a <= 240 px blob copy`);
    assert.equal(await E.sessionGet(env, `scanJob:${panelWindow}`), null, 'job slot consumed');
    assert.equal((await historyEntries()).length, historyBefore, 'a results list writes no history');
    const tabs = await E.allTabs(env);
    assert.ok(!tabs.some((t) => E.hostOf(t.url) === FOREIGN_HOST || E.hostOf(t.pendingUrl ?? '') === FOREIGN_HOST), 'evil.example never navigated');
    assert.ok(!env.net.some((n) => E.hostOf(n.url) === FOREIGN_HOST), 'evil.example never requested');
  });

  test('P1b diagnostic: per-image acquisition method and timings of a warm gallery page scan (scanPage in the panel realm)', T, async () => {
    const job = { v: 1, id: crypto.randomUUID(), createdAt: Date.now(), kind: 'page', source: 'action', srcUrl: null,
      pageUrl: E.minimizePageUrl(tab.url), frameId: 0, tabId: tab.id, windowId: panelWindow };
    const t0 = Date.now();
    const r = await scanPageDirect(panel.page, job);
    console.log(`# P1b warm scanPage: status ${r.status}, discovered ${r.discovered}, discover ${r.timings.discoverMs} ms, capture ${r.timings.captureMs} ms, total ${r.timings.totalMs} ms (wall ${Date.now() - t0} ms)`);
    for (const im of r.images) console.log(`#   img ${im.index}: ok=${im.ok} method=${im.method ?? '-'} resolution=${im.resolution ?? '-'} candidates=${im.candidates ?? 0} acquire=${im.acquireMs} ms scan=${im.scanMs ?? '-'} ms${im.reason ? ` reason=${im.reason}` : ''}`);
    console.log(`#   items: ${r.items.map((i) => `${i.grader ?? '?'}:${i.number}@${i.confidence} (${i.source}, img ${i.imageIndex})`).join(', ')}`);
    assert.equal(r.status, 'page-results');
    assert.equal(r.images.length, Math.min(PAGE_SCAN_IMAGES, r.discovered));
    assert.ok(r.images.every((i) => i.ok), 'every selected photo was acquired and scanned');
    assert.ok(r.timings.totalMs < 30_000, 'within the 30 s page budget');
    assert.equal(r.partial, null);
  });

  test('P2 listing: one slab photo → auto-open psacard.com/cert/108114622 exactly once next to the listing; small images ignored; re-sent job id opens nothing', T, async () => {
    await E.closeGraderTabs(env);
    const exp = listing.expected.default;
    await show(`${servers.A}/${listing.page}`);
    const disc = await discover(panel.page, tab.id);
    assert.deepEqual(disc.images.map((i) => fixtureOf(i.srcUrl)).sort(), ['non-slab.png', 'psa-9digit.png'],
      'logo, avatar, banner and 64 px thumbnails are below the A9 size threshold');
    const historyBefore = (await historyEntries()).length;

    const r = await runPage({ settle: 1500 });
    console.log(`# P2 listing: ${r.view.body} in ${r.uiMs} ms; opened ${r.opened.map((t) => t.url).join(', ')}`);
    assert.equal(r.view.body, exp.status);
    assert.equal(r.opened.length, exp.tabsOpened, 'exactly one tab');
    const [t] = r.opened;
    assert.equal(t.url, exp.url);
    assert.equal(t.windowId, tab.windowId);
    assert.equal(t.openerTabId, tab.id, 'opened with the listing tab as opener');
    assert.equal(t.index, tab.index + 1, 'opened right after the listing tab');
    const res = await E.readResult(panel.page);
    assert.equal(res.number, exp.number);
    assert.equal(res.resultUrl, displayUrl(exp.url), 'S2 shows the exact official path');
    const hist = await historyEntries();
    assert.equal(hist.length, historyBefore + 1, 'history +1');
    assert.deepEqual({ grader: hist[0].grader, number: hist[0].number }, { grader: exp.grader, number: exp.number });
    assert.ok(!JSON.stringify(hist).includes('127.0.0.1') && !JSON.stringify(hist).includes('listing'), 'history holds no page or image URL');
    const shown = await panel.page.evaluate(() => document.getElementById('task').innerText);
    for (const n of listing.mustNeverAutoOpenNumbers) assert.ok(!shown.includes(n), `page-text number ${n} never shown (page text is not read)`);

    // Re-deliver the identical job id: consumed once, so no scan and no second tab (SEC-06 for page jobs).
    const mark = await E.logMark(panel.page);
    await E.writePageJob(env, { windowId: panelWindow, tabId: tab.id, pageUrl: tab.url, overrides: { id: r.job.id } });
    await E.poll(async () => (await E.sessionGet(env, `scanJob:${panelWindow}`)) === null, { message: 're-sent job cleared', timeout: 5000 });
    await E.sleep(4000);
    assert.ok(!(await E.stateLog(panel.page, mark)).includes('scanning'), 're-sent job id starts no scan');
    assert.equal((await E.graderTabs(env)).filter((x) => x.url === exp.url).length, 1, 'still exactly one tab');
  });

  test('P3 price, item number and seller ID on the listing never become an auto-open (page text unread; printed in an image)', T, async () => {
    for (const variant of ['details=1', 'slab=0&details=1']) {
      await E.closeGraderTabs(env);
      const exp = listing.expected[variant];
      await show(`${servers.A}/${listing.page}?${variant}`);
      const disc = await discover(panel.page, tab.id);
      assert.deepEqual(disc.images.map((i) => fixtureOf(i.srcUrl)).sort(),
        exp.discovered.map((id) => listing.images.find((i) => i.elementId === id).src.split('/').pop()).sort(), `${variant}: discovered images`);
      const r = await runPage({ settle: 2500 });
      const urls = r.opened.map((x) => x.url);
      console.log(`# P3 listing?${variant}: ${r.view.body} in ${r.uiMs} ms; rows ${r.view.rows.map((x) => `${x.grader ?? '?'}:${x.number}${x.note ? ' [note]' : ''}`).join(', ') || '-'}; opened ${urls.join(', ') || 'nothing'}`);
      assert.ok(exp.accept.includes(r.view.body), `${variant}: state ${r.view.body} in ${exp.accept}`);
      if (exp.mustNotAutoOpen) assert.deepEqual(urls, [], `${variant}: nothing opened`);
      else assert.ok(urls.length <= 1 && urls.every((u) => u === exp.onlyAutoOpenUrl), `${variant}: only the slab's cert may open`);
      for (const n of listing.mustNeverAutoOpenNumbers) assert.ok(!urls.some((u) => u.includes(n)), `${variant}: ${n} never opened`);
      for (const row of r.view.rows.filter((x) => listing.mustNeverAutoOpenNumbers.includes(x.number))) {
        assert.ok(row.note || !row.grader, `${variant}: listed non-cert number ${row.number} is flagged as unclear or has no grader`);
      }
      // Diagnostic: confidences behind the rows (same pipeline, panel realm; opens nothing).
      const d = await scanPageDirect(panel.page, { ...r.job, id: crypto.randomUUID(), createdAt: Date.now() });
      console.log(`#   ${variant} pipeline: ${d.status}; ${d.items.map((i) => `${i.grader ?? '?'}:${i.number}@${i.confidence} (${i.source}, img ${i.imageIndex})`).join(', ')}`);
      for (const i of d.items.filter((x) => listing.mustNeverAutoOpenNumbers.includes(x.number))) assert.ok(i.confidence < 0.8, `${i.number} below the auto-open threshold`);
    }
  });

  test('P4 nothing found: photos checked → "No cert numbers found" with tips; no slab-sized photo → other reason; no tab, no history', T, async () => {
    await E.closeGraderTabs(env);
    const historyBefore = (await historyEntries()).length;
    await show(`${servers.A}/${listing.page}?slab=0`);
    const a = await runPage({ settle: 800 });
    console.log(`# P4 listing?slab=0: ${a.view.body} in ${a.uiMs} ms; reason "${a.view.noneReason}"`);
    assert.equal(a.view.body, 'none');
    assert.equal(a.view.task, 'none');
    assert.equal(a.view.heading, msg(en, 'page_none_heading'));
    assert.equal(a.view.noneReason, msg(en, 'page_none_checked'));
    assert.equal(a.view.tips.length, 3, 'three tips (open the photo, right-click, upload)');
    assert.ok(a.view.tips.every((x) => x.length > 10));
    assert.equal(a.view.tips[1], msg(en, 'page_tip_right_click', [msg(en, 'context_menu_scan')]));
    assert.ok(a.view.actions.includes('page-scan') && a.view.actions.includes('choose'), 'Scan again + Choose image offered');
    assert.equal(a.opened.length, 0);

    await show(`${servers.A}/${listing.page}?photos=0`);
    const b = await runPage({ settle: 500 });
    console.log(`# P4 listing?photos=0: ${b.view.body} in ${b.uiMs} ms; reason "${b.view.noneReason}"`);
    assert.equal(b.view.body, 'none');
    assert.equal(b.view.noneReason, msg(en, 'page_none_no_images'));
    assert.equal(b.view.tips.length, 3);
    assert.equal(b.opened.length, 0);
    assert.equal((await historyEntries()).length, historyBefore, 'nothing added to history');
  });

  test('P5 restricted: panel button on chrome://version, page jobs with a hidden URL, chrome:// and the Web Store → E1, no fetch, no uncaught errors', T, async () => {
    await E.closeGraderTabs(env);
    const errorsBefore = panel.errors.length;
    const idsBefore = new Set((await E.allTabs(env)).map((t) => t.id));
    const cv = await env.context.newPage();
    await cv.goto('chrome://version');
    const cvTab = await E.poll(async () => (await E.allTabs(env)).find((t) => !idsBefore.has(t.id)), { message: 'chrome://version tab' });
    if (cvTab.windowId !== panelWindow) await env.sw.evaluate((a) => chrome.tabs.move(a.id, { windowId: a.w, index: -1 }), { id: cvTab.id, w: panelWindow });
    await env.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), cvTab.id);
    const errorBody = msg(en, 'err_restricted_page_body');
    const expectE1 = (v, label) => {
      assert.equal(v.body, 'error', `${label}: error state`);
      assert.equal(v.errorCode, 'restricted', `${label}: restricted`);
      assert.equal(v.heading, msg(en, 'err_restricted_heading'), `${label}: heading`);
      assert.equal(v.error, errorBody, `${label}: page-scan body copy`);
      assert.ok(v.actions.includes('page-scan') && v.actions.includes('choose'), `${label}: Scan this page + Choose image`);
    };

    // a) Panel button (real click) while chrome://version is the active tab: tab URL hidden → no-op probe refused → E1.
    assert.ok(await isVisible(panel.page, 'page-scan-button') || (await readPage(panel.page)).actions.includes('page-scan'), 'a Scan-this-page button is shown');
    const mark = await E.logMark(panel.page);
    const btn = (await isVisible(panel.page, 'page-scan-button')) ? panel.page.locator(tid('page-scan-button')) : panel.page.locator('#task [data-action="page-scan"]').first();
    await btn.click();
    await panel.page.waitForFunction((m) => window.__cs.log.slice(m).some((e) => e.state === 'error'), mark, { timeout: 15000 });
    const a = await readPage(panel.page);
    expectE1(a, 'panel button');
    assert.ok(!(await E.stateLog(panel.page, mark)).includes('scanning'), 'panel button on a restricted page starts no scan');

    // b) Page job for a tab whose URL Chrome hides (pageUrl ''), c) chrome://version/, d) Web Store URL.
    for (const [label, target, pageUrl] of [['hidden URL', cvTab, ''], ['chrome://version/', cvTab, 'chrome://version/'], ['Chrome Web Store', tab, 'https://chromewebstore.google.com/detail/abc']]) {
      const r = await runPage({ target, pageUrl, settle: 300 });
      console.log(`# P5 ${label}: ${r.view.body}/${r.view.errorCode} in ${r.uiMs} ms`);
      expectE1(r.view, label);
      assert.equal(r.opened.length, 0);
    }
    assert.ok(!env.net.some((n) => n.url.includes('chromewebstore')), 'restricted page never requested');
    assert.deepEqual(panel.errors.slice(errorsBefore).filter((x) => x.startsWith('pageerror')), [], 'no uncaught panel errors');
    await cv.close();
    await env.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), tab.id);
  });

  test('P6 Cancel during "Scanning image 2 of N" settles within 1 s; focus on the heading; nothing opens later', T, async () => {
    await E.closeGraderTabs(env);
    await show(`${servers.A}/pages/gallery.html`);
    const beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(panel.page);
    await E.writePageJob(env, { windowId: panelWindow, tabId: tab.id, pageUrl: tab.url });
    const second = new RegExp(`^${msg(en, 'page_progress', ['2', '\u0000']).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\u0000', '\\d+')}$`);
    await panel.page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid="page-progress"]')?.textContent.trim() ?? ''),
      second.source, { timeout: 30000, polling: 20 });
    const progress = (await readPage(panel.page)).progress;
    const cancelMark = await E.logMark(panel.page);
    const t0 = Date.now();
    if (await isVisible(panel.page, 'cancel-button')) await panel.page.locator(tid('cancel-button')).click();
    else await panel.page.keyboard.press('Escape');
    await panel.page.waitForFunction((m) => window.__cs.log.slice(m).some((e) => e.state !== 'scanning'), cancelMark, { timeout: 30000, polling: 10 });
    const ms = Date.now() - t0;
    const v = await readPage(panel.page);
    console.log(`# P6 cancel at "${progress}": state ${v.body} after ${ms} ms (budget 1000 ms)`);
    assert.equal(v.body, 'idle');
    assert.ok(ms <= 1000, `Cancel settled after ${ms} ms`);
    assert.equal(v.status, msg(en, 'status_scan_cancelled'), 'cancel announced');
    assert.equal(v.focusId, 'task-heading', 'focus on the task heading');
    await E.sleep(3000);
    assert.deepEqual(await E.stateLog(panel.page, cancelMark), ['idle'], 'no late result after Cancel');
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0, 'nothing opened');
    assert.ok((await E.stateLog(panel.page, mark)).includes('scanning'));
  });

  test('P7 panel "Scan this page" with access scans; Open from a row marks it Opened and keeps the list; Choose grader → confirm → back; reload does not restore the list', T, async () => {
    await E.closeGraderTabs(env);
    assert.equal((await readPage(panel.page)).body, 'idle');
    assert.ok(await isVisible(panel.page, 'page-scan-button'), 'idle shows the Scan this page button');
    const mark = await E.logMark(panel.page);
    const t0 = Date.now();
    await panel.page.locator(tid('page-scan-button')).click();
    await E.waitForScanEnd(panel.page, mark, { timeout: 60000 });
    const v = await readPage(panel.page);
    console.log(`# P7 panel button: ${v.body} in ${Date.now() - t0} ms; ${v.rows.length} rows`);
    assert.equal(v.body, 'page-results');
    assert.equal((await E.graderTabs(env)).length, 0, 'panel-triggered results list opens nothing by itself');

    const row = v.rows.find((x) => x.open);
    assert.ok(row, 'a row with a known grader');
    const beforeTabs = await E.graderTabs(env);
    await panel.page.locator(`${tid(`page-result-${row.i}`)} [data-ref="open"]`).click();
    await E.poll(async () => (await newGraderTabsSince(beforeTabs)).length === 1, { message: 'tab from a results row' });
    assert.equal((await newGraderTabsSince(beforeTabs))[0].url, E.CERT_URL[row.grader](row.number));
    await E.poll(async () => (await readPage(panel.page)).rows.find((x) => x.i === row.i)?.opened, { message: 'row marked Opened' });
    const after = await readPage(panel.page);
    assert.equal(after.body, 'page-results', 'list kept after opening');
    assert.deepEqual(after.rows.map((x) => x.number), v.rows.map((x) => x.number));

    const choose = v.rows.find((x) => x.choose);
    if (choose) {
      await panel.page.locator(`${tid(`page-result-${choose.i}`)} [data-ref="choose"]`).click();
      await E.poll(async () => (await readPage(panel.page)).body === 'confirm', { message: 'confirm for an unknown grader' });
      assert.ok(await isVisible(panel.page, 'grader-select'), 'grader choice shown');
      assert.equal((await E.readResult(panel.page)).number, choose.number);
      await panel.page.locator('#task [data-action="back-to-page"]').click();
      await E.poll(async () => (await readPage(panel.page)).body === 'page-results', { message: 'back to the results' });
      assert.deepEqual((await readPage(panel.page)).rows.map((x) => x.number), v.rows.map((x) => x.number));
    } else {
      console.log('# P7: no grader-unknown row in this run; Choose-grader path not exercised');
    }

    const beforeReload = await E.graderTabs(env);
    await E.reloadPanel(panel.page);
    await E.sleep(1500);
    const r = await readPage(panel.page);
    assert.equal(r.body, 'idle', 'results lists are not restored after reload (thumbnails are not stored)');
    assert.ok(!(await E.stateLog(panel.page)).includes('scanning'), 'reload starts no scan');
    assert.equal((await newGraderTabsSince(beforeReload)).length, 0);
  });

  test('P8 newest page job wins: a gallery scan superseded by a listing job → only the listing cert opens', T, async () => {
    await E.closeGraderTabs(env);
    await show(`${servers.A}/pages/gallery.html`);
    const galleryTab = tab;
    const lp = await env.context.newPage();
    const lurl = `${servers.A}/${listing.page}`;
    await lp.goto(lurl);
    await lp.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 15000 });
    const listingTab = await E.poll(async () => (await E.allTabs(env)).find((t) => t.url === lurl && t.id !== galleryTab.id), { message: 'listing tab' });
    if (listingTab.windowId !== panelWindow) await env.sw.evaluate((a) => chrome.tabs.move(a.id, { windowId: a.w, index: -1 }), { id: listingTab.id, w: panelWindow });
    const beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(panel.page);
    await E.writePageJob(env, { windowId: panelWindow, tabId: galleryTab.id, pageUrl: galleryTab.url });
    await panel.page.waitForFunction((m) => window.__cs.log.slice(m).some((e) => e.state === 'scanning'), mark, { timeout: 15000 });
    await E.sleep(300);
    await E.writePageJob(env, { windowId: panelWindow, tabId: listingTab.id, pageUrl: listingTab.url });
    await E.waitForScanEnd(panel.page, mark, { timeout: 60000 });
    await E.sleep(4000);
    const opened = await newGraderTabsSince(beforeTabs);
    const v = await readPage(panel.page);
    console.log(`# P8 newest wins: final ${v.body}; opened ${opened.map((t) => t.url).join(', ')}`);
    assert.equal(v.body, 'auto-open');
    assert.deepEqual(opened.map((t) => t.url), [listing.expected.default.url], 'only the second (listing) job opened');
    autoOpens.push({ page: lurl, urls: opened.map((t) => t.url), expect: listing.expected.default.url });
    await lp.close();
  });

  test('P9 crop fallback: a hotlink CDN refuses every fetch → the page scan crops the photo from one viewport capture (screen resolution, DPR 1); never a wrong number', T, async () => {
    await E.closeGraderTabs(env);
    const results = [];
    for (const [file, w, number] of [['psa-9digit.png', 400, '108114622'], ['psa-8digit-leading-zero.png', 270, '01234567']]) {
      const img = `${servers.B}/hotlink/${file}`;
      await show(`${servers.A}/__e2e/page.html?img=${encodeURIComponent(img)}&w=${w}&id=img-hotlink`);
      const logStart = servers.log.length;
      const r = await runPage({ settle: 1500, expectUrl: E.CERT_URL.psa(number) });
      const refused = servers.log.slice(logStart).filter((x) => x.server === 'B' && x.path.startsWith('/hotlink/') && x.dest !== 'image');
      for (const t of r.opened) assert.equal(t.url, E.CERT_URL.psa(number), 'only the right cert may open');
      // Diagnostic re-run: an auto-open made the cert tab active, and capture requires the source tab to be active
      // (SEC-08), so close it and re-activate the source tab first.
      await E.closeGraderTabs(env);
      await env.sw.evaluate((id) => chrome.tabs.update(id, { active: true }), tab.id);
      await E.sleep(600); // captureVisibleTab is rate-limited (2/s)
      const d = await scanPageDirect(panel.page, { ...r.job, id: crypto.randomUUID(), createdAt: Date.now() });
      const im = d.images[0] ?? {};
      results.push(`${file}@${w}px → UI ${r.view.body} ${r.view.rows.map((x) => x.number).join(',') || (await E.readResult(panel.page)).number || '-'}; pipeline ${d.status} method=${im.method} resolution=${im.resolution} items=${d.items.map((i) => `${i.number}@${i.confidence}`).join(',') || '-'}; refused fetches ${refused.length}`);
      assert.ok(refused.length >= 1, `${file}: extension/page fetch attempted and refused by the CDN`);
      assert.equal(im.method, 'capture', `${file}: acquired by cropping the viewport capture (UI ${r.view.body}/${r.view.errorCode}; pipeline ${JSON.stringify({ status: d.status, discovered: d.discovered, images: d.images, captureMs: d.timings.captureMs })})`);
      assert.equal(im.resolution, 'screen');
      for (const i of d.items) assert.equal(i.number, number, `${file}: never a wrong number from the capture`);
      assert.ok(['auto-open', 'page-results', 'none'].includes(r.view.body));
      await E.closeGraderTabs(env);
    }
    for (const line of results) console.log(`# P9 ${line}`);
  });

  test('P10 page-job contract: malformed page jobs (mediaType, wrong source, srcUrl, frameId, stale, unknown kind) are cleared without a scan', T, async () => {
    await E.closeGraderTabs(env);
    await show(`${servers.A}/${listing.page}`);
    const key = `scanJob:${panelWindow}`;
    const mark = await E.logMark(panel.page);
    const beforeTabs = await E.graderTabs(env);
    for (const [label, opts] of [
      ['mediaType on a page job', { overrides: { mediaType: 'image' } }],
      ['source contextMenu', { overrides: { source: 'contextMenu' } }],
      ['srcUrl set', { overrides: { srcUrl: `${servers.A}/psa-9digit.png` } }],
      ['frameId 3', { overrides: { frameId: 3 } }],
      ['stale (10 min)', { ageMs: 10 * 60_000 }],
      ['kind "frame"', { overrides: { kind: 'frame' } }],
      ['tabId -1', { overrides: { tabId: -1 } }],
    ]) {
      await E.writePageJob(env, { windowId: panelWindow, tabId: tab.id, pageUrl: tab.url, ...opts });
      await E.poll(async () => (await E.sessionGet(env, key)) === null, { message: `${label}: cleared`, timeout: 5000 });
    }
    await E.sleep(1500);
    assert.ok(!(await E.stateLog(panel.page, mark)).includes('scanning'), 'no scan for malformed page jobs');
    assert.equal((await newGraderTabsSince(beforeTabs)).length, 0);
  });

  test('hard check: every page-scan auto-open went to the one expected URL; no uncaught errors or CSP violations; evil.example never requested', () => {
    for (const a of autoOpens) {
      assert.equal(a.urls.length, 1, `one tab per auto-open (${a.page})`);
      assert.equal(a.urls[0], a.expect, `auto-open went to the expected cert (${a.page})`);
    }
    console.log(`# page-scan panel errors: ${panel.errors.length ? panel.errors.join(' | ') : 'none'}`);
    assert.deepEqual(panel.errors.filter((e) => e.startsWith('pageerror')), []);
    assert.deepEqual(panel.errors.filter((e) => /Content Security Policy|unsafe-eval|Refused to/i.test(e)), []);
    assert.ok(!env.net.some((n) => E.hostOf(n.url) === FOREIGN_HOST));
  });
});

describe('A9 page access on the release build (no host access): the panel button explains the icon/shortcut', { concurrency: false }, () => {
  let servers;
  let tls;
  let env;
  let variant = null;
  let identity;
  before(async () => {
    const e2eBuild = E.assertBuilt();
    const distInfo = path.join(E.ROOT, 'dist', 'build-info.json');
    const rel = existsSync(distInfo) ? JSON.parse(readFileSync(distInfo, 'utf8')) : null;
    let dir;
    if (rel?.target === 'release' && rel.gitCommit === e2eBuild.gitCommit && rel.gitDirty === e2eBuild.gitDirty) {
      dir = path.join(E.ROOT, 'dist');
      identity = `dist/ (release, ${rel.gitCommit?.slice(0, 7)}${rel.gitDirty ? '+dirty' : ''}, built ${rel.builtAt})`;
    } else {
      variant = await E.makeVariant((m) => { delete m.host_permissions; });
      dir = variant.dir;
      identity = 'release-equivalent copy of dist-e2e with the release host_permissions (dist/ missing or from another source state)';
    }
    servers = await E.startServers();
    tls = await E.startHttpsImageServer();
    env = await E.launchExtension({ extensionPath: dir, args: ['--ignore-certificate-errors'] });
  });
  after(async () => {
    await env?.close();
    await servers?.close();
    await tls?.close();
    await variant?.cleanup();
  });

  test('page-access state: no scan, no request; for an unknown host "Always allow on all sites"; copy names the icon and the shortcut', T, async () => {
    console.log(`# page-access build under test: ${identity}`);
    const en = messages(E.DIST_E2E, 'en');
    assert.deepEqual((await env.sw.evaluate(() => chrome.permissions.getAll())).origins, [], 'no page access at install');
    const page0 = env.context.pages()[0];
    await page0.goto(`${servers.A}/pages/gallery.html`);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 15000 });
    const windowId = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    const active = await env.sw.evaluate(async (w) => (await chrome.tabs.query({ active: true, windowId: w })).map((t) => ({ id: t.id, url: t.url ?? null })), windowId);
    assert.equal(active.length, 1);
    assert.equal(active[0].url, null, 'release build cannot see the tab URL without a grant');
    const cmds = await env.sw.evaluate(() => chrome.commands.getAll());
    const shortcut = cmds.find((c) => c.name === 'scan-page')?.shortcut ?? '';
    console.log(`# commands: ${JSON.stringify(cmds)}`);

    const p = await E.openPanel(env, windowId);
    const logStart = servers.log.length;
    const netStart = env.net.length;
    const mark = await E.logMark(p.page);
    await p.page.locator(tid('page-scan-button')).click();
    await E.poll(async () => (await readPage(p.page)).task === 'page-access', { message: '#task[data-state=page-access]', timeout: 10000 });
    await E.sleep(1000);
    const v = await readPage(p.page);
    console.log(`# page-access: body ${v.body}; "${v.heading}" / "${v.accessBody}"; Always allow visible: ${v.alwaysAllowVisible}`);
    assert.equal(v.body, 'idle');
    assert.equal(v.heading, msg(en, 'page_access_heading'));
    assert.equal(v.accessBody, shortcut ? msg(en, 'page_access_body_keys', [shortcut]) : msg(en, 'page_access_body'));
    assert.ok(v.alwaysAllowVisible, 'an offer even when the https host is unknown (user: "kan deze pagina niet scannen")');
    assert.equal((await p.page.locator(tid('always-allow-button')).textContent()).trim(), msg(en, 'page_access_always_all'), 'all sites, as no single site can be named');
    assert.ok(v.actions.includes('page-scan') && v.actions.includes('choose'), 'Try again + Choose image');
    assert.equal(v.focusId, 'task-heading');
    assert.ok(!(await E.stateLog(p.page, mark)).includes('scanning'), 'no scan started');
    assert.deepEqual(servers.log.slice(logStart).filter((r) => r.path !== '/favicon.ico'), [], 'the extension requested nothing from the page origins');
    assert.deepEqual(env.net.slice(netStart).filter((n) => !n.url.startsWith('chrome-extension://')).map((n) => n.url), [], 'no network request from any context');
    assert.deepEqual(p.errors.filter((e) => e.startsWith('pageerror')), []);
    // The offer asks for every https site, and only from the click; declining withdraws it.
    assert.ok(await stubPermissions(p.page, { grant: false }), 'chrome.permissions stubbed in the panel realm');
    await p.page.locator(tid('always-allow-button')).click();
    await E.poll(() => p.page.evaluate(() => window.__perm.requests === 1), { message: 'permission requested' });
    assert.deepEqual(await p.page.evaluate(() => window.__perm.origins), [['https://*/*']]);
    await E.sleep(300);
    const declined = await readPage(p.page);
    assert.equal(declined.alwaysAllowVisible, false, 'offer withdrawn after decline');
    assert.ok(await p.page.evaluate((t) => document.querySelector('#task [data-ref="always-status"]')?.textContent.includes(t), msg(en, 'page_access_denied_all')), 'denied note shown');
    await p.page.close(); // one panel per window in the next test
  });

  test('"Always allow on <host>" for a known https host: request scoped to that host; declining withdraws the offer (prompt stubbed)', T, async () => {
    const en = messages(E.DIST_E2E, 'en');
    const page0 = env.context.pages()[0];
    const url = `${tls.origin}/pages/listing.html`;
    await page0.goto(url);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 15000 });
    const windowId = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    const [active] = await env.sw.evaluate(async (w) => (await chrome.tabs.query({ active: true, windowId: w })).map((t) => ({ id: t.id })), windowId);
    const p = await E.openPanel(env, windowId);
    assert.ok(await stubPermissions(p.page, { grant: false }), 'chrome.permissions stubbed in the panel realm');
    // An earlier toolbar job told the panel this tab's URL (here: its grant is gone, so the scan cannot inject).
    let mark = await E.logMark(p.page);
    await E.writePageJob(env, { windowId, tabId: active.id, pageUrl: url });
    await E.waitForScanEnd(p.page, mark, { timeout: 30000 });
    const first = await readPage(p.page);
    const cmd = (await env.sw.evaluate(() => chrome.commands.getAll())).find((c) => c.name === 'scan-page')?.shortcut ?? '';
    const firstId = await p.page.evaluate(() => document.querySelector('[data-testid="error-message"]')?.dataset.errorId ?? null);
    console.log(`# job without a live grant: ${first.body}/${first.errorCode} (${firstId}) "${first.heading}" / "${first.error}"; actions ${first.actions.join(',')}; focus #${first.focusId}`);
    // O11: a toolbar job on a readable https page whose grant is gone → E12 page-no-access (not E1 restricted).
    assert.equal(first.body, 'error');
    assert.equal(first.errorCode, 'page-no-access');
    assert.equal(firstId, 'E12');
    assert.equal(first.heading, msg(en, 'err_page_no_access_heading'));
    assert.equal(first.error, cmd ? msg(en, 'err_page_no_access_body', [cmd]) : msg(en, 'err_page_no_access_body_icon'), 'E12 body names the icon and the shortcut');
    assert.ok(first.actions.includes('page-scan') && first.actions.includes('choose'), 'Scan this page + Choose image');
    assert.equal(first.focusId, 'task-heading');
    // Panel "Scan this page": no access → page-access with the offer for the known https host.
    mark = await E.logMark(p.page);
    await p.page.locator('#task [data-action="page-scan"]').first().click();
    await E.poll(async () => (await readPage(p.page)).task === 'page-access', { message: 'page-access', timeout: 10000 });
    const v = await readPage(p.page);
    assert.ok(v.alwaysAllowVisible, 'Always allow offered');
    assert.equal((await p.page.locator(tid('always-allow-button')).textContent()).trim(), msg(en, 'page_access_always', ['127.0.0.1']));
    await p.page.locator(tid('always-allow-button')).click();
    await E.poll(() => p.page.evaluate(() => window.__perm.requests === 1), { message: 'permission requested' });
    assert.deepEqual(await p.page.evaluate(() => window.__perm.origins), [['https://127.0.0.1/*']], 'request scoped to the one https host');
    await E.sleep(500);
    const after = await readPage(p.page);
    assert.equal(after.alwaysAllowVisible, false, 'offer withdrawn after decline');
    assert.ok(await p.page.evaluate((t) => document.querySelector('#task [data-ref="always-status"]')?.textContent.includes(t), msg(en, 'page_access_denied', ['127.0.0.1'])), 'denied note shown');
    assert.equal(await p.page.evaluate(() => document.activeElement?.dataset.ref ?? null), 'always-status', 'focus on the note');
    assert.ok(!(await E.stateLog(p.page, mark)).includes('scanning'), 'no scan without access');
    assert.deepEqual((await env.sw.evaluate(() => chrome.permissions.getAll())).origins, [], 'nothing granted');

    // Release-checklist PS4 scenario: the tab moves to another https site. Without access Chrome hides the new URL
    // (tabs.onUpdated has no url), so the panel can no longer name the host: page-access copy without the offer.
    const other = `${tls.origin.replace('127.0.0.1', 'localhost')}/pages/gallery.html`;
    await page0.goto(other);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 15000 });
    await E.sleep(500);
    await p.page.locator('#task [data-action="page-scan"]').first().click();
    await E.sleep(1000);
    const nav = await readPage(p.page);
    const noteVisible = await p.page.evaluate(() => { const n = document.querySelector('#task [data-ref="always-status"]'); return !!n && !n.hidden; });
    console.log(`# after a cross-origin navigation: task ${nav.task}; Always allow visible: ${nav.alwaysAllowVisible}; old note visible: ${noteVisible}`);
    assert.equal(nav.task, 'page-access');
    assert.equal(noteVisible, false, 'page-access card re-rendered');
    assert.equal((await p.page.locator(tid('always-allow-button')).textContent()).trim(), msg(en, 'page_access_always_all'), 'after the tab left the known host (observation O12) only all sites can be offered');

    // O11: a toolbar job on the new site (no grant) → E12 again; E12 is not restored when the panel is reopened.
    mark = await E.logMark(p.page);
    await E.writePageJob(env, { windowId, tabId: active.id, pageUrl: other });
    await E.waitForScanEnd(p.page, mark, { timeout: 30000 });
    const again = await readPage(p.page);
    assert.equal(again.errorCode, 'page-no-access', 'E12 for the new site too');
    await E.reloadPanel(p.page);
    await E.sleep(1000);
    const reopened = await readPage(p.page);
    console.log(`# E12 after a cross-origin move: ${again.body}/${again.errorCode}; after panel reload: body ${reopened.body}, task ${reopened.task}`);
    assert.equal(reopened.body, 'idle', 'E12 is not restored on reopen');
    assert.equal(reopened.error, '');
    assert.deepEqual(p.errors.filter((e) => e.startsWith('pageerror')), []);
  });
});

describe('A9 Dutch UI smoke (--lang=nl, dist-e2e): idle, toolbar title and page-results', { concurrency: false }, () => {
  let servers;
  let env;
  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    env = await E.launchExtension({ args: ['--lang=nl'], env: { LANGUAGE: 'nl' } });
  });
  after(async () => {
    await env?.close();
    await servers?.close();
  });

  test('NL: html[lang=nl], Dutch toolbar title, idle and page-results copy from _locales/nl', T, async () => {
    const nl = messages(E.DIST_E2E, 'nl');
    const page0 = env.context.pages()[0];
    const url = `${servers.A}/pages/gallery.html`;
    await page0.goto(url);
    await page0.waitForSelector('html[data-ready="1"]', { state: 'attached', timeout: 15000 });
    const tab = await E.findTab(env, url);
    assert.equal(await env.sw.evaluate(() => chrome.i18n.getUILanguage()), 'nl');
    await E.poll(async () => (await env.sw.evaluate(() => chrome.action.getTitle({}))) === nl.action_title.message, { message: 'Dutch toolbar title', timeout: 5000 });
    const p = await E.openPanel(env, tab.windowId);
    const idle = await readPage(p.page);
    assert.equal(idle.lang, 'nl');
    assert.equal(idle.heading, nl.idle_heading.message);
    assert.equal((await p.page.locator(`${tid('page-scan-button')} [data-i18n="page_scan_button"]`).textContent()).trim(), nl.page_scan_button.message);
    const mark = await E.logMark(p.page);
    await E.writePageJob(env, { windowId: tab.windowId, tabId: tab.id, pageUrl: tab.url });
    await E.waitForScanEnd(p.page, mark, { timeout: 60000 });
    const v = await readPage(p.page);
    console.log(`# NL page-results: "${v.heading}" / "${v.summary[0]}"; first row Open name "${v.rows[0]?.openName}"`);
    assert.equal(v.body, 'page-results');
    assert.equal(v.heading, nl.page_results_heading.message);
    assert.equal(v.summary[0], msg(nl, 'page_results_summary', [String(v.rows.length)]));
    const openRow = v.rows.find((x) => x.open);
    assert.ok(openRow?.openName.startsWith(nl.recent_open.message), 'row Open button named in Dutch');
    const ambiguous = v.rows.find((x) => x.choose);
    if (ambiguous) assert.ok(await p.page.locator(`${tid(`page-result-${ambiguous.i}`)} [data-ref="choose"]`).textContent().then((s) => s.trim() === nl.page_result_choose.message));
    assert.deepEqual(p.errors.filter((e) => e.startsWith('pageerror')), []);
  });
});
