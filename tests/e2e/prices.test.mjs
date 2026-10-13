// In-panel prices (PriceCharting) and the PSA cert lookup, against routed copies of their responses: the real sites
// are never contacted by the test run (host-resolver-rules block them anyway).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { expandOtherWays, pasteImage } from './lib/panel.mjs';

const T = { timeout: 120_000 };
const FX = path.join(E.FIXTURES, 'pricecharting');
const EBAY = path.join(E.FIXTURES, 'ebay');
const PSA_CERT = { PSACert: { CertNumber: '81234567', Year: '2023', Brand: 'POKEMON SV 151', CardNumber: '199', Subject: 'CHARIZARD ex', Variety: 'SPECIAL ILLUSTRATION RARE', CardGrade: 'GEM MT 10', TotalPopulation: 1234, PopulationHigher: 0 } };

describe('Prices for this card', { concurrency: false }, () => {
  let env;
  let page;
  const hits = [];

  /** fetch() from the panel gets the challenge while `challengeFetch` is on; a real tab (document) always passes. */
  let challengeFetch = false;
  before(async () => {
    E.assertBuilt();
    env = await E.launchExtension();
    await env.context.route('https://www.pricecharting.com/**', async (route) => {
      const req = route.request();
      const u = req.url();
      hits.push({ url: u, type: req.resourceType(), referer: req.headers().referer ?? null });
      if (challengeFetch && req.resourceType() !== 'document') {
        return route.fulfill({ status: 403, contentType: 'text/html', headers: { 'cf-mitigated': 'challenge' }, body: await readFile(path.join(FX, 'challenge.html'), 'utf8') });
      }
      const body = u.includes('/search-products') ? (u.includes('199') ? 'search.html' : null) : 'product.html';
      return route.fulfill({ status: 200, contentType: 'text/html', body: body ? await readFile(path.join(FX, body), 'utf8') : '<html><body>none</body></html>' });
    });
    await env.context.route('https://www.ebay.com/**', async (route) => {
      const u = route.request().url();
      hits.push({ url: u, type: route.request().resourceType(), referer: route.request().headers().referer ?? null });
      const file = new URL(u).searchParams.get('LH_Sold') === '1' ? 'sold.html' : 'active.html';
      return route.fulfill({ status: 200, contentType: 'text/html', body: await readFile(path.join(EBAY, file), 'utf8') });
    });
    await env.context.route('https://api.psacard.com/**', (route) => {
      hits.push({ url: route.request().url(), auth: route.request().headers().authorization });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PSA_CERT) });
    });
    const win = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    ({ page } = await E.openPanel(env, win));
  });
  after(async () => { await env?.close(); });

  const read = () => page.evaluate(() => ({
    status: document.querySelector('[data-testid="price-data"]')?.dataset.status,
    card: document.querySelector('[data-testid="price-card-text"]')?.textContent,
    chip: document.querySelector('[data-testid="price-grade-chip"]')?.textContent,
    current: document.querySelector('[data-testid="price-current"]')?.textContent,
    last: document.querySelector('[data-testid="price-last-sold"]')?.textContent,
    grid: [...document.querySelectorAll('[data-testid="price-grid"] li')].map((li) => li.textContent),
    sales: [...document.querySelectorAll('[data-testid="price-sales"] li')].map((li) => li.textContent),
    pop: document.querySelector('[data-testid="psa-info"]')?.hidden ? null : document.querySelector('[data-testid="psa-info"]')?.textContent,
    number: document.querySelector('[data-testid="result-number"]')?.textContent,
  }));
  const settled = () => E.poll(async () => { const s = (await read()).status; return s && !['loading', 'reading', 'check'].includes(s); }, { message: 'prices settled', timeout: 45000 });

  test('scanned slab: current price and last sold for its grade, all grades, recent sales', T, async () => {
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await settled();
    const v = await read();
    assert.equal(v.status, 'ok');
    assert.equal(v.card, 'Charizard ex #199', "PriceCharting's card name");
    assert.equal(v.chip, 'PSA 10');
    assert.equal(v.current, '$612.99', 'PSA 10 price');
    assert.equal(v.last, '$625.00', 'most recent PSA 10 sale');
    assert.ok(v.grid.some((g) => g.startsWith('BGS 10')) && v.grid.some((g) => g.startsWith('Grade 7')));
    assert.ok(!v.grid.some((g) => g.startsWith('BGS 10 Black')), 'a grade without a price is left out');
    assert.equal(v.sales.length, 3, 'only PSA 10 sales');
    assert.ok(v.sales[0].includes('PSA 10 GEM MINT') && !v.sales.some((s) => /CGC 10|SIR NM/.test(s)));
    const pc = hits.filter((h) => h.url.startsWith('https://www.pricecharting.com/'));
    assert.equal(pc[0].url, 'https://www.pricecharting.com/search-products?q=POKEMON+CHARIZARD+ex+199&type=prices');
    assert.ok(pc.every((h) => !h.referer), 'no referrer sent');
  });

  test('typed PSA number with a PSA API key: card name and population from the cert', T, async () => {
    await env.sw.evaluate(() => chrome.storage.local.set({ psaApiToken: 'test-token-1234567890' }));
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    await expandOtherWays(page);
    await page.fill('#cert-input', '81234567');
    await page.click('#manual-submit');
    // the restored previous result also gets PSA data now that a key is saved: wait for this cert's own prices
    await E.poll(async () => { const x = await read(); return x.number === '81234567' && x.status === 'ok' && Boolean(x.pop); }, { message: 'prices for 81234567', timeout: 45000 });
    const v = await read();
    assert.equal(v.status, 'ok');
    assert.equal(v.chip, 'PSA 10', 'grade from the cert');
    assert.equal(v.current, '$612.99');
    assert.match(v.pop, /1,234/);
    const api = hits.find((h) => h.url.endsWith('/GetByCertNumber/81234567'));
    assert.equal(api?.auth, 'bearer test-token-1234567890');
  });

  test("PriceCharting's bot check: read once in an inactive tab (setting on); with the setting off no tab, the panel reports it", T, async () => {
    const files = Object.fromEntries(await Promise.all(['challenge', 'search', 'product'].map(async (f) => [f, await readFile(path.join(FX, `${f}.html`), 'utf8')])));
    const r = await page.evaluate(async ({ files }) => {
      const { loadPrices } = await import('/sidepanel/priceData.js');
      const run = async (allowTab) => {
        const log = [];
        const tabs = new Map();
        const fetchImpl = async (url) => { log.push(`fetch ${url}`); return new Response(files.challenge, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }); };
        const chromeApi = {
          permissions: { contains: async () => true },
          tabs: {
            create: async ({ url, active }) => { log.push(`tab ${url} active=${active}`); tabs.set(tabs.size + 1, url); return { id: tabs.size }; },
            remove: async (id) => { log.push(`close ${id}`); },
          },
          scripting: {
            executeScript: async ({ target }) => {
              const url = tabs.get(target.tabId);
              return [{ result: { url, challenge: false, ready: true, html: url.includes('/search-products') ? files.search : files.product } }];
            },
          },
        };
        const stages = [];
        const res = await loadPrices({ query: 'Charizard ex 199', cardNo: '199', grader: 'psa', grade: '9', allowTab, onStage: (s) => stages.push(s) }, { fetchImpl, chromeApi });
        return { status: res.status, current: res.current?.price ?? null, log, stages };
      };
      return { off: await run(false), on: await run(true) };
    }, { files });
    assert.equal(r.off.status, 'challenge');
    assert.ok(r.off.log.every((l) => l.startsWith('fetch ')), `setting off: no tab, only the fetch: ${r.off.log.join(', ')}`);
    assert.equal(r.on.status, 'ok');
    assert.equal(r.on.current, 212.75, 'Grade 9 price read from the tab');
    assert.deepEqual(r.on.stages, ['check', 'check'], 'the panel shows "checking" while the tab reads');
    const tabsOpened = r.on.log.filter((l) => l.startsWith('tab '));
    assert.equal(tabsOpened.length, 2, 'search page and product page');
    assert.ok(tabsOpened.every((l) => l.endsWith('active=false')), 'inactive tabs');
    assert.equal(r.on.log.filter((l) => l.startsWith('close ')).length, 2, 'every tab closed again');
  });

  test('eBay sales for this card and grade: last sold, median, cheapest Buy It Now, recent sales', T, async () => {
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    const ebay = () => page.evaluate(() => {
      const box = document.querySelector('[data-testid="ebay-sold"]');
      return {
        status: box?.dataset.status, hidden: box?.hidden,
        last: box?.querySelector('[data-testid="ebay-last"]')?.textContent,
        median: box?.querySelector('[data-testid="ebay-median"]')?.textContent,
        low: box?.querySelector('[data-testid="ebay-low"]')?.textContent,
        rows: [...(box?.querySelectorAll('[data-testid="ebay-sales"] li') ?? [])].map((li) => li.textContent),
        urls: [...(box?.querySelectorAll('[data-action="ebay-item"]') ?? [])].map((b) => b.dataset.url),
      };
    });
    await E.poll(async () => !['', 'loading', 'check', undefined].includes((await ebay()).status), { message: 'eBay settled', timeout: 45000 });
    const v = await ebay();
    assert.equal(v.status, 'ok');
    assert.ok(!v.hidden);
    assert.equal(v.last, '$625.00', 'newest PSA 10 sale');
    assert.equal(v.median, '$605.00', 'median of the 4 matching sales');
    assert.equal(v.low, '$649.99', 'cheapest PSA 10 Buy It Now');
    assert.equal(v.rows.length, 4, 'PSA 9, the lot and results below "fewer words" left out');
    assert.ok(v.rows[0].includes('$625.00') && v.rows[3].includes('$590.00'));
    assert.ok(v.urls.every((u) => /^https:\/\/www\.ebay\.com\/itm\/\d{9,15}$/.test(u)), 'clean item links');
    // the restored previous result (same card) may have started the same searches during the reload: count distinct URLs
    const eb = hits.filter((h) => h.url.startsWith('https://www.ebay.com/'));
    assert.equal(new Set(eb.map((h) => h.url)).size, 2, 'one sold search, one Buy It Now search');
    for (const h of eb) {
      const u = new URL(h.url);
      assert.equal(u.pathname, '/sch/i.html');
      assert.match(u.searchParams.get('_nkw'), /CHARIZARD ex 199 PSA 10/);
      assert.ok(!/\d{8,}/.test(u.search), `no cert number sent to eBay: ${h.url}`);
      assert.ok(!h.referer, 'no referrer sent');
    }
  });

  test("eBay's bot check: read once in an inactive tab (setting on); with the setting off the panel reports it", T, async () => {
    const files = Object.fromEntries(await Promise.all(['challenge', 'sold', 'active'].map(async (f) => [f, await readFile(path.join(EBAY, `${f}.html`), 'utf8')])));
    const r = await page.evaluate(async ({ files }) => {
      const { loadEbay } = await import('/sidepanel/ebayData.js');
      const run = async (allowTab, desc) => {
        const log = [];
        const tabs = new Map();
        const fetchImpl = async (url) => { log.push(`fetch ${url}`); return new Response(files.challenge, { status: 200, headers: { 'content-type': 'text/html' } }); };
        const chromeApi = {
          permissions: { contains: async () => true },
          tabs: {
            create: async ({ url, active }) => { log.push(`tab active=${active}`); tabs.set(tabs.size + 1, url); return { id: tabs.size }; },
            remove: async (id) => { log.push(`close ${id}`); },
          },
          scripting: {
            executeScript: async ({ target }) => {
              const url = tabs.get(target.tabId);
              return [{ result: { url, challenge: false, ready: true, html: new URL(url).searchParams.get('LH_Sold') ? files.sold : files.active } }];
            },
          },
        };
        const res = await loadEbay({ site: 'com', grader: 'psa', grade: '10', desc, allowTab }, { fetchImpl, chromeApi });
        return { status: res.status, count: res.overview?.count ?? null, low: res.overview?.forSale?.low.price.value ?? null, log };
      };
      return { off: await run(false, 'Pokemon 151 Charizard ex 199'), on: await run(true, 'Pokemon 151 Charizard ex 199') };
    }, { files });
    assert.equal(r.off.status, 'blocked');
    assert.ok(r.off.log.every((l) => l.startsWith('fetch ')), `setting off: no tab: ${r.off.log.join(', ')}`);
    assert.equal(r.on.status, 'ok');
    assert.equal(r.on.count, 4);
    assert.equal(r.on.low, 649.99);
    assert.deepEqual(r.on.log.filter((l) => l.startsWith('tab ')), ['tab active=false', 'tab active=false']);
    assert.equal(r.on.log.filter((l) => l.startsWith('close ')).length, 2, 'every tab closed again');
  });

  test('number from a QR code: the card name is still read from the label (text-size pass)', T, async () => {
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'cgc-comic-qr.png')));
    assert.equal(r.number, '4012347003');
    await settled();
    assert.ok(hits.some((h) => h.url === 'https://www.pricecharting.com/search-products?q=Amazing+Spider-Man+300&type=prices'), 'searched by the name read from the label');
  });

  test('Pokémon slab with a PokemonPriceTracker key: value from its API (eBay sales per grade), not PriceCharting', T, async () => {
    const ppt = [];
    const body = await readFile(path.join(E.FIXTURES, 'pokemonpricetracker', 'cards-charizard.json'), 'utf8');
    await env.context.route('https://www.pokemonpricetracker.com/**', (route) => {
      ppt.push({ url: route.request().url(), auth: route.request().headers().authorization });
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    await env.sw.evaluate(() => chrome.storage.local.set({ pptApiToken: 'ppt_test_token_1234567890' }));
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    const pcBefore = hits.filter((h) => h.url.startsWith('https://www.pricecharting.com/')).length;
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await E.poll(async () => { const x = await read(); return x.status === 'ok' && x.current === '$601.50'; }, { message: 'PokemonPriceTracker value', timeout: 45000 });
    const v = await page.evaluate(() => ({
      source: document.querySelector('[data-ref="value-source"]')?.textContent,
      second: document.querySelector('[data-testid="price-last-sold"]')?.textContent,
      pcOpen: !document.querySelector('[data-testid="price-pc-open"]')?.hidden,
    }));
    assert.match(v.source, /PokemonPriceTracker/);
    assert.equal(v.second, '$598.00', 'median sold in PSA 10 (plan without single sales)');
    assert.ok(!v.pcOpen, 'no "View on PriceCharting" for this source');
    assert.equal(ppt.length, 1);
    assert.match(ppt[0].url, /^https:\/\/www\.pokemonpricetracker\.com\/api\/v2\/cards\?search=CHARIZARD\+ex\+199&limit=2&includeEbay=true$/);
    assert.equal(ppt[0].auth, 'Bearer ppt_test_token_1234567890');
    assert.equal(hits.filter((h) => h.url.startsWith('https://www.pricecharting.com/')).length, pcBefore, 'PriceCharting not asked');
    await env.sw.evaluate(() => chrome.storage.local.remove('pptApiToken'));
  });

  test('grade not read: the eBay block offers "Choose grade", which opens Change with the grade list focused', T, async () => {
    await env.sw.evaluate(() => chrome.storage.local.remove('psaApiToken'));
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    await expandOtherWays(page);
    await page.fill('#cert-input', '81234570');
    await page.click('#manual-submit');
    await E.poll(async () => page.evaluate(() => document.querySelector('[data-testid="ebay-sold"]')?.dataset.status === 'need-grade'), { message: 'eBay needs the grade' });
    const before = await page.evaluate(() => ({ pick: document.querySelector('[data-testid="ebay-pick"]')?.textContent, hidden: document.querySelector('[data-testid="ebay-pick"]')?.hidden, fields: document.getElementById('price-fields')?.hidden }));
    assert.equal(before.hidden, false);
    assert.equal(before.pick, 'Choose grade');
    await page.click('[data-testid="ebay-pick"]');
    const after = await page.evaluate(() => ({ fields: document.getElementById('price-fields')?.hidden, focus: document.activeElement?.id }));
    assert.equal(after.fields, false, 'Change is open');
    assert.equal(after.focus, 'price-grade', 'the grade list has the focus');
    const error = () => page.evaluate(() => document.getElementById('price-error')?.textContent ?? '');
    await page.click('[data-testid="price-show"]');
    assert.match(await error(), /card name/, 'no card name: asks for it first');
    await page.fill('[data-testid="price-card"]', 'Charizard ex 199');
    await page.click('[data-testid="price-show"]');
    assert.match(await error(), /Choose the grade/, 'then for the grade');
    await page.selectOption('[data-testid="price-grade"]', '10');
    await page.click('[data-testid="price-show"]');
    await E.poll(async () => page.evaluate(() => !['need-grade', 'need-card', 'loading', 'check'].includes(document.querySelector('[data-testid="ebay-sold"]')?.dataset.status)), { message: 'card and grade applied' });
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="ebay-sold"] h3')?.textContent), 'eBay sales · PSA\u00a010');
    assert.equal(await page.evaluate(() => document.getElementById('price-fields')?.hidden), true, 'Show value closes Change');
  });

  test('Change: a new grade applies on "Show value" (form closes, value of that grade); the list has the slab\'s grades only', T, async () => {
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await settled();
    assert.equal((await read()).current, '$612.99');
    await page.click('[data-testid="price-edit"]');
    const options = await page.evaluate(() => [...document.querySelectorAll('[data-testid="price-grade"] option')].map((o) => o.textContent));
    assert.ok(!options.includes('All grades') && options.includes('PSA 9') && options.includes('PSA 10'), options.join(', '));
    await page.selectOption('[data-testid="price-grade"]', '9');
    await E.sleep(800);
    assert.equal((await read()).current, '$612.99', 'picking a grade alone changes nothing yet');
    await page.click('[data-testid="price-show"]');
    await E.poll(async () => (await read()).current === '$212.75', { message: 'PSA 9 value after Show value' });
    const v = await page.evaluate(() => ({ fields: document.getElementById('price-fields')?.hidden, label: document.querySelector('[data-ref="pc-label"]')?.textContent, ebay: document.querySelector('[data-testid="ebay-sold"] h3')?.textContent, focus: document.activeElement?.dataset.testid }));
    assert.equal(v.fields, true, 'Change closed');
    assert.equal(v.label, 'Current price · PSA\u00a09');
    assert.equal(v.ebay, 'eBay sales · PSA\u00a09');
    assert.equal(v.focus, 'price-edit', 'focus back on "Wrong card or grade? Change"');
  });
});
