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

---

## Round 2: commit `03d9589` (S6 security fixes + A9 page scan)

**Reviewer:** security-reviewer (independent native specialist agent; read-only) · **Date:** 2026-10-10 · Saved by the orchestrator.
**Source:** `03d95895443d88898592fbc4e6da723d8910ea98` from a fresh `git archive` export (src-tree sha256 prefix `4db373e4457811db`).
**Builds:** release `dist/manifest.json` sha256 `0aec47bb6c9faf3b…a2e1`; `dist-e2e/manifest.json` `88fb2414b131391e…4062`; test ZIP (`SOURCE_DATE_EPOCH=1760000000 --allow-dirty`) `094f816f68b171b5…c44b`, 64 files.
**Environment:** Node 22.22.0, Playwright 1.56.1, bundled Chromium 141.0.7390.37 headless, 127.0.0.1 servers only.

### Outcome

No critical, high or medium findings. All round-1 code blockers fixed. Page scan withstands huge image lists, 36 MB of URLs, hostile schemes, main-world prototype tampering, busy pages, Cancel and the 30 s budget; aggregation can't be outvoted. New: four Low (SEC-13…16), three Info (SEC-17…19).

### Round-1 items re-verified

| ID | Status | Evidence |
|---|---|---|
| SEC-01 | Fixed | `manifest.json` `"incognito":"not_allowed"`, enforced by `--check`; runtime: cannot be enabled in incognito |
| SEC-02 | Fixed | descriptions 126 (en) / 131 (nl); every locale checked ≤132 |
| SEC-03 | Fixed | `raceAbort` in acquire/scanner/pageScan; probe 300 ms fallback; busy page: acquire `timeout` at 12,002 ms, Cancel 86 ms; page scan Cancel 31 ms, budget error at 30,017 ms |
| SEC-04 | Fixed for listed formats (bypass: SEC-14) | BMP/WebP VP8L/ICO/AVIF bombs refused in 1–6 ms |
| SEC-05 | Partial (legal gate open) | six licence files shipped and required; texts not yet compared with upstream |
| SEC-06 | Fixed | `autoOpenKey` per job id incl. page jobs; unit + e2e |
| SEC-07 | Accepted residual, widened by page scan (SEC-13) | preview shows analysed bytes |
| SEC-08 | Fixed (code) | post-capture re-check in single and page mode |
| SEC-09 | Fixed | query/hash stripped from `pageUrl`; history/lastResult hold no URLs |
| SEC-10 | Accepted (disclosed) | four CDN default strings; runtime egress none |
| SEC-11 | Fixed, small residual | "All sites" row; subdomain-wildcard grants not listed |
| SEC-12 | Mostly fixed (gaps: SEC-15) | release-only, dirty refused without `--allow-dirty`, ZIP of `dist/` only, manifest re-validated, deterministic with `SOURCE_DATE_EPOCH` |

### New findings

| ID | Severity | Evidence | Scenario | Fix | Blocks release | Orchestrator decision |
|---|---|---|---|---|---|---|
| SEC-13 | Low (integrity/UX) | `pageImagesProbe.js:25-40` has no CSS-visibility/occlusion filter; `pageAggregate.js:187-197` ignores visibility for auto-open | Hostile page shows slab A as CSS background, adds invisible `<img>` of slab B (`opacity:0`, off-screen or `visibility:hidden`) → B auto-opened | Skip images failing `checkVisibility({checkOpacity, checkVisibilityCSS})`; auto-open only when the winning image is ≥ 50 % in the viewport and topmost at its centre | No (recommended before 1.0) | **Fix now** |
| SEC-14 | Low (availability) | 64 KiB header read; JPEG SOF after 64 KiB and GIF frames larger than the screen bypass the sniffer; after `too-large` page-fetch decodes again | 1 MB JPEG → 16000² decode 1,107 ms; 8 such images exhaust the page budget | Walk JPEG segments up to ~1 MB; GIF largest image descriptor; stop after `too-large` | No | **Fix now** |
| SEC-15 | Low (release integrity) | dirty check misses ignored files and `third_party/`; same ZIP name for dirty builds; `builtAt` defaults to now; vendor hashes compared only to `node_modules` | Ignored `src/dist/stowaway.txt` and edited licence packaged with `gitDirty:false` | Package from `git ls-files`/archive or extend the check; `-dirty` ZIP name; default epoch = commit time; pin vendor sha256 | No | **Fix now** |
| SEC-16 | Low (privacy policy/Store accuracy) | Docs still say "Sharper scans"/"Scan the page when I click the icon"; "image's host name" vs page host; cites `bb1666f` | Policy points to settings that don't exist | Update labels (en/nl), re-source | **Yes (Store, docs only)** | **Fix now (release manager)** |
| SEC-17 | Info | removal announced without checking result | "Removed All sites." while still granted | Announce from resolved boolean | No | Fix now |
| SEC-18 | Info | Clear history / history off don't clear `lastResult:<windowId>` | cert number + host restored up to 12 h | Clear `lastResult:*` too, and on window close | No | Fix now |
| SEC-19 | Info | `probeValidate.js:174` accepts any `data:` type | harmless (decode fails) | `^data:image/(?!svg)` | No | Fix now |

### Verified controls (new surface)

- SW: `sidePanel.open` first in all three listeners; only `action`, `commands`, `contextMenus` listeners; no messaging listeners.
- Settings → SW behaviour/tooltip switch at runtime; malformed synced values fall back.
- Probe: self-contained, ISOLATED world, main frame only; main-world prototype overrides ineffective; `javascript:`, `data:text/html`, SVG dropped; 3,000 images → 39 ms, capped 24, 8 scanned; 36 M chars of URLs → 786 ms + 87 ms validation; malformed envelopes rejected.
- Aggregation: 20 repeats at 0.79, off-site QR, duplicate numbers across graders, null grader, manual source and invalid lengths never auto-open.
- Panel: `blob:` thumbnails revoked; `textContent` only; i18n substitutions not re-expanded; dropped links/HTML refused without fetch; clipboard writes digits only; "Always allow" requests exactly `https://<host>/*` as the first call; `chrome://extensions/shortcuts` is a constant.
- Greps: no `innerHTML`/`eval`/`Function`/`importScripts`/remote `import()`/messaging/WAR/`externally_connectable`; `fetch` only in `acquire.js`/`pageProbe.js`; `tabs.create` only in `opener.js` (via `buildCertUrl`) and the shortcuts constant.
- Privacy docs vs behaviour: probe reads only URL, srcset, rect, natural size, viewport, dpr — matches PRIVACY.md except SEC-16 labels.

### Commands (observed)

| Command / test | Result |
|---|---|
| `npm test` | 164/164 pass |
| `npm run check` | all checks passed |
| `build:e2e` + `diff -rq dist dist-e2e` | only `manifest.json` (+`<all_urls>`) and `build-info.json` differ |
| `--package` without git / with `--e2e` | refused / refused |
| `SOURCE_DATE_EPOCH=… --package --allow-dirty` ×2 | identical `094f816f…`; 64 entries dated 1980-01-01; manifest identical to `dist/` |
| Decode bombs (release `dist/`) | 9 refused in 1–6 ms; JPEG SOF-after-head 1,107 ms; GIF frame > screen 1,033 ms |
| Busy page / page busy (dist-e2e) | see SEC-03 |
| Page T1–T9 (dist-e2e) | as above; no panel errors; no egress beyond 127.0.0.1 |
| Egress (release `dist/`) | PSA auto-open 01234567; CGC QR 4012347003; origins `[]`; egress none |
| Native CSP probe | `new Function`, `eval`, string timer, inline script, remote `import()` blocked; WASM allowed |
| QA e2e `security` + `privacy` | 7/7 pass |

### Release recommendation (code)

Conditional pass, no security blocker: package only from a clean commit with `SOURCE_DATE_EPOCH` and record the ZIP sha256 (until SEC-15 is fixed); fix SEC-13 before a public 1.0. Store/legal gates: SEC-16 docs and SEC-05 upstream licence comparison.

**Incident (resolved):** the reviewer accidentally created a self-referencing symlink `node_modules/node_modules`; the orchestrator removed only that link (`unlink`) on 2026-10-10.

**Not run:** real toolbar click/shortcut and permission prompt, forced SEC-08 tab switch, subdomain wildcard grant listing, Chrome 116.
