// D3 OCR benchmark gate (ADR-001 §14): every fixture in tests/fixtures/bench/ goes through the real
// extension's upload path in one warm side panel. Gate: top-1 >= 90% clean, >= 70% degraded, and zero
// wrong auto-opens (hard blocker). Also records auto-open precision and cold/warm timings (p50/p95).
// For diagnosis each fixture is additionally passed to scan() in the same panel realm (same engines) to
// capture candidates, confidences and warnings; the gate itself uses only what the UI showed and opened.
//
// Output: $CERTSCANNER_E2E_OUT (default <tmp>/certscanner-e2e)/benchmark-results.{json,md}.
// Skip with CERTSCANNER_SKIP_BENCH=1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const OUT = process.env.CERTSCANNER_E2E_OUT ? path.resolve(process.env.CERTSCANNER_E2E_OUT) : path.join(os.tmpdir(), 'certscanner-e2e');
const SKIP = process.env.CERTSCANNER_SKIP_BENCH === '1';

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

describe('D3 OCR benchmark (upload path, one warm panel)', { concurrency: false, skip: SKIP ? 'CERTSCANNER_SKIP_BENCH=1' : false }, () => {
  let env;
  let panel;
  let targetWindow;
  const rows = [];
  const cold = [];
  let build;

  async function scanFixture(f) {
    const before = new Set((await E.allTabs(env)).map((t) => t.id));
    const r = await E.uploadAndWait(panel.page, path.join(E.BENCH, f.file), { timeout: 60000 });
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
    let card = null;
    if (['auto-open', 'opened'].includes(r.state)) {
      card = await E.poll(async () => panel.page.evaluate(() => {
        const box = document.querySelector('[data-testid="price-data"]');
        if (!box || ['reading', ''].includes(box.dataset.status ?? '')) return null;
        return document.querySelector('[data-testid="price-card"]')?.value ?? '';
      }), { timeout: 15000, interval: 100, message: 'label pass' }).catch(() => null);
    }
    return { ...r, opened: opened.map((t) => t.url), card };
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

  test('cold start: first scan in a fresh profile, then 4 freshly loaded panels', { timeout: 300_000 }, async () => {
    const f = bench.fixtures.find((x) => x.id === 'psa-c01');
    for (let i = 0; i < 5; i++) {
      if (i > 0) await E.reloadPanel(panel.page);
      const r = await scanFixture(f);
      cold.push({ sample: i === 0 ? 'fresh-profile' : `panel-reload-${i}`, wallMs: r.wallMs, state: r.state, number: r.number });
    }
    console.log(`# cold scans (${f.file}): ${cold.map((c) => `${c.sample} ${c.wallMs} ms ${c.state}`).join('; ')}`);
    assert.ok(cold.every((c) => c.number === f.expected.number));
  });

  test(`all ${bench.fixtures.length} benchmark fixtures: top-1, auto-open precision, wrong auto-opens, warm timings`, { timeout: 1_200_000 }, async () => {
    for (const f of bench.fixtures) {
      const ui = await scanFixture(f);
      let diag = null;
      try {
        diag = await E.scanInPanel(panel.page, { kind: 'blob-b64', b64: readFileSync(path.join(E.BENCH, f.file)).toString('base64'), type: f.mimeType });
      } catch (e) { diag = { error: { code: `diag-failed: ${e.message}` } }; }
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
      const row = {
        id: f.id, file: f.file, category: f.category, degradations: f.degradations,
        expected: exp, accept: f.accept,
        observed: { state: ui.state, number: ui.number, grader: graderShown, opened: ui.opened, wallMs: ui.wallMs },
        top1, statusAccepted: f.accept.includes(ui.state),
        graderOk: exp.grader === null ? (f.graderUnresolved ? graderShown === null : true) : graderShown === exp.grader,
        autoOpen, wrongAuto, strayTab, name: expectedDesc ? { expected: expectedDesc, shown: ui.card, ok: nameOk } : null,
        pipeline: diag ? {
          status: diag.status, error: diag.error?.code ?? null, timings: diag.timings ?? null,
          warnings: (diag.warnings ?? []).map((w) => w.code),
          candidates: (diag.candidates ?? []).map((c) => ({ number: c.number, grader: c.grader, confidence: c.confidence, source: c.source, evidence: c.evidence })),
          imageInfo: diag.imageInfo ? { width: diag.imageInfo.width, height: diag.imageInfo.height } : null,
        } : null,
      };
      rows.push(row);
      const flag = wrongAuto ? 'WRONG-AUTO-OPEN' : !top1 && exp.number ? 'MISS' : !row.statusAccepted ? 'STATUS' : 'ok';
      console.log(`# ${f.id.padEnd(26)} ${f.category.padEnd(8)} ${ui.state.padEnd(9)} ${String(ui.number).padEnd(14)} ${String(graderShown).padEnd(10)} ${String(ui.wallMs).padStart(5)} ms  ${flag}`);
    }

    const by = (cat) => rows.filter((r) => r.category === cat && r.expected.number !== null);
    const clean = by('clean');
    const degraded = by('degraded');
    const autos = rows.filter((r) => r.autoOpen);
    const wrong = rows.filter((r) => r.wrongAuto);
    const warm = rows.map((r) => r.observed.wallMs);
    const pipe = rows.map((r) => r.pipeline?.timings?.totalMs).filter((x) => typeof x === 'number');
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
      `| Auto-open precision | ${summary.autoOpen.correct}/${summary.autoOpen.count} = ${summary.autoOpen.precision}% | - |`,
      `| Auto-open rate (clean / degraded positives) | ${summary.autoOpen.rateCleanPositives}% / ${summary.autoOpen.rateDegradedPositives}% | - |`,
      `| Grader correct when top-1 correct | ${summary.graderCorrectWhenTop1}% | - |`,
      `| Grader correct (clean / degraded) | ${summary.graderCorrect.clean}% / ${summary.graderCorrect.degraded}% | - |`,
      `| Per grader top-1 / grader (n) | ${Object.entries(summary.graderCorrect.byGrader).map(([g, v]) => `${g} ${v.top1}%/${v.grader}% (${v.n})`).join('; ')} | - |`,
      `| Card name in search terms (clean / degraded) | ${summary.cardName.clean}% / ${summary.cardName.degraded}% | - |`,
      `| Warm UI time p50 / p95 / max | ${summary.timings.warmUiMs.p50} / ${summary.timings.warmUiMs.p95} / ${summary.timings.warmUiMs.max} ms | - |`,
      `| Warm scan() total p50 / p95 / max | ${summary.timings.warmPipelineTotalMs.p50} / ${summary.timings.warmPipelineTotalMs.p95} / ${summary.timings.warmPipelineTotalMs.max} ms | - |`,
      `| Cold UI time | ${cold.map((c) => `${c.sample}: ${c.wallMs} ms`).join('; ')} | - |`,
      '',
      `Gate: **${summary.gatePassed ? 'PASS' : 'FAIL'}**`,
      '',
      '| Fixture | Category | Degradations | Expected | Observed state | Shown number | Grader | Opened | UI ms | Top pipeline candidates | Card name (expected → shown) |',
      '|---|---|---|---|---|---|---|---|---|---|---|',
      ...rows.map((r) => `| ${r.id} | ${r.category} | ${r.degradations.join(', ') || '-'} | ${r.expected.status} ${r.expected.grader ?? '-'} ${r.expected.number ?? '-'} | ${r.observed.state}${r.wrongAuto ? ' **WRONG**' : ''} | ${r.observed.number ?? '-'}${r.expected.number && !r.top1 ? ' (miss)' : ''} | ${r.observed.grader ?? '-'} | ${r.observed.opened.map((u) => u.replace('https://www.', '')).join(' ') || '-'} | ${r.observed.wallMs} | ${(r.pipeline?.candidates ?? []).slice(0, 3).map((c) => `${c.number}/${c.grader ?? '?'}/${c.confidence}`).join(' ') || '-'} | ${r.name ? `${r.name.ok ? 'ok' : 'MISS'}: ${r.name.expected} → ${r.name.shown ?? '-'}` : '-'} |`),
      '',
    ].join('\n');
    await writeFile(path.join(OUT, 'benchmark-results.md'), md);
    console.log(`# grader correct clean/degraded ${summary.graderCorrect.clean}%/${summary.graderCorrect.degraded}%; card name clean/degraded ${summary.cardName.clean}%/${summary.cardName.degraded}%`);
    console.log(`# benchmark: top-1 clean ${summary.top1.clean.pct}%, degraded ${summary.top1.degraded.pct}%, wrong auto-opens ${wrong.length}, auto-open precision ${summary.autoOpen.precision}%, warm p50/p95 ${summary.timings.warmUiMs.p50}/${summary.timings.warmUiMs.p95} ms -> ${path.join(OUT, 'benchmark-results.md')}`);

    assert.equal(wrong.length, 0, `wrong auto-opens (hard blocker): ${JSON.stringify(summary.wrongAutoOpens)}`);
    assert.deepEqual(summary.strayTabs, [], 'tabs opened without an auto-open');
    assert.ok(summary.top1.clean.pct >= bench.gate.top1CleanMin * 100, `top-1 clean ${summary.top1.clean.pct}%`);
    assert.ok(summary.top1.degraded.pct >= bench.gate.top1DegradedMin * 100, `top-1 degraded ${summary.top1.degraded.pct}%`);
  });
});
