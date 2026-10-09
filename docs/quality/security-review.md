# CertScanner — security and privacy review

## Round 1: commit `2cd4f86` (core S1–S5)

**Reviewer:** security-reviewer (independent native specialist agent; read-only, wrote no repo files) · **Date:** 2026-10-09 · Saved by the orchestrator.
**Source identity:** commit `2cd4f8645486271fbad7485f86931af72d1be0ed`, reviewed on a clean `git archive` export (the shared working tree had S6 edits in progress, which are **not** covered here).
**Build identity:** release `dist/manifest.json` sha256 `df5d5845…529e`; e2e `dist-e2e/manifest.json` sha256 `ba1ccb86…c174`; vendor sha256 values in `dist/build-info.json`.
**Environment:** Node 22.22.0; Playwright 1.56.1, bundled Chromium 141 headless; local 127.0.0.1 fixture servers only.

### Outcome

- **No critical or high findings.** No remote code; least-privilege manifest; strict QR/URL allow-list with URLs always rebuilt by `buildCertUrl`; no messaging surface; safe DOM rendering; credential-less extension fetches; zero network egress during a full scan.
- **2cd4f86 is not yet releasable** (conditional pass for continued development): SEC-01 must be fixed; SEC-02 and SEC-05 are Store/legal gates; Store prerequisites (privacy-policy URL, permission justifications, data-use form) have no evidence yet.

### Findings

| ID | Severity | Title | Blocks release | Orchestrator decision |
|---|---|---|---|---|
| SEC-01 | Medium (privacy) | Scans from incognito tabs are saved to on-disk history (page host + cert number) | **Yes** | Fix with `"incognito": "not_allowed"` (simplest verifiable option); update ADR §3 and `--check` |
| SEC-02 | Low (Store) | `nl` `extDescription` is 147 chars (limit 132) | **Yes (Store)** | Fix in S6 + ≤132 check |
| SEC-03 | Low (availability) | Page probe / capture can hang past the 12 s / 25 s budgets and Cancel | No | Fix (`raceAbort`, rAF timeout fallback) |
| SEC-04 | Low (availability) | Decode bomb via formats the header sniffer doesn't read (BMP, ICO, AVIF, WebP VP8/VP8L) | No | Fix (extend sniffer) |
| SEC-05 | Low (licence) | Notices missing for libraries linked into the WASM (Leptonica, IJG libjpeg, libpng, zlib, libtiff, zxing-cpp) | **Yes (legal)** | Fix in build + check |
| SEC-06 | Info | Auto-open de-dup is per scan, not per job (Sharper re-run can open twice) | No | Fix (key on job id) |
| SEC-07 | Info | Page decides which bytes are analysed (bait-and-switch) — preview already mitigates | No | Keep preview + number visible |
| SEC-08 | Info | Time-of-check gap between active-tab check and `captureVisibleTab` | No | Fix (re-check after capture) |
| SEC-09 | Info | Unused `frameUrl` and full `pageUrl` stored in the session job | No | Drop `frameUrl`; store `pageUrl` without query/hash |
| SEC-10 | Info | Vendor bundles contain jsDelivr default URL strings (overridden at runtime) | No | Disclose in Store notes |
| SEC-11 | Info | Granted-sites list hides wildcard grants | No | Fix ("All sites" row) |
| SEC-12 | Info | Release-packaging guards (ZIP from `dist/` only, `target`/`gitDirty` checks, ZIP sha256) | No | Fix in build/package |

#### SEC-01 · Medium · Incognito scans saved to persistent history
- **Evidence:** `src/manifest.json` has no `incognito` key (default `spanning`); `src/sidepanel/opener.js:40-47` `recordHistory()` writes whenever `saveHistory` is on; `src/shared/history.js:132-141` keeps `pageHost` in `chrome.storage.local`; no incognito check in `src/`.
- **Scenario:** user enables "Allow in Incognito" → scans in an incognito window → `{grader, number, at, source, pageHost}` written to disk and shown under "Recent scans" in normal windows.
- **Fix:** (a) `"incognito": "not_allowed"`, or (b) carry `incognito` in the job and skip history writes. **Verify:** manual M11 / unit test.

#### SEC-02 · Low · Dutch description > 132 characters
- `src/_locales/nl/messages.json` `extDescription` = 147 chars; Chrome's limit is 132. Suggested: "Leest het certificaatnummer van een PSA- of CGC-slabfoto en opent de officiële verificatiepagina. Afbeeldingen blijven lokaal." (127).

#### SEC-03 · Low · Probe or capture can hang the scan
- **Evidence:** `acquire.js:155-165` awaits `executeScript` without racing the abort signal; `acquire.js:247-256` same for `captureVisibleTab`; `scanner.js:109-111` acquire not raced against the 25 s signal; `pageProbe.js:59-71` waits on rAF (paused for hidden pages).
- **Observed:** hostile busy-loop page kept `acquireFromJob` unsettled after 25,002 ms (budget 12 s); `scan()` with Cancel at 2 s unsettled after 30,004 ms.
- **Fix:** `raceAbort(promise, sig)` around `executeScript`, `captureVisibleTab` and the acquire call; `setTimeout` fallback (~300 ms) in `twoFrames`.

#### SEC-04 · Low · Decode bomb
- **Evidence:** `acquire.js:42-63` sniffs only PNG, GIF, WebP VP8X, JPEG; others are fully decoded before the 12,000 px / 40 MP checks.
- **Observed:** a 1,080-byte RLE8 BMP declaring 16000×16000 decoded for 5,206 ms (~1 GB RGBA) before `too-large`.
- **Fix:** sniff BMP, WebP `VP8 `/`VP8L`, ICO, AVIF/HEIF `ispe`; optionally refuse unreadable dimensions above a small byte threshold.

#### SEC-05 · Low · Third-party notices incomplete
- `strings` on `tesseract-core-simd-lstm.wasm` shows Leptonica (BSD-2), IJG libjpeg, libpng, zlib, libtiff; `zxing_reader.wasm` is zxing-cpp (Apache-2.0). Ship their licence texts/acknowledgements and require them in `--check`.

#### SEC-06 · Info · Auto-open de-dup per scan
- `main.js` keys `autoOpened` on a fresh UUID per `startScan`; the Sharper-scans re-run can open the same cert twice, contradicting ADR §7. Key on `job.id`.

#### SEC-07 · Info · Page decides analysed bytes
- Largest same-origin `srcset` and `Sec-Fetch-Dest`-varying responses can differ from what is displayed. Mitigated: the preview shows the analysed blob and the UI disclaims authenticity.

#### SEC-08 · Info · Capture TOCTOU
- After `captureVisibleTab`, re-check `chrome.tabs.get(job.tabId)` is active with an unchanged origin; else `tab-changed`.

#### SEC-09 · Info · Job data minimisation
- `frameUrl` unused; full `pageUrl` (possibly with query tokens) kept in `storage.session`. Drop `frameUrl`; keep only origin + path.

#### SEC-10 · Info · CDN default strings in vendor bundles
- Four default URLs in `tesseract.min.js`, `worker.min.js`, `zxing-reader.iife.js`; all overridden; no fallback on failure; runtime egress test showed zero http(s)/ws requests.

#### SEC-11 · Info · Wildcard grants hidden
- `permissionsUi.js:71-77` lists only `https://<host>/*`; show "All sites" with Remove if `https://*/*` or `<all_urls>` is granted.

#### SEC-12 · Info · Release-packaging guards
- ZIP only `dist/`; re-check the unzipped manifest; fail if `build-info.target !== 'release'` or `gitDirty !== false`; record ZIP sha256.

### Verified controls (evidence)

1. **Manifest/permissions:** exactly `contextMenus, activeTab, scripting, storage, sidePanel` + optional `https://*/*`; no host permissions/content scripts/WAR/externally_connectable; runtime `permissions.getAll()` → `origins: []`. **CSP enforced at runtime:** inline script, remote script and `<object>` blocked; `WebAssembly.compile` allowed (`'wasm-unsafe-eval'` justified). `minimum_chrome_version` 116 matches `sidePanel.open` and `AbortSignal.any`. Optional host access is per-origin, https only, from a user gesture (first async call in the click handler), listed and removable. `dist/` vs `dist-e2e/` differ only by `manifest.json` (`host_permissions:["<all_urls>"]`) and `build-info.json`.
2. **Remote code/supply chain:** all JS/WASM/traineddata packaged; overrides in `ocr.js` and `barcode.js`; no `importScripts`/`eval`/`new Function`/remote `import()` in `src/`; lockfile resolves from registry.npmjs.org with sha512 integrity; exact pins enforced; vendor sha256 recorded.
3. **Untrusted inputs:** probe self-contained in the ISOLATED world; `validateProbeResult` rejected 14 hostile shapes; 19 hostile QR payloads (lookalikes, userinfo, port, punycode, homograph, `javascript:`, `data:`…) stayed non-official; `buildCertUrl` threw on 18 bad inputs; `chrome.tabs.create` only in `opener.js` with `buildCertUrl` output; 11 hostile manual inputs and 11 forged jobs rejected; untrusted QR blocks auto-open.
4. **Network/privacy:** extension fetch sends no Cookie/Referer/Origin, 10 s timeout; only with host access; zero egress during OCR/QR scans on release `dist/`; no analytics; `storage.session` at `TRUSTED_CONTEXTS`; history holds `{grader, number, at, source, pageHost}` only. "Images stay on this device" is accurate.
5. **DOM safety:** no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`/`srcdoc`/`DOMParser`/string timers in `src/`; textContent rendering; preview via `blob:` `<img>`.
6. **Messaging:** no `onMessage`/`onMessageExternal`/`onConnect`/`sendMessage`; pages see `chrome.runtime.sendMessage === undefined`; only trusted extension contexts can write jobs; `sidepanel.html` is not web-accessible.
7. **Store policy:** single purpose holds; name "CertScanner"; grader names used descriptively; generic icon; "Not affiliated with PSA or CGC." in en and nl; explicit no-authenticity note.

### Commands run (observed)

| Command / test | Result |
|---|---|
| `npm test` (clean export) | 91/91 pass |
| `npm run check` (clean export) | all checks passed |
| `npm run build:e2e` + `diff -rq dist dist-e2e` | only `manifest.json` + `build-info.json` differ |
| adversarial pure-function suite | 0 failures |
| runtime adversarial (dist-e2e) | BMP bomb 5,206 ms → `too-large`; busy page acquire unsettled at 25,002 ms; Cancel unsettled at 30,004 ms |
| runtime egress (release dist) | PSA fixture auto-open psa 01234567; CGC QR auto-open 4012347003; **egress none** |
| runtime CSP (release dist) | violations blocked; WASM allowed |

### Store submission inputs (draft, for the release manager)

- **Permission justifications:** contextMenus — "Scan slab cert number" on images · activeTab — temporary access to the clicked tab to locate the image and read its pixels · scripting — one-time function in the clicked frame to find the image and its position · storage — scan hand-off, settings, optional local recent scans · sidePanel — progress, results, confirmation, manual entry · optional https host access — one image host at a time via "Sharper scans on ‹host›", removable in Settings · Remote code — none.
- **Privacy policy URL required** (local processing of website content is still user data). Contents: on-device processing, possible re-download from the image host, in-memory visible-area capture, cert number reaches PSA/CGC only by opening their page, local recent scans (clearable), settings via Chrome sync, no analytics.
- Put "Not affiliated with PSA or CGC" in the detailed description and screenshots.

### Not run / residual risk

Not run: incognito runtime test, Chrome 116, real-CDN activeTab behaviour, drag-and-drop of links into the panel, Store dashboard. Residual: a counterfeit slab showing a real cert number still "verifies" (R8, disclosed); a per-host grant gives lasting credential-less fetch access to that host (revocable); activeTab + capture expose the visible tab area in memory after a click.
