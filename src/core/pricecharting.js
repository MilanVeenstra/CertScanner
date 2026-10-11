// Reading PriceCharting pages (user request 2026-10-11: "altijd de prijs en last sold laten zien, zoals op PriceCharting").
// Pure functions over a parsed Document (DOMParser in the side panel): nothing here fetches, and nothing from the page
// is ever inserted as HTML; only short text values leave this module.
// PriceCharting has no public sales API (its paid API only has current values), so the panel reads the same public
// product page a user would open. PriceCharting sits behind Cloudflare's bot check: requests need the browser's
// cookies, and the first visit may need a real tab (sidepanel/priceData.js). The markup is undocumented; the selectors
// below follow a saved real page (tests/fixtures/pricecharting) and parsing stays defensive.

export const PC_ORIGIN = 'https://www.pricecharting.com';
export const PC_HOST = 'www.pricecharting.com';
export const PC_PERMISSION = `${PC_ORIGIN}/*`;

const MAX_TEXT = 140;
const MAX_SALES = 8;
const MAX_PRICES = 20;

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
export function gradeLabels(grader, grade, special = null) {
  if (grade == null || grade === '') return [];
  const n = Number(grade);
  if (!Number.isFinite(n)) return [];
  if (n === 10 && special === 'Pristine' && grader === 'cgc-cards') return ['CGC 10 Pristine', ...gradeLabels(grader, grade)];
  if (n === 10 && special === 'Black' && grader === 'bgs') return ['BGS 10 Black', ...gradeLabels(grader, grade)];
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

/** "Loose<span> Price</span>" -> "Loose"; "PSA 10 Sold Listings (25)" -> "PSA 10"; "Grade 9 (4)" -> "Grade 9". */
export function labelOf(text) {
  return clean(text).replace(/\s*\(\d[\d,]*\)\s*$/, '').replace(/\s+sold listings$/i, '').replace(/\s+price$/i, '').trim();
}

/** True for Cloudflare's bot check page (shown instead of PriceCharting until the browser passed it). */
export function isChallengePage(doc) {
  const title = clean(doc?.title);
  return /just a moment|attention required|verify you are human/i.test(title)
    || Boolean(doc?.querySelector?.('#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile, script[src*="challenge-platform"]'));
}

/**
 * Product page -> {name, set, prices:[{label, price, text}], sales:{label: [{date, title, price, source}]}}.
 * Markup (verified against a saved PriceCharting page, see tests): h1#product_name ("Name <a>Set</a>"),
 * #full-prices table rows "label | td.price", #price_data (th labels over td#used_price ... .price),
 * sold listings in div.completed-auctions-<key>:not(.tab) > table > tbody > tr (td.date, td.title a, td.numeric .js-price),
 * key labels in select#completed-auctions-condition options or div.tab.completed-auctions-<key>.
 */
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
    const l = labelOf(label);
    const price = parsePrice(text);
    if (!l || price === null || l.length > 30 || prices.some((p) => sameLabel(p.label, l))) return;
    prices.push({ label: l, price, text: clean(PRICE_RE.exec(text)?.[0] ?? '') });
  };
  const priceText = (el) => el.querySelector('.price, .js-price')?.textContent ?? el.textContent;
  // 1. Full price guide: every grade with its own label (cards: Ungraded, Grade 1 ... Grade 9.5, PSA 10, BGS 10, CGC 10 ...).
  for (const tr of doc.querySelectorAll('#full-prices tr')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length >= 2) add(tds[0].textContent, priceText(tds[1]));
  }
  // 2. Main price table: header labels over the price cells.
  const table = doc.querySelector('#price_data');
  if (table) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => labelOf(th.textContent));
    const row = table.querySelector('tbody tr');
    [...(row?.querySelectorAll('td') ?? [])].forEach((td, i) => add(heads[i] || PRICE_IDS[td.id], priceText(td)));
  }
  // 3. Fallbacks: known cell ids, then any "grade label | price" row.
  for (const [id, label] of Object.entries(PRICE_IDS)) {
    const el = doc.getElementById(id);
    if (el && !prices.length) add(label, priceText(el));
  }
  if (!prices.length) {
    for (const tr of doc.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td, th')];
      if (cells.length < 2 || !GRADE_LABEL_RE.test(clean(cells[0].textContent))) continue;
      const priced = cells.slice(1).find((c) => parsePrice(c.textContent) !== null);
      if (priced) add(cells[0].textContent, priceText(priced));
    }
  }

  // 4. Sold listings per grade: key -> label from the condition picker or the tab, then each section's rows.
  const keyLabel = {};
  for (const o of doc.querySelectorAll('#completed-auctions-condition option')) {
    const key = /^completed-auctions-(.+)$/.exec(o.getAttribute('value') ?? '')?.[1];
    if (key && labelOf(o.textContent)) keyLabel[key] = labelOf(o.textContent);
  }
  const keyOf = (el) => [...el.classList].find((c) => /^completed-auctions-./.test(c))?.slice('completed-auctions-'.length);
  for (const tab of doc.querySelectorAll('.tab[class*="completed-auctions-"]')) {
    const key = keyOf(tab);
    if (key && !keyLabel[key] && labelOf(tab.textContent)) keyLabel[key] = labelOf(tab.textContent);
  }
  const sales = {};
  for (const sec of doc.querySelectorAll('div[class*="completed-auctions-"]:not(.tab)')) {
    const key = keyOf(sec);
    if (!key) continue;
    const label = keyLabel[key] || SALES_KEYS[key] || key;
    const rows = [];
    for (const tr of sec.querySelectorAll('tbody tr')) {
      const date = DATE_RE.exec(clean(tr.querySelector('td.date')?.textContent))?.[1];
      const priceEl = tr.querySelector('td.numeric .js-price') ?? tr.querySelector('.js-price');
      const price = priceEl ? parsePrice(priceEl.textContent) : null;
      if (!date || price === null) continue;
      const titleCell = tr.querySelector('td.title');
      const title = clean(titleCell?.querySelector('a')?.textContent ?? titleCell?.textContent ?? '').replace(/\s*\[[^\]]+\]\s*$/, '');
      const source = /^([a-z]+)-/.exec(tr.id ?? '')?.[1] ?? (/\[([^\]]+)\]/.exec(titleCell?.textContent ?? '')?.[1]?.toLowerCase() ?? null);
      rows.push({ date, title, price, source });
      if (rows.length >= MAX_SALES) break;
    }
    if (rows.length && !sales[label]) sales[label] = rows;
  }
  return { name, set, prices: prices.slice(0, MAX_PRICES), sales };
}

/** Sales for the first matching grade label, else null (never another grade's sales). */
export function pickSales(sales, labels) {
  for (const l of labels) {
    const key = Object.keys(sales).find((k) => sameLabel(k, l) || norm(k).startsWith(`${norm(l)} `));
    if (key) return { label: key, rows: sales[key] };
  }
  return null;
}

export { isProductUrl };
