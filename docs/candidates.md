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
- ~~PriceCharting tab fallback policy review~~: resolved 2026-10-12 (ADR A18) — the inactive-tab fallback was removed; Pokémon slabs can use PokemonPriceTracker's official API.

## Scan-accuracy round (2026-10-12, ADR A20)

User report (NL, paraphrased): "scanning suddenly goes wrong more often". The research the same day found no broad
regression in the last scanning change, but a change in the *kind* of failure: the label pass turned some "nothing
found" results into a wrong preselected number or a "choose between numbers" screen. The plan (ten mechanisms, eight
steps) and the acceptance below were frozen before any scanning code changed.

Method: the current build `58754af` was frozen as an e2e build and measured with the new benchmark (both sets) before
the first scanning change; after the last change the baseline and the final build were measured again back to back.
Same machine, Chromium 141.0.7390.37, warm panel, upload path, one run at a time. "Final" = the working tree on top of
`58754af` (uncommitted when measured). Reports: `docs/quality/bench/a20-baseline-58754af{,-real}.md`,
`docs/quality/bench/a20-final{,-real}.md` (the baseline-2 / final-B pair below).

### Frozen acceptance

Wrong auto-opens 0 on both sets (hard) · bench top-1 ≥ 100 % clean / ≥ 90 % degraded · bench-real top number right
≥ 60/62, wrong number shown ≤ 1, had to choose ≤ 5, no new none → wrong number · warm UI p50/p95 ≤ +10 % on the bench,
bench-real p95 ≤ the current build's and no photo > 5 s · unit, check and all e2e suites green.

### Bench (65 fixtures)

| Metric | 58754af run 1 | 58754af run 2 | Final run A | Final run B |
|---|---|---|---|---|
| Top-1 clean / degraded | 100 / 87.8 % | 100 / 87.8 % | 100 / 92.7 % | 100 / 92.7 % |
| Wrong auto-opens | 0 | 0 | 0 | 0 |
| Wrong number shown | 3 (psa-c03-blur2, cgcd-c16-rot-6, bgs-c23-glare) | 3 | 1 (psa-c03-blur2) | 1 |
| Had to choose | 0 | 0 | 0 | 0 |
| Nothing found on a slab | 2 (blur-2 photos) | 2 | 2 | 2 |
| Auto-open precision / rate clean, degraded | 49/49 · 85.7 / 75.6 % | 49/49 · 85.7 / 75.6 % | 50/50 · 85.7 / 78 % | 50/50 · 85.7 / 78 % |
| Grader correct clean / degraded; BGS top-1 | 100 / 92.7 %; 87.5 % | 100 / 92.7 %; 87.5 % | 100 / 95.1 %; 100 % | 100 / 95.1 %; 100 % |
| Card name clean / degraded | 90 / 66.7 % | 90 / 66.7 % | 90 / 69.2 % | 90 / 69.2 % |
| Warm UI p50 / p95 / max | 655 / 1332 / 3509 ms | 631 / 1325 / 3514 ms | 635 / 1042 / 3522 ms | 654 / 1145 / 3613 ms |

Class changes (final B vs run 2): bgs-c21, bgs-c21-jpeg40, bgs-c21-blur1 confirm → result shown (Sauvola reads the gold
label); cgcd-c16-rot-6 wrong number → auto-open right; bgs-c23-glare wrong PSA number → right BGS number (confirm).

### bench-real (66 fixtures, 62 with a number)

| Metric | 58754af run 1 | 58754af run 2 | Final run A | Final run B |
|---|---|---|---|---|
| auto-ok / auto-WRONG | 38 / 0 | 38 / 0 | 42 / 0 | 42 / 0 |
| opened-ok (BGS) | 7 | 7 | 9 | 9 |
| confirm-ok / confirm-choose / confirm-wrong | 7 / 6 / 2 | 7 / 6 / 2 | 7 / 4 / 0 | 7 / 4 / 0 |
| none-ok / none on a slab / fp | 3 / 2 / 1 | 3 / 2 / 1 | 3 / 0 / 1 | 3 / 0 / 1 |
| **Top number right** | **58/62** | **58/62** | **62/62** | **62/62** |
| **Wrong number shown** | **3** (bgs-c21-reflect, bgs-c21-moire, neg-receipt) | **3** | **1** (neg-receipt) | **1** |
| **Had to choose** | **6** | **6** | **4** (the two-slab photos) | **4** |
| New none → wrong number | - | - | 0 | 0 |
| Warm UI p50 / p95 / max | 660 / 2300 / 3459 ms | 660 / 2289 / 3619 ms | 673 / 2093 / 4066 ms | 709 / 2069 / 4035 ms |

Class changes (final B vs run 2): bgs-c21-phone choose → result shown; cgcd-c17-thumb250 choose → auto-open (near-duplicate
merge); bgs-c21-thumb300 confirm → result shown; psa-c08-keystone confirm → auto-open (Sauvola reads the number next to
the barcode); bgs-c21-reflect and bgs-c21-moire wrong PSA number → right BGS number (confirm); psa-c01-side90 and
cgcd-c15-side90-thumb nothing → auto-open (orientation probe). Per family, warm UI p95 grew where outcomes improved
(sideways 1407 → 1806 ms, reflect 663 → 1059 ms, phone 901 → 1239 ms, moiré max 3540 → 4035 ms) and fell for negatives
(3182 → 2069 ms: no label pass on a landscape photo that read nothing).

### Steps kept and dropped

| Step | Kept? | Evidence |
|---|---|---|
| 1 Realistic set + outcome metrics | kept | 66 files byte-identical to the research set; baseline reproduced the research classes exactly (38/0/7/0/7/6/2/3/2/1) |
| 2 Safe label pass | kept | second read = plain label image with Sauvola (131-fixture check: 100 right agreements with the black/white read, 4 wrong; the same image read twice: 14 wrong); bgs-c21-moire wrong → right |
| 3 One number (near-duplicates) | **narrowed in review** | as built, cgcd-c17-thumb250 choose → auto-open; in the review run the time-gated Sauvola pass also ran and the merge absorbed the right number into the wrong one (see below); now only weak stray reads are absorbed, never past the auto-open bar |
| 4 Orientation probe, 10 calls | kept | both sideways misses → auto-open right |
| 5 Gated second opinions | kept | bench degraded 87.8 → 92.7 %; gated on slab words or a barcode and < 1.2 s of OCR; replaces the band passes when no digit group was read (bench p95 fell) |
| 6 Incomplete numbers keep no grader | kept | bgs-c21-reflect / bgs-c23-glare no longer preselect PSA; new reason `reason_number_incomplete` (EN/NL) |
| 7a/7b GTIN-13, `14xx` prior | **dropped** | neg-receipt stayed `fp`: with the EAN codes demoted, the customer ID took their place |
| 7c lost-dash `7 + 3` | **dropped** | the `4102938` runs were the dash form `4102938-015`, which the parser already joins |
| 7d median denoise | **dropped** | text pass not faster on the dark photos (1211 → 1736 ms, 1643 → 1915 ms), same reads |
| 8 "This went wrong" export | kept | one local `.zip` (JSON + photo) via `<a download>`; e2e: confirm/none/result, contents checked, no network request, not after a restore |

Residual: the order-confirmation fixture still offers a number (`fp`, within the gate); a two-slab photo where one
slab's number is read only once and differs by ≤ 2 digits from the other's could be merged (unit-tested for the read-twice
case only); timings vary ±10 % between runs of the same build, so both final runs are listed.

### Review and verified final (orchestrator)

Reviewing the diff before committing, two parser rules were tightened (ADR A20 amendments), because they could put or
open a wrong number:
- **Near-duplicate merge.** As built, a near-duplicate read was absorbed as the host's *second read* (+0.15), which can
  carry a number across the auto-open bar although two passes disagree on a digit. The verification run hit exactly that:
  default + Sauvola text read `2038475610`, the digit crop the right `2938475610`; the merge absorbed the right one into the
  wrong one (with the bonus capped it showed the wrong number at 0.79; uncapped it would have auto-opened it). The
  implementer's runs missed it because the second opinion is gated on OCR time. Now only a weak stray read (score < 0.50)
  is absorbed, and its bonus stops at 0.79.
- **Independent reads.** A Sauvola / Leptonica *text* read of a number the default text pass also read no longer counts
  as a second read (same engine, same pixels, same misread); a digit crop, label image, barcode or QR still does.

Verified run on the final source (frozen e2e build, same machine, one run at a time; reports
`docs/quality/bench/a20-final{,-real}.md`):

| | Bench (65) | bench-real (66) |
|---|---|---|
| Top-1 / top number right | 100 % clean, 92.7 % degraded | **62/62** |
| Wrong auto-opens | 0 | 0 |
| Wrong number shown | 1 (psa-c03-blur2) | 1 (neg-receipt, an order confirmation) |
| Had to choose | 0 | 5 (the four two-slab photos + cgcd-c17-thumb250) |
| Nothing found on a slab | 2 (blur-2) | 0 |
| Warm UI p50 / p95 / max | 638 / 1155 / 3606 ms | 732 / 2053 / 4154 ms |

All frozen criteria pass (had to choose exactly at the bound of 5). Unit tests 261/261, `npm run check`, benchmark
gates; remaining e2e suites re-run on the same build (see the commit).

