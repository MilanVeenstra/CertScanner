# CertScanner — QA test report (e2e, benchmark, fixtures)

_Role: qa-engineer (native specialist agent) · Date: 2026-10-09 · Canonical path: `docs/quality/test-report.md`._
_This report is evidence. It does not override the ADR, the UX spec or the user's decisions._

## 1. Outcome

- **Automated e2e: 35/35 pass** on the real extension (`npm run e2e`, exit 0): journeys J1–J11, the security checks SEC-01/03/04/06, job-contract negatives, service-worker restart, and settings and history persistence.
- **D3 OCR benchmark gate: PASS.** Top-1 accuracy is **100% clean (18/18)** and **88.9% degraded (32/36)**. There were **0 wrong auto-opens**, and auto-open precision was 100% (48/48).
- **Hard checks held across every run:**
  - No wrong auto-open.
  - The foreign QR host `evil.example` was never navigated to or requested, according to both Playwright's log and Chrome's browser-wide NetLog.
- **No open defects.** Section 6 lists observations for FE tuning, a contract note and limits of the test harness.
- **Manual checks M1–M11 were not run.** They need branded Chrome and a person. Section 8 has step-by-step instructions.

## 2. Artifact identity

| Item | Value |
|---|---|
| Source | `git HEAD 5cf27427b39b8a7ed3e2f4b82b41d98eba2252f2`. `src/` is clean (build-info `gitDirty:false`). FE's S6 and security fixes are in `7d15b99`. QA's final edits to `tests/e2e/extension.test.mjs` and `tests/e2e/security.test.mjs` are uncommitted; the orchestrator commits them. |
| e2e build | `dist-e2e/build-info.json`: target `e2e`, gitCommit `5cf2742…`, gitDirty `false`, builtAt `2026-10-09T22:00:55.832Z`, no harness. `dist-e2e/manifest.json` sha256 `cf0b7867ed906a1e150a5398884b5d34c9cd068db392fe8116816edee90d92a7`. |
| Release build (J11) | `dist/build-info.json`: target `release`, gitCommit `5cf2742…`, gitDirty `false`, builtAt `2026-10-09T22:00:13.232Z`. `dist/manifest.json` sha256 `1e37125fce76ee61c585f6fa97debc7e1e3a9714c1f53f1dc3cb493afb7b2229`. |
| Fixtures | `tests/fixtures/manifest.json` sha256 `87ca8692…ee930`. `tests/fixtures/bench/bench-manifest.json` sha256 `03dfec6e…3fc25` (57 fixtures, 4,141,607 bytes). |
| Browser | Playwright-bundled Chromium **141.0.7390.37** (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`), new headless mode, device scale factor 1, `viewport:null`, `--window-size=1280,1000`. Isolated throw-away profile per suite. |
| Tooling | Playwright 1.56.1 (library) driven by `node --test`; Node 22.22.0. |
| OS | Ubuntu 24.04.5 LTS, Linux 6.18.44, x86_64, 4 vCPU, 16 GB RAM. |
| Run window | 2026-10-09 22:00:55Z – 22:04:57Z (full suite 241 s). |

**Network isolation (all e2e launches):**
- Flags: `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost` and `--no-proxy-server`.
- The browser process gets a minimal environment: no proxy variables and no credentials.
- Grader pages are never contacted. Opened URLs are read with `chrome.tabs.query` from the extension, and for the release build from NetLog.

## 3. Commands and observed results

| Command | Result |
|---|---|
| `npm test` (FE unit tests) | 127/127 pass |
| `npm run check` (release `dist/`) | all checks passed, including `incognito not_allowed`, no `host_permissions`, licences, locale parity |
| `node scripts/gen-fixtures.mjs` | `VERIFY OK` and `BENCH VERIFY OK`. A second run into a scratch dir (`--out`) was byte-identical to the committed fixtures (`diff -r` clean). Main fixture hashes are unchanged; only `manifest.json` changed. |
| `CERTSCANNER_E2E_OUT=<dir> npm run e2e` | builds `dist-e2e/`, runs `tests/e2e/**/*.test.mjs`: **tests 35, pass 35, fail 0**, exit 0 |
| `python3 <skill>/scripts/check_extension.py dist` (static heuristics) | 6 "ERRORS" and 1 warning, all reviewed; none is a real issue (details in O6). |

**How to run the suite yourself:**
- Prerequisite: `npm run build:e2e`. `npm run e2e` runs it for you. The suite fails fast with that message if `dist-e2e/` is missing.
- Skip the benchmark (about 2 min): `CERTSCANNER_SKIP_BENCH=1`.
- Choose where benchmark output goes: `CERTSCANNER_E2E_OUT=<dir>`. The default is `<tmp>/certscanner-e2e`; it writes `benchmark-results.{json,md}`.
- Test a different build: `CERTSCANNER_E2E_DIST=<dir>`.
- Use a different browser binary: `CERTSCANNER_CHROMIUM=<chrome>`.
- `npm run e2e` already builds first; do not run `playwright install`.

## 4. Per-case results (final run)

| # | Case (file) | Evidence | Result |
|---|---|---|---|
| 1 | Install (`extension.test.mjs`) | Menu `certscanner-scan` exists; `openPanelOnActionClick:true`; panel path is correct; no `onMessage`, `onMessageExternal` or `onConnect` listeners in the SW or panel; permissions exactly as ADR §3; optional `https://*/*` | pass |
| 2 | SEC-01 / A7 | `manifest.incognito === "not_allowed"`; `isAllowedIncognitoAccess() === false` (manifest level only; runtime is M11) | pass |
| 3 | Panel contract | All 22 §13 test ids present; `status-live` has `aria-live=polite`; `body[data-window-id]` equals `?w=`; accessible names on inputs and switches; `lang=en` | pass |
| 4 | J1 PSA | Job with a same-origin image → `auto-open`, `01234567` (leading zero kept), opened `https://www.psacard.com/cert/01234567` at source index+1 with opener = source tab; job slot removed; history entry holds no image URL or data | pass |
| 5 | J2 CGC comic | CORS image on :C → `cgccomics.com/certlookup/4012345001/`; no-CORS :B dash form → `4012346002` | pass |
| 6 | J3 CGC card | Same-origin iframe job (real `frameId`) → `cgccards.com/certlookup/1401036622258/`; 10-digit card wording (bench `cgcd-c16`) → cgc-cards | pass |
| 7 | J4 QR | `blob:` image via page-fetch → `cgccomics…/4012347003/` with `ocrMs 0`. Foreign QR → **confirm** (12345678 at 0.35 with `qr-untrusted-host`), no tab; Open from confirm → rebuilt `psacard.com/cert/12345678`; `evil.example` absent from tabs and network | pass |
| 8 | J4b QR edge cases (generated with bwip-js at test time) | Allow-listed host with unmatched path → number `23456789`, any tab equals the rebuilt URL; look-alike `www.psacard.com.evil.example` → never auto-opens, nothing opened | pass |
| 9 | J5 ambiguous | Confirm, `5012345678`, grader unresolved, no tab. Open without a grader opens nothing. Choosing CGC Comics → `cgccomics…/5012345678/`, state `opened` | pass |
| 10 | J6 non-slab | `none`, no tab, manual entry and upload offered | pass |
| 11 | J7 fetch blocked | Hotlink CDN (:B `/hotlink/` returns 403 to non-`<img>` fetches) → extension fetch refused → capture → result never a wrong number. ADR harness case `strategies:['page-fetch','capture']` → `method capture`, `resolution screen`, width ≈ on-screen 400 px, `canRequestSharper false` (http origin) | pass |
| 12 | J7b Sharper offer | https image (self-signed, `localhost`) read at screen resolution → confirm with "Sharper scans on localhost" (names only that host). `permissions.request` scoped to `https://localhost/*`. Decline → offer withdrawn, manual entry still opens `psacard…/01234567`. Permission API **stubbed** in the panel realm; see §7. | pass |
| 13 | J8 restricted | `chrome://version` job and Chrome Web Store `pageUrl` → `error` with the same message; image never fetched; no uncaught panel errors; manual entry offered | pass |
| 14 | J9 keyboard only | Tab to `manual-input`, type `PSA 12345678` + Enter → `psacard…/12345678`; `1401234567890` → `cgccards…/1401234567890/`; `hello` → `manual-error` text, `aria-invalid=true`, `aria-describedby` linked, live region, focus kept, no tab | pass |
| 15 | J10 offline input | `context.setOffline(true)` (panel `navigator.onLine === false`): upload → `108114622`; synthetic paste → `4012345001`; synthetic drop → `1401036622258`. A text file and a 1×1 PNG → `error` | pass |
| 16 | Two quick jobs | PSA job then CGC job 60 ms later → only `cgccomics…/4012345001/` opened, even after waiting 4 s | pass |
| 17 | Panel reload | After completion: no new scan or tab (A5 restore showed the last result, state `auto-open`). Mid-scan reload: the job slot was already empty, no re-run, nothing opened | pass |
| 18 | Job contract | Stale (10 min), wrong window, `v:2`, `javascript:` src, `tabId -1` and non-object values: each cleared within 5 s with no scan. A job for another window is left alone; `windows.onRemoved` clears it | pass |
| 19 | Settings and history | "Always ask" on → saved to `storage.sync`, survives reload, upload → `confirm` with no tab (D5). Open in background → tab `active:false`. History survives reload | pass |
| 20 | SW stopped | CDP `ServiceWorker.stopAllWorkers` → `stopped`. Closing a window wakes it (`running`), and its top-level `windows.onRemoved` listener clears that window's job. Menu and panel behaviour intact; job hand-off → auto-open | pass |
| 21 | History clear / off | Clear empties list and `storage.local`, survives reload; with saveHistory off an auto-open writes nothing | pass |
| 22 | Hard check (journeys) | Every auto-open opened exactly one grader URL; no `evil.example`; no `pageerror`; no CSP violations. The only panel console error was the expected 403 from the hotlink CDN in J7. | pass |
| 23 | J11 dist-e2e (`privacy.test.mjs`) | Playwright log (tabs, extension pages, workers, SW) shows only `chrome-extension://<id>/`, fixture origins and grader URLs; SW loads only its own files; no CDN. NetLog: 27 URL requests, 21 from renderers; 3 grader navigations, all `main frame` and `ERR_NAME_NOT_RESOLVED`; every non-local request failed (no egress) | pass |
| 24 | J11 release `dist/` | `permissions.getAll().origins = []`, no `host_permissions`. Upload PSA → auto-open, CGC QR → auto-open, foreign QR → not auto-open. NetLog: 2 renderer requests, both official-page navigations (`psacard…/01234567`, `cgccomics…/4012347003/`), DNS-blocked | pass |
| 25 | SEC-03 busy page (`security.test.mjs`) | Hostile page (`pages/busy.html`, own site `localhost`) blocks its main thread; the image is hotlink-only so the probe must be injected → UI `error` after **12,034 ms** (budget 12,500) | pass |
| 26 | SEC-03 `scan()` | `error/timeout`, `acquireMs 12001`, settled at 12,005 ms | pass |
| 27 | SEC-03 Cancel | Cancel 2 s into a hung acquisition → `idle` after **66 ms** (budget 1,000); nothing opened | pass |
| 28 | SEC-04 decode bomb | 1,080-byte RLE8 BMP declaring 16000×16000 → UI `error` in 80 ms; `scan()` `too-large`, `totalMs 2` | pass |
| 29 | SEC-06 | 110 px https image → `none` + offer → grant (stubbed) → Rescan → full-resolution fetch → auto-open, **1 tab**. Re-delivering the identical job id starts no scan; still 1 tab | pass |
| 30–33 | Fixture integrity (`fixtures.test.mjs`) | Hashes and bytes for main, bench and security fixtures. `qr-foreign-host` accepts `confirm`/`none` with `mustNotAutoOpen` and `mustNotOpen`. Bench has ≥40 fixtures and is <8 MB; all degradation types and grader/length combinations covered | pass |
| 34–35 | Benchmark (`benchmark.test.mjs`) | Cold and warm timings; all 57 fixtures; gate (section 5) | pass |

**Coverage matrix (skill checklist):**
- **Pass:**
  - Install and first use.
  - Panel reload, panel state and window binding.
  - Worker termination and revival.
  - Same-origin iframe.
  - Deny (stubbed).
  - Restricted pages.
  - Settings persistence.
  - Offline.
  - Duplicates and two quick jobs.
  - Invalid messages (jobs).
  - Keyboard and labels (basic).
- **Not run:**
  - Cross-origin iframe: dist-e2e's `<all_urls>` makes it equivalent to a direct fetch.
  - Revoke and real grant (M5).
  - Extension update/reload.
  - Storage migration in the browser (unit-tested by FE).
  - Zoom, contrast, reduced motion, screen reader, Dutch (M8).
  - Chrome 116 (M9).
  - Incognito runtime (M11).
- **Not applicable:**
  - Account, sign-in, tenant, 429/5xx and backend cases: v1 is local-only with no server.
  - Popup: no `action.default_popup`.
  - Content scripts: none declared.

## 5. Benchmark (D3 gate)

**Fixtures:**
- 57 synthetic fixtures in `tests/fixtures/bench/`, 3.95 MiB: 18 clean, 36 degraded, 3 negative.
- Cert numbers: PSA with 7, 8 and 9 digits, including `00573921` and the 9-digit `056734128` with leading zeros; CGC comics with 10 digits, including a dash form, a signature-series band and an allow-listed QR; CGC cards with 13 digits and 10 digits with card wording.
- Degradations:
  - JPEG q40
  - 0.5× scale
  - 1 px and 2 px blur
  - glare
  - rotation by −6° to +5°
  - dark/low contrast with seeded noise
  - busy art with competing digits: `151`, `#199`, `199/165`, `©1995-2023`, `No. 300`, `1988`, `58/102`, and a `LOT 20230417` sticker
  - two combinations
- All fixtures run through the real panel's upload input in one warm panel. `scan()` is also called in the same realm for candidate diagnostics.

| Metric | Observed | Gate |
|---|---|---|
| Top-1 clean | **18/18 = 100%** | ≥ 90% |
| Top-1 degraded | **32/36 = 88.9%** | ≥ 70% |
| Wrong auto-opens | **0** | 0 |
| Auto-open precision | 48/48 = 100% | – |
| Auto-open rate on positives (clean / degraded) | 100% / 83.3% | – |
| Grader correct when top-1 correct | 98% (the one miss is `cgcc-c10-glare`: grader left unresolved, not wrong) | – |
| Negatives (ambiguous, raw card, raw card JPEG) | confirm / none / none, all accepted, no tab | – |
| Warm UI time (upload → final state) p50 / p95 / max | 779 / 1,964 / 5,064 ms | – |
| Warm `scan()` total p50 / p95 / max | 671 / 1,824 / 4,803 ms | – |
| Cold UI time (first scan in a fresh profile, then 4 freshly loaded panels) | 1,352 / 1,333 / 1,300 / 1,413 / 1,254 ms | – |

A second complete benchmark run earlier on the same day (working tree just before `7d15b99`) gave identical accuracy: 100% clean, 88.9% degraded, 0 wrong auto-opens.

**Misses, for FE tuning.** All four ended in confirm or none, none auto-opened:

| Fixture | Degradation | Expected | Observed | Pipeline top candidates |
|---|---|---|---|---|
| psa-c03-blur2 | blur 2 px | psa 109876543 | **confirm with wrong number `100876043`**, PSA pre-selected | `100876043`/psa/0.53, `10987654`/psa/0.35 |
| cgcc-c09-blur2 | blur 2 px | cgc-comics 3984561002 | none | – |
| cgcd-c17-blur2 | blur 2 px | cgc-cards 2938475610 | none | – |
| cgcd-c16-rot-6 | rotation −6° | cgc-cards 3901234567 | none | – |

**Per-fixture results.** "Expected" is the preferred status; every fixture also accepts `confirm` except the negatives.

| Fixture | Category | Degradations | Expected | Observed state | Shown number | Grader | Opened | UI ms | Top pipeline candidates (number/grader/confidence) |
|---|---|---|---|---|---|---|---|---|---|
| psa-c01 | clean | - | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 795 | 04718263/psa/0.9 |
| psa-c02 | clean | - | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 733 | 72910483/psa/0.9 |
| psa-c03 | clean | - | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 827 | 109876543/psa/0.9 |
| psa-c04 | clean | - | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 799 | 00573921/psa/0.9 |
| psa-c05 | clean | - | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 808 | 056734128/psa/0.9 |
| psa-c06 | clean | - | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 667 | 30561247/psa/0.9 |
| psa-c07 | clean | - | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 647 | 5123478/psa/0.9 |
| psa-c08 | clean | - | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 607 | 61834502/psa/1 |
| cgcc-c09 | clean | - | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 797 | 3984561002/cgc-comics/0.95 |
| cgcc-c10 | clean | - | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 899 | 4087123006/cgc-comics/0.95 |
| cgcc-c11 | clean | - | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 845 | 4102938015/cgc-comics/0.95 |
| cgcc-c12 | clean | - | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 813 | 3765432011/cgc-comics/0.95 |
| cgcc-c13 | clean | - | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 297 | 4155667002/cgc-comics/0.95 |
| cgcd-c14 | clean | - | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 831 | 1402345678901/cgc-cards/0.9 |
| cgcd-c15 | clean | - | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 694 | 1403987650123/cgc-cards/0.9 |
| cgcd-c16 | clean | - | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 681 | 3901234567/cgc-cards/0.95 |
| cgcd-c17 | clean | - | auto-open cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | cgccards.com/certlookup/2938475610/ | 777 | 2938475610/cgc-cards/0.95 |
| cgcd-c18 | clean | - | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 677 | 1405551234567/cgc-cards/0.9 |
| neg-c19 | negative | - | confirm - 6012349870 | confirm | 6012349870 | - | - | 637 | 6012349870/?/0.45 |
| neg-c20 | negative | - | none - - | none | - | - | - | 770 | - |
| psa-b01 | degraded | busy-art | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1081 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 |
| cgcc-b02 | degraded | busy-art | auto-open cgc-comics 4011223004 | auto-open | 4011223004 | cgc-comics | cgccomics.com/certlookup/4011223004/ | 900 | 4011223004/cgc-comics/0.95 |
| cgcd-b03 | degraded | busy-art | auto-open cgc-cards 1404440987654 | auto-open | 1404440987654 | cgc-cards | cgccards.com/certlookup/1404440987654/ | 1051 | 1404440987654/cgc-cards/0.9 |
| psa-b04 | degraded | busy-art | confirm psa 81726354 | auto-open | 81726354 | psa | psacard.com/cert/81726354 | 889 | 81726354/psa/0.9 |
| psa-c01-jpeg40 | degraded | jpeg-q40 | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 726 | 04718263/psa/0.9 |
| psa-c03-jpeg40 | degraded | jpeg-q40 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 817 | 109876543/psa/0.9 |
| cgcc-c09-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 847 | 3984561002/cgc-comics/0.95 |
| cgcd-c14-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 779 | 1402345678901/cgc-cards/0.9 |
| cgcd-c16-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 712 | 3901234567/cgc-cards/0.95 |
| psa-c08-jpeg40 | degraded | jpeg-q40 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 653 | 61834502/psa/1 |
| cgcc-c13-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 307 | 4155667002/cgc-comics/0.95 |
| psa-c02-half | degraded | scale-0.5 | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 442 | 72910483/psa/0.9 |
| psa-c04-half | degraded | scale-0.5 | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 535 | 00573921/psa/0.9 |
| cgcc-c10-half | degraded | scale-0.5 | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 658 | 4087123006/cgc-comics/0.8 |
| cgcd-c15-half | degraded | scale-0.5 | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 451 | 1403987650123/cgc-cards/0.9 |
| psa-c08-half | degraded | scale-0.5 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 467 | 61834502/psa/0.9 |
| psa-c01-blur1 | degraded | blur-1px | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 820 | 04718263/psa/0.9 |
| cgcc-c11-blur1 | degraded | blur-1px | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 838 | 4102938015/cgc-comics/0.95 |
| cgcd-c14-blur1 | degraded | blur-1px | auto-open cgc-cards 1402345678901 | confirm | 1402345678901 | cgc-cards | - | 611 | 1402345678901/cgc-cards/0.7 |
| psa-c03-blur2 | degraded | blur-2px | auto-open psa 109876543 | confirm | 100876043 (miss) | psa | - | 816 | 100876043/psa/0.53 10987654/psa/0.35 |
| cgcc-c09-blur2 | degraded | blur-2px | auto-open cgc-comics 3984561002 | none | - (miss) | - | - | 1188 | - |
| cgcd-c17-blur2 | degraded | blur-2px | auto-open cgc-cards 2938475610 | none | - (miss) | - | - | 905 | - |
| psa-c02-glare | degraded | glare | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 678 | 72910483/psa/0.9 |
| psa-c06-glare | degraded | glare | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 702 | 30561247/psa/0.9 |
| cgcc-c10-glare | degraded | glare | auto-open cgc-comics 4087123006 | confirm | 4087123006 | - | - | 703 | 4087123006/?/0.45 |
| cgcd-c14-glare | degraded | glare | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 759 | 1402345678901/cgc-cards/0.9 |
| psa-c03-rot-3 | degraded | rotate:-3 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 860 | 109876543/psa/0.9 |
| cgcc-c09-rot5 | degraded | rotate:5 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 809 | 3984561002/cgc-comics/0.85 |
| cgcd-c16-rot-6 | degraded | rotate:-6 | auto-open cgc-cards 3901234567 | none | - (miss) | - | - | 1234 | - |
| psa-c07-rot2 | degraded | rotate:2 | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 644 | 5123478/psa/0.9 |
| psa-c04-dark | degraded | dark-low-contrast | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 1964 | 00573921/psa/0.9 |
| cgcc-c12-dark | degraded | dark-low-contrast | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 1172 | 3765432011/cgc-comics/0.94 |
| cgcd-c18-dark | degraded | dark-low-contrast | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 2923 | 1405551234567/cgc-cards/0.9 |
| psa-c05-dark | degraded | dark-low-contrast | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 5064 | 056734128/psa/0.9 |
| psa-b01-jpeg40 | degraded | busy-art, jpeg-q40 | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1058 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 |
| cgcd-c14-rot-4-jpeg60 | degraded | rotate:-4, jpeg-q60 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 753 | 1402345678901/cgc-cards/0.9 |
| neg-c20-jpeg40 | negative | jpeg-q40 | none - - | none | - | - | - | 773 | - |

## 6. Defects and observations

**No open defects.** Nothing failed in the final run against `5cf2742`.

Earlier failures during development were all test-side issues against FE's in-progress tree. FE's diagnosis matched mine and I fixed them in the tests:
- NetLog reports `ERR_NAME_NOT_RESOLVED`, not `NAME_NOT_RESOLVED`.
- Playwright does not surface a restarted service worker, which left a stale handle. The SW test now drives chrome.* from the panel and proves the restarted worker through its `windows.onRemoved` cleanup.
- SEC-06 originally expected a Sharper offer after an auto-open, which UX5 forbids. It was rewritten.
- `setting-autoOpen` has inverted semantics.
- Some §13 elements were rendered from templates.

While FE was mid-edit, one interim build of the panel threw `Cannot set properties of null (setting 'hidden')` before `data-ready`. It was transient and absent from the final build.

**SEC-03, SEC-04, SEC-06 and SEC-01 were already fixed in every build I ran.** I did not observe their failing state myself. The security review's round-1 observations are the "before" evidence.

| ID | Type | Observation | Repro / evidence | Suggested owner |
|---|---|---|---|---|
| O1 | Accuracy risk (R2), not a gate failure | With 2 px blur, `psa-c03-blur2` shows confirm with the **wrong** 9-digit number `100876043` at 0.53 and PSA pre-selected. It is correctly not auto-opened, but one click on Open would open a plausible wrong record. | `tests/fixtures/bench/psa-c03-blur2.jpg` via upload; pipeline candidates in section 5 | FE: consider not pre-filling the number below about 0.6, or highlighting low confidence. UX decision. |
| O2 | Accuracy | 2 px blur on 10-digit comic/card labels and −6° rotation on a 10-digit card produce **no candidate at all** (`none`). | `cgcc-c09-blur2`, `cgcd-c17-blur2`, `cgcd-c16-rot-6` | FE (OCR tuning: deskew, or a sharpening/upscale pass for the digits crop) |
| O3 | Performance | Dark/low-contrast scans are slow: `psa-c05-dark` 5.1 s, `cgcd-c18-dark` 2.9 s, `psa-c04-dark` 2.0 s (warm). This is within the 25 s budget but 3–7× the median. | Benchmark rows | FE (cap OCR passes once a valid run is found) |
| O4 | Contract note | `setting-autoOpen` sits on the "Always ask before opening" switch with `data-inverted="true"` (checked means autoOpen is false). The tests handle this, but ADR §13 does not say so. | `src/sidepanel/sidepanel.html` | Architect: note it in §13 |
| O5 | Busy-art competition works as designed | `psa-b01`: printed `2023 SV 151` and `Illus. Studio 1999 199/165` merged into PSA-length candidates `2023151` and `1997165` at 0.35, below the 0.50 competitor threshold, so auto-open of the correct cert was kept. The `LOT 20230417` sticker (`psa-b04`) was not read as a candidate. | Benchmark rows | – |
| O6 | Static checker heuristics | Results of `check_extension.py dist`:<br>• "unsafe HTML asset: ../vendor/…" is a false positive (the checker does not normalise `..`).<br>• "remote or dynamic code" in `tesseract-core-simd-lstm.js` and `zxing-reader.iife.js` matches `function(` case-insensitively; false positive.<br>• `tesseract.min.js` and `worker.min.js` contain Babel/regenerator fallbacks `Function("r","regeneratorRuntime = r")` and `new Function("return this")` inside `try/catch`. The extension CSP (no `unsafe-eval`) blocks them; the e2e run asserted no CSP violation was logged. Not remote code.<br>• "broad hosts" warning: refers to the optional `https://*/*`, which is documented. | Command in section 3 | Release manager: mention in the Store remote-code answer if asked |
| O7 | Console noise | A hotlink-protected image logs `Failed to load resource: 403` in the panel console when extension-fetch is refused. Expected; harmless. | J7 | – |

## 7. Assumptions and limitations (what automation does not prove)

**What the harness substitutes for real user actions:**
- **No real right-click, activeTab grant or `sidePanel.open` gesture.** Jobs are written to `chrome.storage.session` from the extension's own service worker, in the same shape as `sw.js` after A7: no `frameUrl`, and `pageUrl` reduced to origin + path. The panel runs as the `?w=` popup-window fallback.
- **The test build holds host access.** `dist-e2e` has `host_permissions:["<all_urls>"]` because tests cannot produce an activeTab grant. Extension-fetch therefore succeeds where release builds need activeTab or a per-origin grant. The release build was exercised only through upload (J11).
- **The permission prompt is stubbed.** In J7b and SEC-06, `chrome.permissions.contains/request` were replaced in the panel realm only. Headless Chromium cannot answer the prompt, and the e2e build already holds `<all_urls>`. Fetch, capture, OCR, routing and tab opening stayed real. A real grant, deny or revoke is M5.

**What was not tested here:**
- **Playwright and headless limits.**
  - After `ServiceWorker.stopAllWorkers`, Chromium restarted the worker (confirmed through CDP `runningStatus`), but Playwright 1.56 did not expose the new instance.
  - Headless runs at device scale factor 1, so capture-resolution results are pessimistic compared with 2× laptop screens.
- **Out of scope here.**
  - Branded Chrome.
  - Chrome 116.
  - Dutch UI.
  - Screen readers, zoom and contrast.
  - Incognito at runtime.
  - Extension update/reload.
  - Cross-origin iframe without host access.
  - Real marketplace CDNs.
  - Live grader pages, which are DNS-blocked by design.

**About the fixtures and the NetLog:**
- **The benchmark is synthetic.** HTML/CSS renders in Liberation Sans with abstract art. Real photos (perspective, reflections, other fonts, JPEG chains) are likely harder. The gate result should not be read as real-world accuracy.
- **NetLog background traffic.** The browser-wide NetLog also records Chromium background services that are not extension traffic: `clients2.google.com` (time), `accounts.google.com`, `redirector.gvt1.com` (spell-check dictionary), `www.google.com/async/folae`, `android.clients.google.com`. They are identified by non-renderer traffic annotations and an initiator of "not an origin", and all failed DNS (no egress).

## 8. Manual Chrome checks M1–M11 — **not run** (need branded Chrome and a person)

**Setup for all checks:**
1. Build the release package: `npm run build`.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the `dist/` folder.
3. Pin CertScanner.

**Test pages:**
- Serve the fixtures with `cd tests/fixtures && python3 -m http.server 8000`, then open `http://localhost:8000/pages/gallery.html`.
- For CDN checks, use a real public marketplace listing that shows a graded slab photo.
- Record the Chrome version (`chrome://version`), the OS, the result, and a screenshot of each step.

| ID | Check | Steps | Pass when |
|---|---|---|---|
| M1 | Context menu opens the panel (fresh / already open) | 1. Close the side panel. 2. Right-click the PSA image (`#img-psa-leading-zero`) and choose "Scan slab cert number". 3. Repeat with the side panel already open. | The panel opens immediately both times, shows progress, then a new tab opens at `https://www.psacard.com/cert/01234567` next to the gallery tab. No permission prompt appears. |
| M2 | Two quick clicks | Right-click scan the PSA image, then within about 1 s right-click scan the rotated CGC image (`#img-rotated`). | Only the CGC result is shown and only `cgccomics.com/certlookup/4012345001/` opens. The first scan is cancelled silently. |
| M3 | Click after the service worker stopped | 1. Open `chrome://serviceworker-internals`, find CertScanner and click **Stop** (or wait about 30 s idle with DevTools closed). 2. Right-click scan the ambiguous image. | The panel opens and shows confirm with `5012345678` and no grader pre-selected. No error. |
| M4 | activeTab on a real CDN | On a real listing page whose image is on another host (for example `i.ebayimg.com`), right-click scan the slab photo. | It works without any prompt. The preview shows the image. If the CDN refuses the fetch, the result is still read from the screen capture. No requests other than the image host and the opened official page (check DevTools → Network on the panel). |
| M5 | Sharper scans grant / deny / revoke | 1. Make the image small (browser zoom at 50%) on a real https CDN page and scan until confirm/none shows "Sharper scans on ‹host›". 2. Click it → Chrome's prompt must name only that host → **Deny** → the offer disappears and manual entry still works. 3. Restart Chrome and repeat → **Allow** → **Rescan** → full-resolution result. 4. Settings → Sharper scans lists the host → **Remove** → `chrome://extensions` → CertScanner → Details → Site access no longer lists it. | Each step behaves as described. A cert opens at most once per scan. |
| M6 | Web Store and `chrome://` pages | 1. Open a Chrome Web Store item page and right-click an image. 2. Open `chrome://version`. 3. In both cases, open the panel from the toolbar and upload `tests/fixtures/psa-9digit.png`. | On the Web Store, either no menu item appears or the panel says Chrome does not allow reading the page and offers upload/paste. Upload works. No uncaught errors appear in the panel DevTools. |
| M7 | Two windows | Open the gallery in windows A and B, each with its own side panel. Scan in A. | Only A's panel reacts. The tab opens in window A. B's panel is unchanged. |
| M8 | Dutch UI, screen reader, keyboard | 1. Set Chrome's display language to Nederlands (`chrome://settings/languages`; on Linux start with `LANGUAGE=nl`) and relaunch. 2. Check that all panel text is Dutch, the menu reads in Dutch, and `html[lang]` is `nl`. 3. With NVDA, VoiceOver or ChromeVox, scan the PSA image: the result is announced once. 4. Tab through the panel using only the keyboard, type `PSA 12345678` + Enter, then an invalid value. 5. Check at 200% zoom. | Strings are complete and not truncated. Announcements happen. Focus is visible and logical. The error is read out. There is no horizontal scrolling at 200%. |
| M9 | Chrome 116 | Install Chrome for Testing 116 with a fresh profile, load `dist/`, and repeat M1, M5 (deny) and an upload. | It works with no console errors (APIs used: `sidePanel.open`, `AbortSignal.any`, `storage.session`). |
| M10 | Official URLs resolve | With normal internet access, open each builder URL for a cert number that the grader itself shows publicly (not the synthetic test numbers): `https://www.psacard.com/cert/<n>`, `https://www.cgccomics.com/certlookup/<n>/`, `https://www.cgccards.com/certlookup/<n>/`. | Each page shows that cert's record. A leading zero on a PSA number is preserved. |
| M11 | Incognito not allowed (SEC-01) | 1. `chrome://extensions` → CertScanner → **Details**: look for the "Allow in Incognito" toggle. 2. Open an incognito window, right-click an image, and look at the toolbar. | The incognito toggle is absent or cannot be enabled. In incognito there is no "Scan slab cert number" item and the action/panel is unavailable. No history entry is created. |

## 9. Files (QA-owned)

**Tests:**
- `tests/e2e/lib/env.mjs`: launch, isolation, fixture servers (pages, no-CORS with `/hotlink/`, CORS, self-signed HTTPS), job writer, panel helpers, NetLog parser.
- `tests/e2e/lib/panel.mjs`: §13 test-id interactions, settings, paste/drop, permission stub.
- `tests/e2e/extension.test.mjs`: journeys.
- `tests/e2e/security.test.mjs`: SEC-03, SEC-04, SEC-06.
- `tests/e2e/privacy.test.mjs`: J11 on both builds.
- `tests/e2e/benchmark.test.mjs`: D3 gate.
- `tests/e2e/fixtures.test.mjs`: fixture integrity.

**Fixtures and generator:**
- `scripts/gen-fixtures.mjs` now also generates:
  - the benchmark set (`tests/fixtures/bench/` + `bench-manifest.json`);
  - the SEC-03 page `tests/fixtures/pages/busy.html`;
  - the SEC-04 bomb `tests/fixtures/security/decode-bomb-rle8.bmp`.
- `tests/fixtures/manifest.json` changes:
  - `qr-foreign-host` accepts `confirm` or `none`, with `mustNotAutoOpen`, `mustNotOpen` and `expectWarning`;
  - `ambiguous-10digit` has `graderUnresolved`;
  - adds the `busy.html` page entry and `securityFixtures`.

**Report:** this file.

**Next owners:**
- FE: O1–O3, optional.
- Architect: O4 note.
- User + QA: M1–M11 in branded Chrome before release.
- Release manager: O6 wording.
