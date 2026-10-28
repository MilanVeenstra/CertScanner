#!/usr/bin/env node
// Grade check on real scans of PSA-graded cards (tests/bench/real/psa-labels.json: border widths labelled by hand,
// scans in .cache/grade-data/psa/images via scripts/fetch-grade-data.mjs). Two runs per scan:
//   full   analyzeCard(scan): finds the card itself, as the panel does
//   given  analyzeCard(scan, {quad}) with the labelled card outline: the border measurement alone
// Centering error per axis: |measured − labelled| share of the left (top) border, in points.
// PSA check: a PSA 10 needs 55/45 or better on the front (75/25 on the back), a 9 60/40 (90/10).
//   node scripts/bench-grade-real.mjs [--jobs 4] [--json out.json] [--compare before.json] [--out report.md] [--only file,...]
//        [--src dir]   (a src/ root or checkout holding the analyze.js to test, e.g. an older version)
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABELS = path.join(ROOT, 'tests/bench/real/psa-labels.json');
const IMAGES = path.join(ROOT, '.cache/grade-data/psa/images');
const SEEN = new Set(['minor', 'visible']);
export const PSA_LIMITS = { 10: { front: 55, back: 75 }, 9: { front: 60, back: 90 } };

/** Border shares in the labelled orientation; a found quad that starts at the opposite corner is turned round. */
function shares(result, gold) {
  const sides = result.borders?.sides ?? {};
  let flip = false;
  if (result.quad) {
    const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    flip = d(result.quad[0], gold.outer[2]) < d(result.quad[0], gold.outer[0]);
  }
  const get = (s) => (sides[s]?.ok ? sides[s].mm : null);
  let [l, r, t, b] = [get('left'), get('right'), get('top'), get('bottom')];
  if (flip) [l, r, t, b] = [r, l, b, t];
  return { l, r, t, b };
}

/** analyze.js under --src (a src/ root, a checkout, or the grade folder itself); default: this checkout. */
function analyzePath(src) {
  const dir = path.resolve(src ?? path.join(ROOT, 'src/pipeline/grade'));
  for (const p of [path.join(dir, 'analyze.js'), path.join(dir, 'pipeline/grade/analyze.js'), path.join(dir, 'src/pipeline/grade/analyze.js')]) if (existsSync(p)) return p;
  throw new Error(`no analyze.js under ${dir}`);
}

const share = (a, b) => (a !== null && b !== null && a + b > 0 ? (a / (a + b)) * 100 : null);

function score(result, gold) {
  const m = shares(result, gold); const g = gold.borders;
  const axes = {};
  for (const [ax, truth, meas] of [['lr', share(g.left, g.right), share(m.l, m.r)], ['tb', share(g.top, g.bottom), share(m.t, m.b)]]) {
    axes[ax] = truth === null || meas === null ? null : { truth, meas, err: Math.abs(meas - truth), sigma: result.centering?.[ax]?.sigma ?? null };
  }
  const outlineMm = result.quad ? Math.max(...result.quad.map((p) => Math.min(...gold.outer.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))) / (result.quality?.pxPerMm || 1) : null;
  return {
    status: result.status, source: result.source, flags: result.quality?.flags ?? [], outlineMm,
    lr: axes.lr, tb: axes.tb, worst: result.centering?.lr && result.centering?.tb ? Math.max(result.centering.lr.pct, result.centering.tb.pct) : null,
    edges: result.wear?.edges?.rating ?? 'unknown', corners: result.wear?.corners?.rating ?? 'unknown',
  };
}

async function workerMain() {
  const { default: jpeg } = await import('jpeg-js');
  const { analyzeCard } = await import(pathToFileURL(workerData.analyze).href);
  parentPort.on('message', (gold) => {
    try {
      const d = jpeg.decode(readFileSync(path.join(IMAGES, gold.file)), { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 });
      const img = { data: new Uint8ClampedArray(d.data.buffer), width: d.width, height: d.height };
      const t0 = performance.now(); const full = analyzeCard(img); const t1 = performance.now();
      const given = analyzeCard(img, { quad: gold.outer });
      parentPort.postMessage({ file: gold.file, ms: t1 - t0, full: score(full, gold), given: score(given, gold) });
    } catch (e) { parentPort.postMessage({ file: gold.file, error: String(e?.message ?? e) }); }
  });
}

const q = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const fmt = (v, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)} %` : '–');

/** Summary numbers for one run (full or given) over a set of labelled scans. */
export function summarize(recs, run) {
  const r = recs.map((x) => ({ ...x[run], gold: x.gold }));
  const both = r.filter((x) => x.lr && x.tb);
  const errs = both.map((x) => Math.max(x.lr.err, x.tb.err));
  const axisErr = both.flatMap((x) => [x.lr, x.tb]);
  const within = (k) => axisErr.filter((a) => a.sigma && a.err <= k * a.sigma).length;
  const psa = {};
  for (const g of [10, 9]) for (const side of ['front', 'back']) {
    const L = r.filter((x) => x.gold.grade === g && x.gold.side === side && x.worst !== null);
    const lim = PSA_LIMITS[g][side];
    psa[`${g}-${side}`] = { n: L.length, over: L.filter((x) => x.worst > lim + 1).length, overGold: r.filter((x) => x.gold.grade === g && x.gold.side === side && x.gold.worst !== null && x.gold.worst > lim + 1).length, nGold: r.filter((x) => x.gold.grade === g && x.gold.side === side && x.gold.worst !== null).length };
  }
  const wear = {};
  for (const [name, lo, hi] of [['10', 10, 10], ['9', 9, 9.5], ['7-8', 7, 8.5], ['1-6', 1, 6.5]]) {
    const L = r.filter((x) => x.gold.grade !== null && x.gold.grade >= lo && x.gold.grade <= hi);
    const ratedC = L.filter((x) => x.corners !== 'unknown'); const ratedE = L.filter((x) => x.edges !== 'unknown');
    wear[name] = { n: L.length, corners: ratedC.filter((x) => SEEN.has(x.corners)).length, ratedC: ratedC.length, edges: ratedE.filter((x) => SEEN.has(x.edges)).length, ratedE: ratedE.length };
  }
  return {
    n: r.length, found: r.filter((x) => x.status !== 'no-card').length, measured: both.length,
    wrongOutline: r.filter((x) => x.outlineMm !== null && x.outlineMm > 1).length,
    median: q(errs, 0.5), p90: q(errs, 0.9), max: errs.length ? Math.max(...errs) : null, over2: errs.filter((e) => e > 2).length,
    within1: axisErr.length ? within(1) / axisErr.length : null, within2: axisErr.length ? within(2) / axisErr.length : null, psa, wear,
  };
}

function report(recs, opts) {
  const lines = ['# Grade check on real scans', '', `${recs.length} labelled scans of PSA-graded cards (${opts.labelled}); ${opts.elapsed} s.`, ''];
  lines.push('| run | measured both axes | outline off > 1 mm | median err | P90 | max | > 2 points | within 1σ / 2σ |', '|---|---|---|---|---|---|---|---|');
  for (const run of ['full', 'given']) {
    const s = summarize(recs, run);
    lines.push(`| ${run} | ${s.measured}/${s.n} (${pct(s.measured, s.n)}) | ${run === 'given' ? '–' : s.wrongOutline} | ${fmt(s.median)} | ${fmt(s.p90)} | ${fmt(s.max)} | ${s.over2} | ${fmt(s.within1 === null ? null : 100 * s.within1, 0)} % / ${fmt(s.within2 === null ? null : 100 * s.within2, 0)} % |`);
  }
  lines.push('', '## Against the PSA grade (worse than the limit by more than 1 point)', '', '| grade / side | full | given | labels |', '|---|---|---|---|');
  const sf = summarize(recs, 'full'); const sg = summarize(recs, 'given');
  for (const k of Object.keys(sf.psa)) {
    const [g, side] = k.split('-'); const lim = PSA_LIMITS[g][side];
    lines.push(`| PSA ${g} ${side} (≤ ${lim}/${100 - lim}) | ${sf.psa[k].over}/${sf.psa[k].n} | ${sg.psa[k].over}/${sg.psa[k].n} | ${sg.psa[k].overGold}/${sg.psa[k].nGold} |`);
  }
  lines.push('', '## Wear alarms by grade (share of the scans rated, full run)', '', '| grade | corners | edges |', '|---|---|---|');
  for (const [k, w] of Object.entries(sf.wear)) lines.push(`| ${k} (n ${w.n}) | ${w.corners}/${w.ratedC} (${pct(w.corners, w.ratedC)}) | ${w.edges}/${w.ratedE} (${pct(w.edges, w.ratedE)}) |`);
  if (opts.compare) {
    const before = JSON.parse(readFileSync(opts.compare, 'utf8'));
    lines.push('', `## Change against ${path.basename(opts.compare)}`, '', '| run | measured | median | P90 | max | PSA 10 front over |', '|---|---|---|---|---|---|');
    for (const run of ['full', 'given']) {
      const a = summarize(before.recs, run); const b = summarize(recs, run);
      lines.push(`| ${run} | ${a.measured} → ${b.measured} | ${fmt(a.median)} → ${fmt(b.median)} | ${fmt(a.p90)} → ${fmt(b.p90)} | ${fmt(a.max)} → ${fmt(b.max)} | ${a.psa['10-front'].over}/${a.psa['10-front'].n} → ${b.psa['10-front'].over}/${b.psa['10-front'].n} |`);
    }
  }
  return lines.join('\n');
}

async function main() {
  const { values: o } = parseArgs({ options: { jobs: { type: 'string' }, json: { type: 'string' }, compare: { type: 'string' }, out: { type: 'string' }, only: { type: 'string' }, src: { type: 'string' } } });
  const analyze = analyzePath(o.src);
  if (!existsSync(LABELS)) throw new Error('no labels: tests/bench/real/psa-labels.json');
  const doc = JSON.parse(readFileSync(LABELS, 'utf8'));
  let golds = doc.images.filter((r) => r.status === 'ok');
  if (o.only) { const s = new Set(o.only.split(',')); golds = golds.filter((g) => s.has(g.file)); }
  const missing = golds.filter((g) => !existsSync(path.join(IMAGES, g.file)));
  if (missing.length) throw new Error(`${missing.length} scans missing: run node scripts/fetch-grade-data.mjs`);
  for (const g of golds) {
    const b = g.borders; const w = (x, y) => (x && y ? (Math.max(x, y) / (x + y)) * 100 : null);
    const lr = w(b.left, b.right); const tb = w(b.top, b.bottom);
    g.worst = lr !== null && tb !== null ? Math.max(lr, tb) : null;
  }
  const t0 = performance.now();
  const jobs = Math.max(1, Number(o.jobs ?? Math.min(4, os.availableParallelism?.() ?? os.cpus().length)));
  const queue = [...golds]; const recs = [];
  await Promise.all(Array.from({ length: jobs }, () => new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { analyze } });
    const next = () => { const g = queue.shift(); if (!g) { w.terminate(); resolve(); return; } w.postMessage(g); w.gold = g; };
    w.on('message', (m) => { if (m.error) console.error(`${m.file}: ${m.error}`); else recs.push({ ...m, gold: w.gold }); next(); });
    w.on('error', reject);
    next();
  })));
  recs.sort((a, b) => (a.file < b.file ? -1 : 1));
  const ok = doc.images.filter((r) => r.status === 'ok');
  const labelled = `labels: ${ok.filter((r) => r.by === 'user').length} checked in scripts/annotate-grade.mjs, ${ok.filter((r) => r.by !== 'user' && r.method === 'review').length} set after looking at each border, ${ok.filter((r) => r.by !== 'user' && r.method === 'agree').length} where two measurements agreed`;
  const md = report(recs, { labelled, elapsed: ((performance.now() - t0) / 1000).toFixed(0), compare: o.compare });
  console.log(md);
  if (o.out) writeFileSync(o.out, `${md}\n`);
  if (o.json) writeFileSync(o.json, JSON.stringify({ recs }));
}

if (isMainThread) { if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); }); } else workerMain();
