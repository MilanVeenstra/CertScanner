// Grade check estimate: combines the measured centering caps with an optional condition check (corners, edges,
// surface) into a range per grader, with the reasons. Pure. Never a single "the grade": always a range or a cap.
import { centeringCaps, GRADER_ORDER } from './gradeStandards.js';

export const CONDITION_AREAS = Object.freeze(['corners', 'edges', 'surface']);

/** Qualitative wear ratings (vision-LLM provider) mapped onto the 1-10 scale. */
export const RATING_SCORE = Object.freeze({ none: 10, minor: 9, moderate: 7, heavy: 4 });

const floorHalf = (v) => Math.floor(v * 2 + 1e-9) / 2;
const roundHalf = (v) => Math.round(v * 2) / 2;
const clampGrade = (v) => Math.max(1, Math.min(10, v));

/**
 * Normalise a condition result: each area a score 1-10 or null (not assessed).
 * @param {{corners?:number|null, edges?:number|null, surface?:number|null}|null} c
 */
export function normalizeCondition(c) {
  if (!c) return null;
  const out = {};
  let any = false;
  for (const a of CONDITION_AREAS) {
    const v = Number(c[a]);
    out[a] = c[a] !== null && c[a] !== undefined && Number.isFinite(v) ? clampGrade(v) : null;
    if (out[a] !== null) any = true;
  }
  return any ? out : null;
}

/** Beckett-style overall from four subgrades: 9.5 needs three 9.5s and none under 9; else near the lowest. */
export function bgsOverall(subs) {
  const s = [...subs].sort((a, b) => a - b);
  const lowest = s[0];
  const mean = s.reduce((a, v) => a + v, 0) / s.length;
  if (s.every((v) => v === 10)) return 10;
  if (lowest >= 9.5 && s.filter((v) => v === 10).length >= 3) return 10;
  if (lowest >= 9 && s.filter((v) => v >= 9.5).length >= 3) return 9.5;
  return Math.min(lowest + 0.5, floorHalf(mean));
}

/**
 * @param {{front?:object|null, back?:object|null, condition?:object|null}} o
 *   front/back: measured centering {lr, tb} per side (null when not measured); condition: {corners, edges, surface}
 * @returns {{caps:object, condition:object|null, graders:Record<string, {low:number|null, high:number|null,
 *   centeringCap:number|null, possible:number|null, sub?:object, reasons:{key:string, subs:string[], areas?:string[]}[]}>}}
 */
export function estimateGrades({ front = null, back = null, condition = null } = {}) {
  const caps = centeringCaps({ front, back });
  const cond = normalizeCondition(condition);
  const condScores = cond ? CONDITION_AREAS.map((a) => cond[a]).filter((v) => v !== null) : [];
  const condMin = condScores.length ? Math.min(...condScores) : null;
  const unassessed = cond ? CONDITION_AREAS.filter((a) => cond[a] === null) : [...CONDITION_AREAS];
  const graders = {};
  for (const id of GRADER_ORDER) {
    const c = caps[id];
    const reasons = [];
    if (c.cap !== null || c.possible !== null) {
      reasons.push({ key: c.limitedBy === 'back' ? 'grade_reason_centering_back' : 'grade_reason_centering', subs: [String(c.cap ?? c.possible)] });
    }
    if (!c.backChecked && (front?.lr || front?.tb)) reasons.push({ key: 'grade_reason_no_back', subs: [] });
    let low = null; let high = null; let sub;
    const centerTop = c.cap ?? (c.below ? null : 10);
    if (id === 'bgs') {
      const cent = c.cap;
      if (cent !== null && condMin !== null) {
        // Subgrades: centering measured here, the others from the check (null where it couldn't judge).
        const known = CONDITION_AREAS.map((a) => (cond[a] === null ? null : roundHalf(cond[a])));
        sub = { centering: cent, corners: known[0], edges: known[1], surface: known[2] };
        // An area not judged could be anything from perfect to a grade under the worst one seen.
        high = bgsOverall([cent, ...known.map((v) => v ?? 10)]);
        const worst = bgsOverall([cent, ...known.map((v) => v ?? Math.max(1, roundHalf(condMin) - 1))]);
        low = Math.max(1, unassessed.length ? Math.min(worst, high - 0.5) : high - 0.5);
      }
    } else if (condMin !== null && centerTop !== null) {
      const step = id === 'cgc' ? floorHalf : Math.floor;
      high = clampGrade(Math.min(centerTop, step(condMin + 0.25)));
      // Not every area could be judged: the range opens one grade further down.
      low = clampGrade(high - (unassessed.length ? 2 : 1));
    }
    if (cond) {
      for (const a of CONDITION_AREAS) if (cond[a] !== null && cond[a] < 10) reasons.push({ key: `grade_reason_${a}`, subs: [String(roundHalf(cond[a]))] });
      if (unassessed.length) reasons.push({ key: 'grade_reason_unassessed', subs: [], areas: unassessed });
    }
    graders[id] = { low, high, centeringCap: c.cap, possible: c.possible, below: c.below, sub, reasons };
  }
  return { caps, condition: cond, graders };
}
