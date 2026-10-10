// S8 improvement round (docs/implementation/frontend-handoff.md "S8 improvement round", ADR-001 A10) on the real
// extension (dist-e2e):
// - SEC-13: hostile page pages/hidden.html (slab A painted as a CSS background, the <img> of slab B hidden) never
//   auto-opens B; the control variant (B visible) does.
// - O9: consumed job ids survive a panel reload (storage.session seenJobs:<windowId>): a re-written id neither scans
//   nor opens again.
// - Perf 5: the preview is a <= 240 px copy; "Show larger" shows the original from a new blob URL and "Show smaller"
//   revokes it.
// SEC-14 crafted uploads are in security.test.mjs; O10 ("Checked 8 of 10 photos.") and row thumbnails in pagescan P1;
// O11/E12 in pagescan P13. Page jobs are written from the SW in the createPageJob shape (see pagescan.test.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { readPage, tid } from './lib/panel.mjs';

const T = { timeout: 240_000 };
const manifest = JSON.parse(readFileSync(path.join(E.FIXTURES, 'manifest.json'), 'utf8'));
const hidden = manifest.pages.find((p) => p.kind === 'hostile-hidden-image');
const listing = manifest.pages.find((p) => p.kind === 'single-slab-listing');
const fixture = (file) => manifest.fixtures.find((f) => f.file === file);
const B_NUMBER = fixture(hidden.fixture).expected.number;
const THUMB_MAX = 240;
const A9_PROBE_OPTS = { minRendered: 120, minNatural: 150, max: 24 };

const messages = (lang) => JSON.parse(readFileSync(path.join(E.DIST_E2E, '_locales', lang, 'messages.json'), 'utf8'));
const fileOf = (u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()); } catch { return null; } };

/** The extension's own discovery probe, run in the tab from the panel realm (same call as scanPage). */
async function discover(panelPage, tabId) {
  return panelPage.evaluate(async ({ tabId, opts }) => {
    const { pageImagesProbe } = await import(chrome.runtime.getURL('pipeline/pageImagesProbe.js'));
    const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: pageImagesProbe, args: [opts] });
    return r.result;
  }, { tabId, opts: A9_PROBE_OPTS });
}

/** Natural size of the preview (data-testid=preview) once it has loaded. */
async function previewSize(page) {
  return page.evaluate(async () => {
    const img = document.querySelector('[data-testid="preview"]');
    if (!img || img.hidden || !img.getAttribute('src')) return null;
    await img.decode().catch(() => {});
    return { width: img.naturalWidth, height: img.naturalHeight, src: img.src };
  });
}

describe('S8 on dist-e2e: SEC-13 hidden-image page, O9 consumed ids after a panel reload, preview thumbnails', { concurrency: false }, () => {
  let servers;
  let env;
  let en;
  let tabPage;
  let tab;
  let panel;
  let panelWindow;
  const residual = [];

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

  async function runPage({ settle = 1500, overrides = {} } = {}) {
    const beforeTabs = await E.graderTabs(env);
    const mark = await E.logMark(panel.page);
    const t0 = Date.now();
    const job = await E.writePageJob(env, { windowId: panelWindow, tabId: tab.id, pageUrl: tab.url, overrides });
    await E.waitForScanEnd(panel.page, mark, { timeout: 60000 });
    const uiMs = Date.now() - t0;
    await E.sleep(settle);
    return { job, uiMs, view: await readPage(panel.page), opened: await newGraderTabsSince(beforeTabs), states: await E.stateLog(panel.page, mark) };
  }

  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    env = await E.launchExtension();
    en = messages('en');
    tabPage = env.context.pages()[0] ?? await env.context.newPage();
    await show(`${servers.A}/${hidden.page}`);
    panelWindow = tab.windowId;
    panel = await E.openPanel(env, panelWindow);
  });

  after(async () => {
    await env?.close();
    await servers?.close();
  });

  test('SEC-13 hostile page: slab A as a CSS background, <img> of slab B hidden (opacity 0, visibility hidden, off-screen, covered, opacity 0.05) → B never auto-opens (none or list), no tab; control (B visible) auto-opens B', T, async () => {
    // Hiding variants first, the control (none) last: a regression fails on the hidden-image auto-open itself.
    const variants = Object.entries(hidden.variants).filter(([, v]) => v.asserted).sort(([a], [b]) => (a === 'none') - (b === 'none'));
    for (const [name, spec] of variants) {
      await E.closeGraderTabs(env);
      await show(`${servers.A}/${hidden.page}?hide=${encodeURIComponent(name)}`);
      const disc = await discover(panel.page, tab.id);
      const discovered = disc.images.map((i) => fileOf(i.srcUrl));
      const r = await runPage({ settle: name === 'none' ? 1500 : 3000 });
      const urls = r.opened.map((t) => t.url);
      console.log(`# SEC-13 hide=${name} (${spec.how}): discovered [${disc.images.map((i) => `${fileOf(i.srcUrl)} vf ${i.visibleFraction.toFixed(2)} topmost ${i.topmostAtCenter}`).join('; ') || '-'}] total ${disc.total}; UI ${r.view.body} in ${r.uiMs} ms; rows ${r.view.rows.map((x) => `${x.grader ?? '?'}:${x.number}`).join(', ') || '-'}; opened ${urls.join(', ') || 'nothing'}`);
      assert.deepEqual(discovered, spec.expected.discovered.map(() => hidden.fixture), `${name}: discovered images`);
      assert.ok(!urls.some((u) => hidden.mustNeverOpenUrls.includes(u)), `${name}: slab A (CSS background) is never opened`);
      if (name === 'none') {
        assert.equal(r.view.body, 'auto-open', 'control: B visible and topmost → auto-open');
        assert.deepEqual(urls, [spec.expected.url], 'control: exactly B\'s cert');
        assert.equal(disc.images[0].topmostAtCenter, true);
        continue;
      }
      assert.ok(!r.states.includes('auto-open'), `${name}: never auto-open`);
      assert.deepEqual(urls, [], `${name}: no tab`);
      assert.equal(r.view.body, spec.expected.status, `${name}: ${spec.expected.status}`);
      if (spec.expected.status === 'none') {
        assert.equal(r.view.noneReason, en.page_none_no_images.message, `${name}: hidden image not discovered`);
      } else {
        assert.equal(disc.images[0].topmostAtCenter, false, `${name}: B is not what the user sees`);
        assert.deepEqual(r.view.rows.map((x) => x.number), spec.expected.listed, `${name}: B's number listed for the user to check`);
      }
    }
    assert.deepEqual(panel.errors.filter((e) => e.startsWith('pageerror')), []);
  });

  test('SEC-13 residual techniques the probe does not model (diagnostic, outcome recorded, not asserted): filter:opacity(0), covering div with pointer-events:none, clip-path, 0 px overflow:hidden parent', T, async () => {
    for (const [name, spec] of Object.entries(hidden.variants).filter(([, v]) => !v.asserted)) {
      await E.closeGraderTabs(env);
      await show(`${servers.A}/${hidden.page}?hide=${encodeURIComponent(name)}`);
      const disc = await discover(panel.page, tab.id);
      const r = await runPage({ settle: 3000 });
      const urls = r.opened.map((t) => t.url);
      const line = `hide=${name} (${spec.how}): discovered [${disc.images.map((i) => `vf ${i.visibleFraction.toFixed(2)} topmost ${i.topmostAtCenter}`).join('; ') || '-'}]; UI ${r.view.body}; rows ${r.view.rows.map((x) => x.number).join(', ') || '-'}; opened ${urls.join(', ') || 'nothing'}`;
      residual.push({ name, body: r.view.body, opened: urls, topmost: disc.images[0]?.topmostAtCenter ?? null });
      console.log(`# SEC-13 residual ${line}${r.states.includes('auto-open') ? '  <-- auto-opened the hidden slab B' : ''}`);
      assert.ok(!urls.some((u) => hidden.mustNeverOpenUrls.includes(u)), `${name}: slab A is never opened`);
      assert.ok(urls.every((u) => u === hidden.variants.none.expected.url) && urls.length <= 1, `${name}: at most B's own cert`);
    }
    await E.closeGraderTabs(env);
    console.log(`# SEC-13 residual summary: ${residual.map((x) => `${x.name}=${x.body}${x.opened.length ? ' (tab)' : ''}`).join(', ')}`);
  });

  test('O9 consumed ids survive a panel reload: re-writing a consumed page job id and image job id after a reload starts no scan and opens no second tab', T, async () => {
    await E.closeGraderTabs(env);
    await show(`${servers.A}/${listing.page}`);
    const want = listing.expected.default.url;
    const key = `seenJobs:${panelWindow}`;

    // Page job → auto-open once.
    const first = await runPage({ settle: 1500 });
    assert.equal(first.view.body, 'auto-open');
    assert.deepEqual(first.opened.map((t) => t.url), [want]);
    // Image job (context menu shape) → auto-open once more (new id).
    let mark = await E.logMark(panel.page);
    const imageJob = await E.writeJob(env, { windowId: panelWindow, tabId: tab.id, srcUrl: `${servers.A}/${listing.fixture}`, pageUrl: tab.url });
    await E.waitForScanEnd(panel.page, mark, { timeout: 60000 });
    await E.sleep(1500);
    assert.equal((await readPage(panel.page)).body, 'auto-open');
    const tabsBefore = (await E.graderTabs(env)).filter((t) => t.url === want).length;
    assert.equal(tabsBefore, 2, 'one tab per job');
    const seen = await E.sessionGet(env, key);
    console.log(`# O9 ${key} before reload: ${JSON.stringify(seen)}`);
    assert.ok(Array.isArray(seen) && seen.includes(first.job.id) && seen.includes(imageJob.id), 'both ids stored in storage.session');
    assert.ok(seen.length <= 20);
    assert.ok(seen.every((x) => typeof x === 'string' && !x.includes('/')), 'ids only, no URLs');

    await E.reloadPanel(panel.page);
    await E.sleep(1000);
    mark = await E.logMark(panel.page);
    await E.writePageJob(env, { windowId: panelWindow, tabId: tab.id, pageUrl: tab.url, overrides: { id: first.job.id } });
    await E.poll(async () => (await E.sessionGet(env, `scanJob:${panelWindow}`)) === null, { message: 're-written page job cleared', timeout: 5000 });
    await E.writeJob(env, { windowId: panelWindow, tabId: tab.id, srcUrl: `${servers.A}/${listing.fixture}`, pageUrl: tab.url, overrides: { id: imageJob.id } });
    await E.poll(async () => (await E.sessionGet(env, `scanJob:${panelWindow}`)) === null, { message: 're-written image job cleared', timeout: 5000 });
    await E.sleep(4000);
    const states = await E.stateLog(panel.page, mark);
    const tabsAfter = (await E.graderTabs(env)).filter((t) => t.url === want).length;
    console.log(`# O9 after reload: re-written page id + image id → states ${JSON.stringify(states)}; ${want} tabs ${tabsBefore} → ${tabsAfter}`);
    assert.ok(!states.includes('scanning'), 'no scan for an already consumed id');
    assert.equal(tabsAfter, tabsBefore, 'no second tab');

    // A fresh id after the reload still works (the guard is per id, not a lock-out).
    const fresh = await runPage({ settle: 1500 });
    assert.equal(fresh.view.body, 'auto-open');
    assert.equal(fresh.opened.length, 1);
    await E.closeGraderTabs(env);
    assert.deepEqual(panel.errors.filter((e) => e.startsWith('pageerror')), []);
  });

  test('Perf 5 preview: upload shows a <= 240 px copy (aspect kept); "Show larger" shows the original from a new blob URL; "Show smaller" goes back and revokes it', T, async () => {
    const results = [];
    for (const file of ['psa-9digit.png', 'cgc-comic-10digit.png', 'ambiguous-10digit.png']) {
      const f = fixture(file);
      const r = await E.uploadAndWait(panel.page, path.join(E.FIXTURES, file));
      const p = await previewSize(panel.page);
      results.push(`${file} ${f.width}x${f.height} → ${r.state}, preview ${p ? `${p.width}x${p.height}` : 'none'}`);
      assert.ok(p, `${file}: preview shown`);
      assert.ok(p.src.startsWith('blob:'), `${file}: preview from a blob URL`);
      assert.ok(Math.max(p.width, p.height) <= THUMB_MAX && Math.max(p.width, p.height) >= THUMB_MAX - 1, `${file}: longest side ${Math.max(p.width, p.height)} px (<= ${THUMB_MAX})`);
      assert.ok(Math.abs(p.width / p.height - f.width / f.height) < 0.02, `${file}: aspect ratio kept`);
    }
    console.log(`# Perf 5 previews: ${results.join('; ')}`);

    // ambiguous-10digit → confirm, which offers "Show larger".
    assert.equal((await readPage(panel.page)).body, 'confirm');
    const small = await previewSize(panel.page);
    const larger = panel.page.locator('#task [data-ref="larger"]');
    assert.ok(await larger.isVisible(), '"Show larger" offered');
    assert.equal(await larger.getAttribute('aria-expanded'), 'false');
    await larger.click();
    await E.poll(async () => (await previewSize(panel.page))?.width === 544, { message: 'original shown', timeout: 5000 });
    const big = await previewSize(panel.page);
    assert.notEqual(big.src, small.src, 'original from its own blob URL');
    assert.equal(await larger.getAttribute('aria-expanded'), 'true');
    assert.equal((await larger.textContent()).trim(), en.image_smaller.message);
    await larger.click();
    await E.poll(async () => (await previewSize(panel.page))?.src === small.src, { message: 'back to the thumbnail', timeout: 5000 });
    const back = await previewSize(panel.page);
    const revoked = await panel.page.evaluate(async (u) => { try { await fetch(u); return false; } catch { return true; } }, big.src);
    console.log(`# Perf 5 Show larger: ${small.width}x${small.height} → ${big.width}x${big.height} → ${back.width}x${back.height}; large blob URL revoked: ${revoked}`);
    assert.equal(Math.max(back.width, back.height), Math.max(small.width, small.height));
    assert.equal(await larger.getAttribute('aria-expanded'), 'false');
    assert.ok(revoked, 'the original\'s blob URL is revoked after "Show smaller"');
    assert.equal(await panel.page.locator(tid('preview')).count(), 1);
  });
});
