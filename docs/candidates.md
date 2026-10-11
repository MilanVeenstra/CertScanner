# CertScanner improvement round (2026-10-11): candidates, gates, evidence

User request (NL, paraphrased): test the extension thoroughly and fix what is needed; improve scanning; handle the
differences between PSA, BGS and CGC better; make the UI better and more logically organised.

Method: bounded generate → evaluate → select (chrome-extension-builder-evolution): ≤ 3 candidates per round, ≤ 3 rounds,
hard gates before scores, rubric and acceptance frozen below before any candidate was scored.

## Incumbent (baseline)

- Source/build: `3957a00` (clean), e2e build snapshot `incumbent/dist-e2e`, release `incumbent/dist`; Chromium 141.0.7390.37.
- Benchmark set extended **before** measuring: 8 synthetic BGS fixtures (3 clean gold/silver/black labels with
  subgrades + 5 degraded) added to `tests/fixtures/bench` (`scripts/gen-fixtures.mjs`; existing 57 fixtures unchanged,
  hashes verified). Benchmark test gained grader-per-family and card-name metrics (same code for every build).
- Baseline result (`docs/quality/bench/baseline-3957a00.md`, 65 fixtures):

| Metric | Baseline 3957a00 |
|---|---|
| Top-1 clean / degraded | 95.2% (20/21) / 82.9% (34/41) |
| Wrong auto-opens | 0 |
| Auto-open precision | 100% (48/48) |
| Per grader top-1 | PSA 96% (25), CGC comics 92.9% (14), CGC cards 86.7% (15), **BGS 50% (8)** |
| Card name in search terms clean / degraded | 90% / 66.7% |
| Warm UI p50 / p95 | 1006 / 1516 ms |

Observed baseline defects: BGS gold labels (bgs-c21 and its JPEG/blur variants) give **no number at all** (full-image
OCR cannot separate dark print from the gold label; the band digits passes return nothing); a glared BGS black label is
read one digit short and routed to PSA; BGS subgrades share OCR lines with the card name, and the whole line was dropped.

## Frozen acceptance criteria

- A1 No regressions: unit tests, `npm run check`, all e2e suites pass; benchmark gate holds (top-1 ≥ 90% clean, ≥ 70%
  degraded, **0 wrong auto-opens**, no stray tabs).
- A2 BGS: top-1 ≥ 75% over the 8 BGS fixtures and BGS shown as the grader whenever the number is right; BGS never opens
  a tab by itself.
- A3 Grader family correct when the number is right: ≥ 95% overall (PSA / CGC comics / CGC cards / BGS).
- A4 Card name in the price search terms: clean ≥ 90%, degraded not lower than baseline.
- A5 UI: result organised so identity → value → verification is clear; core journeys keyboard-operable with visible
  focus and a heading focus on state change; no new failures in the existing accessibility e2e checks; screenshots at
  360 px light + dark.
- A6 Performance: warm UI p95 not more than +25% over baseline (extra OCR only on weak reads).

## Rubric (skills/chrome-extension-builder/references/team.json; unchanged across rounds)

task_success 25 · security_privacy 20 · usability_accessibility 20 · architecture_reliability 15 · test_evidence 10 ·
performance_cost 10; each 0–5, score = Σ weight × s / 5. Hard gates first (security/privacy/policy/runtime/package,
broken acceptance, wrong auto-open).

## Round 1–2: scanning candidates (owned files: `src/pipeline/*`, `src/core/certParser.js`, `src/core/priceLinks.js`)

All three were measured with the same benchmark code on the same machine (Chromium 141, 65 fixtures). The baseline was
re-run next to the candidates because absolute timings drift between runs (baseline p95 1516 → 1485 ms).

| | Baseline 3957a00 (re-run) | S1 label pass on weak reads (text + digits) | S2 S1, digits first | **S3 only when no number / no grader; text only if still no grader; smaller label image** |
|---|---|---|---|---|
| Top-1 clean / degraded | 95.2% / 82.9% | 100% / 87.8% | 100% / 87.8% | **100% / 87.8%** |
| Wrong auto-opens | 0 | 0 | 0 | **0** |
| BGS top-1 / grader shown (n = 8) | 50% / 50% | 87.5% / n.m.¹ | 87.5% / 87.5% | **87.5% / 87.5%** |
| Grader correct clean / degraded | 95.2% / 85.4% | n.m.¹ | 100% / 92.7% | **100% / 92.7%** |
| Card name clean / degraded | 90% / 66.7% | 90% / 66.7% | 90% / 66.7% | **90% / 66.7%** |
| Warm UI p50 / p95 | 1002 / 1485 ms | 1036 / 2365 ms | 1070 / 2618 ms | **1035 / 1946 ms** |

¹ S1 ran before the harness read the grader of a BGS result (BGS has no per-number URL); fixed in `readResult`.

Evidence: `docs/quality/bench/baseline-3957a00-rerun.md`, `candidate-s1.md`, `candidate-s3.md`.

Kept: **S3**. It meets A1–A4 (gate holds, 0 wrong auto-opens, BGS top-1 87.5% ≥ 75%, grader family correct when the
number is right 98.3% ≥ 95%, card name not lower). **A6 is missed narrowly**: p95 +31% against the +25% bound. The extra
time is spent almost only on photos where the incumbent found no number or no grader (bgs-c21 and its JPEG/blur
variants, cgcd-c16-rot-6, cgcc-c09-blur2): over the 60 fixtures whose outcome did not change, p95 is 1485 → 1508 ms
(+1.5%, independent evaluator's recomputation); p50 +3–4%; single fixtures vary (psa-c01-jpeg40 852 → 1273 ms).
Non-slab photos take 0.35–0.7 s longer (one extra digits pass). Recorded as a limitation instead of re-tuning the
criterion.

## Round 1: UI information-architecture candidates (design before implementation)

Candidates: `docs/design/ui-candidates.md` (A answer-first single scroll, B tabs inside the result, C summary card +
drawers). Input evidence: `docs/quality/qa-audit-2026-10-11.md` (3 P1, 8 P2). Independent evaluator (separate agent,
read-only, rubric above), scores are pre-implementation estimates:

| Criterion (weight) | A | B | C |
|---|---|---|---|
| task_success (25) | 4 | 3 | 4 |
| security_privacy (20) | 4 | 4 | 3 |
| usability_accessibility (20) | 4 | 2 | 3 |
| architecture_reliability (15) | 4 | 2 | 3 |
| test_evidence (10) | 1 | 1 | 1 |
| performance_cost (10) | 4 | 2 | 3 |
| **Total** | **74** | 51, **gated** (idle tabs replace the disclosure that e2e and J9 use; tabs rejected in design-spec §2.2) | 61 (drawer state + one lookup per page row) |

Chosen: **A**, built as specified with the evaluator's brief (identity heading, Value, Cert check, Market).

## Regression run on the chosen build (S3 scanning + layout A)

- Unit tests 240/240, `npm run check` passes (manifest, CSP, locales EN/NL parity).
- All e2e suites on the frozen e2e build: 64/64 (the fixture-set test first failed on a missing `bgs` entry in its
  valid-length table for the new BGS fixtures; added, rerun 7/7).
- Benchmark on that build (`docs/quality/bench/final-layout-a.md`): top-1 100% / 87.8%, 0 wrong auto-opens, BGS 87.5% /
  87.5%, grader correct 100% / 92.7%, warm UI p50 / p95 1042 / 1955 ms.
- Layout checks at 360 px: focus on `#task-heading` after every result incl. manual entry, no `aria-live` on the price
  box (one spoken value summary), no disabled buttons, Open again moves 0 px between "loading" and "ok", no horizontal
  overflow at 320 px.

## Final independent evaluation (built version, separate read-only agent)

Gates: no new permissions or hosts (manifest unchanged; removing the PSA key now also drops its API permission), no new
storage, CSP unchanged, no page/console errors in EN, NL or release runs, 0 wrong auto-opens. Shared, not new: the
PriceCharting inactive-tab fallback (`priceData.js`, unchanged) still needs a Web Store / terms review before a Store
release.

| Criterion (weight) | Incumbent 3957a00 | Final |
|---|---|---|
| task_success (25) | 3 | 4 |
| security_privacy (20) | 3 | 4 |
| usability_accessibility (20) | 2 | 4 |
| architecture_reliability (15) | 3 | 4 |
| test_evidence (10) | 3 | 3 |
| performance_cost (10) | 4 | 3 |
| **Total** | **58** | **76** |

Acceptance: A1–A5 pass (A4 without gain: card name 90% / 66.7% as before), A6 missed (+31.6% p95, judged not a blocker,
see above). QA P1-1/2/3 and P2-4/6/7/10/11 verified in the browser; P2-9 verified in code. Verdict: ship.

The evaluator's P3 findings were fixed afterwards and re-measured:
- Dutch tiles: labels reserve two lines and prices stay on one line (size follows the panel width); "Open again" moves
  0 px between loading and loaded in EN and NL at 360 px, no price overflow at 320 px. (At 320 px the heading itself
  can get one line shorter when PriceCharting's tidier name replaces the label text.)
- Typed numbers: heading "PSA 81234567" when the name is unknown; the Value box alone says the name is missing.
- The outcome ("Opened PSA cert page for …") is announced even when focus moves to the identity heading.
- Comics: "Wrong title or grade? Change".
- New e2e J5b: Confirm → "Scan something else" (no tab, not restored after reload) and focus on the result heading
  after a typed number. Unit 240/240, check, extension + prices e2e 28/28 after the fixes.

## Not done / limitations

- A6 performance bound missed as described.
- Card name from degraded photos did not improve (66.7%).
- Page-scan results still have no per-row value (deferred: needs one PriceCharting lookup per row).
- Settings regroup, a "Look up value automatically" switch and half grades PriceCharting has no column for (e.g.
  PSA 8.5 shows "—") are deferred.
- PriceCharting tab fallback policy review (see gates).
