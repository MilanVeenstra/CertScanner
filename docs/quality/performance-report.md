# CertScanner performance report

_Role: performance-engineer · Date: 2026-10-10 · Canonical path: `docs/quality/performance-report.md`._
_This report is evidence. It does not override the ADR, the UX spec or the user's decisions. No source, test or script was changed; nothing was optimized. All numbers are local synthetic measurements in headless Chromium, not production data._

## 1. Outcome

- **Every ADR latency budget passes with a wide margin.**
  - Image scans: warm UI p50 0.3–2.4 s for the nine fixtures, except the dark bench image at 4.8 s; worst single `scan()` 5.06 s against the 25 s budget.
  - Page scan of `gallery.html`: 7.9 s cold and 7.5 s warm (UI p50) against 30 s.
  - The 8-image cap and the 30 s page budget work. Pages too slow for the budget stop at 30.0–30.2 s with either E11 or a partial results list.
- **Idle behaviour is clean.**
  - With the panel open for 120 s: 0 service-worker wakeups and 0 panel timers.
  - The service worker stops exactly 30.0 s after its last event.
  - The Tesseract worker is disposed about 180 s after the last scan.
- **Main finding (memory, no ADR budget exists):** the extension renderer keeps growing while the panel stays open.
  - PSS goes 61 → 384 MiB after 20 image scans, and 568 MiB after 5 more page scans.
  - It drops only to about 420 MiB after the OCR worker is disposed.
  - Cause: the preview and row thumbnails are full-size images, so the compositor keeps full-resolution decodes in its image cache. One 12 MP photo is 46.5 MiB.
  - This memory is purgeable (a simulated critical-pressure signal frees about 220 MiB), so it is cache retention, not a JS leak. Bitmaps, blob URLs, DOM nodes and listeners are all bounded.
- **The injected probes have negligible page impact.**
  - Page main-thread script time: about 0.4 ms for `pageImagesProbe`, about 1 ms for `pageProbe` inspect, about 1.2 ms for a whole page scan.
  - 0 long tasks.
  - No globals or listeners are left behind.

## 2. Artifact identity

| Item | Value |
|---|---|
| Source | `git archive 03d9589` (`03d95895443d88898592fbc4e6da723d8910ea98`, branch `claude/sharp-turing-1et8ns`), exported to the scratchpad `perf/`; `node_modules` symlinked from the repo |
| src-tree sha256 | `4db373e4457811dbdbb0d671ec39db16fe013550bdc7909508013e2a7793a077`, the same tree as FE's S7 handoff |
| `dist/manifest.json` | sha256 `0aec47bb6c9faf3baf5f3bd21946a65652cebab78336a4247526aa30a3f9a2e1` |
| `dist-e2e/manifest.json` | sha256 `88fb2414b131391e91e9e0f64767b756c6e084a4568d2fec796010c055784062` (adds `host_permissions:["<all_urls>"]`) |
| Package | `SOURCE_DATE_EPOCH=1760000000 npm run package -- --allow-dirty` → `certscanner-0.1.0.zip`, 64 files, 4,658,943 B, sha256 `094f816f…dc44b`, all checks PASS. `build-info.gitCommit` is `null` because the export is not a git checkout. **Not a Store artifact.** |
| Run window | 2026-10-10 06:30–07:15 UTC |

## 3. Environment and method

| Item | Value |
|---|---|
| Host | Ubuntu 24.04.5 LTS, Linux 6.18.44, Intel Xeon @ 2.80 GHz, **`nproc` 4**, **RAM 16,093 MiB**, Node 22.22.0. Shared host (see §10). |
| Browser | Playwright-bundled Chromium 141.0.7390.37, new headless mode, software raster, DPR 1, `viewport:null`, `--window-size=1280,1000` |
| Isolation | `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`, `--no-proxy-server`, a throw-away profile per run, no internet |
| Driving | Panel opened as `sidepanel/sidepanel.html?w=<windowId>` (popup-window fallback). Image scans via `upload-input` `setInputFiles` (UI) and `scan()` in the panel realm (`timings`). Page scans via a `kind:'page'` job written to `storage.session` from the SW (UI), and via `scanPage()` in the panel realm (breakdown). |
| Measurement | UI ms = time from `scanning` to the terminal `body[data-state]`, on the panel clock. Memory = `/proc` RSS, PSS and VmHWM of the extension renderer (panel, SW and Tesseract/zxing all run in it), plus CDP heap, metrics and `memory-infra` dumps. SW state from CDP `ServiceWorker` events. |
| Test-only instrumentation | `context.addInitScript` counted timers, blob URLs, ImageBitmaps and Workers in the panel, and recorded long tasks in web pages. Nothing ships. |
| Samples | n ≥ 5 per latency metric (n = 25 for SW wakes and warm panel opens). p95 is nearest-rank, so with n = 5 it equals the max. "Cold" = first scan after a fresh browser launch, one launch per sample. |
| Stress inputs (generated, scratchpad only) | `synth-12mp.jpg`: 4032×3024, 1.0 MB, the PSA fixture slab on a textured background. `heavy-N.jpg`: 2400×1600 dense-text landscape photos with no valid run, which forces the worst case. Pages `many.html` (12 bench slabs), `heavy.html` (12 heavy photos) and `heavy-mixed.html` (2 slabs + 10 heavy). |

## 4. Package (measurement 1)

| Content | Files | Unpacked B | In ZIP B |
|---|---|---|---|
| `vendor/tesseract/lang/eng.traineddata.gz` (4.0.0_best_int, already gzip; 5.2 MB raw) | 1 | 2,952,873 | 2,948,213 |
| `tesseract-core-simd-lstm.wasm` | 1 | 2,857,601 | 1,064,008 |
| `zxing_reader.wasm` | 1 | 966,895 | 417,958 |
| Own code (SW, panel, pipeline, core, shared, manifest, build-info) | 36 | 277,245 | 88,280 |
| Tesseract JS (`tesseract.min`, `worker.min`, core loader) | 3 | 263,539 | 68,760 |
| Licences / notices | 12 | 95,525 | 29,377 |
| Locales (en, nl) | 2 | 51,270 | 11,535 |
| zxing JS | 1 | 36,583 | 12,812 |
| Icons | 7 | 11,427 | 9,918 |
| **Total** | **64** | **7,512,958 (7.17 MiB)** | **4,658,943 (4.44 MiB)** |

**What users download:**
- The Store serves a CRX built from this ZIP, so the expected download is about 4.4 MiB. This is not observed: no Store artifact exists.
- The installed footprint is about 7.2 MiB.
- Vendor files are 95% of the package. The traineddata alone is 63% of the download and doesn't compress further.
- This is within the R7 estimate of about 8–10 MB.

## 5. Install, service worker and idle (measurement 2)

| Metric | Result |
|---|---|
| Work at install | `onInstalled`: `contextMenus.removeAll` + `create`. `applyPanelBehavior` runs twice (once at top level, once in `onInstalled`), each time doing `storage.sync.get` + `sidePanel.setPanelBehavior` + `action.setTitle`. Nothing is written to storage (session, local and sync are empty after install). Result: `openPanelOnActionClick:false`, title "Scan this page for slab cert numbers". |
| Extension-renderer CPU, process start through install | p50 40 ms, p95 50 ms (n=5) |
| SW memory (extension renderer, SW only) | RSS 96 MiB p50 (95–97); PSS 21–32 MiB |
| SW wake, renderer already alive (`windows.onRemoved` trigger) | trigger → running p50 74 ms, p95 96 ms (n=25). The `starting` → `running` part is p50 10 ms, p95 15 ms. The trigger time includes the window create/remove round trip. |
| SW wake with process spawn (no extension page; raw CDP launch) | window close → running p50 71 ms, p95 76 ms (n=5). The extension process is respawned each time. |
| SW idle stop | **30.0 s after the last event, 6/6** (30,002–30,015 ms). The process exits. Measured with raw CDP: Playwright's auto-attach keeps the SW alive, so it can't measure this. |
| Panel open, SW stopped, 120 s idle | **0 SW wakes, 0 panel timers created**, panel ScriptDuration +0 ms, TaskDuration +69 ms, extension-renderer CPU 110 ms (0.09%) |
| SW wakes caused by panel activity | Each `storage.session` or `storage.local` write wakes a stopped SW **once**: one upload scan = 1 wake, one page scan = 1 wake. Cause: `chrome.storage.onChanged` in `sw.js` listens to every storage area, but it only needs `sync`. |

## 6. Side panel (measurement 3)

| Metric | Cold (first panel after launch, n=5) | Warm re-open (n=25) |
|---|---|---|
| Navigation start → `body[data-ready]` | p50 137 ms, p95 154 ms | p50 114 ms, p95 154 ms |
| `windows.create` → ready, seen by the harness | p50 196 ms, p95 252 ms | p50 167 ms, p95 243 ms |
| DOMContentLoaded | p50 123 ms, p95 142 ms | – |

**Memory before the first scan:**
- Extension renderer: RSS 145 MiB (+49 MiB vs SW only); PSS 43 MiB p50 (41–60).
- Panel JS heap 2.2 MiB, 1,141 DOM nodes, 57 listeners.
- **0 workers.** The engines are lazy.

## 7. Image scan latency (measurement 4)

**Cold vs warm** (`psa-8digit-leading-zero.png`; each cold sample is a fresh browser, n=5):

| Metric | Cold first scan | Second scan, same panel |
|---|---|---|
| UI (upload → `auto-open`) | p50 1,346 ms, p95 1,497 ms | p50 832 ms, p95 923 ms |
| `scan()` total | p50 1,269 ms, p95 1,299 ms | p50 758 ms, p95 834 ms |

**Cold first-scan breakdown (p50):**
- acquire 12 ms
- preprocess 161 ms
- barcode 82 ms (warm: 16 ms; the zxing prepare is 25 ms)
- `ocrInitMs` 197 ms. This is the wait left after init overlaps with acquire, preprocess and barcode. Full `warmUp()` takes p50 291 ms, p95 349 ms.
- OCR 790 ms (warm: 506 ms)

**Warm, per fixture** (n=5 each; same panel; rounds interleaved):

| Fixture (px) | Result | UI p50 / p95 ms | acquire | preprocess | barcode | OCR | `scan()` total p50 / p95 |
|---|---|---|---|---|---|---|---|
| PSA OCR `psa-8digit-leading-zero` (544×850) | auto-open 0.90 | 796 / 836 | 9 | 159 | 16 | 506 | 692 / 745 |
| CGC QR `cgc-comic-qr` (680×1044), OCR skipped | auto-open 0.95 | 284 / 292 | 12 | 173 | 24 | 0 | 218 / 254 |
| Non-slab `non-slab` (640×420, landscape, 8 recognize calls) | none | **2,379 / 2,514** | 6 | 175 | 12 | 2,266 | 2,483 / 2,607 |
| Low-res JPEG `psa-lowres.jpg` (260×406) | auto-open 0.90 | 509 / 610 | 4 | 63 | 4 | 363 | 435 / 513 |
| Rotated `cgc-comic-rotated` (768×1105) | auto-open 0.95 | 835 / 947 | 15 | 196 | 27 | 471 | 732 / 903 |
| Largest bench file `cgcc-c12-dark.jpg` (170 KB) | auto-open 0.94 | 1,062 / 1,387 | 12 | 221 | 49 | 706 | 1,002 / 1,024 |
| Largest bench image `cgcc-c09-rot5.jpg` (785×1116) | auto-open 0.85 | 795 / 847 | 10 | 184 | 27 | 491 | 727 / 845 |
| Slowest bench image `psa-c05-dark.jpg` (QA O3) | auto-open 0.90 | **4,767 / 4,909** | 10 | 199 | 33 | 4,563 | 4,815 / 5,060 |
| Synthetic 12 MP photo (4032×3024, 1.0 MB) | auto-open 0.90 | 1,327 / 1,494 | 71 | 315 | 84 | 557 | 1,033 / 1,125 |

**Where OCR time goes** (per-`recognize` timing through a test-only `engines` wrapper; warm):
- The **full-image sparse-text pass dominates.**
  - PSA: 550 of 597 ms.
  - `psa-c05-dark`: 4,481 ms, because image noise produces 339 "words".
  - `cgcd-c18-dark`: 2,211 ms.
  - Dense-text photo: 3,469 ms.
- The digit-crop passes take 27–62 ms each.
- `non-slab`: 8 calls (text, two band passes, then the same at 90° and 270°) = 2.2 s.

## 8. Page scan latency (measurement 5, `dist-e2e`)

**`gallery.html`** (10 images found → 8 scanned; 6 result rows, as in FE's S7):

| Metric | Cold (fresh browser, n=5) | Warm (n=5) |
|---|---|---|
| UI (job write → `page-results`) | p50 7,876 ms, p95 8,080 ms | p50 7,466 ms, p95 7,815 ms |
| `scanPage()` total | p50 7,540 ms, p95 7,719 ms | p50 7,073 ms, p95 7,667 ms |
| Discover | p50 7 ms, p95 11 ms | p50 3 ms, p95 8 ms |
| Viewport capture (one per scan) | p50 115 ms, p95 130 ms | p50 138 ms, p95 154 ms |
| First image scan | p50 1,431 ms (includes OCR init) | p50 904 ms |

**Per image** (warm, p50, n=5). The order is the probe's visible-area order, checked against the `pageImagesProbe` output:

| # | Image | Method | acquire | scan | preprocess | barcode | OCR |
|---|---|---|---|---|---|---|---|
| 0 | `qr-foreign-host` | extension-fetch | 17 | 904 | 163 | 21 | 687 |
| 1 | `psa-8digit-leading-zero` | extension-fetch | 17 | 740 | 162 | 18 | 545 |
| 2 | `ambiguous-10digit` | extension-fetch | 16 | 494 | 159 | 17 | 307 |
| 3 | srcset → `psa-lowres.jpg` (`currentSrc`, 260 px) | extension-fetch | 10 | 417 | 60 | 4 | 352 |
| 4 | `cgc-comic-dash` (under overlay) | extension-fetch | 18 | 801 | 171 | 23 | 605 |
| 5 | `non-slab` | extension-fetch | 13 | **2,566** | 146 | 10 | 2,410 |
| 6 | `blob:` QR | page-fetch | 26 | 180 | 153 | 27 | 0 |
| 7 | `cgc-comic-rotated` | extension-fetch | 33 | 724 | 180 | 44 | 496 |

The `non-slab` photo alone is **36% of the page scan**.

**Cap and budget pages:**

| Page | Runs | Result |
|---|---|---|
| `many.html`: 12 slab photos | 5 direct + 2 UI | **12 found → 8 scanned** → 8 rows. Total p50 5,577 ms, p95 5,855 ms; UI 5.7 / 6.1 s. |
| `heavy.html`: 12 dense-text photos (about 6 s each) | 3 UI + 3 direct | **E11 "Scanning this page took too long" at 30,004–30,005 ms** (panel clock); `scanPage()` returns `error/timeout` at 30,003 ms, 3/3 |
| `heavy-mixed.html`: 2 slabs + 10 heavy photos | 3 UI | `page-results`, 2 rows, "Stopped after 30 seconds: checked 6 of 8 photos." at 30,004–30,145 ms; never auto-opened |
| Gallery scan started right after a budget abort | 3 | 9,536 / 8,564 / 7,400 ms vs warm p50 7,073 ms. The first image took 3,016 / 1,950 / 1,418 ms vs 904 ms, because the aborted scan's in-flight `recognize` still occupies the single worker. |

## 9. Memory (measurement 6)

**Soak:** one panel; 20 UI uploads cycling 10 fixtures (including 12 MP twice), then 5 UI page scans of the gallery, then 222 s idle. Values are for the extension renderer.

| Point | PSS MiB | RSS MiB | Panel JS heap MiB | Nodes | Listeners | Workers | Blob URLs live | ImageBitmaps created / closed |
|---|---|---|---|---|---|---|---|---|
| Baseline (panel ready) | 61 | 147 | 2.2 | 1,141 | 57 | 0 | 0 | 0 / 0 |
| After image scan 1 | 157 | 247 | 2.8 | 1,263 | 62 | 1 | 1 | 1 / 1 |
| After image scan 10 (12 MP) | 285 | 375 | 3.2 | 1,403 | 78 | 1 | 1 | 10 / 10 |
| After image scan 20 | 384 | 475 | 3.4 | 1,403 | 87 | 1 | 1 | 20 / 20 |
| After page scan 5 | 568 | 661 | 3.7 | 1,860 | 106 | 1 | 8 (0.9 MB, current rows) | 65 / 65 |
| Idle +162 s | 563 | 655 | 3.6 | 1,860 | 83 | 1 | 8 | 65 / 65 |
| Idle +182 s (worker terminated) | 435 | 527 | 3.6 | 1,860 | 81 | **0** | 8 | 65 / 65 |
| Idle +222 s | 433 | 525 | 3.6 | 1,860 | 81 | 0 | 8 | 65 / 65 |

**Peaks (VmHWM):**
- First scan in a fresh panel: 283 / 290 MiB (p50 / p95).
- Image phase: 589 MiB.
- Page phase: 751 MiB.
- GPU process: flat at about 100 MiB.

**OCR engine cost:**
- `warmUp()` alone: +60 MiB PSS (p50).
- After the first `recognize`: +131 MiB PSS (p50, n=5).
- Freed on disposal: about 130 MiB.
- The worker is created once per panel lifetime and is never duplicated.

**Attribution of the growth** (`memory-infra` dump, 20 UI uploads):

| Allocator | Baseline MiB | After 20 uploads MiB |
|---|---|---|
| `cc/image_memory` (software image-decode cache) | 0 | **183.6** |
| `discardable` | 0 | **222.6**, in 46.5 MiB segments: 4032×3024×4 B, i.e. one full-resolution decode of the 12 MP upload |
| `partition_alloc` | 1.6 | 22.6 |
| `malloc` | 13.2 | 26.8 |
| `v8` | 3.5 | 6.3 |

**Reclaim check:**

| Step | PSS MiB |
|---|---|
| After 20 uploads | 377 |
| After a simulated critical memory-pressure signal | 157 |
| After `disposeEngines()` | 77 (baseline 62) |

**Control without thumbnails:** direct `scan()` calls plateau at 150–217 MiB with the worker alive, and fall to 96 MiB after disposal.

**Conclusion:**
- This is purgeable decode-cache retention driven by the full-size thumbnails (the scan preview, plus 8 page-result rows per page scan). It is not a JS, blob-URL or ImageBitmap leak.
- On machines that never signal memory pressure, it is held for as long as the panel stays open.

## 10. Page impact of the injected probes (measurement 7, `gallery.html`)

| Probe | Round trip from panel | Page main-thread script | Page task time | Result size |
|---|---|---|---|---|
| `pageImagesProbe` (n=20) | p50 2.4 ms, p95 4.3 ms | p50 0.44 ms, p95 0.58 ms | p50 1.1 ms, p95 2.4 ms | 18.6 KB (mostly the page's own `data:` URL) |
| Function body only, in page (n=20) | – | p50 0.1 ms, p95 0.3 ms | – | – |
| `pageProbe` inspect, `blob:` QR (n=10) | p50 9.6 ms, p95 16.3 ms | p50 1.0 ms, p95 2.8 ms | p50 6.4 ms, p95 9.6 ms | 113 KB data URL over IPC |
| `pageProbe` inspect, 317 KB PNG (n=10) | p50 17.1 ms, p95 26 ms | p50 0.9 ms, p95 5.0 ms | p50 8.1 ms, p95 15.4 ms | 423 KB data URL |
| Whole UI page scan (n=5) | – | p50 1.2 ms, p95 2.3 ms | p50 8.8 ms, p95 30.4 ms | – |

**Long tasks (> 50 ms) in the page during 5 full scans:** 0.

**Leftovers (before → after 20 + 20 probes + 5 scans, after GC):**
- Main-world globals: 235 → 235.
- `window` listeners: the same 13, all Playwright's own.
- `document` listeners: 0 → 0.
- Renderer `JSEventListeners`: 13 → 13.
- Isolated-world own globals: standard `window` properties only, no probe names.
- **No lasting listeners or globals.**

## 11. Budgets

| Budget (source) | Target | Observed | Status |
|---|---|---|---|
| Acquisition (ADR §6) | ≤ 12 s | image p95 ≤ 108 ms (12 MP decode); page per image ≤ 42 ms | PASS |
| OCR init (§6) | ≤ 10 s | cold `warmUp()` p50 291 ms, p95 349 ms | PASS |
| Each `recognize` (§6) | ≤ 8 s | max 4,481 ms (dark bench text pass) | PASS (1.8× margin) |
| Whole image scan (§6) | ≤ 25 s | max 5,060 ms; cold first scan p95 1,299 ms | PASS |
| Images per page (A9) | ≤ 8 | 12 found → 8 scanned; 10 → 8 | PASS |
| Page scan (A9) | ≤ 30 s | gallery cold p95 8.1 s; stress pages stop at 30.0–30.2 s (E11 / partial) | PASS |
| Bundle (R7 estimate) | ≈ 8–10 MB | 7.17 MiB unpacked, 4.44 MiB ZIP | Within |
| Engine idle disposal (§2) | 3 min | terminated between 162 and 182 s after the last scan | PASS |
| No polling or keepalive when idle (skill) | 0 | 0 SW wakes and 0 panel timers in 120 s; SW stops at 30.0 s | PASS |
| Memory | **No ADR budget** | renderer PSS 568 MiB after 25 scans; about 430 MiB 3 min later | **Unbudgeted — flagged.** Suggested target for the architect: ≤ 250 MiB PSS while scanning and ≤ 150 MiB after idle disposal. Currently this would fail; recommendation 1 below addresses it. |

## 12. Optimization opportunities (not implemented)

| # | Change | Evidence | Expected gain | Risk / cost |
|---|---|---|---|---|
| 1 | **Downscaled thumbnails.** Make the preview and the page-row thumbnails small (for example 240 px) from the already-decoded bitmap. Keep the original blob only for "Show larger", decoded on demand. | §9: decode cache 184 MiB plus discardable 223 MiB after 20 uploads; one 12 MP photo = 46.5 MiB; the control without thumbnails plateaus at 150–217 MiB | Removes most of the +300–500 MiB growth. The renderer should stay close to the 150–220 MiB direct-`scan()` plateau (estimate based on the control run). | Low. About 5–20 ms extra per image (estimate). Re-verify "Show larger" and UX screenshots. |
| 2 | **Page scan: rotation passes as a second sweep, plus progressive rows.** Run the 90°/270° passes for landscape photos only after every image has had its 0° passes. Render rows as each image finishes. Keep auto-open decided only on the full scan. | §8: `non-slab` = 2.5 s of 7.1 s (8 calls); its 0° passes take about 0.66 s (§7). Heavy pages check only 6 of 8 photos. | Gallery about −1.8 s (−25%). Time to first row about 1 s instead of 7–8 s. More photos checked before the 30 s cut-off. | A rotated landscape slab could be read only in sweep 2, or cut off by the budget. Rerun the D3 benchmark and the page e2e. Progressive rows need a11y review (live announcements, focus). |
| 3 | **OCR lifecycle.** (a) Terminate the worker when a scan aborts while a `recognize` is in flight for more than about 1 s. (b) Call `warmUp()` and `warmUpBarcodes()` at page-scan start, not at the first image. | §8: the next scan after an abort was +0.3–2.5 s slower. §7: the cold penalty is 0.55 s, of which 197 ms is init wait. | (a) Penalty after Cancel or timeout bounded to about 0.3–0.6 s (one re-init), instead of up to the 8 s `recognize` cap. (b) About −0.15–0.2 s on a cold page scan. | (a) Re-init churn if users cancel often. (b) None beyond memory the scan needs anyway. **Pre-warming when the panel opens is not recommended:** +60 MiB PSS for every panel opened without a scan, and no gain for toolbar/shortcut scans, where the job arrives together with the panel. |

**Considered, lower priority or not recommended:**
- **SW listener (low effort, small gain):** use `chrome.storage.sync.onChanged` instead of `chrome.storage.onChanged` in `sw.js`. Each scan would wake the SW 0 times instead of 1. Each wake costs about 70 ms plus 3 API calls.
- **Dark and noisy images (QA O3):** the 4.8 s comes from the full-image text pass. Downscaling or denoising that pass could help, but it changes OCR input, so the accuracy gate must be rerun first.
- **Lazy viewport capture:** take the screenshot only when a fetch fails. Saves 115–138 ms and about 5 MB per page scan, but the screenshot would no longer be taken at the start of the scan.
- **Early stop at the first confident result:** not recommended as is. A9 auto-opens only if no other photo has a number ≥ 0.50. On the gallery and on `many.html`, several photos have certs, so stopping early could auto-open one of several numbers (R2).
- **Smaller traineddata (for example `tessdata_fast`):** not measurable offline; the only local alternative (4.0.0) is 10.9 MB gz. It would need the D3 accuracy gate.

**Observation for FE (accuracy, not performance):** in page mode, extension-fetch uses `currentSrc`, so the srcset tile was scanned at 260 px. The largest srcset candidate is only used by page-fetch.

## 13. Limitations

- **Simulated runs.**
  - Headless Chromium 141 with software raster and DPR 1, not branded Chrome on a GPU laptop.
  - With GPU raster, decode memory may sit in the GPU process and be budgeted differently. Verify recommendation 1 in Chrome's Task Manager or `chrome://memory-internals`.
  - The panel ran as the `?w=` popup window, not inside the real side-panel container.
- **The test build has broader access than real users.** `dist-e2e` holds `<all_urls>`, so most images used extension-fetch. The release activeTab flow can't be automated. Page-fetch cost was measured through direct probe injection and the `blob:` image.
- **Shared host.** Other agents' Chromium instances ran on the same 4 vCPUs at times (2–5 foreign browsers seen during the control; load average about 1.2–1.5).
  - A control rerun gave gallery warm p50 6,864 ms vs 7,073 ms, and PSA 736 ms vs 692 ms, i.e. within ±6%.
  - Treat absolute latencies as ±10%.
  - The ratios between cold and warm runs are consistent across runs (CV ≤ 0.07).
- **Playwright limits.** Its CDP auto-attach keeps the SW alive, so the 30 s idle stop was measured with a raw CDP launch.
- **Instrumentation and fixtures.** Panel counters wrapped `setTimeout`, `createObjectURL`, `createImageBitmap` and `Worker` (negligible overhead). All inputs are synthetic.
- **Not measured.** Network volume (no egress is covered by QA J11), storage bytes per scan (small: `lastResult` and history entries), branded Chrome, Chrome 116, and low-end hardware.

## 14. Artifacts (scratchpad, not committed)

- **Harness:** `…/scratchpad/perf-bench/`:
  - `lib.mjs`, `session.mjs`, `server.mjs`, `gen.mjs`
  - `a-swpanel.mjs`, `a2-rawcdp.mjs`, `a3-wakes.mjs`
  - `b-image.mjs`, `b2-ocrcalls.mjs`
  - `c-page.mjs`
  - `d-soak.mjs`, `d2-diagnose.mjs`, `d3-memdump.mjs`
  - `e-impact.mjs`, `e2-listeners.mjs`
  - `f-init.mjs`, `g-control.mjs`
- **Raw results:** `perf-bench/results/*.json` and `*.log`. Generated inputs: `perf-bench/gen/`.
- **Build:** export `…/scratchpad/perf/` (`dist/`, `dist-e2e/`, `certscanner-0.1.0.zip`). The QA launcher `tests/e2e/lib/env.mjs` was used read-only from the export.

**Next owners:**
- Architect: decide a memory budget, and decide on recommendations 1–3.
- FE: implement whichever recommendations are approved; after that, performance re-measures with the same harness.
- QA: rerun the D3 benchmark and the page e2e if recommendation 2 is adopted.
