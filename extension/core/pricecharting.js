// PriceCharting link (ADR A25): the panel opens PriceCharting's search for the card in a new tab, on a click. Nothing is
// fetched or read from PriceCharting any more: its terms don't allow other software to show its prices.

export const PC_ORIGIN = 'https://www.pricecharting.com';
export const PC_HOST = 'www.pricecharting.com';

const MAX_TEXT = 140;
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** Search link; with a single match PriceCharting redirects straight to the product page. The year is left out. */
export function searchUrl(query) {
  const q = clean(query).replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) throw new RangeError('empty query');
  return `${PC_ORIGIN}/search-products?${new URLSearchParams({ q, type: 'prices' }).toString()}`;
}

/** Only https PriceCharting search pages (what the panel opens). */
export function isPcUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === PC_HOST && !u.username && !u.password && !u.port && u.pathname === '/search-products';
  } catch { return false; }
}
