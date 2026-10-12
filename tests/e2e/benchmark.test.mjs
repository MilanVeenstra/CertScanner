// D3 OCR benchmark gate (ADR-001 §14, ADR A20): every fixture goes through the real extension's upload path in one
// warm side panel, for two sets:
//   bench       tests/fixtures/bench/ (65 renders + single-factor degradations). Gate: top-1 >= 90% clean, >= 70%
//               degraded, and zero wrong auto-opens (hard blocker). Unchanged since D3.
//   bench-real  tests/fixtures/bench-real/ (66 phone/marketplace-style photos, ADR A20). Gate (frozen 2026-10-12):
//               0 wrong auto-opens, top number correct >= 60 of 62 positives, wrong number shown <= 1, had to
//               choose <= 5.
// Both sets also report what a user sees beyond top-1: outcome classes (auto-ok / auto-WRONG / opened-ok /
// opened-wrong / confirm-ok / confirm-choose / confirm-wrong / none-ok / none-miss / fp / error), "wrong number shown"
// (confirm-wrong + opened-wrong + fp), "had to choose" (>= 2 numbers offered, top right) and timing per family.
// For diagnosis each fixture is additionally passed to scan() in the same panel realm (same engines) to capture
// candidates, evidence and timings; the gates use only what the UI showed and opened.
//
// Output: $CERTSCANNER_E2E_OUT (default <tmp>/certscanner-e2e)/benchmark-results.{json,md} and
// bench-real-results.{json,md}.
// Env: CERTSCANNER_SKIP_BENCH=1 skips everything; CERTSCANNER_BENCH_SETS=bench|real|bench,real (default both);
// CERTSCANNER_BENCH_COMPARE=<dir with an earlier run's result files> adds class changes per fixture and fails on a
// new none -> confirm-wrong transition.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import * as E from './lib/env.mjs';
import { storageGet } from './lib/panel.mjs';
import { cardInfo } from '../../src/core/priceLinks.js';

/** Card name check: the search terms the panel shows (after its label pass) vs the same rule applied to the printed label. */
const words = (s) => String(s ?? '').toLowerCase().split(/\s+/).filter((w) => /\p{L}{3,}/u.test(w) || /^\d{1,4}$/.test(w));
function nameMatch(expectedDesc, shown) {
  if (!expectedDesc) return null;
  const got = new Set(words(shown));
  const want = words(expectedDesc);
  return want.length > 0 && want.every((w) => got.has(w));
}

const bench = JSON.parse(readFileSync(path.join(E.BENCH, 'bench-manifest.json'), 'utf8'));
const real = JSON.parse(readFileSync(path.join(E.BENCH_REAL, 'manifest.json'), 'utf8'));
const OUT = process.env.CERTSCANNER_E2E_OUT ? path.resolve(process.env.CERTSCANNER_E2E_OUT) : path.join(os.tmpdir(), 'certscanner-e2e');
const SKIP = process.env.CERTSCANNER_SKIP_BENCH === '1';
const SETS = new Set((process.env.CERTSCANNER_BENCH_SETS ?? 'bench,real').split(',').map((s) => s.trim()));
const COMPARE = process.env.CERTSCANNER_BENCH_COMPARE ? path.resolve(process.env.CERTSCANNER_BENCH_COMPARE) : null;
const SLOW_MS = 5000;

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}
const timing = (xs) => ({ n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: xs.length ? Math.max(...xs) : null });

const CLASSES = Object.freeze(['auto-ok', 'auto-WRONG', 'opened-ok', 'opened-wrong', 'confirm-ok', 'confirm-choose', 'confirm-wrong', 'none-ok', 'none-miss', 'fp', 'error']);
const TOP_OK = new Set(['auto-ok', 'opened-ok', 'confirm-ok', 'confirm-choose']);
const WRONG_SHOWN = new Set(['confirm-wrong', 'opened-wrong', 'fp']);

/**
 * Outcome class from what the panel showed and opened.
 * `numbers`: every number that counts as right (two-slab photos: either slab); `positive`: a miss here is a failure.
 */
function classify({ numbers, positive, expectedUrl, mustNotAutoOpen }, ui) {
  const shownOk = ui.number !== null && numbers.includes(ui.number);
  if (ui.state === 'auto-open') {
    const ok = positive && !mustNotAutoOpen && expectedUrl && ui.opened.length === 1 && ui.opened[0] === expectedUrl;
    return ok ? 'auto-ok' : 'auto-WRONG';
  }
  if (ui.state === 'opened') return shownOk ? 'opened-ok' : 'opened-wrong';
  if (ui.state === 'confirm') {
    if (!numbers.length) return 'fp';
    if (!shownOk) return 'confirm-wrong';
    return ui.candidates >= 2 ? 'confirm-choose' : 'confirm-ok';
  }
  if (ui.state === 'none') return positive ? 'none-miss' : 'none-ok';
  return 'error';
}
const countClasses = (rows) => Object.fromEntries(CLASSES.map((c) => [c, rows.filter((r) => r.cls === c).length]));

/** Class changes against an earlier run's rows (same fixture ids). */
function compareRuns(rows, file) {
  if (!COMPARE || !existsSync(path.join(COMPARE, file))) return null;
  const prev = JSON.parse(readFileSync(path.join(COMPARE, file), 'utf8'));
  const byId = new Map((prev.rows ?? []).map((r) => [r.id, r]));
  const changes = [];
  for (const r of rows) {
    const p = byId.get(r.id);
    if (p?.cls && p.cls !== r.cls) changes.push({ id: r.id, from: p.cls, to: r.cls, fromMs: p.observed?.wallMs ?? null, toMs: r.observed.wallMs });
  }
  return {
    against: { build: prev.summary?.build ?? null, date: prev.summary?.date ?? null },
    changes,
    noneToConfirmWrong: changes.filter((c) => c.from.startsWith('none') && (c.to === 'confirm-wrong' || c.to === 'opened-wrong' || c.to === 'fp')).map((c) => c.id),
  };
}

/** Summary metrics shared by both sets. */
function outcomeSummary(rows, groupKey) {
  const positives = rows.filter((r) => r.positiveForTop);
  const groups = [...new Set(rows.map((r) => r[groupKey]))];
  const warm = rows.map((r) => r.observed.wallMs);
  return {
    classes: countClasses(rows),
    positives: positives.length,
    topCorrect: positives.filter((r) => TOP_OK.has(r.cls)).length,
    wrongAutoOpens: rows.filter((r) => r.cls === 'auto-WRONG').length,
    wrongNumberShown: rows.filter((r) => WRONG_SHOWN.has(r.cls)).map((r) => r.id),
    hadToChoose: rows.filter((r) => r.cls === 'confirm-choose').map((r) => r.id),
    noneOnPositives: rows.filter((r) => r.cls === 'none-miss').map((r) => r.id),
    slowerThan5s: rows.filter((r) => r.observed.wallMs > SLOW_MS).map((r) => `${r.id} (${r.observed.wallMs} ms)`),
    labelPassRows: rows.filter((r) => (r.pipeline?.candidates ?? []).some((c) => (c.evidence ?? []).includes('label-pass'))).map((r) => r.id),
    warmUiMs: timing(warm),
    byGroup: Object.fromEntries(groups.map((g) => {
      const rs = rows.filter((r) => r[groupKey] === g);
      return [g, { classes: countClasses(rs), warmUiMs: timing(rs.map((r) => r.observed.wallMs)) }];
    })),
  };
}

function outcomeMarkdown(o, groupLabel, cmp) {
  const nz = (cls) => CLASSES.filter((c) => cls[c]).map((c) => `${c} ${cls[c]}`).join(', ') || '-';
  const lines = [
    '| Outcome | n |', '|---|---|', ...CLASSES.map((c) => `| ${c} | ${o.classes[c]} |`), '',
    `Top number correct ${o.topCorrect}/${o.positives}; wrong number shown ${o.wrongNumberShown.length}${o.wrongNumberShown.length ? ` (${o.wrongNumberShown.join(', ')})` : ''}; had to choose ${o.hadToChoose.length}${o.hadToChoose.length ? ` (${o.hadToChoose.join(', ')})` : ''}; nothing found on a positive ${o.noneOnPositives.length}${o.noneOnPositives.length ? ` (${o.noneOnPositives.join(', ')})` : ''}; slower than 5 s: ${o.slowerThan5s.join(', ') || 'none'}.`,
    '',
    `| ${groupLabel} | Outcomes | Warm UI p50 / p95 / max (ms) |`, '|---|---|---|',
    ...Object.entries(o.byGroup).map(([g, v]) => `| ${g} | ${nz(v.classes)} | ${v.warmUiMs.p50} / ${v.warmUiMs.p95} / ${v.warmUiMs.max} |`),
    '',
  ];
  if (cmp) {
    lines.push(`Class changes against ${cmp.against.build?.gitCommit?.slice(0, 7) ?? '?'}${cmp.against.build?.gitDirty ? '+dirty' : ''} (${cmp.against.date ?? '?'}): ${cmp.changes.length}; new none -> wrong number shown: ${cmp.noneToConfirmWrong.length}.`, '');
    if (cmp.changes.length) lines.push('| Fixture | Before | After | ms before → after |', '|---|---|---|---|', ...cmp.changes.map((c) => `| ${c.id} | ${c.from} | ${c.to} | ${c.fromMs} → ${c.toMs} |`), '');
  }
  return lines;
}

const fmtCands = (r) => (r.pipeline?.candidates ?? []).slice(0, 3).map((c) => `${c.number}/${c.grader ?? '?'}/${c.confidence}${(c.evidence ?? []).includes('label-pass') ? '(L)' : ''}`).join(' ') || '-';

describe('D3 OCR benchmark (upload path, one warm panel)', { concurrency: false, skip: SKIP ? 'CERTSCANNER_SKIP_BENCH=1' : false }, () => {
  let env;
  let panel;
  let targetWindow;
  const cold = [];
  let build;

  /** Wait until the panel's background label pass (card name, price block) has finished: the OCR queue is empty. */
  async function settledCard() {
    return E.poll(async () => panel.page.evaluate(() => {
      const box = document.querySelector('[data-testid="price-data"]');
      if (!box || ['reading', ''].includes(box.dataset.status ?? '')) return null;
      return document.querySelector('[data-testid="price-card"]')?.value ?? '';
    }), { timeout: 15000, interval: 100, message: 'label pass' }).catch(() => null);
  }

  async function scanFile(file) {
    const before = new Set((await E.allTabs(env)).map((t) => t.id));
    const r = await E.uploadAndWait(panel.page, file, { timeout: 60000 });
    let opened = [];
    if (r.state === 'auto-open') {
      opened = await E.poll(async () => { const x = (await E.graderTabs(env)).filter((t) => !before.has(t.id)); return x.length ? x : null; },
        { timeout: 5000, message: 'auto-opened tab' }).catch(() => []);
    } else {
      await E.sleep(150);
      opened = (await E.graderTabs(env)).filter((t) => !before.has(t.id));
    }
    await E.closeGraderTabs(env);
    // Card name: wait for the panel's label pass (price block leaves 'reading'), then read the shown search terms.
    const card = ['auto-open', 'opened'].includes(r.state) ? await settledCard() : null;
    return { ...r, opened: opened.map((t) => t.url), card };
  }

  async function diagnose(file, mimeType) {
    try {
      const diag = await E.scanInPanel(panel.page, { kind: 'blob-b64', b64: readFileSync(file).toString('base64'), type: mimeType });
      return {
        status: diag.status, error: diag.error?.code ?? null, timings: diag.timings ?? null,
        warnings: (diag.warnings ?? []).map((w) => w.code),
        candidates: (diag.candidates ?? []).map((c) => ({ number: c.number, grader: c.grader, graderOptions: c.graderOptions, confidence: c.confidence, source: c.source, evidence: c.evidence })),
        imageInfo: diag.imageInfo ? { width: diag.imageInfo.width, height: diag.imageInfo.height } : null,
      };
    } catch (e) {
      return { status: 'error', error: `diag-failed: ${e.message}`, timings: null, warnings: [], candidates: [], imageInfo: null };
    }
  }

  before(async () => {
    build = E.assertBuilt();
    env = await E.launchExtension();
    targetWindow = await env.sw.evaluate(async () => (await chrome.windows.getAll())[0].id);
    panel = await E.openPanel(env, targetWindow);
    const settings = await storageGet(panel.page, 'sync', 'settings');
    assert.ok(settings === null || settings.autoOpen !== false, 'fresh profile: auto-open on (default)');
  });

  after(async () => {
    await env?.close();
  });

  test('cold start: first scan in a fresh profile, then 4 freshly loaded panels', { timeout: 300_000, skip: !SETS.has('bench') && 'bench set not selected' }, async () => {
    const f = bench.fixtures.find((x) => x.id === 'psa-c01');
    for (let i = 0; i < 5; i++) {
      if (i > 0) await E.reloadPanel(panel.page);
      const r = await scanFile(path.join(E.BENCH, f.file));
      cold.push({ sample: i === 0 ? 'fresh-profile' : `panel-reload-${i}`, wallMs: r.wallMs, state: r.state, number: r.number });
    }
    console.log(`# cold scans (${f.file}): ${cold.map((c) => `${c.sample} ${c.wallMs} ms ${c.state}`).join('; ')}`);
    assert.ok(cold.every((c) => c.number === f.expected.number));
  });

  test(`all ${bench.fixtures.length} benchmark fixtures: top-1, auto-open precision, wrong auto-opens, warm timings`, { timeout: 1_200_000, skip: !SETS.has('bench') && 'bench set not selected' }, async () => {
    const rows = [];
    for (const f of bench.fixtures) {
      const file = path.join(E.BENCH, f.file);
      const ui = await scanFile(file);
      const diag = await diagnose(file, f.mimeType);
      const exp = f.expected;
      const expectedUrl = exp.number && exp.grader ? E.CERT_URL[exp.grader](exp.number) : null;
      const top1 = exp.number !== null && ui.number === exp.number;
      const autoOpen = ui.state === 'auto-open';
      const autoUrl = ui.opened[0] ?? null;
      const wrongAuto = autoOpen && (f.mustNotAutoOpen || !expectedUrl || autoUrl !== expectedUrl || ui.opened.length !== 1);
      const strayTab = !autoOpen && ui.opened.length > 0;
      const graderShown = ui.grader;
      const expectedDesc = exp.grader && exp.number ? cardInfo({ grader: exp.grader, number: exp.number, lines: f.labelText ?? [] }).desc : null;
      const nameOk = expectedDesc ? nameMatch(expectedDesc, ui.card) : null;
      const numbers = exp.number ? [exp.number] : [];
      const positive = numbers.length > 0 && f.category !== 'negative';
      const cls = classify({ numbers, positive, expectedUrl, mustNotAutoOpen: !!f.mustNotAutoOpen }, ui);
      const row = {
        id: f.id, file: f.file, category: f.category, degradations: f.degradations, grader: exp.grader ?? 'none',
        expected: exp, accept: f.accept,
        observed: { state: ui.state, number: ui.number, grader: graderShown, opened: ui.opened, wallMs: ui.wallMs, candidates: ui.candidates },
        top1, statusAccepted: f.accept.includes(ui.state),
        graderOk: exp.grader === null ? (f.graderUnresolved ? graderShown === null : true) : graderShown === exp.grader,
        autoOpen, wrongAuto, strayTab, cls, positiveForTop: positive,
        name: expectedDesc ? { expected: expectedDesc, shown: ui.card, ok: nameOk } : null,
        pipeline: diag,
      };
      rows.push(row);
      const flag = row.wrongAuto ? 'WRONG-AUTO-OPEN' : !top1 && exp.number ? 'MISS' : !row.statusAccepted ? 'STATUS' : 'ok';
      console.log(`# ${f.id.padEnd(26)} ${f.category.padEnd(8)} ${ui.state.padEnd(9)} ${String(ui.number).padEnd(14)} ${String(graderShown).padEnd(10)} ${String(ui.wallMs).padStart(5)} ms  ${cls.padEnd(14)} ${flag}`);
    }

    const by = (cat) => rows.filter((r) => r.category === cat && r.expected.number !== null);
    const clean = by('clean');
    const degraded = by('degraded');
    const autos = rows.filter((r) => r.autoOpen);
    const wrong = rows.filter((r) => r.wrongAuto);
    const warm = rows.map((r) => r.observed.wallMs);
    const pipe = rows.map((r) => r.pipeline?.timings?.totalMs).filter((x) => typeof x === 'number');
    const cmp = compareRuns(rows, 'benchmark-results.json');
    const summary = {
      build: { gitCommit: build.gitCommit, gitDirty: build.gitDirty, builtAt: build.builtAt, target: build.target },
      browser: env.browserVersion, date: new Date().toISOString(), fixtures: rows.length,
      top1: {
        clean: { correct: clean.filter((r) => r.top1).length, total: clean.length, pct: pct(clean.filter((r) => r.top1).length, clean.length) },
        degraded: { correct: degraded.filter((r) => r.top1).length, total: degraded.length, pct: pct(degraded.filter((r) => r.top1).length, degraded.length) },
      },
      graderCorrectWhenTop1: pct(rows.filter((r) => r.top1 && r.graderOk).length, rows.filter((r) => r.top1).length),
      graderCorrect: {
        clean: pct(clean.filter((r) => r.graderOk).length, clean.length),
        degraded: pct(degraded.filter((r) => r.graderOk).length, degraded.length),
        byGrader: Object.fromEntries(['psa', 'cgc-comics', 'cgc-cards', 'bgs'].map((g) => {
          const rs = rows.filter((r) => r.expected.grader === g);
          return [g, { top1: pct(rs.filter((r) => r.top1).length, rs.length), grader: pct(rs.filter((r) => r.graderOk).length, rs.length), n: rs.length }];
        })),
      },
      cardName: {
        clean: pct(clean.filter((r) => r.name?.ok).length, clean.filter((r) => r.name).length),
        degraded: pct(degraded.filter((r) => r.name?.ok).length, degraded.filter((r) => r.name).length),
      },
      autoOpen: {
        count: autos.length, correct: autos.length - wrong.length, precision: pct(autos.length - wrong.length, autos.length),
        rateCleanPositives: pct(clean.filter((r) => r.autoOpen && !r.wrongAuto).length, clean.length),
        rateDegradedPositives: pct(degraded.filter((r) => r.autoOpen && !r.wrongAuto).length, degraded.length),
      },
      wrongAutoOpens: wrong.map((r) => ({ id: r.id, opened: r.observed.opened, expected: r.expected })),
      strayTabs: rows.filter((r) => r.strayTab).map((r) => r.id),
      negatives: rows.filter((r) => r.category === 'negative').map((r) => ({ id: r.id, state: r.observed.state, accepted: r.statusAccepted })),
      outcomes: { byCategory: outcomeSummary(rows, 'category'), byGrader: outcomeSummary(rows, 'grader').byGroup },
      comparison: cmp,
      timings: {
        coldUiMs: cold,
        warmUiMs: { p50: quantile(warm, 0.5), p95: quantile(warm, 0.95), max: Math.max(...warm) },
        warmPipelineTotalMs: { p50: quantile(pipe, 0.5), p95: quantile(pipe, 0.95), max: Math.max(...pipe) },
      },
      gate: bench.gate,
      failures: rows.filter((r) => (r.expected.number !== null && !r.top1) || r.wrongAuto || !r.statusAccepted).map((r) => ({
        id: r.id, category: r.category, degradations: r.degradations, expected: r.expected, observed: r.observed,
        top1: r.top1, statusAccepted: r.statusAccepted, wrongAuto: r.wrongAuto, pipelineTop: r.pipeline?.candidates?.slice(0, 3) ?? [],
        warnings: r.pipeline?.warnings ?? [],
      })),
    };
    summary.gatePassed = summary.top1.clean.pct >= bench.gate.top1CleanMin * 100
      && summary.top1.degraded.pct >= bench.gate.top1DegradedMin * 100
      && wrong.length <= bench.gate.wrongAutoOpensMax;

    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, 'benchmark-results.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
    const o = summary.outcomes.byCategory;
    const md = [
      `# CertScanner OCR benchmark (${summary.date})`,
      '',
      `Build ${summary.build.gitCommit?.slice(0, 7)}${summary.build.gitDirty ? '+dirty' : ''} (${summary.build.target}, ${summary.build.builtAt}); Chromium ${summary.browser}; ${rows.length} fixtures.`,
      '',
      '| Metric | Observed | Gate |',
      '|---|---|---|',
      `| Top-1 clean | ${summary.top1.clean.correct}/${summary.top1.clean.total} = ${summary.top1.clean.pct}% | >= ${bench.gate.top1CleanMin * 100}% |`,
      `| Top-1 degraded | ${summary.top1.degraded.correct}/${summary.top1.degraded.total} = ${summary.top1.degraded.pct}% | >= ${bench.gate.top1DegradedMin * 100}% |`,
      `| Wrong auto-opens | ${wrong.length} | ${bench.gate.wrongAutoOpensMax} |`,
      `| Wrong number shown (confirm-wrong + opened-wrong + fp) | ${o.wrongNumberShown.length} | - |`,
      `| Had to choose (>= 2 numbers, top right) | ${o.hadToChoose.length} | - |`,
      `| Auto-open precision | ${summary.autoOpen.correct}/${summary.autoOpen.count} = ${summary.autoOpen.precision}% | - |`,
      `| Auto-open rate (clean / degraded positives) | ${summary.autoOpen.rateCleanPositives}% / ${summary.autoOpen.rateDegradedPositives}% | - |`,
      `| Grader correct when top-1 correct | ${summary.graderCorrectWhenTop1}% | - |`,
      `| Grader correct (clean / degraded) | ${summary.graderCorrect.clean}% / ${summary.graderCorrect.degraded}% | - |`,
      `| Per grader top-1 / grader (n) | ${Object.entries(summary.graderCorrect.byGrader).map(([g, v]) => `${g} ${v.top1}%/${v.grader}% (${v.n})`).join('; ')} | - |`,
      `| Card name in search terms (clean / degraded) | ${summary.cardName.clean}% / ${summary.cardName.degraded}% | - |`,
      `| Warm UI time p50 / p95 / max | ${summary.timings.warmUiMs.p50} / ${summary.timings.warmUiMs.p95} / ${summary.timings.warmUiMs.max} ms | - |`,
      `| Warm scan() total p50 / p95 / max | ${summary.timings.warmPipelineTotalMs.p50} / ${summary.timings.warmPipelineTotalMs.p95} / ${summary.timings.warmPipelineTotalMs.max} ms | - |`,
      `| Cold UI time | ${cold.map((c) => `${c.sample}: ${c.wallMs} ms`).join('; ') || 'not run'} | - |`,
      '',
      `Gate: **${summary.gatePassed ? 'PASS' : 'FAIL'}**`,
      '',
      ...outcomeMarkdown(o, 'Category', cmp),
      '| Grader | Outcomes | Warm UI p50 / p95 / max (ms) |', '|---|---|---|',
      ...Object.entries(summary.outcomes.byGrader).map(([g, v]) => `| ${g} | ${CLASSES.filter((c) => v.classes[c]).map((c) => `${c} ${v.classes[c]}`).join(', ')} | ${v.warmUiMs.p50} / ${v.warmUiMs.p95} / ${v.warmUiMs.max} |`),
      '',
      '| Fixture | Category | Degradations | Expected | Observed state | Shown number | Grader | Opened | UI ms | Outcome | Top pipeline candidates | Card name (expected → shown) |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${r.category} | ${r.degradations.join(', ') || '-'} | ${r.expected.status} ${r.expected.grader ?? '-'} ${r.expected.number ?? '-'} | ${r.observed.state}${r.wrongAuto ? ' **WRONG**' : ''} | ${r.observed.number ?? '-'}${r.expected.number && !r.top1 ? ' (miss)' : ''} | ${r.observed.grader ?? '-'} | ${r.observed.opened.map((u) => u.replace('https://www.', '')).join(' ') || '-'} | ${r.observed.wallMs} | ${r.cls} | ${fmtCands(r)} | ${r.name ? `${r.name.ok ? 'ok' : 'MISS'}: ${r.name.expected} → ${r.name.shown ?? '-'}` : '-'} |`),
      '',
    ].join('\n');
    await writeFile(path.join(OUT, 'benchmark-results.md'), md);
    console.log(`# grader correct clean/degraded ${summary.graderCorrect.clean}%/${summary.graderCorrect.degraded}%; card name clean/degraded ${summary.cardName.clean}%/${summary.cardName.degraded}%`);
    console.log(`# benchmark: top-1 clean ${summary.top1.clean.pct}%, degraded ${summary.top1.degraded.pct}%, wrong auto-opens ${wrong.length}, wrong number shown ${o.wrongNumberShown.length}, had to choose ${o.hadToChoose.length}, auto-open precision ${summary.autoOpen.precision}%, warm p50/p95 ${summary.timings.warmUiMs.p50}/${summary.timings.warmUiMs.p95} ms -> ${path.join(OUT, 'benchmark-results.md')}`);

    assert.equal(wrong.length, 0, `wrong auto-opens (hard blocker): ${JSON.stringify(summary.wrongAutoOpens)}`);
    assert.deepEqual(summary.strayTabs, [], 'tabs opened without an auto-open');
    assert.ok(summary.top1.clean.pct >= bench.gate.top1CleanMin * 100, `top-1 clean ${summary.top1.clean.pct}%`);
    assert.ok(summary.top1.degraded.pct >= bench.gate.top1DegradedMin * 100, `top-1 degraded ${summary.top1.degraded.pct}%`);
    if (cmp) assert.deepEqual(cmp.noneToConfirmWrong, [], 'new none -> wrong number shown');
  });

  test(`all ${real.fixtures.length} realistic fixtures (bench-real): outcome classes, wrong number shown, had to choose, timing per family`, { timeout: 1_200_000, skip: !SETS.has('real') && 'bench-real set not selected' }, async () => {
    // Warm-up when the bench set did not run first: the first scan in a panel pays OCR init.
    if (!SETS.has('bench')) {
      await scanFile(path.join(E.BENCH, 'psa-c01.png'));
    }
    const rows = [];
    for (const f of real.fixtures) {
      const file = path.join(E.BENCH_REAL, f.file);
      const ui = await scanFile(file);
      const diag = await diagnose(file, f.mimeType);
      const exp = f.expected;
      const numbers = f.numbers ?? (exp.number ? [exp.number] : []);
      const expectedUrl = exp.number && exp.grader ? E.CERT_URL[exp.grader](exp.number) : null;
      const cls = classify({ numbers, positive: numbers.length > 0 && !f.mustNotAutoOpen, expectedUrl, mustNotAutoOpen: !!f.mustNotAutoOpen }, ui);
      const row = {
        id: f.id, file: f.file, family: f.family, expected: exp, numbers: f.numbers ?? null, mustNotAutoOpen: !!f.mustNotAutoOpen, note: f.note ?? '',
        observed: { state: ui.state, number: ui.number, grader: ui.grader, candidates: ui.candidates, opened: ui.opened, wallMs: ui.wallMs },
        cls, positiveForTop: numbers.length > 0, strayTab: ui.state !== 'auto-open' && ui.opened.length > 0,
        pipeline: diag,
      };
      rows.push(row);
      console.log(`# ${f.id.padEnd(30)} ${f.family.padEnd(9)} ${ui.state.padEnd(9)} ${String(ui.number).padEnd(14)} ${String(ui.grader).padEnd(10)} c${ui.candidates} ${String(ui.wallMs).padStart(5)} ms  ${cls}`);
    }
    const o = outcomeSummary(rows, 'family');
    const pipe = rows.map((r) => r.pipeline?.timings?.totalMs).filter((x) => typeof x === 'number');
    const cmp = compareRuns(rows, 'bench-real-results.json');
    const gate = real.gate;
    const summary = {
      build: { gitCommit: build.gitCommit, gitDirty: build.gitDirty, builtAt: build.builtAt, target: build.target },
      browser: env.browserVersion, date: new Date().toISOString(), fixtures: rows.length,
      ...o,
      strayTabs: rows.filter((r) => r.strayTab).map((r) => r.id),
      warmPipelineTotalMs: timing(pipe),
      comparison: cmp,
      gate,
    };
    summary.gatePassed = o.wrongAutoOpens <= gate.wrongAutoOpensMax && o.topCorrect >= gate.topCorrectMin
      && o.wrongNumberShown.length <= gate.wrongNumberShownMax && o.hadToChoose.length <= gate.hadToChooseMax;

    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, 'bench-real-results.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
    const md = [
      `# CertScanner realistic benchmark, bench-real (${summary.date})`,
      '',
      `Build ${summary.build.gitCommit?.slice(0, 7)}${summary.build.gitDirty ? '+dirty' : ''} (${summary.build.target}, ${summary.build.builtAt}); Chromium ${summary.browser}; ${rows.length} fixtures (${o.positives} with a number).`,
      '',
      '| Metric | Observed | Gate |',
      '|---|---|---|',
      `| Wrong auto-opens | ${o.wrongAutoOpens} | ${gate.wrongAutoOpensMax} |`,
      `| Top number correct (positives) | ${o.topCorrect}/${o.positives} | >= ${gate.topCorrectMin} |`,
      `| Wrong number shown | ${o.wrongNumberShown.length} | <= ${gate.wrongNumberShownMax} |`,
      `| Had to choose | ${o.hadToChoose.length} | <= ${gate.hadToChooseMax} |`,
      `| Nothing found on a positive | ${o.noneOnPositives.length} | - |`,
      `| Warm UI time p50 / p95 / max | ${o.warmUiMs.p50} / ${o.warmUiMs.p95} / ${o.warmUiMs.max} ms | - |`,
      `| Warm scan() total p50 / p95 / max | ${summary.warmPipelineTotalMs.p50} / ${summary.warmPipelineTotalMs.p95} / ${summary.warmPipelineTotalMs.max} ms | - |`,
      '',
      `Gate: **${summary.gatePassed ? 'PASS' : 'FAIL'}**`,
      '',
      ...outcomeMarkdown(o, 'Family', cmp),
      '| Fixture | Family | Expected | State | Shown | Grader | #cand | Opened | UI ms | Outcome | Pipeline candidates |', '|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${r.family} | ${r.numbers ? r.numbers.join('/') : `${r.expected.grader ?? '-'} ${r.expected.number ?? '-'}`} | ${r.observed.state} | ${r.observed.number ?? '-'} | ${r.observed.grader ?? '-'} | ${r.observed.candidates} | ${r.observed.opened.map((u) => u.replace('https://www.', '')).join(' ') || '-'} | ${r.observed.wallMs} | ${r.cls} | ${fmtCands(r)} |`),
      '',
    ].join('\n');
    await writeFile(path.join(OUT, 'bench-real-results.md'), md);
    console.log(`# bench-real: ${JSON.stringify(o.classes)}; top correct ${o.topCorrect}/${o.positives}; wrong shown ${o.wrongNumberShown.length}; choose ${o.hadToChoose.length}; warm p50/p95/max ${o.warmUiMs.p50}/${o.warmUiMs.p95}/${o.warmUiMs.max} ms -> ${path.join(OUT, 'bench-real-results.md')}`);

    assert.equal(o.wrongAutoOpens, 0, `wrong auto-opens (hard blocker): ${rows.filter((r) => r.cls === 'auto-WRONG').map((r) => r.id).join(', ')}`);
    assert.deepEqual(summary.strayTabs, [], 'tabs opened without an auto-open');
    assert.ok(o.topCorrect >= gate.topCorrectMin, `top number correct ${o.topCorrect}/${o.positives}`);
    assert.ok(o.wrongNumberShown.length <= gate.wrongNumberShownMax, `wrong number shown: ${o.wrongNumberShown.join(', ')}`);
    assert.ok(o.hadToChoose.length <= gate.hadToChooseMax, `had to choose: ${o.hadToChoose.join(', ')}`);
    if (cmp) assert.deepEqual(cmp.noneToConfirmWrong, [], 'new none -> wrong number shown');
  });
});
