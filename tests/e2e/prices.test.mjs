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

  before(async () => {
    E.assertBuilt();
    env = await E.launchExtension();
    await env.context.route('https://www.pricecharting.com/**', async (route) => {
      const u = route.request().url();
      hits.push({ url: u, cookie: route.request().headers().cookie ?? null });
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
    grid: [...document.querySelectorAll('[data-testid="price-grid"] li')].map((li) => li.textContent),
    sales: [...document.querySelectorAll('[data-testid="price-sales"] li')].map((li) => li.textContent),
    pop: document.querySelector('[data-ref="pc-pop"]')?.hidden ? null : document.querySelector('[data-ref="pc-pop"]')?.textContent,
  }));
  const settled = () => E.poll(async () => { const s = (await read()).status; return s && s !== 'loading'; }, { message: 'prices settled', timeout: 20000 });

  test('scanned slab: price for its grade, all grades and last sold, without cookies', T, async () => {
    const r = await pasteImage(page, await readFile(path.join(E.FIXTURES, 'psa-8digit-leading-zero.png')));
    assert.equal(r.state, 'auto-open');
    await settled();
    const v = await read();
    assert.equal(v.status, 'ok');
    assert.equal(v.card, 'Charizard ex #199', "PriceCharting's card name");
    assert.equal(v.chip, 'PSA 10');
    assert.equal(v.current, '$612.99', 'PSA 10 price');
    assert.ok(v.grid.some((g) => g.startsWith('BGS 10')) && v.grid.length === 8);
    assert.equal(v.sales.length, 3, 'only PSA 10 sales');
    assert.ok(v.sales.every((s) => /PSA 10/.test(s)));
    const pc = hits.filter((h) => h.url.startsWith('https://www.pricecharting.com/'));
    assert.equal(pc[0].url, 'https://www.pricecharting.com/search-products?q=POKEMON+CHARIZARD+ex+199&type=prices');
    assert.ok(pc.every((h) => !h.cookie), 'no cookies sent');
  });

  test('typed PSA number with a PSA API key: card name and population from the cert', T, async () => {
    await env.sw.evaluate(() => chrome.storage.local.set({ psaApiToken: 'test-token-1234567890' }));
    await page.reload();
    await page.waitForSelector('body[data-ready="1"]', { state: 'attached' });
    await expandOtherWays(page);
    await page.fill('#cert-input', '81234567');
    await page.click('#manual-submit');
    await settled();
    const v = await read();
    assert.equal(v.status, 'ok');
    assert.equal(v.chip, 'PSA 10', 'grade from the cert');
    assert.equal(v.current, '$612.99');
    assert.match(v.pop, /1,234/);
    const api = hits.find((h) => h.url.endsWith('/GetByCertNumber/81234567'));
    assert.equal(api?.auth, 'bearer test-token-1234567890');
  });
});
