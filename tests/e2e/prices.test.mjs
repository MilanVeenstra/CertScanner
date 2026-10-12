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
    pop: document.querySelector('[data-ref="pc-pop"]')?.hidden ? null : document.querySelector('[data-ref="pc-pop"]')?.textContent,
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

  test("PriceCharting's bot check: the panel reports it and opens no tab by itself (user opens PriceCharting, then Try again)", T, async () => {
    const challenge = await readFile(path.join(FX, 'challenge.html'), 'utf8');
    const r = await page.evaluate(async ({ challenge }) => {
      const { loadPrices } = await import('/sidepanel/priceData.js');
      const log = [];
      const fetchImpl = async (url) => { log.push(`fetch ${url}`); return new Response(challenge, { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } }); };
      const chromeApi = {
        permissions: { contains: async () => true },
        tabs: { create: async ({ url }) => { log.push(`tab ${url}`); return { id: 1 }; }, remove: async () => {} },
        scripting: { executeScript: async () => { log.push('script'); return []; } },
      };
      const res = await loadPrices({ query: 'Charizard ex 199', cardNo: '199', grader: 'psa', grade: '9' }, { fetchImpl, chromeApi });
      return { status: res.status, log };
    }, { challenge });
    assert.equal(r.status, 'challenge');
    assert.ok(r.log.every((l) => l.startsWith('fetch ')), `no tab and no script, only the fetch: ${r.log.join(', ')}`);
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
});
