#!/usr/bin/env node
// Grade-check benchmark: how precisely analyzeCard (src/pipeline/grade) measures centering and sees wear on realistic
// simulated phone photos and flatbed scans (tests/bench/gradeSim.mjs). Deterministic for a given seed.
//
//   node scripts/bench-grade.mjs [--n 20] [--seed 1] [--scenario a,b] [--out file.md] [--save-images dir]
//        [--case i] [--jobs 4] [--src dir] [--json file.json] [--compare before.json] [--faces]
//
//   --scenario     one or more of the scenario names (comma separated); default all
//   --case i       run only case i of the chosen scenario(s) and print it in detail (reproduce a worst case)
//   --save-images  write the 5 worst cases per scenario (or the --case) as PNG: the photo as analysed, and an overlay
//                  with the true outline in green and the found one in red
//   --jobs         worker threads (default: up to 4); --jobs 1 gives the steadiest timings
//   --src          directory holding the analyze.js to test (or a src/ root): e.g. a checkout of the old version
//   --pipeline     panel (default): as that version's panel does it: the photo scaled to ANALYZE_MAX_SIDE and, when
//                  its gradeEngine.js has cropRect (second pass), the card cut out of the full-size photo and measured
//                  again; single: one pass on the scaled photo only
//   --json         write every case's result; --compare prints the change against such a file
//   --faces        every scenario draws its card from the official card renders (tests/bench/official/faces.json;
//                  fetch them first: node scripts/fetch-grade-data.mjs --faces), the print moved against the cut by
//                  a known amount; without it the stylised templates (no network, the default)
//
// Centering error per axis: |measured − true| share of the left (top) border, in points. Unlike the folded "55/45"
// number it doesn't shrink near 50/50, so it is never smaller than the error of the number the panel shows.
import { parseArgs } from 'node:util';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  renderCase, prepareForAnalysis, cropArea, quadErrorMm, scoreCentering, drawQuads, encodePng, SCENARIOS, SCENARIO_NAMES, registerFaces,
} from '../tests/bench/gradeSim.mjs';
import { loadFaces } from '../tests/bench/officialFaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSITIVE = new Set(['minor', 'visible']);

function analyzePath(src) {
  const dir = path.resolve(src ?? path.join(ROOT, 'src/pipeline/grade'));
  for (const p of [path.join(dir, 'analyze.js'), path.join(dir, 'pipeline/grade/analyze.js'), path.join(dir, 'src/pipeline/grade/analyze.js')]) if (existsSync(p)) return p;
  throw new Error(`no analyze.js under ${dir}`);
}

/** The algorithm under test: analyzeCard, and the panel's second pass when that version has one. */
async function loadPipeline(analyzeFile, mode = 'panel') {
  const mod = await import(pathToFileURL(analyzeFile).href);
  const pipe = { analyzeCard: mod.analyzeCard, maxSide: mod.ANALYZE_MAX_SIDE ?? 2800, cropRect: null, cropMax: 3600 };
  const engine = path.resolve(path.dirname(analyzeFile), '../../sidepanel/gradeEngine.js');
  if (mode === 'panel' && existsSync(engine)) {
    try {
      const e = await import(pathToFileURL(engine).href);
      if (typeof e.cropRect === 'function') { pipe.cropRect = e.cropRect; pipe.cropMax = e.CROP_MAX_SIDE ?? 3600; }
    } catch { /* no second pass */ }
  }
  return pipe;
}

const RANK = { ok: 3, partial: 2, 'no-border': 1, 'no-card': 0 };

/**
 * As the panel measures a photo (gradeView.measure): the photo scaled to maxSide; then, if it was scaled down by more
 * than 1.15× and a card was found, the card cut out of the full photo (cropRect, long side ≤ CROP_MAX_SIDE) and
 * measured again; the finer pass wins unless its status ranks lower. Truth is moved into the winning frame.
 */
function analyzeLikePanel(pipe, raw) {
  const first = prepareForAnalysis(raw, pipe.maxSide);
  let t = performance.now();
  let res = pipe.analyzeCard(first.img);
  let ms = performance.now() - t;
  let { img, truth } = first;
  let passes = 1;
  const k = raw.img.width / first.img.width;
  if (pipe.cropRect && res.status !== 'no-card' && k > 1.15 && res.quad) {
    const rect = pipe.cropRect(res.quad.map(([x, y]) => [x * k, y * k]), { width: raw.img.width, height: raw.img.height });
    if (rect) {
      const crop = cropArea(raw.img, rect, pipe.cropMax);
      t = performance.now();
      const fine = pipe.analyzeCard(crop.img);
      ms += performance.now() - t;
      passes = 2;
      if (RANK[fine.status] >= RANK[res.status]) {
        res = fine; img = crop.img;
        truth = { ...raw.truth, corners: raw.truth.corners.map(([x, y]) => [(x - rect.x) / crop.scale, (y - rect.y) / crop.scale]), pxPerMm: raw.truth.pxPerMm / crop.scale };
      }
    }
  }
  return { r: res, img, truth, meta: first.meta, passes, ms };
}

/** Render, analyse as the panel would, score. */
async function runCase(pipe, scenario, seed, index, { keep = false } = {}) {
  const t0 = performance.now();
  const raw = renderCase(scenario, seed, index);
  const t1 = performance.now();
  // ms: analyzeCard only (both passes); the panel's resizing is left out, as is rendering.
  const { r, img, truth, meta, passes, ms } = analyzeLikePanel(pipe, raw);
  const rec = {
    scenario, index, caseSeed: meta.caseSeed, renderMs: t1 - t0, ms, passes,
    status: r.status, source: r.source ?? null, flags: r.quality?.flags ?? [],
    truth: { lr: truth.lr, tb: truth.tb, borders: truth.borders, pxPerMm: truth.pxPerMm, wear: truth.wear },
    pxPerMm: r.quality?.pxPerMm ?? null,
    quadErrMm: r.quad ? quadErrorMm(r.quad, truth) : null,
    meta: describeMeta(meta, img),
  };
  // Signed shares in card orientation (the found quad may start at another corner when the card is upside down).
  Object.assign(rec, scoreCentering(r, truth));
  rec.measured = rec.err !== null;
  // Wear: rating per area against the truth.
  rec.wear = {
    edges: r.wear?.edges?.rating ?? 'unknown', corners: r.wear?.corners?.rating ?? 'unknown',
    trueEdges: truth.wear.edges.length > 0, trueCorners: truth.wear.corners.length > 0,
  };
  if (keep) {
    rec.detail = {
      sides: Object.fromEntries(Object.entries(r.borders?.sides ?? {}).map(([k, v]) => [k, { ok: v.ok, mm: v.mm, sigmaPx: v.sigmaPx, reason: v.reason }])),
      wearEdges: r.wear?.edges?.sides ? Object.fromEntries(Object.entries(r.wear.edges.sides).map(([k, v]) => [k, v.status === 'ok' ? v.runs : v.reason])) : null,
      wearCorners: r.wear?.corners?.list ?? null,
      quad: r.quad, trueQuad: truth.corners,
    };
    rec.image = img;
  }
  return rec;
}

function describeMeta(m, img) {
  const out = {
    template: m.template, variant: m.variant && Object.keys(m.variant).length ? m.variant : undefined,
    size: `${img.width}x${img.height}`, bg: m.bg,
  };
  if (m.mode === 'scan') Object.assign(out, { dpi: m.dpi, skew: m.skew, jpeg: m.jpeg, cis: +m.cis.sx.toFixed(2), page: !!m.page, analysisScale: +m.analysisScale.toFixed(3) });
  else {
    Object.assign(out, {
      pxPerMm: m.scaleUsed, pitch: m.pitch, yaw: m.yaw, rot: m.rotation, fOverL: +(m.f / Math.max(m.W, m.H)).toFixed(2), k1: +m.k1.toFixed(3),
      jpeg: m.jpeg, psf: +m.psf.sigma.toFixed(2), psf2: m.psf.sigma2 ? +m.psf.sigma2.toFixed(2) : undefined,
      glare: m.glare ? +m.glare.amp.toFixed(2) : undefined, sharpen: m.sharpen ? +m.sharpen.amount.toFixed(2) : undefined,
    });
  }
  if (m.hard) out.hard = m.hard;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

// ---------------------------------------------------------------- statistics and report

const q = (sorted, f) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(f * sorted.length) - 1))];
const f2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(d));
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '–');

function summarize(recs) {
  const n = recs.length;
  const det = recs.filter((r) => r.status !== 'no-card').length;
  const meas = recs.filter((r) => r.measured);
  const errs = meas.map((r) => r.err).sort((a, b) => a - b);
  const axes = meas.flatMap((r) => [r.lr, r.tb]);
  const wrong = recs.filter((r) => r.status !== 'no-card' && !(r.quadErrMm <= 1)).length;
  const clean = recs.filter((r) => !r.wear.trueEdges && !r.wear.trueCorners);
  const alarm = clean.filter((r) => POSITIVE.has(r.wear.edges) || POSITIVE.has(r.wear.corners)).length;
  const unknownClean = clean.filter((r) => r.wear.edges === 'unknown' && r.wear.corners === 'unknown').length;
  return {
    n, det, measured: meas.length, wrong,
    mean: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
    median: errs.length ? q(errs, 0.5) : null, p95: errs.length ? q(errs, 0.95) : null, max: errs.length ? errs[errs.length - 1] : null,
    in1: axes.filter((a) => a.err <= a.sigma).length, in2: axes.filter((a) => a.err <= 2 * a.sigma).length, axes: axes.length,
    sigmaMed: axes.length ? q(axes.map((a) => a.sigma).sort((a, b) => a - b), 0.5) : null,
    ms: recs.reduce((a, r) => a + r.ms, 0) / n, renderMs: recs.reduce((a, r) => a + r.renderMs, 0) / n,
    clean: clean.length, alarm, unknownClean,
  };
}

function wearTable(recs) {
  const rows = [];
  for (const area of ['edges', 'corners']) {
    const truthKey = area === 'edges' ? 'trueEdges' : 'trueCorners';
    const pos = recs.filter((r) => r.wear[truthKey]); const neg = recs.filter((r) => !r.wear[truthKey]);
    const known = (list) => list.filter((r) => r.wear[area] !== 'unknown');
    const hit = (list) => list.filter((r) => POSITIVE.has(r.wear[area])).length;
    const kp = known(pos); const kn = known(neg);
    rows.push(`| ${area} | ${hit(kp)}/${kp.length} (${pct(hit(kp), kp.length)}) | ${hit(kn)}/${kn.length} (${pct(hit(kn), kn.length)}) | ${pos.length - kp.length}/${pos.length} | ${neg.length - kn.length}/${neg.length} |`);
  }
  return ['| area | true positives (worn, rated minor/visible) | false positives (not worn, rated minor/visible) | unknown (worn) | unknown (not worn) |',
    '|---|---|---|---|---|', ...rows].join('\n');
}

function table(byScenario) {
  const head = '| scenario | n | detected | measured | wrong outline | err mean | median | P95 | max | within 1σ | within 2σ | σ median | analyze ms | render ms | wear alarm on clean |';
  const lines = [head, '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const all = [];
  for (const [name, recs] of byScenario) {
    all.push(...recs);
    lines.push(row(name, summarize(recs)));
  }
  if (byScenario.size > 1) lines.push(row('**all**', summarize(all)));
  return lines.join('\n');
}
function row(name, s) {
  return `| ${name} | ${s.n} | ${pct(s.det, s.n)} | ${pct(s.measured, s.n)} | ${s.wrong} | ${f2(s.mean)} | ${f2(s.median)} | ${f2(s.p95)} | ${f2(s.max)} | ${pct(s.in1, s.axes)} | ${pct(s.in2, s.axes)} | ${f2(s.sigmaMed)} | ${Math.round(s.ms)} | ${Math.round(s.renderMs)} | ${s.alarm}/${s.clean}${s.unknownClean ? ` (unknown ${s.unknownClean})` : ''} |`;
}

const badness = (r) => (r.status === 'no-card' ? 1e9 : !r.measured ? 1e8 : r.err);
const worst = (recs, k = 5) => [...recs].sort((a, b) => badness(b) - badness(a) || a.index - b.index).slice(0, k);

function caseLine(r, seed) {
  const ax = (a) => (r[a] ? `${f2(r[a].share, 1)} vs ${f2(r[a].trueShare, 1)} (σ ${f2(r[a].sigma)})` : 'none');
  const what = r.status === 'no-card' ? 'no card' : !r.measured ? `not measured (${r.status})` : `err ${f2(r.err)}`;
  const wearTxt = r.wear.trueEdges || r.wear.trueCorners || POSITIVE.has(r.wear.edges) || POSITIVE.has(r.wear.corners)
    ? `; wear edges ${r.wear.edges}${r.wear.trueEdges ? ' (worn)' : ''}, corners ${r.wear.corners}${r.wear.trueCorners ? ' (worn)' : ''}` : '';
  return `- #${r.index}: ${what}; L/R ${ax('lr')}, T/B ${ax('tb')}; outline off ${f2(r.quadErrMm)} mm; ${r.status}${r.flags.length ? ` [${r.flags.join(', ')}]` : ''}${wearTxt}\n`
    + `  ${JSON.stringify(r.meta)}\n`
    + `  \`node scripts/bench-grade.mjs --scenario ${r.scenario} --seed ${seed} --case ${r.index}\``;
}

function report(byScenario, { seed, n, src, elapsed, jobs, pipeline, faces = 0 }) {
  const out = [];
  out.push(`# Grade-check benchmark${faces ? ' (official card faces)' : ''}\n`);
  out.push(`seed ${seed}, ${n} cases per scenario, algorithm: \`${src}\` (${pipeline}), ${jobs} worker(s), ${(elapsed / 1000).toFixed(0)} s.\n`);
  if (faces) out.push(`Cards: ${faces} official card renders (tests/bench/official/faces.json), the whole print moved against the cut by a known amount; true borders = the render's measured borders plus that shift (Lorcana: centering taken against its wide bottom border).\n`);
  out.push('Error: |measured − true| share of the left (top) border, points, worst of the two axes, on cases measured on both axes. '
    + '"wrong outline": found, but a corner more than 1 mm from the true one. Within 1σ / 2σ: share of axis errors within the claimed sigma. '
    + 'Wear alarm: minor or visible on a card without wear.\n');
  out.push(table(byScenario));
  if (faces) {
    const byGame = new Map();
    for (const r of [...byScenario.values()].flat()) {
      const g = r.meta.variant?.game ?? 'other';
      if (!byGame.has(g)) byGame.set(g, []);
      byGame.get(g).push(r);
    }
    out.push(`\n## By game\n\n${table(new Map([...byGame].sort()))}`);
  }
  const sc = [...byScenario.keys()];
  if (byScenario.has('wear')) out.push(`\n## Wear (scenario wear)\n\n${wearTable(byScenario.get('wear'))}`);
  out.push('\n## Scenarios\n');
  for (const name of sc) out.push(`- **${name}**: ${SCENARIOS[name].description}`);
  out.push('\n## Worst cases\n');
  for (const name of sc) {
    out.push(`### ${name}\n`);
    for (const r of worst(byScenario.get(name))) out.push(caseLine(r, seed));
    out.push('');
  }
  return out.join('\n');
}

function compare(byScenario, beforeFile, seed) {
  const before = JSON.parse(readFileSync(beforeFile, 'utf8'));
  if (before.seed !== seed) return `\n## Change against ${path.basename(beforeFile)}\n\nNot compared: that run used seed ${before.seed}, this one ${seed}.`;
  const old = new Map();
  for (const r of before.cases) old.set(`${r.scenario}:${r.index}`, r);
  const lines = [`\n## Change against ${path.basename(beforeFile)} (seed ${before.seed})\n`,
    '| scenario | detected before → after | measured | median err | P95 | max | better by > 0.5 | worse by > 0.5 |', '|---|---|---|---|---|---|---|---|'];
  const worse = [];
  for (const [name, recs] of byScenario) {
    const prev = recs.map((r) => old.get(`${name}:${r.index}`)).filter(Boolean);
    if (prev.length !== recs.length) { lines.push(`| ${name} | (not in the old run, or different n) |||||||`); continue; }
    const a = summarize(prev); const b = summarize(recs);
    let better = 0; let worseN = 0;
    recs.forEach((r, i) => {
      const e0 = prev[i].err ?? 99; const e1 = r.err ?? 99;
      if (e1 < e0 - 0.5) better++;
      if (e1 > e0 + 0.5) { worseN++; worse.push({ r, e0, e1 }); }
    });
    lines.push(`| ${name} | ${a.det} → ${b.det} | ${a.measured} → ${b.measured} | ${f2(a.median)} → ${f2(b.median)} | ${f2(a.p95)} → ${f2(b.p95)} | ${f2(a.max)} → ${f2(b.max)} | ${better} | ${worseN} |`);
  }
  if (worse.length) {
    lines.push('\nWorse cases:\n');
    for (const { r, e0, e1 } of worse.sort((p, q2) => (q2.e1 - q2.e0) - (p.e1 - p.e0)).slice(0, 15)) lines.push(`- ${r.scenario} #${r.index}: ${e0 === 99 ? 'none' : f2(e0)} → ${e1 === 99 ? 'none' : f2(e1)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- workers

async function workerMain() {
  const pipe = await loadPipeline(workerData.analyze, workerData.pipeline);
  if (workerData.faces) registerFaces(loadFaces());
  parentPort.on('message', async (job) => {
    try {
      const rec = await runCase(pipe, job.scenario, job.seed, job.index, { keep: !!job.save });
      if (job.save) { await saveImages(rec, job.save); delete rec.image; }
      parentPort.postMessage({ id: job.id, rec });
    } catch (err) {
      parentPort.postMessage({ id: job.id, error: String(err?.stack ?? err) });
    }
  });
}

async function saveImages(rec, dir) {
  mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `${rec.scenario}-${rec.index}`);
  writeFileSync(`${base}.png`, await encodePng(rec.image));
  const over = drawQuads(rec.image, [{ quad: rec.detail.trueQuad, color: [0, 255, 0] }, { quad: rec.detail.quad, color: [255, 0, 0] }]);
  writeFileSync(`${base}-overlay.png`, await encodePng(over));
}

function pool(jobs, analyze, pipeline, faces) {
  const workers = []; const waiting = new Map(); let id = 0;
  const queue = [];
  const spawn = () => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { analyze, pipeline, faces } });
    w.on('message', (m) => { const p = waiting.get(m.id); waiting.delete(m.id); w.busy = false; if (m.error) p.reject(new Error(m.error)); else p.resolve(m.rec); pump(); });
    w.on('error', (e) => { for (const p of waiting.values()) p.reject(e); });
    workers.push(w);
  };
  const pump = () => {
    for (const w of workers) {
      if (w.busy || !queue.length) continue;
      const job = queue.shift();
      w.busy = true;
      w.postMessage(job);
    }
  };
  for (let i = 0; i < jobs; i++) spawn();
  return {
    run(job) { return new Promise((resolve, reject) => { const j = { ...job, id: ++id }; waiting.set(j.id, { resolve, reject }); queue.push(j); pump(); }); },
    close() { for (const w of workers) w.terminate(); },
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const { values: o } = parseArgs({
    options: {
      n: { type: 'string', default: '20' }, seed: { type: 'string', default: '1' }, scenario: { type: 'string' },
      out: { type: 'string' }, 'save-images': { type: 'string' }, case: { type: 'string' }, jobs: { type: 'string' },
      src: { type: 'string' }, json: { type: 'string' }, compare: { type: 'string' }, quiet: { type: 'boolean', default: false },
      pipeline: { type: 'string', default: 'panel' }, faces: { type: 'boolean', default: false },
    },
  });
  const seed = Number(o.seed); const n = Number(o.n);
  const names = o.scenario ? o.scenario.split(',').map((s) => s.trim()) : [...SCENARIO_NAMES];
  for (const s of names) if (!SCENARIOS[s]) throw new Error(`unknown scenario "${s}"; known: ${SCENARIO_NAMES.join(', ')}`);
  const analyze = analyzePath(o.src);
  if (!['panel', 'single'].includes(o.pipeline)) throw new Error('--pipeline is panel or single');
  const rel = path.relative(ROOT, path.dirname(analyze));
  const srcLabel = rel && !rel.startsWith('..') ? rel : path.dirname(analyze);
  const jobsN = Math.max(1, Number(o.jobs ?? Math.min(4, os.availableParallelism?.() ?? os.cpus().length)));
  const t0 = performance.now();
  // Load once here first: a missing face fails before any worker starts.
  const faceCount = o.faces ? (() => { const f = loadFaces(); registerFaces(f); return f.length; })() : 0;

  if (o.case !== undefined) {
    // One case in detail (in this thread: steady timing).
    const pipe = await loadPipeline(analyze, o.pipeline);
    for (const name of names) {
      const rec = await runCase(pipe, name, seed, Number(o.case), { keep: true });
      console.log(`${name} #${rec.index} (case seed ${rec.caseSeed}): ${rec.status}, source ${rec.source}, ${rec.ms.toFixed(0)} ms in ${rec.passes} pass(es) (render ${rec.renderMs.toFixed(0)} ms)`);
      console.log(`  params ${JSON.stringify(rec.meta)}`);
      const t = rec.truth.borders;
      for (const [side, key] of [['left', 'l'], ['right', 'r'], ['top', 't'], ['bottom', 'b']]) {
        const d = rec.detail.sides[side];
        console.log(`  ${side.padEnd(6)} true ${t[key].toFixed(3)} mm, measured ${d ? (d.ok ? `${d.mm.toFixed(3)} mm (σ ${(d.sigmaPx ?? 0).toFixed(2)} px)` : `– (${d.reason})`) : '–'}`);
      }
      for (const ax of ['lr', 'tb']) console.log(`  ${ax}: ${rec[ax] ? `share ${rec[ax].share.toFixed(2)} vs true ${rec[ax].trueShare.toFixed(2)}, err ${rec[ax].err.toFixed(2)}, σ ${rec[ax].sigma.toFixed(2)}` : 'not measured'}`);
      console.log(`  outline off ${f2(rec.quadErrMm)} mm; px/mm ${f2(rec.pxPerMm)} (true ${f2(rec.truth.pxPerMm)}); flags ${rec.flags.join(', ') || 'none'}`);
      console.log(`  wear: edges ${rec.wear.edges}, corners ${rec.wear.corners}; truth ${JSON.stringify(rec.truth.wear)}`);
      if (rec.detail.wearEdges) console.log(`  edge runs ${JSON.stringify(rec.detail.wearEdges)}`);
      if (rec.detail.wearCorners) console.log(`  corners ${JSON.stringify(Object.fromEntries(Object.entries(rec.detail.wearCorners).map(([k, v]) => [k, v.status === 'ok' ? `${v.rating} shape ${f2(v.shapeMm)} white ${f2(v.whiteFrac)}` : v.reason])))}`);
      if (o['save-images']) { await saveImages(rec, o['save-images']); console.log(`  saved ${path.join(o['save-images'], `${name}-${rec.index}`)}.png and -overlay.png`); }
    }
    return;
  }

  const p = pool(jobsN, analyze, o.pipeline, o.faces);
  const pipeInfo = await loadPipeline(analyze, o.pipeline);
  const pipelineLabel = pipeInfo.cropRect ? `panel: ≤ ${pipeInfo.maxSide} px, then the card at full size (≤ ${pipeInfo.cropMax} px)` : `one pass, ≤ ${pipeInfo.maxSide} px`;
  // Expensive scenarios first, so the workers finish together.
  const cost = { 'scan-1200-black': 9, 'scan-300-fullpage': 6, 'phone-good': 5, hard: 4, wear: 4, 'scan-600-white': 3, 'scan-600-black': 3, 'phone-listing': 2, 'phone-low': 1 };
  const jobs = names.flatMap((s) => Array.from({ length: n }, (_, i) => ({ scenario: s, seed, index: i }))).sort((a, b) => (cost[b.scenario] ?? 1) - (cost[a.scenario] ?? 1));
  let done = 0;
  const results = await Promise.all(jobs.map((j) => p.run(j).then((r) => {
    done++;
    if (!o.quiet && process.stderr.isTTY) process.stderr.write(`\r${done}/${jobs.length} cases`);
    return r;
  })));
  if (!o.quiet && process.stderr.isTTY) process.stderr.write('\n');
  const byScenario = new Map(names.map((s) => [s, results.filter((r) => r.scenario === s).sort((a, b) => a.index - b.index)]));
  const elapsed = performance.now() - t0;
  let md = report(byScenario, { seed, n, src: srcLabel, elapsed, jobs: jobsN, pipeline: pipelineLabel, faces: faceCount });
  if (o.compare) md += `\n${compare(byScenario, o.compare, seed)}\n`;
  console.log(md);
  if (o.out) writeFileSync(o.out, `${md}\n`);
  if (o.json) writeFileSync(o.json, JSON.stringify({ seed, n, src: srcLabel, cases: results }, null, 1));
  if (o['save-images']) {
    const picks = [...byScenario.values()].flatMap((recs) => worst(recs));
    await Promise.all(picks.map((r) => p.run({ scenario: r.scenario, seed, index: r.index, save: o['save-images'] })));
    console.log(`\nSaved ${picks.length} worst cases (photo as analysed + overlay: green true outline, red found) to ${o['save-images']}`);
  }
  p.close();
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain();
