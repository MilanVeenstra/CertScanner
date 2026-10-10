# Frontend handoff — slices S1–S5 (+ minimal side panel)

_Role: frontend-engineer (native specialist agent) · Date: 2026-10-09 · Saved by orchestrator from the agent's final report._
_Build identity: HEAD `7c960b8` + the uncommitted S1–S5 tree (committed by the orchestrator right after this report). Chromium 141.0.7390.37 headless, Playwright 1.56.1, Node 22.22.0. Vendor sha256 values in `dist/build-info.json`._

## Changed files

- **New:** `scripts/build.mjs`; `src/` (manifest, `_locales/en|nl`, placeholder icons, `background/sw.js`, `core/*`, `shared/*`, `pipeline/*`, `sidepanel/*`); 9 test files + helper in `tests/unit/`.
- **Modified:** `package.json` (scripts only; pins and lockfile unchanged), `.gitignore` (`dist-e2e/`).

## Commands and observed results

| Command | Result |
|---|---|
| `npm test` | 91/91 pass (tests were red before code; loosening the auto-open gate made 2 fail → regression-sensitive). Orchestrator re-ran: 91/91 pass. |
| `npm run build` | `dist/` 47 files, 6.93 MiB; no `host_permissions`; vendor files + licences + notices copied. |
| `npm run check` | All checks pass (manifest, no e2e harness, vendor hashes, src URL allow-list, no innerHTML/eval/remote/inline scripts, path overrides, syntax, locale parity). A deliberately bad file was rejected with 3 FAILs. Orchestrator re-ran: all pass. |
| `npm run build:e2e` | `dist-e2e/` with `host_permissions: ["<all_urls>"]` (no harness yet). |

## Fixture results (`dist/`, upload input via `setInputFiles`, grader hosts blocked)

Warm `scan()` timings in the same panel.

| Fixture | Expected | Observed | Confidence / source | Opened | Total ms |
|---|---|---|---|---|---|
| psa-8digit-leading-zero | auto-open psa 01234567 | auto-open psa 01234567 | 0.90 ocr | psacard.com/cert/01234567 | 743 |
| psa-9digit | auto-open psa 108114622 | same | 0.90 ocr | psacard.com/cert/108114622 | 824 |
| psa-back-barcode | auto-open/confirm psa 81234567 | auto-open | 1.00 barcode | psacard.com/cert/81234567 | 514 |
| cgc-comic-10digit | auto-open cgc-comics 4012345001 | same | 0.95 ocr | cgccomics.com/certlookup/4012345001/ | 782 |
| cgc-comic-dash | auto-open cgc-comics 4012346002 | same | 0.95 ocr | cgccomics.com/certlookup/4012346002/ | 752 |
| cgc-comic-qr | auto-open cgc-comics 4012347003 | same, OCR skipped | 0.95 qr-url | cgccomics.com/certlookup/4012347003/ | 747 |
| cgc-card-13digit | auto-open cgc-cards 1401036622258 | same | 0.90 ocr | cgccards.com/certlookup/1401036622258/ | 2227 |
| qr-foreign-host | none | **confirm**, psa 12345678, off-site QR warning | 0.35 barcode | nothing | 2340 |
| ambiguous-10digit | confirm, no grader, 5012345678 | same | 0.45 ocr | nothing | 1058 |
| non-slab | none | none | – | nothing | 2926 (8 OCR calls) |
| psa-lowres.jpg | confirm/auto-open psa 01234567 | auto-open + low-resolution warning | 0.90 ocr | psacard.com/cert/01234567 | 423 |
| cgc-comic-rotated | auto-open/confirm cgc-comics 4012345001 | auto-open | 0.95 ocr | cgccomics.com/certlookup/4012345001/ | 2194 |

- Cold start (first scan in a fresh panel): 1,412 ms total; OCR engine start 528 ms (overlapping image load).
- 120 degraded variants (0.5×/0.35×, JPEG q0.4, blur 1–2 px, rotation −3°/6°, glare, dark): **zero wrong auto-opens**; misreads ended in confirm.
- No request left the extension or the local server; no panel errors.

## Context-menu style jobs (`dist-e2e/`, local HTTP server, `scanJob:<w>` written from the SW)

- Same-origin image → auto-open psa 01234567; tab opened at index 1 with the source tab as opener; job removed from session storage.
- srcset, `data:`, `blob:` (via page-fetch) and same-origin iframe images read correctly.
- Ambiguous → confirm; foreign QR → confirm + warning; nothing opened.
- `chrome://version` → restricted error, no uncaught errors.
- Two quick jobs → first cancelled, only the second opened; panel reload did not re-run a job.
- page-fetch on srcset fetched the largest candidate (544×850).
- Capture fallback returns correctly cropped screen-resolution images (e.g. 270×422); at 1× DPR on ~270 px images OCR alternates confirm/none, never a wrong number. Probe now waits for lazy images to decode before capture.

## Panel checks

All §13 test ids present; polite status announcements; keyboard-only manual entry; `aria-invalid` errors; settings persist in sync; history-off asks then deletes; upload works offline; bad file shows an error; Cancel works; context menu and toolbar → panel registered.

## Orchestrator decisions on the agent's open questions (2026-10-09)

1. **qr-foreign-host:** accept `confirm` (with the off-site warning, number capped, nothing auto-opened, URL always rebuilt by `buildCertUrl`). QA updates the fixture's accepted statuses; `mustNotOpen` for the foreign URL stays a hard check.
2. **Locale keys (A3):** rename to the UX spec keys during S6.
3. **A4 done;** A5 (Try again, `lastResult:<windowId>` restore) in S6.
4. **Contract additions approved** as ADR amendment A6: OCR pages carry `pass`, `rotation`, per-word `lineId`; `analyze()` exported; `ScanResult.error.canRequestSharper`; `scan()` options `onImage`, `engines`, `acquire` as function or `{strategies}`; evidence code `qr-untrusted:<host>`; `invalid-image` ranked after `too-large`; `body[data-ready]`, `body[data-window-id]` for test sync.
5. **To fix in S6:** unsupported image-URL schemes must not show the "too large" message (use `not-found`/`invalid-image` copy); "Clear history" must not be a disabled button (UX6).

## Notes for QA e2e

- `context.route` does not intercept tabs created by `chrome.tabs.create`; block grader hosts with `--host-resolver-rules=MAP *.psacard.com ~NOTFOUND, …` and read opened URLs via `chrome.tabs.query` from the SW (works in `dist-e2e`).
- Capture tests: use `viewport: null` with `--window-size=1280,1000` (Playwright viewport emulation breaks capture geometry).
- `chrome.*` APIs are not ready the instant the `serviceworker` event fires; poll for `chrome.windows` first.
- `npm run e2e` runs `tests/e2e/**/*.test.mjs`.

## Known gaps

- Panel is functional but minimal (no task-card sub-states, stepper, grader radios, settings sub-view, Edit, URL preview, Retry, last-result restore).
- Page probe does not search shadow DOM or CSS background images.
- Not automatable headless: real right-click, activeTab grant, `sidePanel.open`, permission prompt, clipboard → manual checks M1–M8.
- Dutch checked for key parity only.

---

## S6 — side-panel UI per UX spec + security fixes (frontend-engineer, 2026-10-09)

**Source identity:** HEAD `837e84d` + uncommitted working tree (not committed by FE). **Build:** `dist/manifest.json` sha256 prefix `1e37125fce76ee61`; `build-info.gitDirty: true`. **Browser:** bundled Chromium 141.0.7390.37 headless, Playwright 1.56.1, Node 22.22.0.

### Commands and observed results

| Command | Result |
|---|---|
| `npm test` | 127 tests, 127 pass, 0 fail (new: `viewModel`, `lastResult`, `security` suites; failing first, then implemented) |
| `npm run check` | all checks pass (incl. `incognito: not_allowed`, 11 licence files, per-locale description ≤ 132, snake_case keys, placeholder parity, no authenticity wording outside `verify_note`/`about_lookup`) |
| `npm run package` | refuses: `gitDirty=true (commit first, or pass --allow-dirty …)` |
| `SOURCE_DATE_EPOCH=1760000000 npm run package -- --allow-dirty` | `certscanner-0.1.0.zip`, 60 files, 4.42 MiB, manifest re-validated inside the ZIP; same sha256 on two consecutive runs; Python `zipfile.testzip()` OK; all timestamps 1980-01-01 |
| 12-fixture run (`dist/`, upload input) | **12/12 pass, 0 wrong auto-opens**, no requests leave the extension |
| QA `npm run e2e` (run only, not edited) | 24/29 pass; the 5 failures are on the QA side (see below) |

### Fixture results (S6 build, warm `scan()`)

| Fixture | Expected | Observed | Conf / source | Opened | ms |
|---|---|---|---|---|---|
| psa-8digit-leading-zero | auto-open psa 01234567 | same | 0.90 ocr | psacard.com/cert/01234567 | 765 |
| psa-9digit | auto-open psa 108114622 | same | 0.90 ocr | psacard.com/cert/108114622 | 738 |
| psa-back-barcode | auto-open/confirm psa 81234567 | auto-open | 1.00 barcode | psacard.com/cert/81234567 | 493 |
| cgc-comic-10digit | auto-open cgc-comics 4012345001 | same | 0.95 ocr | cgccomics.com/certlookup/4012345001/ | 830 |
| cgc-comic-dash | auto-open cgc-comics 4012346002 | same | 0.95 ocr | cgccomics.com/certlookup/4012346002/ | 781 |
| cgc-comic-qr | auto-open cgc-comics 4012347003 | same, OCR skipped | 0.95 qr-url | cgccomics.com/certlookup/4012347003/ | 181 |
| cgc-card-13digit | auto-open cgc-cards 1401036622258 | same | 0.90 ocr | cgccards.com/certlookup/1401036622258/ | 729 |
| qr-foreign-host | confirm/none | confirm psa 12345678 + off-site QR warning | 0.35 barcode | nothing | 1335 |
| ambiguous-10digit | confirm, no grader | same | 0.45 ocr | nothing | 1067 |
| non-slab | none | none | – | nothing | 4004 |
| psa-lowres.jpg | confirm/auto-open psa 01234567 | auto-open | 0.90 ocr | psacard.com/cert/01234567 | 465 |
| cgc-comic-rotated | auto-open/confirm cgc-comics 4012345001 | auto-open | 0.95 ocr | cgccomics.com/certlookup/4012345001/ | 776 |

Cold first scan: 1,423 ms total (engine init 506 ms).

### Security items

| ID | Status | Change | Verified by |
|---|---|---|---|
| SEC-01 | fixed | `"incognito": "not_allowed"`; `--check` requires it | check PASS line; QA e2e asserts `isAllowedIncognitoAccess() === false` (passes) |
| SEC-02 | fixed | nl `ext_description` = 128 chars (spec copy); check covers every `_locales/*` | `npm run check` |
| SEC-03 | fixed | `src/shared/raceAbort.js`, used around `executeScript`, `captureVisibleTab`, `tabs.get`, the acquire/barcode/OCR/preprocess calls in `scanner.js`; abort re-checked after the strategy loop; probe rAF wait has a 300 ms `setTimeout` fallback | unit `raceAbort …` ×4 (`security.test.mjs`); QA e2e "SEC-03 hostile busy page / SEC-04 decode bomb" passes |
| SEC-04 | fixed | `sniffDimensions` reads BMP (core + info, abs height), WebP VP8/VP8L/VP8X, ICO/CUR (directory + embedded PNG), AVIF/HEIF `ispe`; `dimensionPolicy` refuses formats other than PNG/JPEG/GIF/WebP when dimensions are unreadable and the file is > 256 KB (`invalid-image`) | unit `BMP: …`, `WebP: …`, `ICO: …`, `AVIF/HEIF: …`, `dimensionPolicy: …`; QA e2e decode bomb passes |
| SEC-05 | orchestrator | not touched by FE (`third_party/licenses/`, build edits kept intact) | check: 11 licences present |
| SEC-06 | fixed | auto-open de-dup key = `job:<job.id>` (`scan:<id>` for blobs) via `autoOpenKey()` | unit `autoOpenKey …` |
| SEC-08 | fixed | after `captureVisibleTab`, the tab must still be active, in the same window, with the same origin; else `tab-changed` | capture runs on dist-e2e still return full crops (270×422, 300×461) |
| SEC-09 | fixed (A7) | `ScanJob` has no `frameUrl`; `pageUrl` = origin + path (`minimizePageUrl`); parse accepts and drops a legacy `frameUrl` | unit `createScanJob maps … (A7 …)`, `pageUrl minimisation …`, `parseScanJob accepts older jobs with frameUrl …` |
| SEC-11 | fixed | `listGrantedSites()` → `{hosts, allSites}`; Settings shows an "All sites" row with Remove (new key `settings_sites_all`) | unit `listGrantedSites reports wildcard grants …` |
| SEC-12 | fixed | `npm run package` = `build.mjs --package [--allow-dirty]`: build + full check, release-only, dirty refused, deterministic ZIP of `dist/` only, manifest re-validated inside the ZIP, sha256 printed | see commands table |

Also fixed: an image URL with an unsupported scheme now shows "Couldn't open this image" (E7) instead of "too large". This adds an optional `ScanJob.srcIssue` field (`too-long` / `unsupported`).

### UI per spec

| Spec item | Implemented |
|---|---|
| §2.3 layout | header (logo, h1, Settings), `#status` outside the mains, `main#home` (task, image input, manual entry, recent), `main#settings`, footer disclaimer |
| §3 states | `section#task[data-state]` = idle/scanning/result/edit/confirm/none/error; `body[data-state]` keeps the §13 values + `opened` |
| UX3 | number, method and exact path (e.g. `psacard.com/cert/01234567`) shown in S2; S3 shows number, method and a live URL preview |
| UX4 | verify note in S2; About lookup note; neutral chips; icon has no check mark or logo |
| UX5 / N1 | offer only in S3/S4 for https screen captures; offer → granted (Scan again) / denied / failed / Not now; host remembered in `storage.session` |
| UX6 | no disabled buttons; Clear history uses `aria-disabled` plus "No saved scans." and keeps focus |
| UX7 / §4 | segmented radios; typed prefix > radio > inference; a conflicting radio click strips the prefix; `warn_length` after 600 ms; errors in persistent live regions; success clears the field and keeps focus in it |
| S2e / J12 | Edit pre-fills and selects; Esc/Cancel returns focus to Edit; "Corrected by you"; latest history entry replaced (`replaceLatest`) |
| A5 | Try again re-runs the in-memory job if the tab is the same with the same origin, else E1; `lastResult:<windowId>` restored on reopen with no image (`body[data-restored="true"]`) |
| F1–F5 | heading focus on every state change; `#status` used when the panel is unfocused or the user is typing; `aria-busy` while scanning |
| §7–§9 | spec tokens verbatim, light/dark, 2 px focus ring, reduced motion (static ◐), forced colours, logical properties, reflow below 280/200 px |
| §11 icon | `src/icons/icon.svg` (128 master), `icon-32.svg`, `icon-16.svg` → 16/32/48/128 PNG (48 = master without "#" and second label mark) |
| A3 copy | 155 spec keys verbatim (en/nl) + `ocr_unavailable_note`, `settings_sites_all`; limits 15 MB / 25 entries / 7–13 digits |

### Test ids (for QA)

| Id | Element now |
|---|---|
| `grader-select` | task-card radio `fieldset` (`input[type=radio][value]`), `data-value` mirrors the selection; in S2 it mirrors the opened grader |
| `progress` | step list `<ol>` |
| `preview` | thumbnail `<img>` |
| `setting-autoOpen` | "Always ask before opening" switch, `data-inverted="true"` (checked = `autoOpen:false`); QA helper already handles this |
| all §13 ids | singletons: present and unique at all times (parked in a hidden `#parking` and cleared when not in use) |
| added | `settings-button`, `back-button`, `open-again-button`, `edit-button`, `edit-cancel`, `retry-button`, `rescan-button`, `result-url`, `manual-grader` |

### Screenshots (actual extension captures)

From `dist/` (manifest sha256 prefix `1e37125fce76ee61`, HEAD `837e84d` + dirty tree), Chromium 141.0.7390.37 headless, Linux, 2026-10-09. Width 360 px unless noted. Saved in `docs/quality/screenshots/`.

| File | State / fixture |
|---|---|
| `s0-idle-{light,dark}.png` | S0, fresh profile |
| `s1-scanning-{light,dark}.png` | S1, psa-8digit-leading-zero.png (CPU throttled 6× so the capture lands mid-scan) |
| `s2-result-{light,dark}.png` | S2 after auto-open, psa-8digit-leading-zero.png |
| `s3-confirm-{light,dark}.png` | S3, ambiguous-10digit.png (fits both CGC) |
| `s3-confirm-offsite-qr-{light,dark}.png` | S3 + N2 warning, qr-foreign-host.png |
| `s4-none-{light,dark}.png` | S4, non-slab.png |
| `s5-error-restricted-{light,dark}.png` | S5/E1, job with `pageUrl` `chrome://version/` |
| `v2-settings-{light,dark}.png` | V2, history on (1 entry) |
| `s0-idle-light-320px-zoom200.png`, `s3-confirm-light-320px-zoom200.png` | 160 CSS px (= 320 px at 200 %), DPR 2 |

**Accessibility self-check** (scripted, offline; axe-core not installed): every state (S0–S5, S3+N2, V2, light/dark, and 160 CSS px) had **0 issues**. Checked: accessible names, duplicate ids and test ids, image alt, one h1 and no skipped heading levels, landmarks, `#status`, 24 px targets, horizontal overflow.

**Focus after each state change:**
- Panel load: no focus move.
- S1–S5: `#task-heading`.
- S2e: number field, all text selected.
- Settings: `#settings-heading`; Esc returns focus to the Settings button.

**Tab order:**
- S0: header → Settings → Choose image → manual field → radios → Open → recent.
- S3: Show larger → number → radios → Open → Copy → Choose image → manual.

### QA e2e failures (QA-owned, not edited)

| Test | Cause |
|---|---|
| two J11 privacy tests | assertion expects `NAME_NOT_RESOLVED`; Chrome reports `ERR_NAME_NOT_RESOLVED` |
| service worker stopped | harness times out waiting for the `serviceworker` event; the following history test then hits a destroyed context |
| SEC-06 Sharper re-run | precondition expects the Sharper offer after an `auto-open`; spec UX5/R-10 forbids the offer in S2 (the de-dup key is unit-tested) |

### Deviations and decisions to confirm

| Item | Note |
|---|---|
| History `pageHost` | always stored as `null` (spec R-09: grader, number, method, time only); the ADR §9 schema is unchanged |
| History off | deletes immediately (spec V2), not after a confirmation (ADR §9) |
| `warn_length` | blocks Open, because `buildCertUrl` accepts only lengths valid for the grader (ADR §8) |
| S3 summary row | chip, number and method shown even with one candidate (UX3, keeps `result-number`) |
| Dash form `1234567-001` | infers CGC Comics in manual entry |
| `ScanJob.srcIssue` | new optional additive field (needs an ADR note) |
| Privacy policy link | not rendered: no URL yet (release dependency) |

### Known gaps
- No "two candidates" fixture exists, so the S3 candidate radio group was checked only through the code path and unit logic.
- Not tested: real context-menu click, `sidePanel.open`, the permission prompt, clipboard, Dutch UI, NVDA/VoiceOver.
- Contrast was not measured with a tool (tokens copied verbatim from spec §7).
- Screen-resolution OCR at DPR 1 on ~270 px images is borderline (results alternate between confirm and none, never a wrong number).

---

## S7 page scan (ADR A9) — frontend-engineer, 2026-10-10

**Outcome:** You can now scan the whole page from the toolbar icon, the `Alt+Shift+S` shortcut or the panel's "Scan this page" button. Right-click still scans one photo. Upload, paste and manual entry are now under "Other ways to scan". This includes RM-6 (toolbar tooltip) and RM-7 (sites section). Nothing was committed by FE.

**Source identity:**
- HEAD `33d930f` (orchestrator WIP snapshot of this work) plus an uncommitted tree.
- src-tree sha256 prefix `4db373e4457811db` (`find src -type f | sort | xargs sha256sum | sha256sum`).
- `dist/manifest.json` sha256 prefix `0aec47bb6c9faf3b`; `dist-e2e/manifest.json` sha256 prefix `88fb2414b131391e`.
- `build-info.gitDirty: true`.

**Environment:** bundled Chromium 141.0.7390.37 (headless), Playwright 1.56.1, Node 22.22.0, Linux.

### Changed files

| File | Change |
|---|---|
| `src/sidepanel/main.js` | Page-job intake: kind `page` goes to `startPageScan`. Progress, Cancel, newest-job-wins, one auto-open per job id, history, row thumbnails. Panel button with access check. Page-access state and "Always allow". Retry for page jobs. Shortcut refresh. |
| `src/sidepanel/pageView.js` (new, pure) | `scanShortcut`, `classifyInjectError`, `panelScanPlan`, `alwaysAllowHost`, `accessBody`, `idleShortcutHint`, `pageSummary`, `pageQrInfo`, `pageErrorCode`, `persistablePage`, `pageRowNote` |
| `src/pipeline/pageScan.js` | Test-only `deps` seam. `onImageProgress` drives the per-image step list. When the 30 s budget runs out, returns partial results (`partial:{checked,total}`, never auto-open). `error.injectFailed`. |
| `src/sidepanel/ui.js`, `sidepanel.html`, `sidepanel.css` | Per-image steps. Hint variants. Results rows with an "Opened" mark and row notes (off-site QR / unclear read). Back-to-results link in confirm. Access offer states (offer, denied, failed). Settings shortcut row. E1 "Scan this page" button. |
| `src/sidepanel/viewModel.js` | `autoOpenKey` covers page jobs. New `page-timeout` (E11) error. E1 gets `page` actions and body. |
| `src/sidepanel/jobIntake.js` | A re-delivered job id is also removed from the slot. Before, a panel reload within the TTL re-ran it. |
| `src/shared/lastResult.js` | Accepts the `page-timeout` error code. |
| `src/background/sw.js` | `applyPanelBehavior` also sets the tooltip (RM-6). Runs at worker start, on install/startup and on settings changes. |
| `src/_locales/{en,nl}` | 19 new keys and 7 reworded keys (compared with `bb1666f`), EN and NL (informal "je"). Parity 204/204. Descriptions EN 126 / NL 131 characters (limit 132). |
| `tests/unit/pageScanRun.test.mjs`, `pageView.test.mjs` (new); `jobIntake.test.mjs` (+2 tests) | Orchestration, view logic, intake |

### Commands

| Command | Result |
|---|---|
| `npm test` | 164/164 pass. The `pageScanRun` and `jobIntake` duplicate-id tests were seen failing before the code changes. |
| `npm run check` | all checks pass (src: 37 files) |
| `CERTSCANNER_SKIP_BENCH=1 npm run e2e` (QA suite, run only, not edited) | 31/33 pass. Both failures assert `openPanelOnActionClick === true` (`extension.test.mjs:95`, `:507`). Under A9 the default is now `false`. QA needs to update these. |

### Browser evidence

These are actual extension runs. The toolbar click and the shortcut **cannot be automated**: page jobs were written to `chrome.storage.session` `scanJob:<windowId>` from the service worker, in the same shape as `createPageJob`. The panel ran as the `?w=` popup.

| # | Scenario (build) | Observed | Timing |
|---|---|---|---|
| a | Page job (`action`) on `pages/gallery.html` (dist-e2e) | `page-results`, 6 rows. One row per number below; each row has a thumbnail and the exact URL. The off-site QR warning is shown, and its row says so. No tab opened. `evil.example` never appeared in tabs or network. Job slot cleared. | UI 7.5 s (first scan in the panel) |
| b | Single-slab listing in scratchpad: one 400 px PSA slab, a 48 px logo, a 320 px raw-card photo, text containing digit strings (dist-e2e) | `auto-open` → `https://www.psacard.com/cert/108114622` at source index+1 with the listing tab as opener. History +1. Re-delivering the same job id: no re-scan, still 1 tab. | UI 4.3 s; `scanPage` 2.9 s |
| c | `chrome://version` (dist-e2e and dist) | Panel button: E1 (classified from the injection refusal text) with "Scan this page" and Choose image. Page job with `pageUrl ''` or `chrome://version/`: E1. | <1 s |
| d | Cancel at "Scanning image 2 of 8" | Body `idle`, "Scan cancelled.", focus on `#task-heading`, no tab | settled in 68 ms |
| e1 | Panel button with access (dist-e2e `<all_urls>`) | Scans, `page-results`. Open from a row opens the tab, marks the row "Opened" and keeps the list. "Choose grader" opens confirm; "Back to the results" returns to the list. | 7.4 s |
| e2 | Panel button with no access (release `dist/`, `permissions.getAll().origins = []`) | `#task[data-state=page-access]`, body `idle`, "Click the CertScanner icon in the toolbar, or press Alt+Shift+S…". No offer, because the host is unknown. | – |
| e2' | Known https host (`https://127.0.0.1`, self-signed) | Offer "Always allow on 127.0.0.1" → `permissions.request({origins:['https://127.0.0.1/*']})`. Prompt **stubbed** to deny. Offer withdrawn, note "No access given for 127.0.0.1." and focus on the note. | – |
| f | Page "none" | Photo checked: "Checked the photos on this page but couldn't read a cert number." No slab-sized photo: "No photos large enough…". Shows three tips plus Scan again and Choose image. | 2.6 s / 0.07 s |
| g | Crop fallback: hotlink image (fetch → 403, `<img>` OK) | `method capture`, `resolution screen`, auto-open `psa 108114622` | `scanPage` 1.3 s |

**Gallery rows (a):** cgc-comics 4012345001 · cgc-comics 4012346002 · cgc-comics 4012347003 · psa 01234567 · grader unknown 5012345678 (Choose grader) · psa 12345678 (from the off-site QR, 0.35).

**Gallery per-image timings (warm `scanPage`, 10 images found, 8 scanned):** discovery 3 ms, one viewport capture 125 ms, total 6.3 s.

| img | method | acquire ms | scan ms | candidates |
|---|---|---|---|---|
| 0 qr-foreign | extension-fetch | 14 | 739 | 1 |
| 1 psa | extension-fetch | 14 | 670 | 1 |
| 2 ambiguous | extension-fetch | 13 | 473 | 1 |
| 3 srcset | extension-fetch | 8 | 397 | 1 |
| 4 dash | extension-fetch | 14 | 679 | 1 |
| 5 non-slab | extension-fetch | 10 | 2275 | 0 |
| 6 blob QR | page-fetch | 22 | 187 | 1 |
| 7 rotated | extension-fetch | 20 | 649 | 1 |

The images chosen depend on the layout: in some runs `psa-back-barcode` (81234567) made the top 8 instead of another image.

### Settings and service worker (dist-e2e)

| Check | Result |
|---|---|
| Fresh install | `openPanelOnActionClick:false`, tooltip "Scan this page for slab cert numbers" |
| Switch off (`storage.onChanged` path) | `true`, tooltip "Open CertScanner". Idle hint changes to "Shortcut: Alt+Shift+S." |
| Startup path | Behaviour forced to `false` while the setting is off → CDP `stopAllWorkers` → a `windows.onRemoved` event woke the worker (`starting→running`). The top-level `applyPanelBehavior` restored `true` and "Open CertScanner". |
| Switch on | `false` plus the scan tooltip |
| Shortcut | `chrome.commands.getAll()` → "Keyboard shortcut: Alt+Shift+S". Refreshed on panel focus or visibility change (Chrome has no `commands.onChanged`). "Change shortcut" opened `chrome://extensions/shortcuts` via `tabs.create`. |
| Dutch (`--lang=nl`, dist/) | `html[lang=nl]`, NL tooltip. Idle, page-access and Settings (incl. RM-7) are all Dutch. |
| Throughout | No uncaught panel errors. No requests outside 127.0.0.1 or the extension. |

### RM items

| Item | Result |
|---|---|
| RM-6 | `action_title` = "Scan this page for slab cert numbers" / "Deze pagina scannen op certnummers van slabs" (manifest `default_title`). The new `action_title_open` "Open CertScanner" is set by `chrome.action.setTitle` when the toolbar switch is off. Verified both ways in the browser. |
| RM-7 | `settings_sites_heading` is now "Sites with full access" / "Sites met volledige toegang". The body explains both sources ("Sharper scans" and "Always allow"), and the empty text now covers both offers. |

### Screenshots

All are actual extension captures, 360 px wide, full page, light and dark. Saved in `docs/quality/screenshots/`.
- Source: src-tree `4db373e4457811db`, Chromium 141.0.7390.37 headless, Linux, 2026-10-10.
- Reduced motion was emulated (static ◐ icon), except p1.

| File | State / fixture / build |
|---|---|
| `s0-idle-*` (overwritten) | New S0 layout, fresh profile, dist/ |
| `p1-page-scanning-*` | "Scanning image 2 of 8", gallery.html, dist-e2e |
| `p2-page-results-*` | gallery.html, 6 rows + off-site QR warning, dist-e2e |
| `p3-page-access-*`, `p3-page-access-offer-light` | Panel button with no access (http gallery); with a known https host; dist/ |
| `p4-page-none-*` (extra) | Raw-card page, photo checked, dist-e2e |
| `v2-settings-*` (overwritten) | Toolbar/shortcut section, RM-7 section, dist-e2e |

**Accessibility self-check** (scripted; axe not installed): idle, scanning, page-results, page-none, page-access and settings at 360 px and 160 CSS px (= 320 px at 200 %) show **0 issues**. The script checks names, 24 px targets, duplicate ids/test ids, alt text, headings, horizontal overflow and `#status`. It found one overflow in Settings at 160 px (the `chrome://` hint), which is now fixed.
- **Results tab order:** Open ‹grader› ‹number›, Copy ‹number›, per row.
- **Focus:** `#task-heading` on every state change. Page-access focuses the heading. A denied "Always allow" focuses its note.

### Decisions and limits (for the architect and QA)

| Item | Note |
|---|---|
| "Always allow" offer is rare | Chrome hides `tab.url` from tabs CertScanner can't read, so the host is usually unknown. The offer appears only when the panel already knows the https host for that tab, from an earlier job. That knowledge is dropped as soon as the tab navigates out of sight (`tabs.onUpdated`). **Suggestion for the architect:** `chrome.permissions.addHostAccessRequest({tabId})` (Chrome 133+; present in Chromium 141) can ask for the current site without knowing it. Not implemented, because it is a contract change. |
| No-op access probe | When the URL is hidden, the panel button injects `() => true`. The refusal text tells `chrome://` and Web Store pages (restricted) apart from pages with no access (page-access). The probe reads nothing. |
| Page jobs and `body[data-state]` | `scanning` → `page-results` / `auto-open` / `none` / `error` / `idle` (Cancel). Page-access is `#task[data-state=page-access]` with body `idle`. |
| lastResult restore | Only an auto-open page result is restored, because the A5 schema fits it. Results lists and page "none" clear `lastResult` and are not restored: they need the thumbnails, which are not stored. |
| Partial page | When the 30 s budget runs out with some numbers read, the list shows "Stopped after 30 seconds: checked N of M photos." and never auto-opens. With nothing read: E11 "Scanning this page took too long". Unit-tested only. |
| Panel button after a result | The "Scan this page" button is in idle, page-results/none ("Scan this page again"), E1 for page scans and page-access ("Try again"). From S2/S3 (single-image results) the user uses the icon or shortcut. |
| Setting label | "Toolbar button scans the page", as requested. Other copy keeps "CertScanner icon"; the hint links the two terms. |

### Notes for QA (page-scan e2e)

- Add `page-results` to `TERMINAL_STATES`.
- Update `extension.test.mjs:95` and `:507`: under A9 the default is `openPanelOnActionClick:false` (`true` only when `scanOnToolbarClick` is off).
- **Job writer:**
  - Shape: `{v:1, id, createdAt, kind:'page', source:'action'|'command'|'panel', srcUrl:null, pageUrl:<origin+path>, frameId:0, tabId, windowId}`.
  - Do not include `mediaType`.
  - `pageUrl:''` reproduces a tab whose URL Chrome hides, which gives restricted.
- **Test ids:**
  - `page-scan-button`, `page-progress`, `page-result-list`, `page-result-<i>` (with `data-number` and `data-grader`).
  - `always-allow-button`, `shortcut-current`, `shortcut-button`, `setting-scanOnToolbarClick`.
  - Row buttons use `data-ref="open"`, `"choose"` and `"copy"`.
- In release `dist/` the SW can't see tab URLs, so take the active tab instead of using `findTab`.
- Not automatable: real toolbar click or shortcut (activeTab grant + `sidePanel.open`), the permission prompt, and real "Always allow" grants (manual M-checks).
