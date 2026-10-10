// A9 page scan: pure aggregation of per-image scan results and page-level routing. No chrome, no DOM.
import { DEFAULT_RULES } from './certRules.js';
import { isValidCert } from './certUrls.js';

/**
 * Merge candidates from every scanned image by grader+number (max confidence; the best read's image index is kept
 * for the thumbnail). `seenIn` lists every image the number was read from.
 * @param {{index:number, candidates:import('./types.js').CertCandidate[], warnings:import('./types.js').ScanWarning[]}[]} perImage
 */
export function aggregatePage(perImage) {
  const byKey = new Map();
  const warnings = [];
  for (const p of Array.isArray(perImage) ? perImage : []) {
    const qr = (p.warnings ?? []).filter((w) => w && w.code === 'qr-untrusted-host');
    for (const w of qr) if (!warnings.some((x) => x.detail === w.detail)) warnings.push({ code: w.code, detail: w.detail });
    for (const c of p.candidates ?? []) {
      if (!c || typeof c.number !== 'string') continue;
      const key = `${c.grader ?? '?'}:${c.number}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, {
          grader: c.grader, graderOptions: [...(c.graderOptions ?? [])], number: c.number, confidence: c.confidence,
          source: c.source, evidence: [...(c.evidence ?? [])], imageIndex: p.index, seenIn: [p.index], qrUntrusted: qr.length > 0,
        });
        continue;
      }
      if (!prev.seenIn.includes(p.index)) prev.seenIn.push(p.index);
      prev.seenIn.sort((a, b) => a - b);
      prev.qrUntrusted ||= qr.length > 0;
      if (c.confidence > prev.confidence) {
        Object.assign(prev, { confidence: c.confidence, source: c.source, evidence: [...(c.evidence ?? [])], imageIndex: p.index, graderOptions: [...(c.graderOptions ?? [])] });
      }
    }
  }
  const items = [...byKey.values()].sort((a, b) => (b.confidence - a.confidence) || (a.number < b.number ? -1 : 1));
  return { items, warnings };
}

/**
 * Page routing (A9): auto-open only when exactly one grader+number is confident (known grader, >= 0.80), no other
 * read from any image scores >= 0.50, its images had no off-site QR, and autoOpen is on.
 * @returns {{status:'auto-open'|'page-results'|'none', item:object|null}}
 */
export function decidePage(agg, settings, rules = DEFAULT_RULES) {
  const items = agg?.items ?? [];
  if (!items.length) return { status: 'none', item: null };
  const T = rules.SCORE.thresholds;
  const confident = items.filter((i) => i.grader && isValidCert(i.grader, i.number) && i.confidence >= T.autoOpen && i.source !== 'manual');
  const top = confident[0];
  const ok = settings?.autoOpen === true
    && confident.length === 1
    && !top.qrUntrusted
    && !items.some((i) => i !== top && i.confidence >= T.competitor);
  return ok ? { status: 'auto-open', item: top } : { status: 'page-results', item: null };
}
