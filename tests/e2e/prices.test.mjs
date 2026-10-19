// Value in the panel (ADR A25): only sources with the user's own key — PokemonPriceTracker for the value, PSA for the
// cert data — against routed copies of their answers; eBay, PriceCharting and the population reports are links opened
// on a click, and nothing is read from them. The real sites are never contacted (host-resolver-rules block them).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { expandOtherWays, pasteImage } from './lib/panel.mjs';

const T = { timeout: 120_000 };
const PSA_CERT = { PSACert: { CertNumber: '81234567', Year: '2023', Brand: 'POKEMON SV 151', CardNumber: '199', Subject: 'CHARIZARD ex', Variety: 'SPECIAL ILLUSTRATION RARE', CardGrade: 'GEM MT 10', TotalPopulation: 1234, PopulationHigher: 0 } };
const PPT_KEY = 'ppt_test_token_1234567890';

describe('Value for this card (user keys only)', { concurrency: false }, () => {
  let env;
  let page;
  const hits = [];
  /** PokemonPriceTracker answer: the fixture, or a status code to test the error states. */
  let pptStatus = 200;

  before(async () => {
    E.assertBuilt();
    env = await E.launchExtension();
    const pptBody = await readFile(path.join(E.FIXTURES, 'pokemonpricetracker', 'cards-charizard.json'), 'utf8');
    // Anything else on the price and listing sites would be page reading, which A25 removed: record it.
    for (const host of ['www.pricecharting.com', 'www.ebay.com', '130point.com']) {
      await env.context.route(`https://${host}/**`, (route) => {
        hits.push({ url: route.request().url(), type: route.request().resourceType() });
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>opened</body></html>' });
      });
    }
    await env.context.route('https://www.pokemonpricetracker.com/**', (route) => {
      hits.push({ url: route.request().url(), auth: route.request().headers().authorization, type: route.request().resourceType() });
      return pptStatus === 200
        ? route.fulfill({ status: 200, contentType: 'application/json', body: pptBody })
        : route.fulfill({ status: pptStatus, contentType: 'application/json', body: '{"error":"x"}' });
    });
    await env.context.route('https://api.psacard.com/**', (route) => {
      hits.push({ url: route.request().url(), auth: route.request().headers().authorization, type: route.request().resourceType() });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PSA_CERT) });
    });
    const win = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    ({ page } = await E.openPanel(env, win));
  });
  after(async () => { await env?.close(); });

  const read = () => page.evaluate(() => {
    const box = document.querySelector('[data-testid="price-data"]');
    const visible = (el) => !!el && !el.hidden && !el.closest('[hidden]');
    return {
      status: box?.dataset.status,
      text: box?.querySelector('[data-ref="price-state-text"]')?.textContent ?? '',
      key: visible(document.querySelector('[data-testid="price-key"]')) ? document.querySelector('[data-testid="price-key"]').textContent : null,
      card: document.querySelector('[data-testid="price-card-text"]')?.textContent,
      current: document.querySelector('[data-testid="price-current"]')?.textContent,
      last: document.querySelector('[data-testid="price-last-sold"]')?.textContent,
      source: document.querySelector('[data-ref="value-source"]')?.textContent ?? '',
      note: visible(document.querySelector('[data-ref="pc-col"]')) ? document.querySelector('[data-ref="pc-col"]').textContent : '',
      grid: [...document.querySelectorAll('[data-testid="price-grid"] li')].map((li) => li.textContent),
      market: visible(document.querySelector('[data-ref="market"]')),
      links: [...document.querySelectorAll('[data-testid="price-links"] [data-action]')].filter(visible).map((b) => b.dataset.action),
      pop: document.querySelector('[data-testid="psa-info"]')?.hidden ? null : document.querySelector('[data-testid="psa-info"]')?.textContent,
      number: document.querySelector('[data-testid="result-number"]')?.textContent,
    };
  });
  const settled = () => E.poll(async () => { const s = (await read()).status; return s && !['loading', 'reading'].includes(s); }, { message: 'value settled', timeout: 45000 });
  const fresh = async () => { await page.reload(); await page.waitForSelector('body[data-ready="1"]', { state: 'attached' }); };
  const setKey = (k) => env.sw.evaluate((v) => (v ? chrome.storage.local.set({ pptApiToken: v }) : chrome.storage.local.remove('pptApiToken')), k);

  test('no key: the value block explains it and "Add key" opens Settings at the key; links stay; nothing is read from price sites', T, async () => {
    const before = hits.length;
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await settled();
    const v = await read();
    assert.equal(v.status, 'no-key');
    assert.match(v.text, /free PokemonPriceTracker key/);
    assert.equal(v.key, 'Add key');
    assert.equal(v.market, false, 'no Price per grade without data');
    assert.deepEqual(v.links, ['price-sold', 'price-active', 'price-slab', 'price-pc-search', 'price-pop']);
    assert.equal(v.card, 'POKEMON CHARIZARD ex 199', 'card name read from the label, used by the links');
    await E.sleep(500);
    assert.deepEqual(hits.slice(before), [], 'no request to PriceCharting, eBay or any price source');
    await page.click('[data-testid="price-key"]');
    const s = await page.evaluate(() => ({ settings: !document.getElementById('settings').hidden, focus: document.activeElement?.id }));
    assert.deepEqual(s, { settings: true, focus: 'setting-ppt-key' });
    await page.click('#back-button');
  });

  test('links open the searches for this card in a new tab, on a click only', T, async () => {
    const before = hits.length;
    const priceTabs = async () => (await E.allTabs(env)).filter((t) => /ebay\.com|pricecharting\.com/.test(t.url));
    await page.click('[data-testid="price-sold"]');
    await page.click('[data-testid="price-pc-search"]');
    const tabs = await E.poll(async () => { const x = await priceTabs(); return x.length >= 2 ? x : null; }, { message: 'two tabs' });
    const sold = new URL(tabs.find((t) => t.url.startsWith('https://www.ebay.com/')).url);
    assert.equal(sold.pathname, '/sch/i.html');
    assert.equal(sold.searchParams.get('LH_Sold'), '1');
    assert.match(sold.searchParams.get('_nkw'), /CHARIZARD ex 199 PSA 10/);
    assert.ok(tabs.some((t) => t.url === 'https://www.pricecharting.com/search-products?q=POKEMON+CHARIZARD+ex+199&type=prices'));
    assert.ok(hits.slice(before).every((h) => h.type === 'document'), 'tab navigations only, no reads by the panel');
    for (const t of tabs) await env.sw.evaluate((id) => chrome.tabs.remove(id), t.id);
  });

  test('with a PokemonPriceTracker key: value, median and price per grade from its API', T, async () => {
    await setKey(PPT_KEY);
    await fresh();
    const before = hits.length;
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await E.poll(async () => (await read()).current === '$601.50', { message: 'PokemonPriceTracker value', timeout: 45000 });
    const v = await read();
    assert.equal(v.status, 'ok');
    assert.match(v.source, /PokemonPriceTracker/);
    assert.equal(v.last, '$598.00', 'median sold in PSA 10 (plan without single sales)');
    assert.ok(v.market, 'Price per grade shown');
    assert.ok(v.grid.some((g) => g.startsWith('PSA 9')) && v.grid.some((g) => g.startsWith('CGC 10')), v.grid.join(' | '));
    const ppt = hits.slice(before).filter((h) => h.url.startsWith('https://www.pokemonpricetracker.com/'));
    assert.equal(ppt.length, 1);
    assert.match(ppt[0].url, /^https:\/\/www\.pokemonpricetracker\.com\/api\/v2\/cards\?search=CHARIZARD\+ex\+199&limit=2&includeEbay=true$/);
    assert.equal(ppt[0].auth, `Bearer ${PPT_KEY}`);
    assert.ok(!hits.slice(before).some((h) => /pricecharting|ebay\.com/.test(h.url)), 'no page reading');
  });

  test('Change: a new grade applies on "Show value"; the list has the slab\'s grades only', T, async () => {
    await page.click('[data-testid="price-edit"]');
    const options = await page.evaluate(() => [...document.querySelectorAll('[data-testid="price-grade"] option')].map((o) => o.textContent));
    assert.ok(!options.includes('All grades') && options.includes('PSA 9') && options.includes('PSA 10'), options.join(', '));
    await page.selectOption('[data-testid="price-grade"]', '9');
    await E.sleep(500);
    assert.equal((await read()).current, '$601.50', 'picking a grade alone changes nothing yet');
    await page.click('[data-testid="price-show"]');
    await E.poll(async () => (await read()).current === '$205.00', { message: 'PSA 9 value after Show value' });
    const v = await page.evaluate(() => ({ fields: document.getElementById('price-fields')?.hidden, label: document.querySelector('[data-ref="pc-label"]')?.textContent, focus: document.activeElement?.dataset.testid }));
    assert.equal(v.fields, true, 'Change closed');
    assert.equal(v.label, 'Current price · PSA 9');
    assert.equal(v.focus, 'price-edit');
  });

  test('no sale in the asked grade: the other grades, with the reason', T, async () => {
    await page.click('[data-testid="price-edit"]');
    await page.selectOption('[data-testid="price-grade"]', '7');
    await page.click('[data-testid="price-show"]');
    await E.poll(async () => /PSA 7|PSA 7/.test((await read()).note), { message: 'no-grade note' });
    const v = await read();
    assert.equal(v.status, 'ok');
    assert.equal(v.current, '—');
    assert.match(v.note, /no recent sales in PSA 7 on PokemonPriceTracker/);
    assert.ok(v.grid.length > 2, 'other grades listed');
  });

  test('key errors: not accepted → "Check key" to Settings; daily limit → says when it works again', T, async (t) => {
    pptStatus = 401;
    t.after(() => { pptStatus = 200; });
    await fresh();
    await expandOtherWays(page);
    await page.fill('#cert-input', '81234568');
    await page.click('#manual-submit');
    // A typed number has no card name yet: the value block asks for it, with Change.
    await E.poll(async () => (await read()).status === 'need-card', { message: 'need-card' });
    await page.click('[data-testid="price-data"] [data-ref="price-change"]');
    await page.fill('[data-testid="price-card"]', 'Pikachu 25');
    await page.selectOption('[data-testid="price-grade"]', '10');
    await page.click('[data-testid="price-show"]');
    await E.poll(async () => (await read()).status === 'auth', { message: 'auth state' });
    let v = await read();
    assert.match(v.text, /didn't accept your key/);
    assert.equal(v.key, 'Check key');
    pptStatus = 429;
    await page.click('[data-testid="price-edit"]');
    await page.fill('[data-testid="price-card"]', 'Pikachu 58');
    await page.click('[data-testid="price-show"]');
    await E.poll(async () => (await read()).status === 'limit', { message: 'limit state' });
    v = await read();
    assert.match(v.text, /today's limit/);
    assert.equal(v.key, null);
  });

  test('typed PSA number with a PSA API key: card name and population from the cert, then the value', T, async () => {
    await env.sw.evaluate(() => chrome.storage.local.set({ psaApiToken: 'test-token-1234567890' }));
    await fresh();
    await expandOtherWays(page);
    await page.fill('#cert-input', '81234567');
    await page.click('#manual-submit');
    await E.poll(async () => { const x = await read(); return x.number === '81234567' && x.status === 'ok' && Boolean(x.pop); }, { message: 'value for 81234567', timeout: 45000 });
    const v = await read();
    assert.equal(v.current, '$601.50');
    assert.match(v.pop, /1,234/);
    const api = hits.find((h) => h.url.endsWith('/GetByCertNumber/81234567'));
    assert.equal(api?.auth, 'bearer test-token-1234567890');
    await env.sw.evaluate(() => chrome.storage.local.remove('psaApiToken'));
  });

  test('comics and other card games: no price source in the panel, the links remain', T, async () => {
    await fresh();
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'cgc-comic-qr.png')));
    assert.equal(r.number, '4012347003');
    await settled();
    const v = await read();
    assert.equal(v.status, 'no-source');
    assert.match(v.text, /no price source in the panel/);
    assert.ok(v.links.includes('price-sold') && v.links.includes('price-pc-search'));
    assert.match(v.card, /Amazing Spider-Man 300/, 'the title is still read from the label (text-size pass)');
  });

  test('header "New scan": from a result back to a clean Start screen that stays clean after a reload', T, async () => {
    await setKey(null);
    await fresh();
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await settled();
    const btn = page.locator('[data-testid="new-scan-button"]');
    assert.ok(await btn.isVisible(), 'in the header, next to Settings');
    assert.equal(await btn.getAttribute('title'), 'New scan');
    await btn.click();
    const v = await page.evaluate(() => ({
      task: document.getElementById('task').dataset.state, body: document.body.dataset.state,
      extra: document.getElementById('result-extra').childElementCount, other: document.getElementById('other-ways').dataset.open,
      recent: !document.getElementById('recent').hidden, focus: document.activeElement?.id,
    }));
    assert.deepEqual(v, { task: 'idle', body: 'idle', extra: 0, other: 'true', recent: true, focus: 'task-heading' });
    await fresh();
    assert.equal(await page.evaluate(() => document.getElementById('task').dataset.state), 'idle', 'the last result is not restored');
  });
});
