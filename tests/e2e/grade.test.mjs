// Grade check (raw cards): a photo in, centering and per-grader limits out, on the device. Nothing leaves the browser
// unless the user picks an AI check in Settings, saves a key and starts the check (then, after consent, only the card
// photo goes to that API, routed here to a canned answer).
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';

const T = { timeout: 120_000 };
/** Synthetic card: borders left 3.4, right 2.6, top 3.1, bottom 2.9 mm -> 56.7/43.3 and 51.7/48.3. */
const FRONT = path.join(E.FIXTURES, 'grade', 'raw-card-front.png');
const TRUTH = { lr: 56.7, tb: 51.7 };
const KEY = 'sk-ant-api03-e2etestkey0000000000000000';
/** "57/43" -> 57; measured within 1.5 points of the truth (whole points shown). */
const near = (text, truth, msg) => { const v = Number(/^(\d+)\//.exec(text)?.[1]); assert.ok(Math.abs(v - truth) <= 1.5, `${msg}: ${text} vs ${truth}`); };
const ANSWER = {
  corners: { rating: 'minor', notes: 'Slight whitening on the top-left corner.' },
  edges: { rating: 'none', notes: 'Clean at this size.' },
  surface: { rating: 'unknown', notes: 'Too small to judge.' },
  photo_issues: [], card: { name: '', number: '' },
};

describe('Grade check (raw cards)', { concurrency: false }, () => {
  let servers;
  let env;
  let page;
  let tab;
  const claude = [];

  /** http(s) requests to anything but the local fixture servers. */
  const external = () => env.net.filter((r) => /^https?:/.test(r.url) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(r.url));
  const state = (side) => page.locator(`[data-testid="grade-state-${side}"]`).textContent();
  const measured = (side = 'front') => E.poll(async () => /\d+\/\d+/.test(await state(side)), { message: `${side} measured`, timeout: 45000 });
  const fresh = async () => { await page.reload(); await page.waitForSelector('body[data-ready="1"]', { state: 'attached' }); };

  before(async () => {
    E.assertBuilt();
    servers = await E.startServers();
    env = await E.launchExtension();
    const gallery = env.context.pages()[0] ?? await env.context.newPage();
    await gallery.goto(`${servers.A}/pages/gallery.html`);
    tab = await E.findTab(env, `${servers.A}/pages/gallery.html`);
    ({ page } = await E.openPanel(env, tab.windowId, { width: 400, height: 1000 }));
    await page.route('https://api.anthropic.com/**', (route) => {
      const req = route.request();
      claude.push({ url: req.url(), headers: req.headers(), body: JSON.parse(req.postData() ?? '{}') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(ANSWER) }],
      }) });
    });
  });
  after(async () => { await env?.close(); await servers?.close(); });

  test('Start → grade check: the front photo is measured on the device and nothing is sent', T, async () => {
    const before = external().length;
    await page.click('[data-testid="grade-open"]');
    assert.equal(await page.locator('#grade').isHidden(), false);
    assert.equal(await page.locator('#settings-heading').textContent(), 'Grade check');
    await page.locator('[data-testid="grade-upload-input"]').setInputFiles(FRONT);
    await measured();
    near(await page.locator('[data-testid="grade-lr"]').textContent(), TRUTH.lr, 'left/right');
    near(await page.locator('[data-testid="grade-tb"]').textContent(), TRUTH.tb, 'top/bottom');
    const caps = await page.locator('[data-testid="grade-caps"] li').allInnerTexts();
    assert.equal(caps.length, 3);
    assert.match(caps[0], /PSA[\s\S]*up to 9[\s\S]*10 possible/, caps[0]);
    assert.match(await page.locator('#grade-caps-note').textContent(), /Back not measured/);
    // AI check off (default): the section says so and offers Settings; no request left the browser.
    assert.match(await page.locator('[data-testid="grade-ai"]').innerText(), /Off by default/);
    assert.deepEqual(external().slice(before).map((r) => r.url), []);
    assert.equal(claude.length, 0);
  });

  test('a border line moved with the arrow keys changes the ratio; Undo restores it', T, async () => {
    const line = page.locator('[data-testid="grade-line-left"]');
    const before = await page.locator('[data-testid="grade-lr"]').textContent();
    const was = Number(await line.getAttribute('aria-valuenow'));
    await line.focus();
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    const now = Number(await line.getAttribute('aria-valuenow'));
    assert.ok(now > was + 0.5, `left border grew: ${was} -> ${now}`);
    assert.notEqual(await page.locator('[data-testid="grade-lr"]').textContent(), before);
    assert.match(await page.locator('[data-testid="grade-notes"]').textContent(), /lines you moved/);
    await page.click('#grade-reset');
    assert.equal(await page.locator('[data-testid="grade-lr"]').textContent(), before);
  });

  test('right-click "Estimate card grade": the job opens the grade check with that photo', T, async () => {
    await fresh();
    await E.writeJob(env, { windowId: tab.windowId, tabId: tab.id, srcUrl: `${servers.A}/grade/raw-card-front.png`, pageUrl: tab.url, overrides: { purpose: 'grade' } });
    await E.poll(() => page.locator('#grade').isVisible(), { message: 'grade view shown' });
    await measured();
    const [lr, tb] = (await state('front')).split(' · ');
    near(lr, TRUTH.lr, 'left/right'); near(tb, TRUTH.tb, 'top/bottom');
    assert.equal(await page.evaluate(() => document.body.dataset.state), 'idle', 'no cert scan ran');
  });

  test('AI check: off until chosen; with a key, consent comes first, then only the card photo goes to the API', T, async () => {
    await page.evaluate((k) => Promise.all([
      chrome.storage.sync.set({ settings: { v: 1, gradeAi: 'claude-haiku' } }),
      chrome.storage.local.set({ anthropicApiKey: k }),
    ]), KEY);
    await fresh();
    await page.click('[data-testid="grade-open"]');
    await page.locator('[data-testid="grade-upload-input"]').setInputFiles(FRONT);
    await measured();
    assert.match(await page.locator('.app-footer').textContent(), /except for AI checks you start/);
    await page.click('[data-testid="grade-ai-check"]');
    await page.waitForSelector('[data-testid="grade-consent"]');
    assert.equal(claude.length, 0, 'nothing sent before consent');
    await page.click('[data-testid="grade-consent-send"]');
    await page.waitForSelector('[data-testid="grade-ai-result"]', { timeout: 30000 });
    assert.equal(claude.length, 1);
    const { url, headers, body } = claude[0];
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(headers['x-api-key'], KEY);
    assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(body.model, 'claude-haiku-5-5');
    const parts = body.messages[0].content;
    assert.deepEqual(parts.map((p) => p.type), ['image', 'text'], 'front only: one image');
    const sent = JSON.stringify(body);
    assert.ok(!sent.includes('127.0.0.1') && !sent.includes('gallery') && !sent.includes('raw-card-front'), 'no page address or file name');
    // JPEG from a canvas: starts with the SOI marker and has no EXIF (APP1) segment.
    const jpeg = Buffer.from(parts[0].source.data, 'base64');
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    assert.equal(jpeg.indexOf(Buffer.from('Exif\0')), -1);
    const result = await page.locator('[data-testid="grade-ai-result"]').innerText();
    assert.match(result, /Minor wear[\s\S]*No wear visible[\s\S]*Can't tell from the photo/);
    const caps = await page.locator('[data-testid="grade-caps"] li').allInnerTexts();
    assert.match(caps[0], /PSA\s+7–9/, caps[0]);
    assert.match(await page.locator('#grade-caps-heading').textContent(), /Estimate/);
    // A second check doesn't ask again.
    await page.click('text=Check again');
    await E.poll(() => claude.length === 2, { message: 'second check sent' });
    assert.equal(await page.locator('[data-testid="grade-consent"]').count(), 0);
  });
});
