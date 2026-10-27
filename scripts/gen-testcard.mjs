#!/usr/bin/env node
// Writes src/testcard/testcard.html: printable test cards of known centering (and, on one, known wear) for checking
// the grade check with a real camera or scanner. Each card is drawn in millimetres (SVG mm units print at true size)
// on a black surround, so the edge and the whitening stand out as on a dark background.
//   node scripts/gen-testcard.mjs
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'testcard', 'testcard.html');

const W = 63; const H = 88; const R = 3; const M = 10; // card mm, corner radius, black surround
/** The test cards: border widths in mm and the wear drawn on them. */
export const TEST_CARDS = [
  { id: 'A', l: 3, r: 3, t: 3, b: 3, whitening: [], cut: null },
  { id: 'B', l: 3.6, r: 2.4, t: 3.3, b: 2.7, whitening: [{ side: 'top', from: 20, to: 25, depth: 0.3 }, { side: 'right', from: 50, to: 53, depth: 0.25 }], cut: { corner: 'bl', mm: 0.6 } },
  { id: 'C', l: 4.2, r: 1.8, t: 3, b: 3, whitening: [], cut: null },
  { id: 'D', l: 3.12, r: 2.88, t: 3.9, b: 2.1, whitening: [], cut: null },
];
const ratio = (a, b) => { const p = Math.round((Math.max(a, b) / (a + b)) * 100); return `${p}/${100 - p}`; };
const f = (v) => Number(v.toFixed(3)).toString();

/** Outline of the card: a rounded rectangle; with `cut`, that corner's tip is missing (a straight cut `mm` inside the curve). */
function cardPath(cut) {
  const arcs = {
    tr: { from: [W - R, 0], to: [W, R], c: [W - R, R] },
    br: { from: [W, H - R], to: [W - R, H], c: [W - R, H - R] },
    bl: { from: [R, H], to: [0, H - R], c: [R, H - R] },
    tl: { from: [0, R], to: [R, 0], c: [R, R] },
  };
  const seg = (name) => {
    const a = arcs[name];
    if (!cut || cut.corner !== name) return `A ${R} ${R} 0 0 1 ${f(a.to[0])} ${f(a.to[1])}`;
    // Cut line perpendicular to the corner's diagonal, `mm` further in than the curve's outermost point.
    const dir = [Math.sign(a.from[0] - a.c[0] + a.to[0] - a.c[0]), Math.sign(a.from[1] - a.c[1] + a.to[1] - a.c[1])];
    const d = R - cut.mm; // distance of the cut line from the curve's centre, along the diagonal
    const half = Math.sqrt(R * R - d * d); // half-length of the chord
    const mid = [a.c[0] + (dir[0] * d) / Math.SQRT2, a.c[1] + (dir[1] * d) / Math.SQRT2];
    const perp = [-dir[1] / Math.SQRT2, dir[0] / Math.SQRT2];
    let p1 = [mid[0] + perp[0] * half, mid[1] + perp[1] * half];
    let p2 = [mid[0] - perp[0] * half, mid[1] - perp[1] * half];
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (dist(p1, a.from) > dist(p2, a.from)) [p1, p2] = [p2, p1];
    return `A ${R} ${R} 0 0 1 ${f(p1[0])} ${f(p1[1])} L ${f(p2[0])} ${f(p2[1])} A ${R} ${R} 0 0 1 ${f(a.to[0])} ${f(a.to[1])}`;
  };
  return `M ${R} 0 H ${W - R} ${seg('tr')} V ${H - R} ${seg('br')} H ${R} ${seg('bl')} V ${R} ${seg('tl')} Z`;
}

function art(c) {
  const x = c.l; const y = c.t; const w = W - c.l - c.r; const h = H - c.t - c.b;
  const blocks = [];
  const colours = ['#d8463b', '#3d8f5a', '#e2b93b', '#4a6fd1', '#8e4ca8', '#2aa3b8'];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 7; j++) {
    if ((i * 3 + j * 5) % 4 === 0) continue;
    blocks.push(`<rect x="${f(x + 4 + i * ((w - 8) / 5))}" y="${f(y + 12 + j * ((h - 30) / 7))}" width="${f((w - 8) / 5 - 1.2)}" height="${f((h - 30) / 7 - 1.2)}" fill="${colours[(i + j * 2) % colours.length]}"/>`);
  }
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="#f1e6c2"/>
      <rect x="${f(x + 3)}" y="${f(y + 3)}" width="${f(w - 6)}" height="6" fill="#c9b37a"/>
      ${blocks.join('\n      ')}
      <rect x="${f(x + 3)}" y="${f(y + h - 14)}" width="${f(w - 6)}" height="11" fill="#e8dcb2" stroke="#8a7a4e" stroke-width="0.3"/>`;
}

function whitening(c) {
  return c.whitening.map((w) => {
    if (w.side === 'top') return `<rect x="${f(w.from)}" y="0" width="${f(w.to - w.from)}" height="${f(w.depth)}" fill="#ffffff"/>`;
    if (w.side === 'bottom') return `<rect x="${f(w.from)}" y="${f(H - w.depth)}" width="${f(w.to - w.from)}" height="${f(w.depth)}" fill="#ffffff"/>`;
    if (w.side === 'left') return `<rect x="0" y="${f(w.from)}" width="${f(w.depth)}" height="${f(w.to - w.from)}" fill="#ffffff"/>`;
    return `<rect x="${f(W - w.depth)}" y="${f(w.from)}" width="${f(w.depth)}" height="${f(w.to - w.from)}" fill="#ffffff"/>`;
  }).join('\n      ');
}

function cardSvg(c) {
  return `<svg class="tc-card" width="${W + 2 * M}mm" height="${H + 2 * M}mm" viewBox="0 0 ${W + 2 * M} ${H + 2 * M}" role="img" aria-labelledby="tc-${c.id}-label">
    <rect width="${W + 2 * M}" height="${H + 2 * M}" fill="#000"/>
    <g transform="translate(${M} ${M})">
      <clipPath id="tc-${c.id}-clip"><path d="${cardPath(c.cut)}"/></clipPath>
      <g clip-path="url(#tc-${c.id}-clip)">
      <rect width="${W}" height="${H}" fill="#1d3b8b"/>
      ${art(c)}
      ${whitening(c)}
      </g>
    </g>
  </svg>`;
}

function figure(c) {
  const wear = c.whitening.length || c.cut ? 'tc_wear_b' : 'tc_wear_none';
  return `<figure class="tc-figure">
  ${cardSvg(c)}
  <figcaption id="tc-${c.id}-label"><b data-i18n="tc_card_${c.id.toLowerCase()}">Test card ${c.id}</b> · <span data-i18n="tc_truth_lr">Left/right</span> <b>${ratio(c.l, c.r)}</b> · <span data-i18n="tc_truth_tb">Top/bottom</span> <b>${ratio(c.t, c.b)}</b><br><span class="tc-wear" data-i18n="${wear}"></span></figcaption>
</figure>`;
}

const ticks = Array.from({ length: 101 }, (_, i) => `<line x1="${i}" y1="0" x2="${i}" y2="${i % 10 === 0 ? 5 : i % 5 === 0 ? 3.5 : 2}" stroke="#000" stroke-width="0.2"/>`).join('');
/** The test card page. */
export const testcardHtml = () => `<!doctype html>
<!-- Generated by scripts/gen-testcard.mjs; edit that script, not this file. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title data-i18n="tc_title">CertScanner test cards</title>
<link rel="stylesheet" href="testcard.css">
<script type="module" src="testcard.js"></script>
</head>
<body>
<header class="tc-screen">
  <h1 data-i18n="tc_title">CertScanner test cards</h1>
  <p data-i18n="tc_intro"></p>
  <ol>
    <li data-i18n="tc_step_print"></li>
    <li data-i18n="tc_step_check"></li>
    <li data-i18n="tc_step_photo"></li>
    <li data-i18n="tc_step_compare"></li>
  </ol>
  <p data-i18n="tc_note_ratio"></p>
  <p data-i18n="tc_tolerance"></p>
  <p><button type="button" id="tc-print" data-i18n="tc_print">Print</button></p>
</header>
<main class="tc-sheet">
${TEST_CARDS.map(figure).join('\n')}
  <figure class="tc-ruler">
    <svg width="100mm" height="6mm" viewBox="0 0 100 6" aria-hidden="true">${ticks}<line x1="0" y1="0" x2="100" y2="0" stroke="#000" stroke-width="0.3"/></svg>
    <figcaption data-i18n="tc_ruler">This bar is exactly 100 mm when printed at actual size.</figcaption>
  </figure>
</main>
</body>
</html>
`;

export const TESTCARD_PATH = OUT;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, testcardHtml());
  console.log(`wrote ${path.relative(ROOT, OUT)} (${TEST_CARDS.length} cards)`);
}
