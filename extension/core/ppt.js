// PokemonPriceTracker (pokemonpricetracker.com) official API, v2: prices for Pokémon cards from recent eBay sales per
// grade (PSA, BGS, CGC, …), with the user's own API key (user request: "het mag ook iets anders zijn wat makkelijker is
// om prijzen uit op te halen"; ADR A18). Pure helpers only: building the request, choosing the card, reading the JSON.
// The response is validated field by field and every text is cut short; nothing is inserted as HTML.
//
// Documented shape (vendor docs, 2025–2026; field names vary a little between examples, so both spellings are read):
//   GET /api/v2/cards?search=<words>&limit=<n>&includeEbay=true   Authorization: Bearer <key>
//   { data: [ { name, setName, cardNumber, tcgPlayerId, prices: { market },
//               ebay: { salesByGrade: { psa10: { count, medianPrice, averagePrice, minPrice, maxPrice,
//                                               smartMarketPrice: { price, confidence }, lastSaleDate }, cgc9_5: … },
//                       soldListings?: { psa10: [ { title, price, soldDate } ] } } } ] }
// Costs (vendor docs): 1 credit per card returned, +1 per card for the eBay data. The free key has 100 credits a day.
import { gradeLabel } from './priceLinks.js';

export const PPT_ORIGIN = 'https://www.pokemonpricetracker.com';
export const PPT_PERMISSION = `${PPT_ORIGIN}/*`;
export const PPT_SIGNUP = `${PPT_ORIGIN}/api`;
/** Cards asked per lookup: the best one is picked by card number and name (2 cards = up to 4 credits). */
export const PPT_LIMIT = 2;

const MAX_PRICE = 10_000_000;
const str = (v, max = 120) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const money = (v) => {
  const n = typeof v === 'string' && /^\$?\s*\d[\d,]*(\.\d+)?$/.test(v.trim()) ? Number(v.replace(/[$,\s]/g, '')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n < MAX_PRICE ? Math.round(n * 100) / 100 : null;
};
const count = (v) => (Number.isInteger(v) && v >= 0 && v < 1e7 ? v : null);
const isoDate = (v) => {
  const s = str(v, 40);
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m && !Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`)) ? m[1] : null;
};

/** Pokémon slab? From the label text, the search terms or PSA's brand ("2023 POKEMON SV 151", "Pokémon Sword & Shield"). */
export function isPokemon({ lines = [], desc = '', brand = '' } = {}) {
  return /\bPOK[EÉ]MON\b|\bPKMN\b/i.test([...(Array.isArray(lines) ? lines : []), desc, brand].join(' '));
}

/** Search words for the API: the card name and number without the brand ("POKEMON CHARIZARD ex 199" -> "CHARIZARD ex 199"). */
export function pptSearch(desc) {
  const words = str(desc, 100).replace(/[#()]/g, ' ').split(' ')
    .filter((w) => /[\p{L}\p{N}]/u.test(w) && !/^(POK[EÉ]MON|PKMN|\d{4}|PSA|BGS|CGC|GEM|MINT|MT|NM|HOLO)$/i.test(w));
  return words.join(' ').trim();
}

export function pptUrl(search) {
  const q = new URLSearchParams({ search, limit: String(PPT_LIMIT), includeEbay: 'true' });
  return `${PPT_ORIGIN}/api/v2/cards?${q}`;
}

/**
 * The API's grade key for a slab: company + grade, half grades with "_" (psa10, bgs9_5, cgc10). CGC comics are not on
 * PokemonPriceTracker. null without a usable grade.
 */
export function gradeKey(grader, grade) {
  const company = { psa: 'psa', bgs: 'bgs', 'cgc-cards': 'cgc' }[grader];
  const n = Number(grade);
  if (!company || grade == null || grade === '' || !Number.isFinite(n) || n <= 0 || n > 10) return null;
  return `${company}${String(n).replace('.', '_')}`;
}

const KEY_RE = /^(psa|bgs|cgc|sgc|tag|ace)(10|[1-9](?:[._]5)?)$/i;
const GRADER_OF = { psa: 'psa', bgs: 'bgs', cgc: 'cgc-cards' };
/** "psa10" -> "PSA 10", "cgc9_5" -> "CGC 9.5" (labels match gradeLabel() for the graders CertScanner reads). */
export function keyLabel(key) {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const company = m[1].toLowerCase();
  const grade = m[2].replace('_', '.');
  return GRADER_OF[company] ? gradeLabel(GRADER_OF[company], grade) : `${company.toUpperCase()} ${grade}`;
}

function readGrade(v) {
  if (!v || typeof v !== 'object') return null;
  const median = money(v.medianPrice ?? v.median);
  const smart = money(v.smartMarketPrice?.price ?? v.smartMarketPrice);
  const g = {
    count: count(v.count ?? v.salesCount), median, average: money(v.averagePrice ?? v.average),
    min: money(v.minPrice), max: money(v.maxPrice), smart, lastDate: isoDate(v.lastSaleDate ?? v.lastSold),
  };
  return g.median || g.smart || g.average ? g : null;
}

function readSales(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map((s) => ({
    date: isoDate(s?.soldDate ?? s?.date ?? s?.endTime ?? s?.saleDate) ?? '',
    title: str(s?.title, 160),
    price: money(s?.price ?? s?.soldPrice ?? s?.totalPrice),
  })).filter((s) => s.price && s.date).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 10);
}

/** The cards array of an answer: {data:[…]}, {data:{…}}, {cards:[…]}, {results:[…]} or a bare array. */
export function pptList(json) {
  const d = json?.data ?? json?.cards ?? json?.results ?? json;
  if (Array.isArray(d)) return d;
  return d && typeof d === 'object' && (d.name || d.cardName) ? [d] : [];
}

/**
 * The per-grade object of a card. Documented at ebay.salesByGrade; other places are searched too (a few levels deep)
 * for an object whose keys look like grades ("psa10", "cgc9_5") and whose values carry prices.
 */
function findGradeMap(c) {
  const direct = c?.ebay?.salesByGrade ?? c?.salesByGrade ?? c?.ebay?.graded ?? c?.graded;
  if (direct && typeof direct === 'object') return direct;
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3 || seen.has(o)) return null;
    seen.add(o);
    const keys = Object.keys(o).slice(0, 60);
    if (keys.some((k) => KEY_RE.test(String(k).toLowerCase().replace('.', '_')) && readGrade(o[k]))) return o;
    for (const k of keys) { const hit = walk(o[k], depth + 1); if (hit) return hit; }
    return null;
  };
  return walk(c, 0);
}

/** API JSON -> cards (at most 10), each with its grades and, when the plan includes them, single sales. */
export function parsePptCards(json) {
  return pptList(json).slice(0, 10).map((c) => {
    const grades = {};
    const sold = {};
    const byGrade = findGradeMap(c);
    if (byGrade && typeof byGrade === 'object') {
      for (const [k, v] of Object.entries(byGrade)) {
        const key = String(k).toLowerCase().replace('.', '_');
        const g = KEY_RE.test(key) ? readGrade(v) : null;
        if (g) grades[key] = g;
      }
    }
    const listings = c?.ebay?.soldListings ?? c?.soldListings;
    if (listings && typeof listings === 'object') {
      for (const [k, v] of Object.entries(listings)) {
        const key = String(k).toLowerCase().replace('.', '_');
        const rows = KEY_RE.test(key) ? readSales(v) : [];
        if (rows.length) sold[key] = rows;
      }
    }
    return {
      name: str(c?.name ?? c?.cardName ?? c?.title, 100),
      set: str(c?.setName ?? c?.set?.name ?? c?.expansion?.name ?? (typeof c?.set === 'string' ? c.set : ''), 100),
      number: str(c?.cardNumber ?? c?.number ?? c?.localId ?? c?.collectorNumber, 20),
      raw: money(c?.prices?.market ?? c?.prices?.marketPrice ?? c?.marketPrice ?? c?.prices?.raw),
      grades, sold,
    };
  }).filter((c) => c.name);
}

const words = (s) => new Set(str(s, 200).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1));
const leadNumber = (s) => /^0*(\d+)/.exec(String(s ?? '').trim())?.[1] ?? null;

/**
 * Best card for the search: the card number has to match when known (and the answer has numbers at all); then the
 * most shared name words.
 */
export function bestPptCard(cards, { desc, cardNo = null } = {}) {
  const want = words(desc);
  const no = cardNo && cards.some((c) => leadNumber(c.number)) ? leadNumber(cardNo) : null;
  let best = null;
  let bestScore = -1;
  for (const c of cards) {
    if (no && leadNumber(c.number) !== no) continue;
    const have = words(`${c.name} ${c.set}`);
    let score = 0;
    for (const w of want) if (have.has(w)) score += 1;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return bestScore > 0 || (best && no) ? best : null;
}

const ORDER = ['psa', 'bgs', 'cgc', 'sgc', 'tag', 'ace'];
const sortKeys = (a, b) => {
  const [, ca, ga] = KEY_RE.exec(a);
  const [, cb, gb] = KEY_RE.exec(b);
  const ia = ORDER.indexOf(ca.toLowerCase());
  const ib = ORDER.indexOf(cb.toLowerCase());
  return ia - ib || Number(ga.replace('_', '.')) - Number(gb.replace('_', '.'));
};

/**
 * Card + slab grade -> the panel's price result (same shape as the PriceCharting result):
 * current = PokemonPriceTracker's market price for that grade (its "smart" price, else the median sale);
 * lastSold = the newest single sale when the plan returns them, else soldSummary (median, count, last sale date).
 */
export function pptResult(card, { grader, grade }) {
  const key = gradeKey(grader, grade);
  const label = key ? keyLabel(key) : '';
  const g = key ? card.grades[key] : null;
  const prices = [
    ...(card.raw ? [{ label: 'Ungraded', price: card.raw }] : []),
    ...Object.keys(card.grades).sort(sortKeys).map((k) => ({ label: keyLabel(k), price: card.grades[k].smart ?? card.grades[k].median ?? card.grades[k].average })),
  ].filter((p) => p.label && p.price);
  const rows = (key && card.sold[key]) || [];
  return {
    status: 'ok', source: 'ppt', url: null,
    name: [card.name, card.number && `#${card.number.replace(/^#/, '')}`].filter(Boolean).join(' '),
    set: card.set,
    prices,
    current: g ? { label, price: g.smart ?? g.median ?? g.average } : null,
    lastSold: rows[0] ?? null,
    soldSummary: g && !rows.length ? { median: g.median ?? g.average, count: g.count, lastDate: g.lastDate } : null,
    sales: rows.length ? { label, rows: rows.map((r) => ({ ...r, source: 'eBay' })) } : null,
    labels: label ? [label] : [],
  };
}
