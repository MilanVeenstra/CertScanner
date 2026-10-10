# CertScanner — QA test report (final verification after the S8 improvement round)

_Role: qa-engineer · Date: 2026-10-10 · Canonical path: `docs/quality/test-report.md`._
_This replaces the report at `03d9589` (52/52). It is evidence. It does not override the ADR, the UX spec or the user's decisions._

## 1. Outcome

| Area | Result |
|---|---|
| Full e2e suite + benchmark (`npm run e2e`) on clean `5d67884` | **60/60 pass**, exit 0 (52 before; 8 new tests, 2 extended) |
| New S8 coverage | SEC-13 hostile page, SEC-14 crafted JPEG/GIF uploads, O9 consumed ids after reload, O10 "Checked N of M", O11/E12, thumbnails ≤ 240 px: **all pass** |
| Do the new tests catch the old bugs? | **Yes.** Against the pre-round build (`1ba1b85`): hidden slab B auto-opened in 9/9 hiding variants, both crafted files were decoded (4.7 s / 1.2 s), O9 and the thumbnail checks fail (§4.3) |
| D3 OCR benchmark gate | **PASS**: top-1 clean 100% (18/18), degraded 88.9% (32/36), **0 wrong auto-opens**, auto-open precision 48/48. Every per-fixture outcome is the same as at `03d9589` |
| J11 egress | **pass** on dist-e2e and on release `dist/`. The release build made 0 extension-initiated http(s) requests |
| `npm test` / `npm run check` | 199/199 pass / all checks passed |
| Defects | **No blocking defect.** One open Low item: **SEC-20** is confirmed at runtime. `filter:opacity(0)` and a `pointer-events:none` cover still auto-open the hidden slab (§6). A fix was in progress in the main tree during this run; it is not covered here |
| Manual checks | M1–M11 and PS1–PS13 **not run**. They need branded Chrome and a person (§8) |

## 2. Artifact identity

| Item | Value |
|---|---|
| Source under test | `5d678841546060f1528b61d44d196d6d7f7984ad` ("Improvement round…"), branch `claude/sharp-turing-1et8ns`. The build paths are clean: 0 entries from `git status --porcelain --ignored` over `src third_party scripts/build.mjs package*.json` |
| How it was isolated | The branch HEAD moved during the run, to `b6b6f14`, `2675a83` and then `f4e60ae` (WIP snapshots that include these QA files). The SEC-20 `src/` edits were uncommitted. So the final run used a **local clone checked out at `5d67884`** (scratchpad `clean5d/`), with the 9 QA-owned files from §9 copied in. `tests/` is not a build input, so `gitDirty` stays false. An earlier `npm run e2e` in the main tree had built a dirty `f4e60ae` tree; it was stopped and discarded |
| Release build | `dist/build-info.json`: target `release`, gitCommit `5d67884…`, **gitDirty `false`**, builtAt `2026-10-10T08:00:32.000Z` (the commit time, SEC-15). 71 files, 7.16 MiB. **`dist/manifest.json` sha256 `0aec47bb6c9faf3baf5f3bd21946a65652cebab78336a4247526aa30a3f9a2e1`**. Tree digest (sha256 of the sorted file hashes, without build-info) `36c5caab0e4b2bfb…`. Identical to the main-tree build of `5d67884` at 08:00 |
| e2e build | `dist-e2e/build-info.json`: target `e2e`, gitCommit `5d67884…`, **gitDirty `false`**, builtAt `2026-10-10T08:00:32.000Z`. **`dist-e2e/manifest.json` sha256 `88fb2414b131391e91e9e0f64767b756c6e084a4568d2fec796010c055784062`**. Tree digest `a361fd58a5e3bcae…`. Identical to the main-tree build at 08:00 |
| Manifest hashes vs FE | Match the S8 handoff (`0aec47bb…`, `88fb2414…`); permissions unchanged |
| Fixtures | `tests/fixtures/manifest.json` sha256 `de947f397b23315b…`. Additive only: `pages/hidden.html` and two `security/` files; every existing byte is unchanged. `bench/bench-manifest.json` `03dfec6e…fc25` is unchanged (57 fixtures) |
| Browser | Playwright-bundled Chromium **141.0.7390.37** (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`), new headless. DPR 1, `--window-size=1280,1000` (page viewport 1280×861). Throw-away profile per suite |
| Tooling / OS | Playwright 1.56.1 (library) with `node --test`; Node 22.22.0. Ubuntu 24.04.5 LTS, Linux 6.18.44, x86_64, 4 vCPU, 15 GiB RAM |
| Run window | `npm run check` + `npm test` 08:19:49Z. Full e2e 2026-10-10 **08:19:58Z – 08:26:50Z** (412 s). Benchmark 08:21:49Z |

**Network isolation (all launches, unchanged):**
- `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost` and `--no-proxy-server`.
- The browser gets a minimal environment (no proxy variables, no credentials).
- Grader pages are never contacted. Opened URLs come from `chrome.tabs.query`, and for J11 also from Chrome's NetLog.

## 3. Commands and observed results

| Command (in the `5d67884` clone unless noted) | Result |
|---|---|
| `npm run check` (builds `dist/`) | all checks passed: src 39 files, 16 licences, pins match, en/nl parity 212 keys |
| `npm test` | **199/199 pass** (also 199/199 in the main tree at clean `5d67884`, 08:03Z) |
| `CERTSCANNER_E2E_OUT=<scratch> npm run e2e` (runs `build:e2e` first) | **tests 60, pass 60, fail 0**, exit 0 |
| `node scripts/gen-fixtures.mjs --no-bench` (main tree, before the HEAD move) | `VERIFY OK`. A scratch `--out` run first: all existing files byte-identical, 3 new files, manifest additive |
| Pre-round discrimination: `git archive 1ba1b85` → `node scripts/build.mjs --e2e` → `CERTSCANNER_E2E_DIST=<that> node --test tests/e2e/hardening.test.mjs`, SEC-14 subset | 3 of 4 hardening tests and 2 of 2 SEC-14 tests **fail** as expected (§4.3) |
| `python3 <skill>/scripts/check_extension.py dist` | Unchanged: 6 heuristic "ERRORS" (vendor false positives, O6) and the broad-hosts warning for the optional `https://*/*` |

**Running the suite:**
- `npm run e2e` builds `dist-e2e/` and runs `tests/e2e/**/*.test.mjs`.
- `CERTSCANNER_SKIP_BENCH=1` skips the benchmark.
- `CERTSCANNER_E2E_OUT=<dir>` sets where `benchmark-results.{json,md}` go.
- `CERTSCANNER_E2E_DIST=<dir>` tests another build; `CERTSCANNER_CHROMIUM=<chrome>` uses another binary.
- Never run `playwright install`.

## 4. Per-case results (final run)

### 4.1 New cases (S8 round)

| # | Case (build, file) | Evidence (final run) | Result |
|---|---|---|---|
| SEC-13a | Hostile page `pages/hidden.html` (dist-e2e, `hardening`). Slab A (108114622) is a CSS background; the `<img>` of slab B (01234567) is hidden | **opacity 0**: not discovered → `none`, "No photos large enough…" (70 ms).<br>**visibility hidden**: same (63 ms).<br>**Off-screen** (vf 0), **opaque cover** (vf 1, not topmost) and **opacity 0.05** (not topmost): `page-results` with row psa 01234567, **no tab**.<br>**Control** (B visible, topmost): auto-open `psacard.com/cert/01234567`, 1 tab.<br>Slab A's URL is never opened. No `pageerror` | pass |
| SEC-13b | Residual techniques (diagnostic, logged, not asserted) | **`filter:opacity(0)`: auto-open B (tab).** **Opaque cover with `pointer-events:none`: auto-open B (tab).** `clip-path:inset(0 0 100% 0)` → list; B inside a 0 px `overflow:hidden` box → list. See SEC-20 in §6 | pass (diagnostic) |
| SEC-14 JPEG | Upload `security/jpeg-sof-after-64k.jpg` (72,180 B; SOF0 16000×16000 at byte 72,097) | UI `error`, code `too-large`, **E3** "Image is too large", in **89 ms**. `scan()` `too-large` in 3 ms. **0 `createImageBitmap` calls** with the file. Control PNG: 1 call. No tab | pass |
| SEC-14 GIF | Upload `security/gif-frame-larger-than-screen.gif` (42 B; screen 10×10, frame 16000×16000) | E3 `too-large` in **70 ms**. `scan()` 1 ms. **0 decoder calls**. No tab | pass |
| O9 | Consumed ids after a panel reload (dist-e2e, `hardening`) | A listing page job and an image job each auto-open once (2 tabs). `storage.session` `seenJobs:<w>` holds both ids (ids only, ≤ 20). **After the reload, re-writing both ids**: each slot is cleared, no `scanning` state, tabs still 2 → 2. A fresh id after the reload auto-opens normally | pass |
| Perf 5 | Preview thumbnails (dist-e2e upload, `hardening`) | psa-9digit 544×850 → **154×240**; cgc-comic 680×1044 → **156×240**; ambiguous (confirm) → 154×240. All from `blob:` URLs, aspect ratio kept.<br>Show larger → 544×850 from a **new** blob URL, `aria-expanded=true`, "Show smaller". Show smaller → 154×240; the large URL is **revoked** (`fetch` fails) | pass |
| Fixtures | `fixtures.test.mjs`: SEC-14 file structure; SEC-13 page has one `<img>` and A ≠ B; every hiding variant `mustNotAutoOpen` | Hashes and sizes match the manifest | pass |

### 4.2 Extended cases

| Case | Added assertion | Evidence | Result |
|---|---|---|---|
| P1 gallery (dist-e2e) | O10 coverage line; row thumbnails ≤ 240 px | Summary: "Found: 7. …" + **"Checked 8 of 9 photos."**, which equals `page_results_capped` with the probe's `total` (9). Row thumbnails 143–167 × 240, all `blob:`. 7 rows, no auto-open, no tab, `evil.example` never requested. UI 7.7 s | pass |
| P13 release `dist/` (no host access), https job without a live grant | O11: **E12** instead of E1; not restored on reopen | `error` / `page-no-access` / **E12**. Heading "CertScanner can't read this tab right now". Body "Click the CertScanner icon or press Alt+Shift+S to scan it.". Actions page-scan + choose; focus `#task-heading`. After a cross-origin move: E12 again. **After a panel reload: `idle`**. Always-allow decline flow and O12 unchanged | pass |

The gallery says 9 or 10 photos depending on Chrome's srcset choice. If the srcset image resolves to the already-listed 544w file, it is de-duplicated by URL. FE saw both. P1 compares against the extension's own probe `total`, so it passes either way.

### 4.3 Discrimination check: new tests against the pre-round build `1ba1b85` (evidence only)

| Check | Pre-round `1ba1b85` | `5d67884` |
|---|---|---|
| SEC-13, all 9 hiding variants (scratch script) | **auto-open B in 9/9** | 5 asserted variants: `none`/list, no tab. Residual: 2 of 4 still auto-open |
| SEC-14 JPEG upload | decoded: 2 decoder calls, `too-large` only after 4.7 s → **fail** | 89 ms, 0 decodes |
| SEC-14 GIF upload | decoded: 2 decoder calls, `invalid-image` (E7) after 1.2 s → **fail** | 70 ms, 0 decodes, E3 |
| O9 | `seenJobs` absent → **fail** | pass |
| Perf 5 preview | preview 544×850 (full image) → **fail** | 154×240 |

### 4.4 Unchanged cases (all pass in the final run)

| Cases (file) | Key observations |
|---|---|
| Install, A9 setting, SEC-01, panel contract, J1–J10, J4b, J7b, two quick jobs, panel reload, job contract, settings/history, SW stop/restart, history clear (`extension.test.mjs`) | 22/22 + J7b. Reload after completion restores `auto-open 108114622` (A5). J7b offers "Sharper scans on localhost" |
| P1b–P12, P14 (`pagescan.test.mjs`) | P1b: warm `scanPage` 6.6 s for 8 of 9 images (budget 30 s). P2 auto-open 108114622 once, 3.3 s. P3 never opens 48213576 / 2023041712 (O8 unchanged). P5: E1 in 9–10 ms. **P6 Cancel → idle in 225 ms**. P9 crop fallback: `capture`/`screen`, right numbers. NL smoke OK |
| J11 (`privacy.test.mjs`) | dist-e2e NetLog: 36 requests, 28 renderer, 10 extension-initiated (all local), 3 grader navigations (DNS-blocked). **Release `dist/`**: 24 requests, 17 renderer, **0 extension-initiated**, 2 grader navigations. No non-local request succeeded |
| SEC-03 / SEC-04 / SEC-06 (`security.test.mjs`) | Busy page → `error` in **12,045 ms** (budget 12,500); `scan()` `timeout`; Cancel → idle in 56 ms. BMP bomb → error in 75 ms (`scan()` 2 ms). SEC-06: grant → Rescan auto-opens once; a re-delivered id starts no scan |

**Coverage matrix:**
- **Pass:**
  - install and first use
  - toolbar setting
  - panel state and reload, including consumed ids after a reload (O9)
  - window binding
  - worker stop and revival
  - same-origin iframe
  - restricted pages (E1) and lost access (E12)
  - grant/deny (stubbed)
  - settings persistence
  - offline input
  - duplicates and newest-job-wins
  - invalid jobs
  - hostile pages (busy, hidden image)
  - decode bombs (BMP, JPEG, GIF)
  - keyboard and labels (basic)
  - Dutch smoke
  - egress on both builds
- **Not run:**
  - real grant/revoke and the prompt (M5, PS4)
  - extension update/reload
  - storage migration in the browser
  - zoom, contrast, reduced motion, screen reader (M8)
  - Chrome 116 (M9)
  - incognito runtime (M11)
  - HiDPI capture (PS11)
  - memory soak (perf-owned)
- **Not applicable:**
  - accounts, backends, 429/5xx (local-only v1)
  - popup (none)
  - declared content scripts (none)

## 5. Benchmark (D3 gate), final run

57 synthetic fixtures (18 clean, 36 degraded, 3 negative), run through the real panel's upload input in one warm panel. Build `5d67884` (gitDirty false).

| Metric | Observed | Gate |
|---|---|---|
| Top-1 clean | **18/18 = 100%** | ≥ 90% |
| Top-1 degraded | **32/36 = 88.9%** | ≥ 70% |
| Wrong auto-opens | **0** (stray tabs 0) | 0 |
| Auto-open precision | **48/48 = 100%** | – |
| Auto-open rate on positives (clean / degraded) | 100% / 83.3% | – |
| Grader correct when top-1 correct | 98% | – |
| Negatives | neg-c19 confirm, neg-c20 none, neg-c20-jpeg40 none (all accepted) | – |
| Warm UI p50 / p95 / max | 798 / 1,969 / 5,161 ms | – |
| Warm `scan()` total p50 / p95 / max | 684 / 1,979 / 5,213 ms | – |
| Cold UI (fresh profile, then 4 reloaded panels) | 1,319 / 1,408 / 1,341 / 1,329 / 1,303 ms | – |

**Same four misses as before; none auto-opened:**
- **psa-c03-blur2** (2 px blur): confirm with the **wrong number 100876043**, PSA pre-selected (0.53).
- **cgcc-c09-blur2** and **cgcd-c17-blur2**: none.
- **cgcd-c16-rot-6** (−6°): none.

All 57 per-fixture state/number/grader outcomes match the `03d9589` run. Slowest: psa-c05-dark 5.2 s, cgcd-c18-dark 2.7 s.

<details><summary>Per-fixture results (final run)</summary>

"Expected" is the preferred status; every positive also accepts `confirm`.

| Fixture | Category | Degradations | Expected | Observed | Number | Grader | Opened | UI ms | Top pipeline candidates |
|---|---|---|---|---|---|---|---|---|---|
| psa-c01 | clean | - | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 902 | 04718263/psa/0.9 |
| psa-c02 | clean | - | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 733 | 72910483/psa/0.9 |
| psa-c03 | clean | - | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 798 | 109876543/psa/0.9 |
| psa-c04 | clean | - | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 990 | 00573921/psa/0.9 |
| psa-c05 | clean | - | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 775 | 056734128/psa/0.9 |
| psa-c06 | clean | - | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 667 | 30561247/psa/0.9 |
| psa-c07 | clean | - | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 690 | 5123478/psa/0.9 |
| psa-c08 | clean | - | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 615 | 61834502/psa/1 |
| cgcc-c09 | clean | - | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 849 | 3984561002/cgc-comics/0.95 |
| cgcc-c10 | clean | - | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 876 | 4087123006/cgc-comics/0.95 |
| cgcc-c11 | clean | - | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 819 | 4102938015/cgc-comics/0.95 |
| cgcc-c12 | clean | - | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 788 | 3765432011/cgc-comics/0.95 |
| cgcc-c13 | clean | - | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 356 | 4155667002/cgc-comics/0.95 |
| cgcd-c14 | clean | - | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 944 | 1402345678901/cgc-cards/0.9 |
| cgcd-c15 | clean | - | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 707 | 1403987650123/cgc-cards/0.9 |
| cgcd-c16 | clean | - | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 677 | 3901234567/cgc-cards/0.95 |
| cgcd-c17 | clean | - | auto-open cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | cgccards.com/certlookup/2938475610/ | 712 | 2938475610/cgc-cards/0.95 |
| cgcd-c18 | clean | - | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 716 | 1405551234567/cgc-cards/0.9 |
| neg-c19 | negative | - | confirm - 6012349870 | confirm | 6012349870 | - | - | 609 | 6012349870/?/0.45 |
| neg-c20 | negative | - | none - - | none | - | - | - | 843 | - |
| psa-b01 | degraded | busy-art | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 981 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 |
| cgcc-b02 | degraded | busy-art | auto-open cgc-comics 4011223004 | auto-open | 4011223004 | cgc-comics | cgccomics.com/certlookup/4011223004/ | 952 | 4011223004/cgc-comics/0.95 |
| cgcd-b03 | degraded | busy-art | auto-open cgc-cards 1404440987654 | auto-open | 1404440987654 | cgc-cards | cgccards.com/certlookup/1404440987654/ | 972 | 1404440987654/cgc-cards/0.9 |
| psa-b04 | degraded | busy-art | confirm psa 81726354 | auto-open | 81726354 | psa | psacard.com/cert/81726354 | 925 | 81726354/psa/0.9 |
| psa-c01-jpeg40 | degraded | jpeg-q40 | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 810 | 04718263/psa/0.9 |
| psa-c03-jpeg40 | degraded | jpeg-q40 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 782 | 109876543/psa/0.9 |
| cgcc-c09-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 854 | 3984561002/cgc-comics/0.95 |
| cgcd-c14-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 714 | 1402345678901/cgc-cards/0.9 |
| cgcd-c16-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 718 | 3901234567/cgc-cards/0.95 |
| psa-c08-jpeg40 | degraded | jpeg-q40 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 666 | 61834502/psa/1 |
| cgcc-c13-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 288 | 4155667002/cgc-comics/0.95 |
| psa-c02-half | degraded | scale-0.5 | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 489 | 72910483/psa/0.9 |
| psa-c04-half | degraded | scale-0.5 | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 485 | 00573921/psa/0.9 |
| cgcc-c10-half | degraded | scale-0.5 | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 604 | 4087123006/cgc-comics/0.8 |
| cgcd-c15-half | degraded | scale-0.5 | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 485 | 1403987650123/cgc-cards/0.9 |
| psa-c08-half | degraded | scale-0.5 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 440 | 61834502/psa/0.9 |
| psa-c01-blur1 | degraded | blur-1px | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 925 | 04718263/psa/0.9 |
| cgcc-c11-blur1 | degraded | blur-1px | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 823 | 4102938015/cgc-comics/0.95 |
| cgcd-c14-blur1 | degraded | blur-1px | auto-open cgc-cards 1402345678901 | confirm | 1402345678901 | cgc-cards | - | 655 | 1402345678901/cgc-cards/0.7 |
| psa-c03-blur2 | degraded | blur-2px | auto-open psa 109876543 | confirm | 100876043 (miss) | psa | - | 927 | 100876043/psa/0.53 10987654/psa/0.35 |
| cgcc-c09-blur2 | degraded | blur-2px | auto-open cgc-comics 3984561002 | none | - (miss) | - | - | 1212 | - |
| cgcd-c17-blur2 | degraded | blur-2px | auto-open cgc-cards 2938475610 | none | - (miss) | - | - | 1030 | - |
| psa-c02-glare | degraded | glare | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 698 | 72910483/psa/0.9 |
| psa-c06-glare | degraded | glare | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 628 | 30561247/psa/0.9 |
| cgcc-c10-glare | degraded | glare | auto-open cgc-comics 4087123006 | confirm | 4087123006 | - | - | 673 | 4087123006/?/0.45 |
| cgcd-c14-glare | degraded | glare | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 836 | 1402345678901/cgc-cards/0.9 |
| psa-c03-rot-3 | degraded | rotate:-3 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 811 | 109876543/psa/0.9 |
| cgcc-c09-rot5 | degraded | rotate:5 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 825 | 3984561002/cgc-comics/0.85 |
| cgcd-c16-rot-6 | degraded | rotate:-6 | auto-open cgc-cards 3901234567 | none | - (miss) | - | - | 1409 | - |
| psa-c07-rot2 | degraded | rotate:2 | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 734 | 5123478/psa/0.9 |
| psa-c04-dark | degraded | dark-low-contrast | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 1969 | 00573921/psa/0.9 |
| cgcc-c12-dark | degraded | dark-low-contrast | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 1191 | 3765432011/cgc-comics/0.94 |
| cgcd-c18-dark | degraded | dark-low-contrast | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 2712 | 1405551234567/cgc-cards/0.9 |
| psa-c05-dark | degraded | dark-low-contrast | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 5161 | 056734128/psa/0.9 |
| psa-b01-jpeg40 | degraded | busy-art, jpeg-q40 | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1243 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 |
| cgcd-c14-rot-4-jpeg60 | degraded | rotate:-4, jpeg-q60 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 903 | 1402345678901/cgc-cards/0.9 |
| neg-c20-jpeg40 | negative | jpeg-q40 | none - - | none | - | - | - | 772 | - |
</details>

## 6. Defects and observations

**No blocking defect.** Nothing failed in the final run against `5d67884`.

**Two QA harness slips, fixed before the final run:**
- The first `hidden.html` draft let `display:flex` override the cover's `hidden` attribute. `gen-fixtures` verify caught it.
- One declared hit target was wrong for `clip-path`.

| ID | Type / severity | Observation | Repro / evidence | Owner |
|---|---|---|---|---|
| **SEC-20** | Security, **Low** (open; the fix was in progress in the main tree, not tested here) | The SEC-13 guard is bypassed by **`filter:opacity(0)`** on the hidden `<img>`, and by an **opaque cover with `pointer-events:none`**. In both cases the probe reports `topmostAtCenter:true` and the page scan **auto-opens the invisible slab B** (`psacard.com/cert/01234567`) while the user sees slab A. `clip-path` and a clipped parent are handled (list). Same finding as security review round 3 | `hardening.test.mjs` "SEC-13 residual". Manual: serve `tests/fixtures`, open `pages/hidden.html?hide=filter-opacity` or `?hide=overlay-pe-none`, scan the page | FE (fix), security reviewer (verify). QA: when the fix lands, switch those two variants to `asserted:true` in `gen-fixtures.mjs` and re-run `hardening` + `pagescan` |
| O1 | Accuracy risk (R2) | 2 px blur: `psa-c03-blur2` shows confirm with the wrong number `100876043` at 0.53, PSA pre-selected; not auto-opened | Bench | FE/UX: don't pre-fill below about 0.6 |
| O2 | Accuracy | 2 px blur on 10-digit labels and −6° rotation give no candidate | Bench | FE (OCR) |
| O3 | Performance | Dark scans are slow (5.2 s / 2.7 s warm). In page scans the non-slab photo costs 2.3 s | Bench; P1b img 4 | FE |
| O4 | Contract note | `setting-autoOpen` is inverted (`data-inverted="true"`); ADR §13 doesn't say so | `sidepanel.html` | Architect |
| O6 | Static checker | Vendor false positives | §3 | Release manager |
| O7 | Console noise | Expected 403s from the hotlink CDN (J7, P9) in the panel console | P11 log | – |
| O8 | Page-scan UX / R2 | A non-slab image with printed numbers gives a PSA row at 0.70 with Open, and blocks the slab's auto-open | P3 | Architect/FE |
| O12 | Release checklist | "Always allow on ‹host›" is practically unreachable (PS4 rewritten in §8) | P13 | Architect, release manager |
| **O9 / O10 / O11** | **Closed (verified)** | O9 consumed ids persist (§4.1). O10 "Checked N of M" is shown (§4.2). O11 shows E12 (§4.2) | – | – |

**Process note:** the main tree's `dist/` and `dist-e2e/` currently hold `f4e60ae` + uncommitted SEC-20 edits (`gitDirty:true`). Rebuild before using them as evidence. The clean `5d67884` artifacts in §2 are in the QA scratchpad clone.

## 7. Assumptions and limitations

**Simulated by the harness:**
- **Triggers.** Toolbar clicks, Alt+Shift+S, the activeTab grant and the `sidePanel.open` gesture cannot be automated. Jobs are written from the extension's service worker in the shipped `createPageJob`/`createScanJob` shapes.
- **Panel.** The panel runs as the `?w=` popup-window fallback. The "Scan this page" button is a real click.
- **Host access.** dist-e2e's `<all_urls>` stands in for activeTab.
- **E12.** It is reached on the release build by a job for a tab without a grant. A real race (navigating right after the click) was not reproduced.

**Decode proof.** SEC-14 "no decode" means no `createImageBitmap` call in the panel realm for that file, with a positive control. The pre-round build shows the decoder would have been called. No real 1 GB decode was allowed to finish on `5d67884`.

**SEC-13 scope.** Nine hiding techniques plus the control were tested. Not tested: srcset swap (SEC-20 part), `mask-image`, `mix-blend-mode`, a 2 px clip window, overlays in cross-origin frames.

**DPR 1 only.** Headless runs at DPR 1; HiDPI capture is PS11.

**Not tested:**
- Branded Chrome or Chrome 116.
- Screen readers, zoom, contrast.
- Incognito at runtime; extension update.
- Real CDNs and live grader pages (DNS-blocked by design).
- The memory soak (perf report).

**Synthetic fixtures.** All fixtures are synthetic (Liberation Sans, abstract art); this is not real-world accuracy.

**NetLog background traffic.** NetLog also shows Chromium background services (`clients2.google.com`, `accounts.google.com`, `redirector.gvt1.com`, `www.google.com`, `android.clients.google.com`). They are not from the extension, and all were DNS-blocked.

## 8. Manual checks — **not run** (need branded Chrome and a person)

**Setup:**
1. On the release commit run `npm ci && npm run build`, or unzip the release ZIP into an empty folder.
2. In `chrome://extensions`: Developer mode → **Load unpacked** → `dist/`. Pin CertScanner.
3. Serve the fixtures: `cd tests/fixtures && python3 -m http.server 8000`. The pages are `http://localhost:8000/pages/gallery.html`, `listing.html` (variants `?details=1`, `?slab=0`, `?photos=0`) and `hidden.html?hide=<variant>`.
4. Record the Chrome version, OS, `devicePixelRatio`, `dist/build-info.json` `gitCommit`/`gitDirty`, the date, and a screenshot of each failing step.

| ID | Steps | Pass when |
|---|---|---|
| M1 | Right-click `#img-psa-leading-zero` on the gallery → "Scan slab cert number", with the panel closed and then open | The panel opens; `psacard.com/cert/01234567` opens next to the gallery; no prompt |
| M2 | Scan the PSA image, then `#img-rotated` within 1 s | Only `cgccomics.com/certlookup/4012345001/` opens |
| M3 | Stop the worker (`chrome://serviceworker-internals`), then scan `#img-ambiguous` | Confirm shows `5012345678` with no grader; no error |
| M4 | Right-click a slab photo on a real listing with a CDN image | No prompt; capture fallback if the CDN refuses; only the image host and the official page in DevTools |
| M5 | Sharper scans on a real https CDN: Deny → Allow → Rescan → Settings Remove | The prompt names only that host; at most one tab per scan |
| M6 | `chrome://version` and a Web Store item: right-click, icon, then upload `psa-9digit.png` | "Chrome doesn't allow reading this page"; upload works |
| M7 | Gallery in windows A and B, each with a panel; scan in A | Only A reacts |
| M8 | Dutch UI (`LANGUAGE=nl`), screen reader, keyboard only, 200% zoom | All Dutch and untruncated; one announcement per result; logical focus; no horizontal scroll |
| M9 | Chrome for Testing 116, fresh profile: M1, M5-deny, an upload, PS1 | No console errors |
| M10 | Open each builder URL for a real public cert | The right record; PSA leading zero kept |
| M11 | `chrome://extensions` Details; an incognito window | No "Allow in Incognito"; nothing works in incognito; no history |
| PS1 | Gallery: click the icon with the panel closed, then open | "Scanning image N of 8", then the list (about 7 rows with ≤ 240 px thumbnails) and **"Checked 8 of 9 (or 10) photos."**; no tab |
| PS2 | Alt+Shift+S; change it in `chrome://extensions/shortcuts`; clear it | Same as PS1; Settings shows the shortcut; with none, the idle hint says to click the icon |
| PS3 | Icon on `listing.html`; again with "Always ask before opening" | One tab `psacard.com/cert/108114622`; then a one-row list, no tab |
| PS4 | (a) Panel **Scan this page** on an https site without access. (b) Icon on that site, navigate to another https site, panel **Scan this page** | Both: "CertScanner can't read this page yet" with the icon/shortcut copy. **No** "Always allow" expected (O12); record one if it appears |
| PS5 | Turn off "Toolbar button scans the page"; click the icon; restart Chrome; turn it back on | Off: the icon only opens the panel (also after the restart). On: it scans |
| PS6 | Icon on `chrome://version` and a Web Store item | E1 "Chrome doesn't allow reading this page"; upload works |
| PS7 | Icon on `listing.html?photos=0` and on a text article | "No cert numbers found on this page" with 3 tips; no tab |
| PS8 | Long real page with many photos; Cancel during "Scanning image 2" | ≤ 8 photos, about 30 s at most; Cancel → idle within 1 s; nothing opens later |
| PS9 | Panel DevTools → Network during PS1 on a real listing | Only the page's image hosts and the opened official page |
| PS10 | Gallery in windows A and B; icon in A | Only A scans |
| PS11 | Real CDN listing at DPR 1, then on a HiDPI screen | Numbers read or skipped, never wrong; record per DPR |
| PS12 | Stop the worker, then use the icon and the shortcut | It scans each time; no error |
| PS13 (new) | Icon on `hidden.html?hide=` `opacity0`, `visibility`, `offscreen`, `overlay`, `faint`, then `none` | Hiding variants: "No cert numbers found" or a list with 01234567, **never a tab**. `none`: one tab `psacard.com/cert/01234567`. Slab A's 108114622 never opens. (`filter-opacity` / `overlay-pe-none` will auto-open until SEC-20 is fixed) |

The E12 race (the tab navigates between the click and the scan) is hard to trigger by hand. It is covered on the release build by P13 (§4.2).

## 9. Files (QA-owned) and next owners

**Changed or added.** Most were already snapshotted into `b6b6f14`/`f4e60ae` by the orchestrator. The variant-order edit in `hardening.test.mjs` and this report are uncommitted.

| File | Change |
|---|---|
| `tests/e2e/hardening.test.mjs` (new) | SEC-13 hostile page (asserted + residual), O9 after reload, Perf 5 preview / Show larger |
| `tests/e2e/security.test.mjs` | SEC-14 crafted JPEG/GIF uploads with a decoder-call counter and a positive control |
| `tests/e2e/pagescan.test.mjs` | P1: O10 line and row thumbnails ≤ 240 px. P13: E12 asserted; E12 again after a cross-origin move; not restored after a reload |
| `tests/e2e/fixtures.test.mjs` | SEC-14 file structure; SEC-13 page invariants; security fixture sizes |
| `scripts/gen-fixtures.mjs` | Generates and verifies `pages/hidden.html` (10 variants with browser geometry checks), `security/jpeg-sof-after-64k.jpg` and `security/gif-frame-larger-than-screen.gif` |
| `tests/fixtures/pages/hidden.html`, `tests/fixtures/security/*.{jpg,gif}` (new), `tests/fixtures/manifest.json` | Generated, byte-stable, additive |
| `docs/quality/test-report.md` | This report |

**Next owners:**
- **FE / security reviewer:** SEC-20. QA re-runs `hardening` + `pagescan` (and the full suite before release) once the fix lands, with the two residual variants switched to asserted.
- **Orchestrator:** commit the uncommitted QA edits. Rebuild `dist/` from a clean commit before packaging.
- **Architect:** O4, O8, O12.
- **FE:** O1–O3.
- **Release manager:** use §8 PS1–PS13; O6 wording.
- **User + QA:** M1–M11 and PS1–PS13 in branded Chrome before release.
