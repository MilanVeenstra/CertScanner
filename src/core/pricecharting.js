// Reading PriceCharting pages (user request 2026-10-11: "altijd de prijs en last sold laten zien, zoals op PriceCharting").
// Pure functions over a parsed Document (DOMParser in the side panel): nothing here fetches, and nothing from the page
// is ever inserted as HTML; only short text values leave this module.
// PriceCharting has no public sales API (its paid API only has current values), so the panel reads the same public
// product page a user would open. The markup is not documented: parsing is defensive and returns what it can.

export const PC_ORIGIN = 'https://www.pricecharting.com';
export const PC_HOST = 'www.pricecharting.com';
export const PC_PERMISSION = `${PC_ORIGIN}/*`;

const MAX_TEXT = 140;
const MAX_SALES = 6;
const MAX_PRICES = 16;

/** Price cells of the main price table: id -> label (cards; comics and other categories use their own headers). */
const PRICE_IDS = Object.freeze({
  used_price: 'Ungraded',
  complete_price: 'Grade 7',
  new_price: 'Grade 8',
  graded_price: 'Grade 9',
  box_only_price: 'Grade 9.5',
  manual_only_price: 'PSA 10',
});

/** Sold-listing sections ("completed-auctions-<key>") when no tab label names them. */
const SALES_KEYS = Object.freeze({
  used: 'Ungraded', cib: 'Grade 7', new: 'Grade 8', graded: 'Grade 9', 'box-only': 'Grade 9.5', 'manual-only': 'PSA 10',
});

const GRADE_LABEL_RE = /^(ungraded|grade \d{1,2}(\.\d)?|(psa|bgs|cgc|sgc|tag|ace) \d{1,2}(\.\d)?( (black|pristine))?|\d{1,2}\.\d)$/i;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const PRICE_RE = /(?:US\s?)?\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\$\s?\d+(?:\.\d{1,2})?/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})\b/;

/** "$1,234.50" -> 1234.5 (null when not a price). */
export function parsePrice(text) {
  const m = PRICE_RE.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[0].replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : null;
}

/** Search link; with a single match PriceCharting redirects straight to the product page. */
export function searchUrl(query) {
  const q = clean(query).replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) throw new RangeError('empty query');
  return `${PC_ORIGIN}/search-products?${new URLSearchParams({ q, type: 'prices' }).toString()}`;
}

/** Only https PriceCharting product or search pages (what the panel fetches or opens). */
export function isPcUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === PC_HOST && !u.username && !u.password && !u.port
      && (/^\/game\/[^/]+\/[^/]+\/?$/.test(u.pathname) || u.pathname === '/search-products');
  } catch { return false; }
}

const isProductUrl = (url) => { try { return /^\/game\//.test(new URL(url).pathname); } catch { return false; } };

/** Label a grade for PriceCharting ("PSA 10", "BGS 10", "CGC 10", "Grade 9.5", "9.8"), best first. */
export function gradeLabels(grader, grade) {
  if (grade == null || grade === '') return [];
  const n = Number(grade);
  if (!Number.isFinite(n)) return [];
  const brand = { psa: 'PSA', bgs: 'BGS', 'cgc-cards': 'CGC', 'cgc-comics': 'CGC' }[grader];
  const g = Number.isInteger(n) ? String(n) : String(n);
  const out = [];
  if (n === 10 && brand) out.push(`${brand} 10`);
  if (grader === 'cgc-comics') out.push(n.toFixed(1), `CGC ${n.toFixed(1)}`, `Grade ${n.toFixed(1)}`);
  out.push(`Grade ${g}`);
  if (n === 10) out.push('Grade 10');
  return [...new Set(out)];
}

const norm = (s) => clean(s).toLowerCase().replace(/\s+/g, ' ');
const sameLabel = (a, b) => norm(a) === norm(b);

/** First price whose label matches one of `labels`. */
export function pickPrice(prices, labels) {
  for (const l of labels) {
    const hit = prices.find((p) => sameLabel(p.label, l));
    if (hit) return hit;
  }
  return null;
}

/**
 * Search results page -> best product URL. Rows link to /game/<set>/<card>; the row whose text holds the most query
 * words wins, and a card number ("199") has to match when the query has one.
 */
export function bestSearchResult(doc, query, cardNo = null) {
  const words = norm(query).split(' ').filter((w) => w.length > 1);
  const seen = new Set();
  let best = null;
  for (const a of doc.querySelectorAll('a[href*="/game/"]')) {
    let href;
    try { href = new URL(a.getAttribute('href'), PC_ORIGIN).href; } catch { continue; }
    if (!isPcUrl(href) || !isProductUrl(href) || seen.has(href)) continue;
    seen.add(href);
    const row = a.closest('tr');
    const cells = row ? [...row.querySelectorAll('td, th')].map((c) => c.textContent) : [a.parentElement?.textContent ?? a.textContent];
    const text = norm(cells.join(' '));
    if (cardNo && !new RegExp(`(?:#|\\b)${String(cardNo).replace(/[^\w]/g, '')}(?![\\d])`, 'i').test(text)) continue;
    const score = words.filter((w) => text.includes(w)).length;
    if (!best || score > best.score) best = { href, score };
    if (seen.size >= 60) break;
  }
  return best && best.score > 0 ? best.href : null;
}

/** Product page -> {name, set, prices:[{label, price, text}], sales:{label: [{date, title, price, text}]}}. */
export function parseProduct(doc) {
  const h1 = doc.querySelector('h1#product_name, h1.chart_title, h1');
  let name = '';
  let set = '';
  if (h1) {
    const link = h1.querySelector('a');
    set = clean(link?.textContent);
    name = clean([...h1.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ')) || clean(h1.textContent.replace(set, ''));
  }
  if (!name) name = clean((doc.title || '').split('|')[0].replace(/\bprices?\b/i, ''));

  const prices = [];
  const add = (label, text) => {
    const l = clean(label);
    const price = parsePrice(text);
    if (!l || price === null || l.length > 30 || prices.some((p) => sameLabel(p.label, l))) return;
    prices.push({ label: l, price, text: clean(PRICE_RE.exec(text)?.[0] ?? '') });
  };
  const priceText = (el) => el.querySelector('.price, .js-price')?.textContent ?? el.textContent;
  // 1. Main price table: header labels aligned with the price cells (cards: Ungraded, Grade 7 ... PSA 10).
  const used = new Set();
  const table = doc.querySelector('#price_data');
  if (table) {
    const heads = [...table.querySelectorAll('th')].map((th) => clean(th.textContent));
    const row = [...table.querySelectorAll('tr')].find((tr) => tr.querySelector('td'));
    [...(row?.querySelectorAll('td') ?? [])].forEach((td, i) => {
      add(heads[i] || PRICE_IDS[td.id], priceText(td));
      if (td.id) used.add(td.id);
    });
  }
  for (const [id, label] of Object.entries(PRICE_IDS)) {
    const el = doc.getElementById(id);
    if (el && !used.has(id)) add(label, priceText(el));
  }
  // 2. Any "label | price" rows with a grade label (full price guide: BGS 10, CGC 10, SGC 10, Grade 1-6 ...).
  for (const tr of doc.querySelectorAll('tr')) {
    const cells = [...tr.querySelectorAll('td, th')];
    if (cells.length < 2 || !GRADE_LABEL_RE.test(clean(cells[0].textContent))) continue;
    const priced = cells.slice(1).find((c) => parsePrice(c.textContent) !== null);
    if (priced) add(cells[0].textContent, priceText(priced));
  }

  // 3. Sold listings, per grade section.
  const sales = {};
  for (const sec of doc.querySelectorAll('[class*="completed-auctions-"]')) {
    if (!sec.querySelector('tr')) continue; // a tab, not a section
    const key = [...sec.classList].find((c) => c.startsWith('completed-auctions-'))?.slice('completed-auctions-'.length);
    if (!key) continue;
    const tab = [...doc.querySelectorAll(`[class~="completed-auctions-${CSS_ESCAPE(key)}"]`)].find((el) => el !== sec && !el.querySelector('tr'));
    const label = clean(tab?.textContent) || SALES_KEYS[key] || key;
    const rows = [];
    for (const tr of sec.querySelectorAll('tr')) {
      const text = clean(tr.textContent);
      const date = DATE_RE.exec(tr.querySelector('.date')?.textContent ?? text)?.[1];
      const priceCell = tr.querySelector('.js-price, .numeric, .price') ?? tr;
      const price = parsePrice(priceCell.textContent);
      if (!date || price === null) continue;
      const title = clean(tr.querySelector('.title a, .title, a')?.textContent ?? '');
      rows.push({ date, title, price, text: clean(PRICE_RE.exec(priceCell.textContent)?.[0] ?? '') });
      if (rows.length >= MAX_SALES) break;
    }
    if (rows.length && !sales[label]) sales[label] = rows;
  }
  return { name, set, prices: prices.slice(0, MAX_PRICES), sales };
}

// CSS.escape is not in every test runtime; class keys are plain words and dashes.
const CSS_ESCAPE = (s) => String(s).replace(/[^\w-]/g, '');

/** Sales for the first matching grade label, else null (never another grade's sales). */
export function pickSales(sales, labels) {
  for (const l of labels) {
    const key = Object.keys(sales).find((k) => sameLabel(k, l) || norm(k).startsWith(`${norm(l)} `));
    if (key) return { label: key, rows: sales[key] };
  }
  return null;
}

export { isProductUrl };
