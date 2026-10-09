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
