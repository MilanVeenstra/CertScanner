// Pure routing decision (ADR-001 §7 "Auto-open"). No chrome, no DOM.
import { DEFAULT_RULES } from './certRules.js';
import { isValidCert } from './certUrls.js';

/**
 * @param {import('./types.js').CertCandidate[]} candidates
 * @param {import('./types.js').Settings|null} settings
 * @param {import('./types.js').ScanWarning[]} warnings
 * @returns {'auto-open'|'confirm'|'none'}
 */
export function decide(candidates, settings, warnings, rules = DEFAULT_RULES) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && typeof c === 'object') : [];
  if (!list.length) return 'none';
  const sorted = [...list].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const top = sorted[0];
  const T = rules.SCORE.thresholds;
  const untrusted = Array.isArray(warnings) && warnings.some((w) => w && w.code === 'qr-untrusted-host');
  const competitor = sorted.some((c) => c !== top && c.number !== top.number && c.confidence >= T.competitor);
  const ok = settings?.autoOpen === true
    && top.grader != null
    && isValidCert(top.grader, top.number)
    && typeof top.confidence === 'number' && top.confidence >= T.autoOpen
    && !competitor
    && !untrusted
    && top.source !== 'manual';
  return ok ? 'auto-open' : 'confirm';
}
