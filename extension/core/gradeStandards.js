// Centering limits per grader (grade check). Data, not code: a grader changing a limit is an edit here plus a test.
// A limit is the wider border's share of both borders on the worse axis, in % (55 means 55/45). `frontMax` is the
// loose end where the grader's own wording gives a range ("approximately 55/45 to 60/40"); `frontOther` is a limit
// for the better axis too (Beckett: "50/50 one way, 55/45 the other").
// Sources (checked 2026-10): PSA and CGC from their published grading scales; Beckett from collector guides that
// quote its scale (its own page could not be opened), so its rows are marked 'guides'.

export const STANDARDS_AS_OF = '2026-10';

export const GRADERS = Object.freeze({
  psa: Object.freeze({
    name: 'PSA', url: 'https://www.psacard.com/resources/gradingstandards', basis: 'official',
    grades: Object.freeze([
      { grade: 10, front: 55, frontMax: 60, back: 75 },
      { grade: 9, front: 60, frontMax: 65, back: 90 },
      { grade: 8, front: 65, frontMax: 70, back: 90 },
      { grade: 7, front: 70, frontMax: 75, back: 90 },
      { grade: 6, front: 80, back: 90 },
      { grade: 5, front: 85, back: 90 },
    ]),
  }),
  bgs: Object.freeze({
    name: 'BGS', url: 'https://www.beckett.com/grading/scale', basis: 'guides', subgrade: true,
    grades: Object.freeze([
      { grade: 10, front: 50, frontOther: 50, back: 60 },
      { grade: 9.5, front: 55, frontOther: 50, back: 60 },
      { grade: 9, front: 55, back: 70 },
      { grade: 8, front: 60, back: 80 },
      { grade: 7, front: 65, back: 90 },
      { grade: 6, front: 70, back: 95 },
    ]),
  }),
  cgc: Object.freeze({
    name: 'CGC', url: 'https://www.cgccards.com/card-grading/grading-scale/', basis: 'official',
    grades: Object.freeze([
      { grade: 10, front: 55, back: 75 },
      { grade: 9, front: 60, back: 90 },
      { grade: 8, front: 65, back: 90 },
    ]),
  }),
});
export const GRADER_ORDER = Object.freeze(['psa', 'bgs', 'cgc']);

/** z-score margin that counts as clearly inside (≈ 84 %) or clearly outside a limit. */
const Z = 1;

/**
 * How one grade's limits compare with the measured centering of one side.
 * @param {{front:number, frontMax?:number, frontOther?:number, back:number}} row
 * @param {{lr?:{pct:number, sigma:number}|null, tb?:{pct:number, sigma:number}|null}|null} m  measured axes
 * @param {'front'|'back'} side
 * @returns {'pass'|'borderline'|'fail'|'unknown'}
 */
export function sideStatus(row, m, side) {
  const axes = [m?.lr, m?.tb].filter(Boolean);
  if (!axes.length) return 'unknown';
  axes.sort((a, b) => b.pct - a.pct);
  const [worse, better] = axes;
  const strict = side === 'front' ? row.front : row.back;
  const loose = side === 'front' ? (row.frontMax ?? row.front) : row.back;
  const checks = [{ a: worse, strict, loose }];
  if (side === 'front' && row.frontOther && better) checks.push({ a: better, strict: row.frontOther, loose: row.frontOther });
  let status = 'pass';
  for (const c of checks) {
    const zs = (c.strict - c.a.pct) / c.a.sigma;
    const zl = (c.loose - c.a.pct) / c.a.sigma;
    if (zl <= -Z) return 'fail';
    if (zs < Z) status = 'borderline';
  }
  // Only one axis measured: the other may be worse, so a pass is not proven.
  if (axes.length < 2 && status === 'pass') status = 'borderline';
  return status;
}

/**
 * Highest grade the centering allows, per grader.
 * cap: highest grade that passes (front, and back when measured); possible: a higher grade that is borderline;
 * below: the centering is worse than the lowest grade listed (cap is then that grade minus one, or lower).
 * @param {{front?:object|null, back?:object|null}} centering  measured {lr, tb} per side
 * @returns {Record<string, {cap:number|null, possible:number|null, below:boolean, limitedBy:'front'|'back'|null, backChecked:boolean}>}
 */
export function centeringCaps({ front = null, back = null } = {}) {
  const out = {};
  for (const id of GRADER_ORDER) {
    const g = GRADERS[id];
    const backChecked = Boolean(back?.lr || back?.tb);
    let cap = null; let possible = null; let limitedBy = null;
    for (const row of g.grades) {
      const f = sideStatus(row, front, 'front');
      const b = backChecked ? sideStatus(row, back, 'back') : 'unknown';
      if (f === 'unknown') break;
      const statuses = backChecked ? [f, b] : [f];
      if (statuses.includes('fail')) { limitedBy ??= f === 'fail' ? 'front' : 'back'; continue; }
      if (statuses.every((s) => s === 'pass')) { cap = row.grade; break; }
      possible ??= row.grade;
      limitedBy ??= f !== 'pass' ? 'front' : 'back';
    }
    const below = front && (front.lr || front.tb) && cap === null;
    out[id] = { cap, possible: possible !== null && (cap === null || possible > cap) ? possible : null, below: Boolean(below), limitedBy, backChecked };
  }
  return out;
}
