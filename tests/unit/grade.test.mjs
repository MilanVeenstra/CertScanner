// Grade check (raw cards): geometry, card detection, border measurement, centering limits and estimates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homography, applyH, fitLine, orderQuad, rectAspect, quadSkew } from '../../src/pipeline/grade/geometry.js';
import { analyzeCard, validQuad } from '../../src/pipeline/grade/analyze.js';
import { centeringFrom, ratioText, manualSide } from '../../src/pipeline/grade/measure.js';
import { GRADERS, centeringCaps, sideStatus, STANDARDS_AS_OF } from '../../src/core/gradeStandards.js';
import { estimateGrades, bgsOverall, normalizeCondition } from '../../src/core/gradeEstimate.js';
import { renderCard, COLORS } from './gradeFixtures.mjs';
import { readFileSync } from 'node:fs';
import { testcardHtml, TESTCARD_PATH, TEST_CARDS } from '../../scripts/gen-testcard.mjs';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a.toFixed(2)} vs ${b.toFixed(2)} (±${tol})`);

test('homography maps the 4 corners and round-trips points', () => {
  const from = [[0, 0], [63, 0], [63, 88], [0, 88]];
  const to = [[110, 92], [790, 60], [850, 1010], [90, 1040]];
  const H = homography(from, to);
  for (let i = 0; i < 4; i++) { const [x, y] = applyH(H, ...from[i]); near(x, to[i][0], 1e-6, 'x'); near(y, to[i][1], 1e-6, 'y'); }
  const back = homography(to, from);
  const [u, v] = applyH(back, ...applyH(H, 20, 30));
  near(u, 20, 1e-6, 'u'); near(v, 30, 1e-6, 'v');
});

test('fitLine ignores outliers; orderQuad gives TL, TR, BR, BL with the short side on top', () => {
  const pts = [];
  for (let i = 0; i < 40; i++) pts.push([i * 10, 5 + i * 10 * 0.1]);
  pts.push([100, 80], [200, -60]);
  const l = fitLine(pts);
  near(Math.abs(l.a * 300 + l.b * 35 - l.c), 0, 0.05, 'on the line');
  assert.deepEqual(orderQuad([[630, 0], [0, 880], [0, 0], [630, 880]]), [[0, 0], [630, 0], [630, 880], [0, 880]]);
  // Lying sideways (long side horizontal): the left short side becomes the top.
  assert.deepEqual(orderQuad([[0, 0], [880, 0], [880, 630], [0, 630]]), [[0, 630], [0, 0], [880, 0], [880, 630]]);
});

test('rectAspect recovers 63:88 through perspective; quadSkew grows with tilt', () => {
  const card = [[0, 0], [63, 0], [63, 88], [0, 88]];
  const frontal = [[200, 100], [830, 100], [830, 980], [200, 980]];
  near(rectAspect(frontal, [500, 500]), 63 / 88, 0.002, 'frontal');
  // A card tilted away (top side shorter): the affine ratio is off, the corrected one is not.
  const H = homography(card, [[300, 120], [700, 120], [820, 900], [180, 900]]);
  const q = card.map(([x, y]) => applyH(H, x, y));
  assert.ok(quadSkew(q) > 5);
  assert.equal(quadSkew(frontal), 0);
});

test('analyzeCard: centering of synthetic cards within 1.5 points (yellow, silver, black, navy back, rotated, tilted)', () => {
  const cases = [
    { name: 'yellow 55/45', o: { border: { l: 3.3, r: 2.7, t: 3, b: 3 } } },
    { name: 'rotated 7° 60/40 top/bottom', o: { angle: 7, border: { l: 3, r: 3, t: 3.6, b: 2.4 } } },
    { name: 'silver on light, tilted', o: { tilt: 0.06, angle: -4, borderColor: COLORS.silver, bg: [225, 225, 222], border: { l: 2.6, r: 3.4, t: 3.1, b: 2.9 } } },
    { name: 'black frame', o: { borderColor: COLORS.black, bg: [210, 205, 190], border: { l: 3.4, r: 2.6, t: 3, b: 3 } } },
    { name: 'navy back on texture', o: { borderColor: COLORS.navy, bg: [140, 120, 90], bgTexture: 0.6, border: { l: 4, r: 3, t: 3.5, b: 3.5 } } },
  ];
  for (const { name, o } of cases) {
    const img = renderCard({ width: 760, height: 980, pxPerMm: 9, ...o });
    const r = analyzeCard(img);
    assert.equal(r.status, 'ok', `${name}: ${r.status}`);
    assert.equal(r.source, 'detected', name);
    near(r.centering.lr.pct, img.truth.lr, 1.5, `${name} left/right`);
    near(r.centering.tb.pct, img.truth.tb, 1.5, `${name} top/bottom`);
    assert.ok(r.centering.lr.sigma > 0 && r.centering.lr.sigma < 2, `${name} sigma ${r.centering.lr.sigma}`);
    near(r.quality.pxPerMm, 9, 0.5, `${name} px/mm`);
    assert.equal(r.card.width / r.card.height, Math.round((r.card.height * 63) / 88) / r.card.height);
  }
});

test('analyzeCard: the copyright line printed in the bottom border is not taken for the border end', () => {
  // Modern cards print it in the middle 40 % of the bottom border, about 1 mm from the cut: 5 of the 9 stretches see it.
  const img = renderCard({ width: 684, height: 900, pxPerMm: 9, border: { l: 2.5, r: 2.5, t: 2.6, b: 2.4 },
    borderText: [{ side: 'bottom', fromMm: 19, toMm: 44, depthMm: [0.9, 1.6] }] });
  const r = analyzeCard(img);
  assert.equal(r.status, 'ok');
  near(r.borders.sides.bottom.mm, 2.4, 0.15, 'bottom border');
  near(r.centering.tb.pct, img.truth.tb, 1, 'top/bottom');
});

test('analyzeCard: a photo cropped to the card uses the photo edges and says so', () => {
  const img = renderCard({ fill: true, width: 504, height: 704, pxPerMm: 8, border: { l: 3.2, r: 2.8, t: 3, b: 3 } });
  const r = analyzeCard(img);
  assert.equal(r.source, 'image-edges');
  assert.ok(r.quality.flags.includes('cropped'));
  near(r.centering.lr.pct, img.truth.lr, 1.5, 'left/right');
  assert.ok(r.centering.lr.sigma >= 1, 'a crop line adds uncertainty');
});

test('analyzeCard: a card on a black surround (the printed test card) is not mixed up with the surround', () => {
  // The surround's straight sides are longer than the card's: a quad of two surround sides and two card sides fits
  // the card shape too. Its corners don't look like corners (one line runs on, the other starts late).
  const img = renderCard({ width: 860, height: 1090, pxPerMm: 9, borderColor: COLORS.navy, bg: [244, 242, 236],
    surround: { mm: 10, color: [0, 0, 0] }, border: { l: 3.6, r: 2.4, t: 3.3, b: 2.7 } });
  const r = analyzeCard(img);
  assert.equal(r.status, 'ok', r.status);
  near(r.centering.lr.pct, img.truth.lr, 1, 'left/right');
  near(r.centering.tb.pct, img.truth.tb, 1, 'top/bottom');
});

test('analyzeCard: a tightly cropped card (a slab or sleeve scan) is found at its own edge, not the strip around it', () => {
  // A thin strip to the photo edge (a dark gap and a light holder rim, or a light rim): the strip's outer line is
  // card-shaped too, and often the stronger edge.
  const cases = [
    ['dark gap, light rim', { surround: { mm: 0.5, color: [25, 25, 28] }, bg: [205, 205, 200] }, 1.2],
    ['light rim, dark beyond', { surround: { mm: 0.6, color: [215, 215, 210] }, bg: [40, 40, 45] }, 1.3],
  ];
  for (const [name, o, pad] of cases) {
    const img = renderCard({ width: Math.round((63 + 2 * pad) * 10), height: Math.round((88 + 2 * pad) * 10), pxPerMm: 10,
      border: { l: 3.5, r: 2.5, t: 3.2, b: 2.8 }, ...o });
    const r = analyzeCard(img);
    assert.equal(r.source, 'detected', name);
    const off = Math.max(...r.quad.map((p) => Math.min(...img.corners.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])))));
    assert.ok(off < 2.5, `${name}: outline ${(off / 10).toFixed(2)} mm off`);
    near(r.centering.lr.pct, img.truth.lr, 1, `${name} left/right`);
    near(r.centering.tb.pct, img.truth.tb, 1, `${name} top/bottom`);
  }
});

test('test card page: matches its generator; each card fits and states its true centering', () => {
  assert.equal(readFileSync(TESTCARD_PATH, 'utf8'), testcardHtml(), 'run: node scripts/gen-testcard.mjs');
  for (const c of TEST_CARDS) {
    assert.ok(c.l + c.r < 63 && c.t + c.b < 88 && Math.min(c.l, c.r, c.t, c.b) > 1, c.id);
    const lr = Math.round((Math.max(c.l, c.r) / (c.l + c.r)) * 100);
    assert.ok(testcardHtml().includes(`<b>${lr}/${100 - lr}</b>`), `${c.id} left/right ${lr}`);
  }
});

test('analyzeCard: a card that nearly fills a 3:4 photo is measured from its own edges, not the photo edges', () => {
  // A 3:4 photo is close to card-shaped; the strip of background around the card is not a border.
  const img = renderCard({ width: 540, height: 720, pxPerMm: 8, bg: [40, 40, 45], border: { l: 3.4, r: 2.6, t: 3.3, b: 2.7 } });
  const r = analyzeCard(img);
  assert.equal(r.source, 'detected');
  near(r.centering.lr.pct, img.truth.lr, 1, 'left/right');
  near(r.centering.tb.pct, img.truth.tb, 1, 'top/bottom');
  // An even strip of surface all round, in a photo of nearly card shape: still the surface, not a border.
  const framed = renderCard({ width: 564, height: 764, pxPerMm: 8, bg: [225, 225, 222], border: { l: 3.4, r: 2.6, t: 3.3, b: 2.7 } });
  const f = analyzeCard(framed);
  assert.equal(f.source, 'detected');
  near(f.centering.lr.pct, framed.truth.lr, 1, 'framed left/right');
});

test('analyzeCard: low resolution measures roughly and is flagged; borderless art is not given a number', () => {
  const low = renderCard({ width: 400, height: 540, pxPerMm: 5, border: { l: 3.3, r: 2.7, t: 3, b: 3 } });
  const r = analyzeCard(low);
  assert.ok(r.quality.flags.includes('low-res'));
  near(r.centering.lr.pct, low.truth.lr, 3, 'low-res left/right');
  assert.ok(r.centering.lr.sigma > 1);
  const none = analyzeCard(renderCard({ width: 700, height: 900, pxPerMm: 9, border: null }));
  assert.ok(['no-border', 'no-card'].includes(none.status), none.status);
  assert.equal(none.centering?.lr ?? null, null);
});

test('analyzeCard: corners placed by hand skip detection; invalid ones are ignored', () => {
  const img = renderCard({ width: 700, height: 900, pxPerMm: 9, border: { l: 3.3, r: 2.7, t: 3, b: 3 } });
  const r = analyzeCard(img, { quad: [img.corners[2], img.corners[0], img.corners[3], img.corners[1]] });
  assert.equal(r.source, 'manual');
  near(r.centering.lr.pct, img.truth.lr, 1.5, 'manual left/right');
  assert.equal(validQuad([[0, 0], [1, 1], [2, 2], [3, 3]], 700, 900), false);
  assert.equal(analyzeCard(img, { quad: [[0, 0], [1, 1], [2, 2], [3, 3]] }).source, 'detected');
});

test('analyzeCard: no card in a plain photo', () => {
  const data = new Uint8ClampedArray(300 * 200 * 4).fill(128);
  assert.equal(analyzeCard({ data, width: 300, height: 200 }).status, 'no-card');
});

test('centeringFrom / ratioText / manualSide', () => {
  const s = (px) => ({ ok: true, px, sigmaPx: 0.2 });
  const c = centeringFrom({ left: s(33), right: s(27), top: s(30), bottom: s(30) });
  near(c.lr.pct, 55, 1e-9, 'lr');
  assert.equal(c.lr.wide, 'left');
  assert.equal(c.worst.axis, 'lr');
  assert.equal(ratioText(55.4), '55/45');
  assert.equal(ratioText(50.2), '50/50');
  assert.equal(centeringFrom({ left: s(30), right: { ok: false }, top: s(30), bottom: s(30) }).lr, null);
  assert.equal(manualSide(24, 8).mm, 3);
});

test('gradeStandards: every grader has a source and descending grades; data as of', () => {
  assert.match(STANDARDS_AS_OF, /^\d{4}-\d{2}$/);
  for (const g of Object.values(GRADERS)) {
    assert.match(g.url, /^https:\/\//);
    assert.ok(['official', 'guides'].includes(g.basis));
    for (let i = 1; i < g.grades.length; i++) assert.ok(g.grades[i].grade < g.grades[i - 1].grade);
    for (const row of g.grades) assert.ok(row.front >= 50 && row.back >= row.front);
  }
});

const axis = (pct, sigma = 0.5) => ({ pct, sigma });
const side = (lr, tb = 50.5) => ({ lr: axis(lr), tb: axis(tb) });

test('centeringCaps: PSA 10 needs about 55/45 front and 75/25 back', () => {
  assert.equal(centeringCaps({ front: side(53), back: side(70) }).psa.cap, 10);
  // 57/43: past 55/45 but inside PSA's "to 60/40" wording -> 9 likely, 10 possible.
  const c = centeringCaps({ front: side(57), back: side(70) }).psa;
  assert.equal(c.cap, 9); assert.equal(c.possible, 10); assert.equal(c.limitedBy, 'front');
  // The back limits: 80/20 on the back blocks a 10.
  const b = centeringCaps({ front: side(52), back: side(80) }).psa;
  assert.equal(b.cap, 9); assert.equal(b.limitedBy, 'back');
  // No back photo: front-only cap, flagged.
  const f = centeringCaps({ front: side(52) }).psa;
  assert.equal(f.cap, 10); assert.equal(f.backChecked, false);
  // Way off-centre.
  const w = centeringCaps({ front: side(92) }).psa;
  assert.equal(w.cap, null); assert.equal(w.below, true);
});

test('centeringCaps: BGS Pristine is never "likely" from a photo; CGC Gem Mint at 55/45', () => {
  const caps = centeringCaps({ front: side(50.2, 50.1), back: side(55, 52) });
  assert.notEqual(caps.bgs.cap, 10);
  assert.equal(caps.bgs.possible, 10);
  assert.equal(centeringCaps({ front: side(54), back: side(70) }).cgc.cap, 10);
  assert.equal(centeringCaps({ front: side(58), back: side(70) }).cgc.cap, 9);
  assert.equal(sideStatus(GRADERS.psa.grades[0], { lr: axis(54.4, 0.5) }, 'front'), 'borderline', 'one axis only is never a pass');
});

test('estimateGrades: centering only gives caps, no range; with a condition check a range with reasons', () => {
  const only = estimateGrades({ front: side(53), back: side(70) });
  assert.equal(only.graders.psa.high, null);
  assert.equal(only.graders.psa.centeringCap, 10);
  const est = estimateGrades({ front: side(57), back: side(70), condition: { corners: 8.6, edges: 9.4, surface: 9.1 } });
  assert.equal(est.graders.psa.high, 8);
  assert.equal(est.graders.psa.low, 7);
  assert.ok(est.graders.psa.reasons.some((r) => r.key === 'grade_reason_corners'));
  // CGC uses half grades; BGS gets subgrades with our centering.
  assert.equal(est.graders.cgc.high, 8.5);
  assert.deepEqual(est.graders.bgs.sub, { centering: 8, corners: 8.5, edges: 9.5, surface: 9 }); // 57/43: BGS 9 needs 55/45
  assert.equal(est.graders.bgs.high, 8.5);
  // An area that couldn't be judged widens the range.
  const part = estimateGrades({ front: side(53), back: side(70), condition: { corners: 9.6, edges: null, surface: 9.8 } });
  assert.equal(part.graders.psa.high, 9);
  assert.equal(part.graders.psa.low, 7);
  assert.deepEqual(part.graders.psa.reasons.find((r) => r.key === 'grade_reason_unassessed').areas, ['edges']);
});

test('bgsOverall follows the 9.5 rule; normalizeCondition clamps and drops non-numbers', () => {
  assert.equal(bgsOverall([9.5, 9.5, 9.5, 9]), 9.5);
  assert.equal(bgsOverall([10, 10, 10, 9.5]), 10);
  assert.equal(bgsOverall([9, 9, 9.5, 8]), 8.5);
  assert.deepEqual(normalizeCondition({ corners: 12, edges: 'x', surface: 3 }), { corners: 10, edges: null, surface: 3 });
  assert.equal(normalizeCondition({ corners: null }), null);
});

// ---------------------------------------------------------------- wear seen on the device
import { measureWear, whiteningTest, runsOf } from '../../src/pipeline/grade/wear.js';
import { combineWear, mergeCondition } from '../../src/core/gradeEstimate.js';

const wearOf = (o) => analyzeCard(renderCard({ width: 820, height: 1080, pxPerMm: 11, border: { l: 3.2, r: 2.8, t: 3, b: 3 }, ...o })).wear;

test('wear: clean cards raise no alarm (yellow on grey, navy on dark, black on grey, rotated and noisy)', () => {
  for (const o of [{}, { borderColor: COLORS.navy, bg: [40, 40, 45] }, { borderColor: COLORS.black, bg: [130, 130, 135] },
    { angle: 6, tilt: 0.04, noise: 6, blur: 2 }]) {
    const w = wearOf(o);
    assert.equal(w.status, 'ok');
    assert.equal(w.edges.rating, 'none', JSON.stringify(o));
    assert.equal(w.corners.rating, 'none', JSON.stringify(o));
  }
});

test('wear: whitening found where it is, on dark and on coloured borders', () => {
  const navy = wearOf({ borderColor: COLORS.navy, bg: [40, 40, 45], whitening: [{ side: 'top', fromMm: 10, toMm: 14 }, { side: 'left', fromMm: 30, toMm: 31 }] });
  assert.equal(navy.edges.rating, 'visible', '5 mm of whitening in all');
  near(navy.edges.sides.top.runs[0].fromMm, 10, 0.3, 'top run start');
  near(navy.edges.sides.top.runs[0].toMm, 14, 0.3, 'top run end');
  assert.equal(navy.edges.sides.left.runs.length, 1);
  assert.equal(navy.edges.sides.right.runs.length, 0);
  assert.equal(wearOf({ borderColor: COLORS.navy, bg: [40, 40, 45], whitening: [{ side: 'bottom', fromMm: 25, toMm: 26 }] }).edges.rating, 'minor', 'one short stretch');
  const yellow = wearOf({ blur: 2, whitening: [{ side: 'right', fromMm: 30, toMm: 32, depthMm: 0.22 }] });
  assert.ok(['minor', 'visible'].includes(yellow.edges.rating), yellow.edges.rating);
  const many = wearOf({ borderColor: COLORS.navy, bg: [40, 40, 45], whitening: [{ side: 'top', fromMm: 10, toMm: 12 }, { side: 'bottom', fromMm: 20, toMm: 22 }, { side: 'right', fromMm: 40, toMm: 45 }] });
  assert.equal(many.edges.rating, 'visible');
});

test('wear: a damaged corner stands out against the other three', () => {
  const cut = wearOf({ cornerCut: [{ corner: 'br', mm: 0.6 }] });
  assert.equal(cut.corners.list.br.rating, 'visible');
  near(cut.corners.list.br.shapeMm, 0.6, 0.12, 'missing tip');
  for (const c of ['tl', 'tr', 'bl']) assert.equal(cut.corners.list[c].rating, 'none', c);
  // 0.3 mm is the alarm threshold: on real scans of PSA 10 cards, corners differ by up to that much without damage.
  const small = wearOf({ borderColor: COLORS.navy, bg: [40, 40, 45], cornerCut: [{ corner: 'tr', mm: 0.4 }] });
  assert.ok(['minor', 'visible'].includes(small.corners.list.tr.rating));
  const tiny = wearOf({ borderColor: COLORS.navy, bg: [40, 40, 45], cornerCut: [{ corner: 'tr', mm: 0.15 }] });
  assert.equal(tiny.corners.list.tr.rating, 'none', 'below what a photo can tell apart');
  const white = wearOf({ borderColor: COLORS.black, bg: [130, 130, 135], cornerWhite: ['tl'] });
  assert.notEqual(white.corners.list.tl.rating, 'none');
});

test('wear: says what it cannot see (light background, pale border, small photo, cropped photo)', () => {
  const light = wearOf({ bg: [240, 240, 238] });
  assert.equal(light.edges.rating, 'unknown');
  assert.equal(light.edges.sides.top.reason, 'light');
  assert.equal(wearOf({ borderColor: COLORS.silver, bg: [40, 40, 45] }).edges.sides.left.reason, 'pale-border');
  assert.equal(analyzeCard(renderCard({ width: 420, height: 560, pxPerMm: 6, border: { l: 3, r: 3, t: 3, b: 3 } })).wear.status, 'too-small');
  const crop = analyzeCard(renderCard({ fill: true, width: 504, height: 704, pxPerMm: 8, border: { l: 3.2, r: 2.8, t: 3, b: 3 } }));
  assert.equal(crop.wear.edges.rating, 'unknown');
});

test('wear helpers: the whitening test refuses blends of border and background; runs bridge one-pixel gaps', () => {
  const navy = [27, 12, -50]; const grey = [51, 0, -2];
  const { test: t } = whiteningTest(navy, grey);
  assert.equal(t([39, 6, -26]), false, 'half navy, half grey');
  assert.equal(t([93, 0, 4]), true, 'paper');
  assert.equal(whiteningTest([92, 0, 2], [30, 0, 0]).reason, 'light');
  assert.deepEqual(runsOf([0, 1, 1, 0, 1, 1, 0, 0, 1].map(Boolean), 3), [[1, 5]]);
  assert.deepEqual(runsOf([1, 0, 0, 1].map(Boolean), 2), []);
});

test('device wear joins the estimate: worst of front and back, seen wear caps, AI and device merge per area', () => {
  assert.deepEqual(combineWear([{ corners: { rating: 'none' }, edges: { rating: 'minor' } }, { corners: { rating: 'visible' }, edges: { rating: 'unknown' } }]), { corners: 'visible', edges: 'minor' });
  assert.deepEqual(combineWear([null, null]), { corners: 'unknown', edges: 'unknown' });
  assert.deepEqual(mergeCondition({ corners: 'none', edges: 'none' }, null), { condition: null, sources: {} });
  const m = mergeCondition({ corners: 'visible', edges: 'none' }, { corners: 9.5, edges: 9, surface: 9 });
  assert.deepEqual(m.condition, { corners: 8, edges: 9, surface: 9 });
  assert.deepEqual(m.sources, { corners: 'device', edges: 'ai', surface: 'ai' });
  const est = estimateGrades({ front: side(53), back: side(70), ...mergeCondition({ corners: 'none', edges: 'visible' }, null) });
  assert.equal(est.graders.psa.high, 8);
  assert.ok(est.graders.psa.reasons.some((r) => r.key === 'grade_reason_edges_device'));
});
