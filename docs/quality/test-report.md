# CertScanner — QA test report (e2e, A9 page scan, benchmark, fixtures)

_Role: qa-engineer (native specialist agent) · Date: 2026-10-10 · Canonical path: `docs/quality/test-report.md`._
_This report replaces the 2026-10-09 report (35/35 at `5cf2742`), which predates the A9 page scan. It is evidence. It does not override the ADR, the UX spec or the user's decisions._

## 1. Outcome

| Area | Result |
|---|---|
| Automated e2e, full suite + benchmark (`npm run e2e`, final run) | **52/52 pass**, exit 0, at HEAD `03d9589` |
| A9 page scan (new `tests/e2e/pagescan.test.mjs`) | **15/15 pass** (in the full run, and again after one added assertion, §3) |
| Toolbar behaviour assertions (`extension.test.mjs`) | Updated to A9. They were red before the edit: 2 failures, exactly the two `openPanelOnActionClick === true` assertions. Now green. |
| D3 OCR benchmark gate | **PASS**: 100% clean (18/18), 88.9% degraded (32/36), **0 wrong auto-opens**, auto-open precision 48/48. Same accuracy as the 2026-10-09 run. |
| J11 egress | **pass** on dist-e2e (incl. a page scan) and on the release `dist/` (incl. the page-access path). The release build made 0 extension-initiated http(s) requests. |
| Hard checks | No wrong auto-open in journeys, page scans or the benchmark. `evil.example` was never navigated to or requested (Playwright log + browser-wide NetLog). The listing's price, item number and seller ID never opened a tab. |
| Defects | **None.** 5 new observations (O8–O12, §7). O12 affects release-checklist PS4. |
| Manual checks | M1–M11 and PS1–PS12 **not run**: they need branded Chrome and a person (§9). The real toolbar click, Alt+Shift+S, `sidePanel.open` gesture and permission prompt cannot be automated. |

## 2. Artifact identity

| Item | Value |
|---|---|
| Source | `git HEAD 03d95895443d88898592fbc4e6da723d8910ea98`, branch `claude/sharp-turing-1et8ns`. `src/` is clean (build-info `gitDirty:false`). QA edits are uncommitted (§10); the orchestrator commits them. |
| e2e build | `dist-e2e/build-info.json`: target `e2e`, gitCommit `03d9589…`, gitDirty `false`, builtAt `2026-10-10T06:47:44.982Z` (rebuilt by the final `npm run e2e`). `dist-e2e/manifest.json` sha256 `88fb2414b131391e91e9e0f64767b756c6e084a4568d2fec796010c055784062`. |
| Release build | `dist/build-info.json`: target `release`, gitCommit `03d9589…`, gitDirty `false`, builtAt `2026-10-10T06:24:49.686Z`. `dist/manifest.json` sha256 `0aec47bb6c9faf3baf5f3bd21946a65652cebab78336a4247526aa30a3f9a2e1`. Used directly by J11-release and the page-access cases (same commit, not a copy). |
| Manifest hashes vs FE | Match the S7 handoff prefixes (`0aec47bb…`, `88fb2414…`). |
| Fixtures | `tests/fixtures/manifest.json` sha256 `245df62fe72a08d902ed88d3bd1719fb62eb8514450e32d638cbd5571f677142`. The change is additive: the listing page entry and `pageAssets`. `bench/bench-manifest.json` sha256 `03dfec6e…fc25` is unchanged (57 fixtures). |
| Browser | Playwright-bundled Chromium **141.0.7390.37** (`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`), new headless. Device scale factor 1, `viewport:null`, `--window-size=1280,1000` (page viewport 1280×861). Throw-away profile per suite. |
| Tooling | Playwright 1.56.1 (library) with `node --test`; Node 22.22.0. |
| OS | Ubuntu 24.04.5 LTS, Linux 6.18.44, x86_64, 4 vCPU, 15 GiB RAM. |
| Run windows | Final full run 2026-10-10 06:47:44Z – 06:53:42Z (357 s). Page-scan re-run until 06:56:56Z. |

**Network isolation (all launches, unchanged):**
- `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost` and `--no-proxy-server`.
- The browser gets a minimal environment (no proxy variables, no credentials).
- Grader pages are never contacted. Opened URLs are read with `chrome.tabs.query`, and for the release build also from NetLog.

## 3. Commands and observed results

| Command | Result |
|---|---|
| `npm test` | 164/164 pass |
| `npm run build` / `npm run build:e2e` | `dist/` 64 files, 7.16 MiB; `dist-e2e/` 64 files, 7.17 MiB |
| `npm run check` | all checks passed (src 37 files, en/nl parity 204 keys, no `host_permissions`) |
| Baseline before QA edits: `node --test tests/e2e/extension.test.mjs` | 20/22. Only `install` (`:95`) and `service worker stopped` (`:507`) failed, both on `openPanelOnActionClick === true`. |
| `node scripts/gen-fixtures.mjs` (with the new listing) | `VERIFY OK`, `BENCH VERIFY OK`. A second run into a scratch dir (`--out`) is byte-identical (`diff -r` clean). Existing fixture bytes are unchanged. |
| `CERTSCANNER_E2E_OUT=<dir> npm run e2e` (final) | **tests 52, pass 52, fail 0**, exit 0 |
| `node --test --test-concurrency=1 tests/e2e/pagescan.test.mjs` (after adding the O12 navigation check) | tests 15, pass 15, fail 0 |
| `python3 <skill>/scripts/check_extension.py dist` | Same as the previous report: 6 heuristic "ERRORS" (vendor false positives, O6) and the broad-hosts warning for the optional `https://*/*`. |

**Running the suite:**
- `npm run e2e` builds `dist-e2e/` and runs `tests/e2e/**/*.test.mjs`.
- `CERTSCANNER_SKIP_BENCH=1` skips the benchmark (about 2 min).
- `CERTSCANNER_E2E_OUT=<dir>` sets where `benchmark-results.{json,md}` go.
- `CERTSCANNER_E2E_DIST=<dir>` tests a different build; `CERTSCANNER_CHROMIUM=<chrome>` uses another binary.
- Do not run `playwright install`.

## 4. Per-case results (final run)

### 4.1 A9 page scan — `tests/e2e/pagescan.test.mjs`

Page jobs are written to `chrome.storage.session` `scanJob:<windowId>` from the extension's service worker, in the exact shape of `sw.js` `createPageJob()`:
`{v:1, id, createdAt, kind:'page', source, srcUrl:null, pageUrl:<origin+path>, frameId:0, tabId, windowId}`, with no `mediaType`.
That stands in for the toolbar icon and Alt+Shift+S, which cannot be automated.
P1–P10 carry their ID in the test name. P11–P14 are the tests whose names start with `hard check: every page-scan auto-open`, `page-access state`, `"Always allow on <host>"` and `NL:`.

| # | Case (build) | Evidence (final run) | Time | Result |
|---|---|---|---|---|
| P1 | Gallery page job (dist-e2e) | Body and task `page-results` with heading "Cert numbers on this page". Rows: cgc-comics 4012345001, 4012346002, 4012347003; psa 01234567; `?` 5012345678 ("Choose grader", no Open); psa 12345678 (off-site QR note naming `evil.example`). **Every number on a scanned photo is listed.** No stray number, no wrong grader. Each graded row shows its exact official path, a thumbnail and Copy. Summary "Found: 6". No auto-open, no tab, no history entry. Job slot cleared. `evil.example` absent from tabs and network. Photos ≥ 90% visible were scanned first. The lazy image below the fold was not discovered. | UI 8.0 s (cold panel) | pass |
| P1b | Diagnostic `scanPage()` in the panel realm | 10 discovered, 8 scanned. Every image acquired: 7 by extension-fetch, the `blob:` one by page-fetch. Discovery 3 ms, one capture 157 ms, total 7.1 s (budget 30 s). Per image: §5. | 7.1 s warm | pass |
| P2 | Listing `pages/listing.html` (dist-e2e) | Discovery finds only the slab photo and the raw-card photo. The logo, avatar, banner and two 64 px thumbnails are excluded. Auto-open `https://www.psacard.com/cert/108114622` **exactly once**, at listing index+1, with the listing as opener. S2 shows `psacard.com/cert/108114622`. History +1 (psa 108114622, no URL). No page-text number shown. Re-sending the same job id clears the slot, starts no scan and leaves still 1 tab. | UI 3.65 s | pass |
| P3 | Listing `?details=1` and `?slab=0&details=1` | Page text is never read. Printed in an image: seller ID 48213576 → psa @0.70 and item number 2023041712 → no grader @0.35. Both are listed with "Not a clear read", **never opened**. With the slab present the page shows `page-results` instead of auto-open (O8). | 4.1 s / 3.6 s | pass |
| P4 | Nothing found | `?slab=0`: `none`, "No cert numbers found on this page", "Checked the photos on this page but couldn't read a cert number.", 3 tips (open the photo, right-click, upload), Scan again + Choose image. `?photos=0`: "No photos large enough to be a slab are visible on this page." No tab, no history. | 2.7 s / 61 ms | pass |
| P5 | Restricted | Panel button (real click) with `chrome://version` active: the no-op probe is refused → E1, no scan started. Page jobs with `pageUrl ''` (hidden URL), `chrome://version/` and a Web Store URL → E1 "Chrome doesn't allow reading this page" with Scan this page + Choose image. Web Store never requested. No uncaught errors. | 11–14 ms | pass |
| P6 | Cancel at "Scanning image 2 of 8" (gallery) | `idle`, "Scan cancelled." announced, focus on `#task-heading`. No late result within 3 s, nothing opened. | **90 ms** (budget 1 s) | pass |
| P7 | Panel "Scan this page" with access (dist-e2e) | Real click → `page-results` (6 rows), no tab by itself. Open on a row → exactly the row's official URL; row marked Opened; list kept. "Choose grader" → `confirm` with grader radios → "Back to the results" → same rows. Panel reload → `idle`: the list is not restored, by design, and no scan starts. | 7.4 s | pass |
| P8 | Newest page job wins | Gallery job, then a listing job 300 ms later → final `auto-open`. Only `psacard.com/cert/108114622` opened within 4 s. | – | pass |
| P9 | Crop fallback: hotlink CDN refuses every fetch (dist-e2e) | Extension and page fetches were refused (403). The pipeline cropped from one viewport capture: `method capture`, `resolution screen`, DPR 1. 400 px psa-9digit → auto-open 108114622 @0.90. 270 px psa-8digit → auto-open 01234567 @0.90. Never a wrong number. | – | pass |
| P10 | Page-job contract negatives | `mediaType` on a page job, source `contextMenu`, non-null `srcUrl`, `frameId 3`, stale (10 min), `kind:'frame'`, `tabId -1`: each cleared within 5 s with no scan and no tab. | – | pass |
| P11 | Hard check (page-scan describe) | Every page-scan auto-open went to its one expected URL. No `pageerror`, no CSP violation, no `evil.example`. Console only shows the expected 403s from the P9 hotlink CDN. | – | pass |
| P12 | Page access on release **`dist/`** (no host access) | `permissions.getAll().origins = []`. The active tab's URL is hidden. Panel button → `#task[data-state=page-access]`, body `idle`, focus on the heading. Copy: "Click the CertScanner icon in the toolbar, or press Alt+Shift+S, to scan this page." (Chrome reports `scan-page` = Alt+Shift+S). No "Always allow" (host unknown). No scan, no request from any context. | – | pass |
| P13 | "Always allow" on release `dist/`, https host known from an earlier job, **prompt stubbed** | Offer "Always allow on 127.0.0.1"; `permissions.request({origins:['https://127.0.0.1/*']})`; decline → offer withdrawn, "No access given…" note focused, nothing granted. After the tab moved to another https site: page-access **without** the offer (O12). | – | pass |
| P14 | Dutch smoke (`--lang=nl`, dist-e2e) | `chrome.i18n.getUILanguage()` is `nl`; toolbar title "Deze pagina scannen op certnummers van slabs"; `html[lang=nl]`; idle "Slab scannen"; button "Deze pagina scannen". Page job → "Certnummers op deze pagina", "Gevonden: 7. …", row button "Openen PSA 81234567", "Grader kiezen". | – | pass |

### 4.2 Updated or extended existing cases

| Case (file) | Change and evidence | Result |
|---|---|---|
| Install (`extension.test.mjs`) | `openPanelOnActionClick` is **false** (A9 default: the icon scans the page). `commands` declares `scan-page`. The rest is unchanged: menu, panel path, no message listeners, permissions, optional `https://*/*`. | pass |
| A9 setting (new) | `setting-scanOnToolbarClick` off → `storage.sync` saved → behaviour **true**, tooltip "Open CertScanner". On → **false**, tooltip "Scan this page for slab cert numbers" (RM-6). | pass |
| Panel contract | Adds `page-scan-button`, `page-progress`, `page-result-list`, `setting-scanOnToolbarClick`, `shortcut-current`, `shortcut-button`. All present and unique; idle shows "Scan this page". | pass |
| Service worker stopped | Setting off → behaviour true. CDP `stopAllWorkers` → `stopped`. A stale `false` was forced from the panel while stopped. The worker restarted on its next event → behaviour back to **true** (top-level `applyPanelBehavior`). Setting on → false. Window-job cleanup and image hand-off → auto-open still work. | pass |
| J11 dist-e2e (`privacy.test.mjs`) | Adds a gallery page job (`page-results`). NetLog: 36 requests, 28 renderer, 10 extension-initiated (all to the local fixture origins), 3 grader navigations (`main frame`, `ERR_NAME_NOT_RESOLVED`). Every non-local request failed (no egress). | pass |
| J11 release `dist/` | Adds the gallery page and the panel page-scan click (page-access, no request to the page origins). NetLog: 25 requests, 18 renderer, **0 extension-initiated**, 2 grader navigations (`psacard…/01234567`, `cgccomics…/4012347003/`), DNS-blocked. | pass |
| Fixture integrity (`fixtures.test.mjs`) | Adds the listing: asset hashes; exactly the slab and raw photo are slab-sized; logo, avatar, banner and thumbnails are below threshold; the expected URL matches the slab fixture; no page-text number equals the cert. | pass |

### 4.3 Unchanged cases (all pass in the final run)

| Cases | Key observations (final run) |
|---|---|
| J1–J10, J4b, J7b, two quick jobs, panel reload, job contract, settings and history, history clear/off, journeys hard check (`extension.test.mjs`) | Same evidence as the 2026-10-09 report. Panel reload after completion restored `auto-open 108114622` (A5). J7b offered "Sharper scans on localhost". |
| SEC-03 busy page / `scan()` / Cancel (`security.test.mjs`) | UI `error` after **12,046 ms** (budget 12,500); `scan()` `timeout`, acquireMs 12,001; Cancel → `idle` in **57 ms** |
| SEC-04 decode bomb | UI `error` in 32 ms; `scan()` `too-large`, totalMs 2 |
| SEC-06 | Capture read `none` + offer → grant (stubbed) → Rescan → auto-open, 1 tab. Re-delivered identical id → no scan, still 1 tab. |
| Fixture integrity, benchmark (`fixtures.test.mjs`, `benchmark.test.mjs`) | Hashes OK; gate PASS (§6) |

**Coverage matrix (skill checklist):**
- **Pass:**
  - install and first use, including the A9 default
  - toolbar setting toggle
  - panel state and reload
  - window binding
  - worker stop and revival, including the panel-behaviour restore
  - same-origin iframe
  - restricted pages (image and page jobs, panel button)
  - grant/deny (stubbed)
  - settings persistence
  - offline input
  - duplicates and newest-job-wins (image and page)
  - invalid jobs (image and page)
  - keyboard and labels (basic)
  - Dutch UI smoke
  - egress on both builds
- **Not run:**
  - real grant, revoke and prompt (M5, PS4)
  - extension update/reload
  - storage migration in the browser (unit-tested by FE)
  - zoom, contrast, reduced motion, screen reader (M8)
  - Chrome 116 (M9)
  - incognito runtime (M11)
  - HiDPI capture (PS11)
  - user-restricted sites
- **Not applicable:**
  - accounts, tenants, 429/5xx and backends (local-only v1)
  - popup (no `default_popup`)
  - content scripts (none declared)
  - cross-origin iframes in page mode (main frame only, by A9 design)

## 5. Page-scan evidence detail

**Gallery, final run.** Viewport 1280×861, DPR 1, 10 slab-sized images discovered.
The first 8 by visible area: qr-foreign 1.00, psa-8digit 1.00, ambiguous 1.00, psa-lowres (srcset) 1.00, cgc-comic-dash 0.54, non-slab 1.00, cgc-comic-qr (`blob:`) 0.00, cgc-comic-rotated 0.00.

| img | fixture | method | acquire ms | scan ms | candidates |
|---|---|---|---|---|---|
| 0 | qr-foreign-host | extension-fetch | 22 | 848 | 1 (psa 12345678 @0.35, off-site QR) |
| 1 | psa-8digit-leading-zero | extension-fetch | 22 | 736 | 1 |
| 2 | ambiguous-10digit | extension-fetch | 17 | 520 | 1 (5012345678 @0.45, no grader) |
| 3 | psa-lowres (srcset) | extension-fetch | 10 | 459 | 1 (merged with img 1) |
| 4 | cgc-comic-dash | extension-fetch | 16 | 739 | 1 |
| 5 | non-slab | extension-fetch | 13 | 2,475 | 0 |
| 6 | cgc-comic-qr (`blob:`) | page-fetch | 25 | 196 | 1 (qr-url) |
| 7 | cgc-comic-rotated | extension-fetch | 24 | 811 | 1 |

The selection depends on layout and Chrome's cache. In two other runs, Chrome resolved the srcset image to the already-cached 544w candidate (same URL as img 1, de-duplicated). That left 9 images, so `psa-back-barcode` (81234567) entered the top 8 and was listed.
P1 therefore derives its expected numbers from the extension's own discovery result and checks them against the fixture manifest. It does not hard-code a list.

**Listing variants.** One run each, final.

| Variant | Discovered | Observed | Tabs |
|---|---|---|---|
| default | slab, raw photo | auto-open psa 108114622 @0.90 | 1 (`psacard.com/cert/108114622`) |
| `?details=1` | slab, raw photo, details image | page-results: psa 108114622 @0.90; psa 48213576 @0.70 (note); `?` 2023041712 @0.35 (note) | 0 |
| `?slab=0&details=1` | raw photo, details image | page-results: psa 48213576 @0.70; `?` 2023041712 @0.35 | 0 |
| `?slab=0` | raw photo | none, "photos checked" | 0 |
| `?photos=0` | – | none, "no photos large enough" | 0 |

## 6. Benchmark (D3 gate), final run

57 synthetic fixtures (18 clean, 36 degraded, 3 negative), run through the real panel's upload input in one warm panel. The fixtures are unchanged from the 2026-10-09 report.

| Metric | Observed | Gate |
|---|---|---|
| Top-1 clean | **18/18 = 100%** | ≥ 90% |
| Top-1 degraded | **32/36 = 88.9%** | ≥ 70% |
| Wrong auto-opens | **0** | 0 |
| Auto-open precision | 48/48 = 100% | – |
| Auto-open rate on positives (clean / degraded) | 100% / 83.3% | – |
| Grader correct when top-1 correct | 98% | – |
| Warm UI time p50 / p95 / max | 834 / 2,045 / 5,522 ms | – |
| Warm `scan()` total p50 / p95 / max | 709 / 1,946 / 5,323 ms | – |
| Cold UI time (fresh profile, then 4 reloaded panels) | 1,438 / 1,388 / 1,384 / 1,332 / 1,247 ms | – |

**Misses.** The same four as on 2026-10-09; none auto-opened.

| Fixture | Degradation | Expected | Observed | Pipeline top candidates |
|---|---|---|---|---|
| psa-c03-blur2 | blur 2 px | psa 109876543 | **confirm with wrong number `100876043`**, PSA pre-selected | 100876043/psa/0.53, 10987654/psa/0.35 |
| cgcc-c09-blur2 | blur 2 px | cgc-comics 3984561002 | none | – |
| cgcd-c17-blur2 | blur 2 px | cgc-cards 2938475610 | none | – |
| cgcd-c16-rot-6 | rotation −6° | cgc-cards 3901234567 | none | – |

**Per-fixture results.** "Expected" is the preferred status; every positive also accepts `confirm`.

| Fixture | Category | Degradations | Expected | Observed state | Shown number | Grader | Opened | UI ms | Top pipeline candidates |
|---|---|---|---|---|---|---|---|---|---|
| psa-c01 | clean | - | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 941 | 04718263/psa/0.9 |
| psa-c02 | clean | - | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 874 | 72910483/psa/0.9 |
| psa-c03 | clean | - | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 1030 | 109876543/psa/0.9 |
| psa-c04 | clean | - | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 865 | 00573921/psa/0.9 |
| psa-c05 | clean | - | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 771 | 056734128/psa/0.9 |
| psa-c06 | clean | - | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 721 | 30561247/psa/0.9 |
| psa-c07 | clean | - | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 742 | 5123478/psa/0.9 |
| psa-c08 | clean | - | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 633 | 61834502/psa/1 |
| cgcc-c09 | clean | - | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 804 | 3984561002/cgc-comics/0.95 |
| cgcc-c10 | clean | - | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 1035 | 4087123006/cgc-comics/0.95 |
| cgcc-c11 | clean | - | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 883 | 4102938015/cgc-comics/0.95 |
| cgcc-c12 | clean | - | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 975 | 3765432011/cgc-comics/0.95 |
| cgcc-c13 | clean | - | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 315 | 4155667002/cgc-comics/0.95 |
| cgcd-c14 | clean | - | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 899 | 1402345678901/cgc-cards/0.9 |
| cgcd-c15 | clean | - | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 816 | 1403987650123/cgc-cards/0.9 |
| cgcd-c16 | clean | - | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 723 | 3901234567/cgc-cards/0.95 |
| cgcd-c17 | clean | - | auto-open cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | cgccards.com/certlookup/2938475610/ | 784 | 2938475610/cgc-cards/0.95 |
| cgcd-c18 | clean | - | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 761 | 1405551234567/cgc-cards/0.9 |
| neg-c19 | negative | - | confirm - 6012349870 | confirm | 6012349870 | - | - | 638 | 6012349870/?/0.45 |
| neg-c20 | negative | - | none - - | none | - | - | - | 892 | - |
| psa-b01 | degraded | busy-art | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1182 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 |
| cgcc-b02 | degraded | busy-art | auto-open cgc-comics 4011223004 | auto-open | 4011223004 | cgc-comics | cgccomics.com/certlookup/4011223004/ | 1011 | 4011223004/cgc-comics/0.95 |
| cgcd-b03 | degraded | busy-art | auto-open cgc-cards 1404440987654 | auto-open | 1404440987654 | cgc-cards | cgccards.com/certlookup/1404440987654/ | 1144 | 1404440987654/cgc-cards/0.9 |
| psa-b04 | degraded | busy-art | confirm psa 81726354 | auto-open | 81726354 | psa | psacard.com/cert/81726354 | 917 | 81726354/psa/0.9 |
| psa-c01-jpeg40 | degraded | jpeg-q40 | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 855 | 04718263/psa/0.9 |
| psa-c03-jpeg40 | degraded | jpeg-q40 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 829 | 109876543/psa/0.9 |
| cgcc-c09-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 948 | 3984561002/cgc-comics/0.95 |
| cgcd-c14-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 828 | 1402345678901/cgc-cards/0.9 |
| cgcd-c16-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 776 | 3901234567/cgc-cards/0.95 |
| psa-c08-jpeg40 | degraded | jpeg-q40 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 611 | 61834502/psa/1 |
| cgcc-c13-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 265 | 4155667002/cgc-comics/0.95 |
| psa-c02-half | degraded | scale-0.5 | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 498 | 72910483/psa/0.9 |
| psa-c04-half | degraded | scale-0.5 | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 485 | 00573921/psa/0.9 |
| cgcc-c10-half | degraded | scale-0.5 | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 612 | 4087123006/cgc-comics/0.8 |
| cgcd-c15-half | degraded | scale-0.5 | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 495 | 1403987650123/cgc-cards/0.9 |
| psa-c08-half | degraded | scale-0.5 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 388 | 61834502/psa/0.9 |
| psa-c01-blur1 | degraded | blur-1px | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 779 | 04718263/psa/0.9 |
| cgcc-c11-blur1 | degraded | blur-1px | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 861 | 4102938015/cgc-comics/0.95 |
| cgcd-c14-blur1 | degraded | blur-1px | auto-open cgc-cards 1402345678901 | confirm | 1402345678901 | cgc-cards | - | 618 | 1402345678901/cgc-cards/0.7 |
| psa-c03-blur2 | degraded | blur-2px | auto-open psa 109876543 | confirm | 100876043 (miss) | psa | - | 915 | 100876043/psa/0.53 10987654/psa/0.35 |
| cgcc-c09-blur2 | degraded | blur-2px | auto-open cgc-comics 3984561002 | none | - (miss) | - | - | 1254 | - |
| cgcd-c17-blur2 | degraded | blur-2px | auto-open cgc-cards 2938475610 | none | - (miss) | - | - | 1096 | - |
| psa-c02-glare | degraded | glare | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 783 | 72910483/psa/0.9 |
| psa-c06-glare | degraded | glare | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 696 | 30561247/psa/0.9 |
| cgcc-c10-glare | degraded | glare | auto-open cgc-comics 4087123006 | confirm | 4087123006 | - | - | 700 | 4087123006/?/0.45 |
| cgcd-c14-glare | degraded | glare | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 978 | 1402345678901/cgc-cards/0.9 |
| psa-c03-rot-3 | degraded | rotate:-3 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 854 | 109876543/psa/0.9 |
| cgcc-c09-rot5 | degraded | rotate:5 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 897 | 3984561002/cgc-comics/0.85 |
| cgcd-c16-rot-6 | degraded | rotate:-6 | auto-open cgc-cards 3901234567 | none | - (miss) | - | - | 1377 | - |
| psa-c07-rot2 | degraded | rotate:2 | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 816 | 5123478/psa/0.9 |
| psa-c04-dark | degraded | dark-low-contrast | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 2045 | 00573921/psa/0.9 |
| cgcc-c12-dark | degraded | dark-low-contrast | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 1199 | 3765432011/cgc-comics/0.94 |
| cgcd-c18-dark | degraded | dark-low-contrast | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 3285 | 1405551234567/cgc-cards/0.9 |
| psa-c05-dark | degraded | dark-low-contrast | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 5522 | 056734128/psa/0.9 |
| psa-b01-jpeg40 | degraded | busy-art, jpeg-q40 | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1160 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 |
| cgcd-c14-rot-4-jpeg60 | degraded | rotate:-4, jpeg-q60 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 834 | 1402345678901/cgc-cards/0.9 |
| neg-c20-jpeg40 | negative | jpeg-q40 | none - - | none | - | - | - | 826 | - |

## 7. Defects and observations

**No defects.** Nothing failed in the final run against `03d9589`.
- The only red results were the two pre-A9 assertions (§3), which are test-side and now updated.
- One QA harness slip during development: P9's diagnostic re-scan ran while the opened cert tab was active, so capture correctly refused (SEC-08). The test now re-activates the source tab first.

| ID | Type | Observation | Repro / evidence | Suggested owner |
|---|---|---|---|---|
| O1 | Accuracy risk (R2) | 2 px blur: `psa-c03-blur2` shows confirm with the **wrong** number `100876043` at 0.53, PSA pre-selected. Not auto-opened. | Bench row; upload `tests/fixtures/bench/psa-c03-blur2.jpg` | FE/UX: don't pre-fill below about 0.6 |
| O2 | Accuracy | 2 px blur on 10-digit labels and −6° rotation give no candidate | `cgcc-c09-blur2`, `cgcd-c17-blur2`, `cgcd-c16-rot-6` | FE (OCR tuning) |
| O3 | Performance | Dark/low-contrast scans are slow: `psa-c05-dark` 5.5 s, `cgcd-c18-dark` 3.3 s (warm). In page scans, a non-slab photo costs about 2.5 s (8 OCR calls) of the 30 s budget. | Bench rows; §5 img 5 | FE (stop OCR passes earlier) |
| O4 | Contract note | `setting-autoOpen` is inverted (`data-inverted="true"`); ADR §13 doesn't say so | `src/sidepanel/sidepanel.html` | Architect |
| O5 | Works as designed | Busy-art digits stay below the 0.50 competitor threshold | Bench `psa-b01` | – |
| O6 | Static checker | Vendor false positives; CSP blocks the Babel `Function` fallbacks; the run logged no CSP violation | §3 | Release manager |
| O7 | Console noise | Expected `403` from hotlink CDNs (J7, P9) in the panel console | P11 log | – |
| **O8** | Page-scan UX / R2 (new) | A non-slab image with printed numbers (seller ID `48213576`) yields a **PSA row at 0.70 with an Open button** (plus a "Not a clear read" note). Being ≥ 0.50, it also **blocks the slab's auto-open** on the same page (results list instead). This follows the A9 rules (never auto-opened), but on real listings with item-specifics images the user gets a list and a plausible wrong PSA link. | P3; `listing.html?details=1` and `?slab=0&details=1`; confidences in §5 | Architect/FE: in page mode, consider dropping or demoting candidates from images without slab vocabulary when another image has a confident slab read, or hiding Open for them |
| **O9** | Hardening (new, low) | Auto-open de-dup (`autoOpened`) and intake `seen` live in panel memory. After a **panel reload**, re-writing an already consumed job id within the 120 s TTL runs it again and opens a **second tab**. Real triggers can't do this (fresh UUID per trigger, slot cleared on consumption), so this is not a defect. It is the same for image jobs. | Scratch probe (not in the suite): listing page job → auto-open; reload panel; same id re-written → `["scanning","auto-open"]`, 2 tabs | FE (optional): keep consumed ids in `storage.session` |
| **O10** | Page-scan UX (new) | When more than 8 slab-sized photos exist, the list doesn't say that some were not checked (the gallery: 10 found, 8 checked, "Found: 6"). It mentions "checked N of M" only for the 30 s timeout. The page "none" copy says "Checked the photos on this page…" even when some were skipped. | P1/P1b (discovered 10, scanned 8); `pageView.pageSummary` | UX/FE: add "Checked 8 of 10 photos" |
| **O11** | Copy (new, low) | A toolbar/shortcut page job whose grant is gone by scan time (e.g. the tab navigated cross-origin right after the click) shows E1 "Chrome doesn't allow reading this page". The page itself may be readable. | P13 first step: page job on an https page without a grant → `error/restricted` | UX: consider the page-access copy for `injectFailed` on non-restricted URLs |
| **O12** | Release-checklist conflict (new) | The "Always allow on ‹host›" offer is practically unreachable. The panel only knows a host from an earlier job and drops it on any navigation it can't see. Release checklist **PS4 expects the offer after moving the tab to a different site; it will not appear.** This confirms FE's "rare" note. | P13 second step: after a cross-origin https navigation → page-access, offer hidden | Architect (e.g. `chrome.permissions.addHostAccessRequest`, Chrome 133+, or drop the offer); release manager: PS4 rewritten in §9 |

## 8. Assumptions and limitations (what automation does not prove)

**Simulated by the harness:**
- **Triggers.** Real toolbar clicks, Alt+Shift+S, right-clicks, the activeTab grant and the `sidePanel.open` gesture are not automatable. Jobs are written from the extension's own service worker in the shipped shapes. The panel runs as the `?w=` popup-window fallback. The panel's own "Scan this page" button is a real click.
- **Host access.** dist-e2e holds `<all_urls>`, so extension-fetch succeeds for every page image. Under a real activeTab grant, the release build fetches only same-origin images. Cross-origin CDN images go through page-fetch (page CORS) or the crop fallback. P9 forces the crop path with a hotlink CDN. Release-build page scans with a real grant are manual (PS1, PS9, PS11).
- **Permission prompt.** Stubbed in J7b, SEC-06 and P13 (panel realm only). Real grant, deny and revoke are M5/PS4.

**DPR-1 capture limit (honest):**
- Headless runs at device scale factor 1. Every capture crop is at CSS-pixel resolution: P9's 400 px and 270 px crops; J7 and SEC-06 used 400 px and 110 px.
- The synthetic labels read correctly at 270 px. Real photos with smaller label text, JPEG artefacts or perspective will fail sooner at DPR 1, ending in `none`/unclear rather than a wrong number, as far as tested.
- HiDPI screens (DPR 2) give 2× pixels and should do better. That was **not** measured (PS11).
- The screenshots in `docs/quality/screenshots/` are FE captures (DPR 1, 360 px). QA did not re-capture them.

**Not tested here:**
- Branded Chrome; Chrome 116.
- Screen readers, zoom and contrast beyond FE's scripted self-check.
- Incognito at runtime; extension update/reload.
- User-restricted sites; real marketplace CDNs; live grader pages (DNS-blocked by design).
- By A9 design, page mode does not cover CSS background images, cross-origin iframes or lazy images below the fold. P1 confirms the lazy image is skipped.

**Fixtures and logs:**
- The benchmark and the listing are synthetic (Liberation Sans, abstract art); this is not real-world accuracy.
- NetLog also records Chromium background services (`clients2.google.com`, `accounts.google.com`, `redirector.gvt1.com`, `www.google.com`, `android.clients.google.com`). They are non-renderer and not from the extension, and all were DNS-blocked.

## 9. Manual checks — **not run** (need branded Chrome and a person)

**Setup:**
1. Run `npm ci && npm run build` on the release commit, or unzip the release ZIP into an empty folder.
2. In `chrome://extensions`: turn on Developer mode, then **Load unpacked** → `dist/`. Pin CertScanner.
3. Serve the fixtures: `cd tests/fixtures && python3 -m http.server 8000`. The pages are `http://localhost:8000/pages/gallery.html` and `http://localhost:8000/pages/listing.html` (variants: `?details=1`, `?slab=0`, `?photos=0`).
4. Record the Chrome version, OS, the screen's DPR (`devicePixelRatio`), `dist/build-info.json` `gitCommit`, the date, and a screenshot of each failing step.

**M1–M11 (image journeys).** The detailed steps are unchanged from the 2026-10-09 report and repeated here in short form.

| ID | Steps | Pass when |
|---|---|---|
| M1 | Right-click `#img-psa-leading-zero` on the gallery → "Scan slab cert number". Do it with the panel closed, then with it open. | The panel opens at once; `psacard.com/cert/01234567` opens next to the gallery; no prompt |
| M2 | Right-click scan the PSA image, then within 1 s `#img-rotated` | Only `cgccomics.com/certlookup/4012345001/` opens |
| M3 | Stop the worker in `chrome://serviceworker-internals`, then right-click scan `#img-ambiguous` | The panel opens; confirm shows `5012345678` with no grader; no error |
| M4 | Right-click a slab photo on a real listing whose image is on a CDN host | Works without a prompt; screen-capture fallback if the CDN refuses; DevTools shows only the image host and the official page |
| M5 | Sharper scans on a real https CDN: Deny → Allow → Rescan → Settings Remove | The prompt names only that host; each step as described; at most one tab per scan |
| M6 | On `chrome://version` and a Web Store item: right-click, use the icon, then upload `tests/fixtures/psa-9digit.png` | "Chrome doesn't allow reading this page"; upload works; no uncaught errors |
| M7 | Gallery in windows A and B, each with a panel; scan in A | Only A reacts; the tab opens in A |
| M8 | Dutch UI (`LANGUAGE=nl` on Linux), screen reader (NVDA/VoiceOver/ChromeVox), keyboard only, 200% zoom | All strings Dutch and untruncated; one announcement per result; logical focus; errors read out; no horizontal scrolling |
| M9 | Chrome for Testing 116, fresh profile: M1, M5-deny, an upload, **PS1** | No console errors |
| M10 | Open each builder URL for a real public cert number | The right record; PSA leading zero kept (closes R1) |
| M11 | `chrome://extensions` Details; an incognito window | No "Allow in Incognito"; no menu item, icon action or panel in incognito; no history entry |

**PS1–PS12 (A9 page scan).** These replace PS1–PS10 in `docs/release/manual-test-checklist.md`; PS4 is rewritten because of O12.

| ID | Steps | Pass when |
|---|---|---|
| PS1 | On `gallery.html`, with the panel closed, click the CertScanner icon. Repeat with the panel open. | The panel opens immediately: "Looking for slab photos…", then "Scanning image N of 8", then "Cert numbers on this page" with about 6 rows (thumbnail, number, grader, exact path). No prompt, no page scrolling, no tab. |
| PS2 | Press **Alt+Shift+S** (macOS Option+Shift+S). Change the shortcut in `chrome://extensions/shortcuts` and use it. Then clear it and reopen the panel. | Same as PS1 each time. Settings shows the current shortcut. With none set, the idle hint says to click the icon. |
| PS3 | Click the icon on `listing.html`. Repeat with Settings → "Always ask before opening" on. | First run: exactly one tab `psacard.com/cert/108114622` next to the listing; Recent +1. Second run: a one-row list, no tab. |
| PS4 | (a) On a real https site where CertScanner has no access, click the panel's **Scan this page** without using the icon. (b) Click the icon on that site, then navigate the same tab to a *different* https site and click **Scan this page**. | (a) and (b) both show "CertScanner can't read this page yet" with the icon/shortcut copy. Expect **no** "Always allow" offer (O12); if one appears, record it. If an offer is shown: Allow → the prompt names only that host → the scan runs → Settings lists the host → Remove revokes it. |
| PS5 | Settings → turn off "Toolbar button scans the page"; click the icon; restart Chrome; click again; turn it back on. | Off: the icon only opens the panel (tooltip "Open CertScanner"), also after the restart. On: the icon scans (tooltip "Scan this page for slab cert numbers"). |
| PS6 | Click the icon on `chrome://version` and on a Web Store item. | "Chrome doesn't allow reading this page"; upload works; no uncaught errors in the panel or worker console |
| PS7 | Click the icon on `listing.html?photos=0` and on a plain text article. | "No cert numbers found on this page" with 3 tips; no tab; nothing in Recent |
| PS8 | On a long real page with many large photos, click the icon; on a second run press **Cancel** during "Scanning image 2". | At most 8 photos, visible first, done within about 30 s. Cancel returns to idle within 1 s and nothing opens later. |
| PS9 | Panel DevTools → Network while doing PS1 on a real marketplace listing. | Only the page's image hosts and the opened official page; no other host, CDN or analytics |
| PS10 | Gallery in windows A and B, each with a panel; click the icon in A. | Only A scans; B unchanged |
| PS11 (new) | On a real listing whose photos come from a CDN that refuses extension fetches, run PS1 at 100% zoom on a DPR 1 monitor, then on a HiDPI/Retina screen (DPR 2). | Numbers are read from the screen capture or skipped, never wrong. Record found/not found per DPR (§8 DPR-1 limit). |
| PS12 (new) | Stop the worker (`chrome://serviceworker-internals` → Stop, or 30 s idle with DevTools closed), then click the icon and press the shortcut. | The panel opens and scans each time (`action.onClicked` / `commands.onCommand` are registered at top level); no error |

## 10. Files (QA-owned) and next owners

**Changed or added (uncommitted, for the orchestrator to commit):**

| File | Change |
|---|---|
| `tests/e2e/pagescan.test.mjs` (new) | A9 cases P1–P14 (§4.1) |
| `tests/e2e/extension.test.mjs` | A9 toolbar-behaviour assertions; setting toggle test; A9 test ids; SW restart restores the behaviour |
| `tests/e2e/privacy.test.mjs` | Page scan on dist-e2e; page-access on the release build; NetLog extension-initiator check |
| `tests/e2e/fixtures.test.mjs` | Listing integrity |
| `tests/e2e/lib/env.mjs` | `page-results` terminal state; `writePageJob()` (createPageJob shape); `launchExtension({env})` for the locale run |
| `tests/e2e/lib/panel.mjs` | `readPage()`: page-scan view through test ids and data attributes |
| `scripts/gen-fixtures.mjs` | Generates and verifies `pages/listing.html` and `pages/assets/listing-{logo,avatar,banner,details}.png`; manifest `pages[]` entry and `pageAssets` |
| `tests/fixtures/pages/listing.html`, `tests/fixtures/pages/assets/*.png` (new) | Generated, byte-stable |
| `tests/fixtures/manifest.json` | Regenerated; additive only |
| `docs/quality/test-report.md` | This report |

**Next owners:**
- Architect: O8, O12 (Always-allow reachability), O4.
- FE: O1–O3, O9 (optional), O10 (with UX).
- UX: O10, O11.
- Release manager: replace PS1–PS10 with §9 PS1–PS12 (PS4 rewritten); O6 wording.
- User + QA: M1–M11 and PS1–PS12 in branded Chrome before release.
