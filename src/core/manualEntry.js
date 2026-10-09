// Pure manual-entry parser (ADR-001 §6): "PSA 12345678", "cgc cards 1401234567890", "4012345-001",
// or an official cert URL. No chrome, no DOM.
import { DEFAULT_RULES } from './certRules.js';
import { parseQrPayload } from './certUrls.js';

export const MAX_MANUAL_CHARS = 2048;

/**
 * @typedef {{ok:true, grader:import('./types.js').Grader|null, graderOptions:import('./types.js').Grader[], number:string}
 *   | {ok:false, error:'empty'|'too-long'|'no-number'|'bad-length'|'invalid'|'untrusted-url'}} ManualEntryResult
 */

const FILLER = new Set(['CERT', 'CERTIFICATION', 'CERTIFICATE', 'NO', 'NR', 'NUMBER', 'NUMMER', 'CERTNUMMER', '#']);

function rankByTie(graders, length, rules) {
  const tie = rules.TIE_ORDER[length] ?? rules.TIE_ORDER.default;
  return [...graders].sort((a, b) => tie.indexOf(a) - tie.indexOf(b));
}

/** @returns {ManualEntryResult} */
export function parseManualEntry(input, rules = DEFAULT_RULES) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'empty' };
  if (input.length > MAX_MANUAL_CHARS) return { ok: false, error: 'too-long' };
  const text = input.trim();

  // URLs: only official ones are accepted; the URL is rebuilt later by buildCertUrl().
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text)) {
    const qr = parseQrPayload(text);
    if (qr.kind === 'official') return { ok: true, grader: qr.grader, graderOptions: [qr.grader], number: qr.number };
    return { ok: false, error: 'untrusted-url' };
  }

  const tokens = text.toUpperCase().replace(/[:,]/g, ' ').replace(/#/g, ' # ').split(/\s+/).filter(Boolean);
  let brand = null; // 'psa' | 'cgc'
  let kind = null;  // 'cards' | 'comics'
  const rest = [];
  for (const t of tokens) {
    if (t === 'PSA' || t === 'PSA/DNA') brand = 'psa';
    else if (t === 'CGC') brand ??= 'cgc';
    else if (/^(CARDS?|TCG)$/.test(t)) kind = 'cards';
    else if (/^(COMICS?|MAGAZINES?)$/.test(t)) kind = 'comics';
    else if (!FILLER.has(t)) rest.push(t);
  }
  const body = rest.join(' ');
  if (!body) return { ok: false, error: 'no-number' };
  if (!/^[\d\s-]+$/.test(body)) return /\d/.test(body) ? { ok: false, error: 'invalid' } : { ok: false, error: 'no-number' };

  let number;
  let dash = false;
  const compact = body.replace(/\s+/g, '');
  const m = rules.DASH_FORM.re.exec(compact);
  if (m && m[0] === compact) { number = m[1] + m[2]; dash = true; } else number = compact.replace(/-/g, '');
  if (!/^\d+$/.test(number)) return { ok: false, error: 'no-number' };

  let allowed = rules.GRADER_IDS;
  if (brand === 'psa') allowed = ['psa'];
  else if (brand === 'cgc') allowed = kind === 'cards' ? ['cgc-cards'] : kind === 'comics' ? ['cgc-comics'] : ['cgc-comics', 'cgc-cards'];
  else if (kind === 'cards') allowed = ['cgc-cards', 'psa'];
  else if (kind === 'comics') allowed = ['cgc-comics'];
  if (dash) allowed = allowed.filter((g) => g === rules.DASH_FORM.grader);

  const fit = allowed.filter((g) => rules.GRADERS[g].lengths.includes(number.length));
  if (!fit.length) return { ok: false, error: 'bad-length' };
  const graderOptions = rankByTie(fit, number.length, rules);
  return { ok: true, grader: fit.length === 1 ? fit[0] : null, graderOptions, number };
}
