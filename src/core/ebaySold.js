// eBay sales overview (ADR A21; user request: "kan je niet gewoon in de extension de last sold op eBay zoeken? Ik wil
// alles in een overzicht kunnen zien"). eBay closed its open sold-items API (Finding API, February 2025; Marketplace
// Insights is limited release), so the panel reads eBay's public search pages on this device, as a normal visit would:
// the sold search (newest first) and the Buy It Now search (cheapest first). The user chose this for personal use,
// knowing eBay's user agreement restricts automated reading.
// Pure helpers: URLs, price and date text in the site's language, which listing is this card in this grade, summary.
// extractListings() takes a parsed (inert) Document and reads text only; nothing is inserted as HTML.
import { EBAY_SITES, DEFAULT_EBAY_SITE, isEbaySite, ebaySearchUrl, gradeQuery, cardNoFrom } from './priceLinks.js';

const GRADER_WORDS = Object.freeze({ psa: ['PSA'], bgs: ['BGS', 'BECKETT'], 'cgc-cards': ['CGC'], 'cgc-comics': ['CGC'] });
const OTHER_GRADERS = ['PSA', 'BGS', 'BECKETT', 'CGC', 'SGC', 'TAG', 'ACE', 'HGA', 'CSG'];
/** Words in a title that mean more than one card, a reprint or a raw card. */
const NOT_SINGLE = /\b(lots?|bundles?|bulk|set of|choose|pick|you pick|x\s?[2-9]|[2-9]\s?x|proxy|reprint|custom|raw|ungraded|digital|orica)\b/i;
const MAX_ITEMS = 60;
const FEWER_WORDS = /fewer words|minder woorden|weniger Suchbegriffe|moins de mots/i;

/** The eBay host of a site key. */
export const ebayHost = (site) => EBAY_SITES[isEbaySite(site) ? site : DEFAULT_EBAY_SITE];
/** Host access to ask for (optional permission). */
export const ebayPermission = (site) => `https://${ebayHost(site)}/*`;
export const isEbayUrl = (url, site) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === ebayHost(site); } catch { return false; } };

/** Sold search, ended listings newest first; Buy It Now search, cheapest first (both: no lots, card + grade words). */
export function ebayUrls(site, { grader, desc, grade }) {
  const q = gradeQuery(grader, desc, grade);
  if (!q) return null;
  const sold = new URL(ebaySearchUrl(site, q, { sold: true, single: true }));
  sold.searchParams.set('_sop', '13');
  sold.searchParams.set('_ipg', '60');
  const active = new URL(ebaySearchUrl(site, q, { single: true }));
  active.searchParams.set('LH_BIN', '1');
  active.searchParams.set('_sop', '15');
  active.searchParams.set('_ipg', '60');
  return { query: q, sold: sold.toString(), active: active.toString() };
}

const SITE_CURRENCY = Object.freeze({ com: 'USD', 'co.uk': 'GBP', de: 'EUR', nl: 'EUR', fr: 'EUR', ca: 'CAD', 'com.au': 'AUD' });
/**
 * "$612.99", "US $612.99", "£1,050.00", "EUR 612,99", "612,99 EUR", "€ 1.050,00", "C $80.00", "AU $95.50" -> {value, currency}.
 * Price ranges ("$5.00 to $9.00") and anything else -> null.
 */
export function parseEbayPrice(text, site = DEFAULT_EBAY_SITE) {
  const s = String(text ?? '').replace(/ /g, ' ').trim();
  if (!s || s.length > 60 || /\s(to|bis|tot|à)\s|\s[-–]\s/i.test(s)) return null;
  let currency = SITE_CURRENCY[isEbaySite(site) ? site : DEFAULT_EBAY_SITE];
  if (/£|GBP/.test(s)) currency = 'GBP';
  else if (/€|EUR/.test(s)) currency = 'EUR';
  else if (/\bC\s?\$|CAD/.test(s)) currency = 'CAD';
  else if (/\bAU\s?\$|AUD/.test(s)) currency = 'AUD';
  else if (/\$|USD/.test(s)) currency = 'USD';
  const m = /\d[\d.,\s]*\d|\d/.exec(s);
  if (!m) return null;
  let n = m[0].replace(/\s/g, '');
  const lastComma = n.lastIndexOf(',');
  const lastDot = n.lastIndexOf('.');
  if (lastComma > lastDot && /,\d{1,2}$/.test(n)) n = n.replace(/\./g, '').replace(',', '.'); // 1.050,00
  else n = n.replace(/,/g, ''); // 1,050.00
  const value = Number(n);
  return Number.isFinite(value) && value > 0 && value < 10_000_000 ? { value: Math.round(value * 100) / 100, currency } : null;
}

const MONTHS = Object.freeze({
  jan: 1, janv: 1, feb: 2, febr: 2, fev: 2, fevr: 2, mar: 3, mrt: 3, mrz: 3, maer: 3, mars: 3, apr: 4, avr: 4, may: 5, mei: 5, mai: 5,
  jun: 6, juin: 6, jul: 7, juil: 7, aug: 8, aou: 8, aout: 8, sep: 9, sept: 9, oct: 10, okt: 10, nov: 11, dec: 12, dez: 12,
});
/** "Oct", "okt", "Okt", "oct", "Mär", "févr", "août" -> month number (accents dropped, longest known prefix wins). */
const monthOf = (w) => {
  const k = w.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return MONTHS[k.slice(0, 5)] ?? MONTHS[k.slice(0, 4)] ?? MONTHS[k.slice(0, 3)] ?? null;
};
const iso = (y, mo, d) => {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

/** The sold marker on a listing: "Sold  Oct 9, 2026", "Sold 9 Oct 2026", "Verkocht 9 okt 2026", "Verkauft 9. Okt. 2026", "Vendu le 9 oct. 2026". */
export const SOLD_RE = /\b(?:Sold|Verkocht|Verkauft|Vendu(?:\s+le)?)\s+([^\n|]{5,30}?\b\d{4})\b/i;

/** Date text of a sold marker -> "2026-10-09", else null. */
export function parseSoldDate(text) {
  const s = String(text ?? '').replace(/ /g, ' ').replace(/\./g, ' ').replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let m = /^([A-Za-zÀ-ÿ]{3,5}) (\d{1,2}) (\d{4})$/.exec(s); // Oct 9 2026
  if (m && monthOf(m[1])) return iso(Number(m[3]), monthOf(m[1]), Number(m[2]));
  m = /^(\d{1,2}) ([A-Za-zÀ-ÿ]{3,6}) (\d{4})$/.exec(s); // 9 Oct 2026, 9 okt 2026, 9 Okt 2026
  if (m && monthOf(m[2])) return iso(Number(m[3]), monthOf(m[2]), Number(m[1]));
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s); // 09/10/2026 (day first outside the US; not used by ebay.com)
  return m ? iso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

const gradeRe = (grade) => {
  const n = Number(grade);
  if (!Number.isFinite(n)) return null;
  if (n === 10) return '10(?:\\.0)?';
  return Number.isInteger(n) ? `${n}(?:\\.0)?` : String(n).replace('.', '\\.');
};

/**
 * Is this listing this card in this grade? The grader's name followed (within a few words, e.g. "PSA GEM MT 10") by the
 * slab's grade, not another grader's grade in the same title, no lots/reprints, and the card number when known.
 */
export function titleMatches(title, { grader, grade, cardNo = null }) {
  const t = ` ${String(title ?? '').replace(/\s+/g, ' ')} `;
  if (!t.trim() || NOT_SINGLE.test(t)) return false;
  const words = GRADER_WORDS[grader];
  const g = gradeRe(grade);
  if (!words || !g) return false;
  const near = new RegExp(`\\b(?:${words.join('|')})\\b(?:\\s+[A-Za-z/.+-]{1,10}){0,3}\\s*${g}(?![\\d.])`, 'i');
  if (!near.test(t)) return false;
  // Another grader in the title too ("PSA 10 like BGS 9.5") or a second grade of the same grader: not one clear slab.
  const others = OTHER_GRADERS.filter((w) => !words.includes(w));
  if (new RegExp(`\\b(?:${others.join('|')})\\s*\\d`, 'i').test(t)) return false;
  const grades = [...t.matchAll(new RegExp(`\\b(?:${words.join('|')})\\b(?:\\s+[A-Za-z/.+-]{1,10}){0,3}\\s*(10(?:\\.0)?|\\d(?:\\.5)?)(?![\\d.])`, 'gi'))].map((x) => Number(x[1]));
  if (grades.some((x) => x !== Number(grade))) return false;
  if (cardNo) {
    const no = String(cardNo).replace(/^0+/, '');
    if (!new RegExp(`(?:^|[^\\d])0*${no}(?:/\\d+)?(?![\\d])`).test(t)) return false;
  }
  return true;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
};

/**
 * Listings of a parsed eBay search page, in page order: {id, url, title, price:{value,currency}|null, soldDate}.
 * Stops at eBay's "results matching fewer words" divider; skips the "Shop on eBay" placeholder.
 */
export function extractListings(doc, site = DEFAULT_EBAY_SITE) {
  const host = ebayHost(site);
  const list = doc.querySelector('ul.srp-results, .srp-river-results ul, #srp-river-results ul');
  const items = list ? [...list.children] : [...doc.querySelectorAll('li.s-item, li.s-card, li[data-listingid]')];
  const out = [];
  for (const li of items) {
    const text = (li.textContent ?? '').replace(/\s+/g, ' ').trim();
    const a = li.querySelector('a[href*="/itm/"]');
    if (!a) {
      if (FEWER_WORDS.test(text)) break; // listings below this divider don't match all search words
      continue;
    }
    const id = /\/itm\/(?:[^/?#]+\/)?(\d{9,15})/.exec(a.getAttribute('href') ?? '')?.[1];
    if (!id) continue;
    let title = (li.querySelector('.s-item__title, .s-card__title, [role="heading"]')?.textContent ?? a.textContent ?? '').replace(/\s+/g, ' ').trim();
    title = title.replace(/^(New listing|Nieuwe aanbieding|Neues Angebot|Nouvelle annonce)\s*/i, '').replace(/\s*(Opens in a new window or tab|Wordt geopend in een nieuw venster of tabblad)\s*$/i, '').slice(0, 200);
    if (!title || /^shop on ebay$/i.test(title)) continue;
    const priceText = li.querySelector('.s-item__price, .s-card__price')?.textContent ?? (/(?:US\s?|C\s?|AU\s?)?[$£€]\s?\d[\d.,]*|\d[\d.,]*\s?(?:EUR|€)/.exec(text)?.[0] ?? '');
    const sold = SOLD_RE.exec(li.querySelector('.s-item__caption--signal, .s-item__caption, .s-card__caption, .POSITIVE, .s-item__ended-date')?.textContent ?? '') ?? SOLD_RE.exec(text);
    out.push({ id, url: `https://${host}/itm/${id}`, title, price: parseEbayPrice(priceText, site), soldDate: sold ? parseSoldDate(sold[1]) : null });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** eBay's bot check or sign-in page instead of results. */
export function isEbayBlocked(doc, url = '') {
  const title = doc?.title ?? '';
  return /pardon our interruption|security measure|sicherheitsma|beveiligingsmaatregel|mesure de s/i.test(title)
    || Boolean(doc?.querySelector?.('#captcha-box, iframe[src*="captcha"], form[action*="captcha"]'))
    || /\/splashui\/(challenge|captcha)|signin\.ebay\./.test(url);
}

/**
 * Sold + for-sale listings -> the overview: matching sales (newest first, at most 10 shown), last sale, median and
 * count of the matching sales, cheapest matching Buy It Now. One currency only (the site's), others are left out.
 */
export function ebayOverview({ sold, active }, { grader, grade, desc = '', site = DEFAULT_EBAY_SITE }) {
  const cardNo = cardNoFrom(desc);
  const currency = SITE_CURRENCY[isEbaySite(site) ? site : DEFAULT_EBAY_SITE];
  const ok = (x) => x.price && x.price.currency === currency && titleMatches(x.title, { grader, grade, cardNo });
  const sales = sold.filter((x) => ok(x) && x.soldDate).sort((a, b) => (a.soldDate < b.soldDate ? 1 : a.soldDate > b.soldDate ? -1 : 0));
  const offers = active.filter(ok).sort((a, b) => a.price.value - b.price.value);
  return {
    currency,
    sales: sales.slice(0, 10),
    count: sales.length,
    last: sales[0] ?? null,
    median: median(sales.map((x) => x.price.value)),
    forSale: offers.length ? { count: offers.length, low: offers[0] } : null,
  };
}
