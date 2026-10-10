# ADR-001: CertScanner v1 architecture

**Status:** Accepted by orchestrator 2026-10-09 · **Author:** extension-architect (native specialist agent) · **Canonical path:** `docs/architecture/architecture.md`
**Source identity:** branch `claude/sharp-turing-1et8ns` @ `d809e50` (no source code existed yet).
**Inputs:** `docs/extension-contract.md`, `docs/research/research.md`.
**Frozen and not reopened:** local-only operation, D1–D6, vanilla ES modules with no bundler, the permission set, the vendor asset list.

**Orchestrator amendments (2026-10-09):**
- A1. Locale keys use camelCase with prefixes as in §12; the UX spec's string list is mapped onto these keys by the implementer.
- A2. `package.json` keeps the already-installed `playwright@1.56.1` (not `@playwright/test`); e2e uses `node --test` + `playwright` library.
- A3 (after UX spec, supersedes A1). Locale keys: use the UX spec's message keys (`docs/design/design-spec.md` §6) verbatim; Chrome allows `[A-Za-z0-9_@]`.
- A4. `body[data-state]` gains `opened` (cert page opened by the user from confirm, edit, manual entry or recent). The UX spec's finer task-card states (`result`, `edit`, …) live on `section#task[data-state]`; `body[data-state]` keeps the §13 values plus `opened`.
- A5. Answers to the UX handoff: UX2 confirmed (global panel opened with `{windowId}`); "Try again" re-runs the in-memory job while the activeTab grant lasts (same tab, same origin) and falls back to the restricted/upload path otherwise; limits are the ADR values (15 MB, 12,000 px/side, 40 MP, digits 7–13, history 25 — UX copy must use these numbers); restoring the last completed result on panel reopen via `storage.session` key `lastResult:<windowId>` (no image data) is a *should*, not a release gate.
- A6 (after S1–S5). Backwards-compatible contract additions approved: OCR pages carry `pass`, `rotation`, per-word `lineId`; `analyze()` exported beside `parseCandidates()`; `ScanResult.error.canRequestSharper`; `scan()` options `onImage`, `engines`, and `acquire` as a function or `{strategies}`; evidence code `qr-untrusted:<host>`; `invalid-image` ranked after `too-large`; `body[data-ready]` and `body[data-window-id]` for test sync. A number taken only from an off-site QR stays a capped `confirm` candidate with the `qr-untrusted-host` warning (never auto-opened; URL always rebuilt).
- A7 (after security review round 1). Manifest adds `"incognito": "not_allowed"` (SEC-01: no incognito scans can reach persistent history). ScanJob drops `frameUrl` and stores `pageUrl` as origin + pathname only (SEC-09); parsers ignore an extra `frameUrl`. Auto-open de-dup is keyed on the job id (SEC-06). Acquisition calls are raced against the abort signal (SEC-03) and capture re-checks the tab after `captureVisibleTab` (SEC-08). Release packaging zips `dist/` only and refuses non-release targets (SEC-12).
- A8 (after S6). `ScanJob` gains optional `srcIssue` (set by the SW when the image URL scheme is unsupported, so the panel shows "Couldn't open this image" instead of "too large"). History entries always store `pageHost: null` (the UX spec keeps only grader, number, method and time; the field stays for schema compatibility). Turning "Keep scan history" off deletes history immediately, as the Settings copy states, instead of asking first. In the UI, `setting-autoOpen` is the "Always ask before opening" switch (checked ⇔ `autoOpen:false`, marked `data-inverted="true"`).
- **A9 (user requirement change 2026-10-09: "scan the page itself, without uploading a photo first") — Page scan.** Upload/paste/manual entry become secondary fallbacks; the primary journeys are *page scan* and *right-click an image*.
  - **Triggers (all grant activeTab):** (1) toolbar action click — `setPanelBehavior({openPanelOnActionClick:false})`; `chrome.action.onClicked(tab)` calls `chrome.sidePanel.open({windowId})` synchronously first, then writes a page job; (2) keyboard command `scan-page` (manifest `commands`, suggested `Alt+Shift+S`) via `chrome.commands.onCommand(command, tab)`, same hand-off; (3) the panel's "Scan this page" button, which works only while the extension has access to the active tab (live activeTab grant or an optional host grant for its origin — detect via `chrome.tabs.query({active:true, windowId})` returning a `url`); otherwise the panel explains "Click the CertScanner icon or press Alt+Shift+S" and offers "Always allow on ‹host›" (`permissions.request` for that origin). No new install-time permissions; `commands` is a manifest key, not a permission.
  - **Job contract:** `ScanJob` v1 gains `kind: 'image' | 'page'` (absent ⇒ `'image'`). A page job has `srcUrl:null`, `source:'action'|'command'|'panel'`, and no `mediaType`. `parseScanJob` validates both kinds.
  - **Discovery:** new self-contained injected function `pageImagesProbe(opts)` (main frame only, ISOLATED world, no listeners left) returns `{v:1, viewport, dpr, images:[{srcUrl, rect, natural, srcsetBest, visibleFraction}]}` for `<img>` elements (incl. inside `<picture>`) whose rendered short side ≥ 120 CSS px and natural short side ≥ 150 px, excluding SVG, sorted visible-area-first, capped at 24. Validated by a pure `validatePageImages()` like `validateProbeResult`.
  - **Acquisition per image (no scrolling in page mode):** data URL → extension fetch when host access exists → page-context fetch (existing `pageProbe` inspect mode) → crop from **one** viewport screenshot taken at the start (only images with `visibleFraction ≥ 0.9`). Same caps and SEC-03/04/08 protections.
  - **Budget:** up to 8 images (visible first), each through the existing scanner; whole page scan ≤ 30 s; Cancel and `raceAbort` apply; progress `{stage:'page', index, total}`.
  - **Aggregation/routing:** candidates from all images are merged by grader+number (max confidence, keep the image index for the thumbnail). Auto-open only if exactly one distinct number has a known grader and confidence ≥ 0.80, no other number from any image scores ≥ 0.50, and `autoOpen` is on. Otherwise a results list (one row per distinct cert: thumbnail, number, grader, source, Open, Copy). Nothing found → "No cert numbers found on this page" with tips (right-click a specific photo, Sharper scans, upload).
  - **UI contract additions:** `body[data-state]` adds `page-results`; test ids `page-scan-button`, `page-progress`, `page-result-list`, `page-result-<i>`. Idle state leads with "Scan this page" and the right-click hint; upload/paste/manual move under "Other ways to scan".
  - **Setting:** `scanOnToolbarClick` (default true). When false, the toolbar only opens the panel (`openPanelOnActionClick:true`).
  - **Privacy:** the page probe returns image URLs/geometry only; no page text or DOM is read; nothing leaves the device.
- **A10 (improvement round after security round 2 + performance report).** `pageImagesProbe` skips images failing `checkVisibility({checkOpacity, checkVisibilityCSS})` and returns per image `topmostAtCenter` (hit test at the visible centre) plus the envelope `total`; page auto-open additionally requires the number to come from an image that is ≥ 0.5 visible and topmost (SEC-13). Scan results add `totalFound` ("Checked 8 of 10 photos") and an in-memory `error.injectError`; new error `page-no-access` (E12) when the tab is no longer readable. `storage.session` adds `seenJobs:<windowId>` (≤ 20 consumed job ids). After `too-large` no further fetch/decode strategy runs except the viewport crop. Thumbnails ≤ 240 px; the OCR worker is terminated on abort/timeout. **Memory budget (renderer PSS):** ≤ 150 MiB after idle disposal (met: 117), ≤ 250 MiB median between scans (met: 235), mid-scan peak ≤ 450 MiB (met: max 416; the live OCR worker is ~130 MiB). Lowering the mid-scan peak further needs a smaller OCR working size and a new D3 accuracy gate — deferred.

---

## 1. Decision

One surface does the work: **the side panel hosts the whole pipeline.** The service worker is a stateless trigger. The page is touched only by a one-shot injected function. Nothing runs on a server.

| Candidate (all local-only; cloud excluded by contract) | Verdict |
|---|---|
| **A. Side panel hosts acquisition + OCR + UI (selected, D1)** | One long-lived extension page can run `Worker` and WASM, has visible state, is the place for the `permissions.request` user action, and can call `captureVisibleTab`/`executeScript` under the click's activeTab grant. |
| B. Offscreen document (`WORKERS`) + popup/notification result | Rejected: extra lifecycle, hidden context; popup can't stay open during OCR; no visible place for confirm/edit. |
| C. Content-script overlay in the page | Rejected: page CSP blocks the Tesseract worker (tesseract.js #961); needs broad host access; hostile page CSS/DOM. |

Independent-evaluator scoring was not run (D1 already resolved). No security or policy blocker found in A.

## 2. Contexts, lifetimes, data flow

```
 Web page tab T (untrusted)                     Chrome
 ┌──────────────────────────┐  right-click img ┌──────────────────────────────┐
 │ <img> in frame F         │ ───────────────▶ │ contextMenus 'image' context │
 │ [pageProbe] one-shot,    │                  │ + activeTab grant on T       │
 │ ISOLATED world ◀─────────┼── executeScript ─┤   (main-frame origin only)   │
 └──────────────────────────┘                  └──────────────┬───────────────┘
                                                              │ onClicked(info, tab) + gesture
                                               ┌──────────────▼───────────────┐
                                               │ Service worker (stateless)   │
                                               │ 1. sidePanel.open({windowId})│ sync, first
                                               │ 2. session.set(scanJob:<W>)  │
                                               └──────────────┬───────────────┘
                              chrome.storage.session (trusted contexts only)
 ┌──────────────┐ tabs.create(rebuilt URL)     ┌──────────────▼───────────────┐
 │ New tab:     │ ◀─────────────────────────── │ Side panel page, window W    │
 │ official cert│                              │ jobIntake → scanner:         │
 │ page         │   captureVisibleTab ───────▶ │  acquire→preprocess→barcode→ │
 └──────────────┘   fetch (activeTab/optional  │  ocr→certParser→routing→UI   │
                    per-origin grant)          │  ├ Tesseract Worker (lazy)   │
                                               │  └ zxing wasm (lazy)         │
                                               │ sync: settings  local: history│
                                               └──────────────────────────────┘
```

| Context | Lifetime | Holds state? |
|---|---|---|
| Service worker `background/sw.js` (module) | Event-driven; terminated after idle. All listeners registered synchronously at top level. | No — only writes the job to `storage.session`. |
| Side panel `sidepanel/sidepanel.html` | One global instance per window, from open until closed. Survives tab switches. Reloads on extension update. | In-memory scan, AbortController, engines. |
| Tesseract dedicated worker | Created lazily on first scan, reused, terminated after 3 min idle and on `pagehide`. | Model in memory. |
| `pageProbe` (injected `func`) | One call; no listeners or globals left behind. | None. |
| activeTab grant | From the click until cross-origin navigation or tab close. Covers the tab's **main-frame origin only**. | n/a |

Opening the side panel reflows the page, so rectangles are measured at capture time, never cached from click time.

## 3. Manifest (release)

```json
{
  "manifest_version": 3,
  "name": "__MSG_extName__",
  "description": "__MSG_extDescription__",
  "version": "0.1.0",
  "default_locale": "en",
  "minimum_chrome_version": "116",
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
  "action": { "default_title": "__MSG_actionTitle__" },
  "background": { "service_worker": "background/sw.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel/sidepanel.html" },
  "permissions": ["contextMenus", "activeTab", "scripting", "storage", "sidePanel"],
  "optional_host_permissions": ["https://*/*"],
  "content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
}
```

- **Not used:** `host_permissions`, `content_scripts`, `web_accessible_resources`, `externally_connectable`, `offscreen`, `tabs`, `clipboardWrite`.
- **Minimum version 116 confirmed** by Google's sample `functional-samples/cookbook.sidepanel-open` (`chrome.sidePanel.open({ windowId: tab.windowId })` synchronously inside `contextMenus.onClicked`, `minimum_chrome_version: "116"`); `side_panel.idl`: `open()` "may only be called in response to a user action".
- APIs fitting 116: `AbortSignal.any` (116), `storage.session`, `OffscreenCanvas`, `crypto.randomUUID`.
- **Do not use:** `Promise.withResolvers` (119), `Object.groupBy` (117), Set methods (122), JSON import attributes (123).

## 4. Job hand-off contract (SW → side panel)

The side panel subscribes to `storage.onChanged` and reads the current value with `get()`. A job is consumed once by removing it only if the stored id still matches. **No runtime messaging.**

```js
// src/shared/jobContract.js  (pure; imported by SW, side panel, unit tests)
export const MENU_ID = 'certscanner-scan';
export const SCAN_JOB_VERSION = 1;
export const JOB_TTL_MS = 120_000;
export const MAX_SRC_URL_CHARS = 2_000_000;           // larger data: URLs → srcUrl:null → 'too-large'
export const jobKey = (windowId) => `scanJob:${windowId}`;

/** @typedef {{v:1, id:string, createdAt:number, source:'contextMenu',
 *   srcUrl:string|null, pageUrl:string, frameUrl:string|null, frameId:number,
 *   tabId:number, windowId:number, mediaType:'image'}} ScanJob */

export function createScanJob(info, tab, now, id) { /* maps OnClickData+Tab → ScanJob; frameId ?? 0 */ }
/** @returns {{ok:true, job:ScanJob} | {ok:false, reason:'shape'|'version'|'stale'|'window'}} */
export function parseScanJob(raw, { now, windowId }) {
  /* plain object; v===1; id string ≤64; createdAt finite, now-createdAt ∈ [-5s, TTL];
     srcUrl null | string ≤ MAX with scheme http:|https:|data:|blob:; pageUrl string ≤ 8192;
     frameId/tabId integers ≥ 0; windowId === expected; mediaType === 'image' */
}
```

```js
// src/background/sw.js — every listener registered synchronously at module top level
chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus);   // removeAll → create; refreshes localized title
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !(tab.id >= 0)) return;
  // MUST be the first side effect; no await before it (gesture is only valid synchronously)
  chrome.sidePanel.open({ windowId: tab.windowId })
    .catch(() => chrome.windows.create({ type: 'popup', width: 420, height: 760,
      url: chrome.runtime.getURL(`sidepanel/sidepanel.html?w=${tab.windowId}`) }));
  const job = createScanJob(info, tab, Date.now(), crypto.randomUUID());
  chrome.storage.session.set({ [jobKey(tab.windowId)]: job }).catch(console.warn);
});
chrome.windows.onRemoved.addListener((w) => chrome.storage.session.remove(jobKey(w)));
```

**Side panel intake** (`sidepanel/jobIntake.js`):
1. `targetWindowId`: the `?w=` query parameter if it matches `^\d{1,10}$`, else `(await chrome.windows.getCurrent()).id`. Powers the popup-window fallback and e2e tests.
2. Subscribe to `storage.onChanged` (area `session`, key `jobKey(W)`) **before** calling `get()`. Both call `consider(raw)`.
3. `consider`: `parseScanJob`; invalid/stale → remove and ignore; skip ids in the in-memory `seen` Set; else `onJob(job)`; then remove the key only if the stored id still equals `job.id`.
4. `onJob` aborts the scan in flight and starts the new job. **Newest job wins.**

| Scenario | Outcome |
|---|---|
| Panel not loaded yet | `open()` loads the panel; its initial `get()` finds the job. |
| Panel already open | `onChanged` delivers the job within milliseconds. |
| SW restarted/killed | Nothing lost: job lives in session storage; SW holds no state. |
| Two quick clicks | Second job overwrites the slot; a scanning panel aborts the first and runs the second. |
| Panel reloaded mid-scan | Job already removed → no re-run; user clicks again. |
| Browser restart / extension update | Session storage cleared (intended). |
| Multiple windows | One key per window; each panel consumes only its own. |

`storage.session` stays at its default `TRUSTED_CONTEXTS` access level.

## 5. Image acquisition (`src/pipeline/acquire.js`)

```js
/** @typedef {'data-url'|'extension-fetch'|'page-fetch'|'capture'|'upload'|'paste'|'drop'} AcquireMethod */
/** @typedef {'restricted'|'not-found'|'too-large'|'fetch-failed'|'capture-failed'|'tab-changed'
 *            |'invalid-image'|'engine-failed'|'timeout'|'aborted'} ScanErrorCode */
/** @typedef {{ok:true, bitmap:ImageBitmap, blob:Blob, info:ImageInfo}
 *          | {ok:false, reason:ScanErrorCode, origin:string|null, canRequestSharper:boolean}} AcquireResult */
export async function acquireFromJob(job, { signal, strategies /* test-only override */ }) {}
export async function acquireFromBlob(blob, method /* 'upload'|'paste'|'drop' */, { signal }) {}
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
```

Strategies in order; first success returns:

| # | Strategy | Precondition | Mechanism | `resolution` |
|---|---|---|---|---|
| 0 | guard | `isRestrictedPage(job.pageUrl)` and srcUrl not `data:` | Scheme/host check: `chrome:`, `chrome-extension:`, `chrome-untrusted:`, `devtools:`, `edge:`, `about:`, `view-source:`, `file:`, `chromewebstore.google.com`, `chrome.google.com/webstore` → **restricted** | n/a |
| 1 | data-url | srcUrl `^data:image/` | `fetch(srcUrl)` → blob | full |
| 2 | extension-fetch | http(s) srcUrl **and** (`permissions.contains({origins:[origin+'/*']})` or image origin = `pageUrl` origin under activeTab) | `fetch(srcUrl, {credentials:'omit', referrerPolicy:'no-referrer', cache:'force-cache', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)])})`, streamed with 15 MB cap | full |
| 3 | page-fetch | Page not restricted | `executeScript({target:{tabId, frameIds:[frameId]}, world:'ISOLATED', func:pageProbe, args:[srcUrl,'inspect',MAX_IMAGE_BYTES]})`; page-context fetch (page CORS) of `srcsetBest`, then srcUrl, returned as data URL | full |
| 4 | capture | Probe found the image, `rectIsTopLevel`, `job.tabId` still active in its window, tab origin still equals job `pageUrl` origin | Probe in `'capture'` mode: if < 98% visible, `scrollIntoView({block:'center', behavior:'instant'})`, wait 2 rAF, re-measure; `captureVisibleTab(windowId,{format:'png'})`; crop rect × `capture.width / viewport.width`; retry once after 600 ms on the 2/s rate limit | **screen** |
| 5 | fail | n/a | Most specific reason: `restricted` > `tab-changed` > `not-found` > `too-large` > `capture-failed` > `fetch-failed` | n/a |

**Decode rules:** `createImageBitmap(blob, {imageOrientation:'from-image'})`; `too-large` if > 15 MB, > 12,000 px per side or > 40 MP; `invalid-image` if < 32 px or decode fails; long side < 500 px adds warning `low-resolution`.

**Why access works this way:** the activeTab grant belongs to the extension, so the side panel can use it for `executeScript` and `captureVisibleTab`. `CanCaptureVisiblePage` requires activeTab or `<all_urls>`; a specific optional host grant does **not** enable capture — it enables strategy 2. Cross-origin iframes are outside the activeTab grant (probe fails with `fetch-failed`; "Sharper scans" still helps). The eBay `s-l500→s-l1600` rewrite is not used in v1.

**`canRequestSharper`** = image origin is `https:`, not already granted, and (`resolution === 'screen'` or reason is `fetch-failed`/`capture-failed`).

### Page probe contract (`src/pipeline/pageProbe.js`)

Self-contained (Chrome serializes `func.toString()`): no imports, no closure variables.

```js
export async function pageProbe(srcUrl, mode /* 'inspect'|'capture' */, maxBytes) { /* … */ }
/** UNTRUSTED until validateProbeResult() (src/pipeline/probeValidate.js, pure) passes
 * @typedef {{v:1, found:boolean,
 *   rect?:{x:number,y:number,width:number,height:number},   // CSS px, top-level viewport coords
 *   rectIsTopLevel?:boolean,
 *   viewport?:{width:number,height:number}, dpr?:number,
 *   natural?:{width:number,height:number},
 *   srcsetBest?:string|null,                                  // largest 'w' candidate, same origin as srcUrl only
 *   fetch?:{ok:true, dataUrl:string, url:string}|{ok:false, reason:'cors'|'http'|'too-large'|'timeout'}}} ProbeResult */
```

Finds the `<img>` whose `currentSrc` or resolved `src` equals srcUrl; fetch uses `cache:'force-cache'` and an 8 s timeout.
Validation: all numbers finite; rect width/height in [4, 20000]; `dpr` in (0, 8]; `dataUrl` matches `^data:[\w.+-]+/[\w.+-]+;base64,` and ≤ `ceil(maxBytes·4/3)+256` chars; `srcsetBest` only if same origin as srcUrl.

## 6. Recognition pipeline

| Module | Responsibility | Boundary |
|---|---|---|
| `pipeline/preprocess.js` | `OffscreenCanvas` scaling (long side 2000 px, clamp [1600, 2400], upscaling ≤ 3×), grayscale, 1st–99th percentile contrast stretch → PNG `ocrBlob`, RGBA `ImageData` for barcodes, band rects (top 35% / bottom 35%), `cropForDigits(rect)` (pad 25% of height, text height ≈64 px with ≤ 4×, Otsu threshold, 16 px white border), `rotate(90\|180\|270)` | DOM-free canvas code |
| `pipeline/barcode.js` | `detectBarcodes(imageData,{signal})` → `[{format, text, engine}]`; native `BarcodeDetector` if `getSupportedFormats()` covers QRCode/Code128/Code39/DataMatrix/ITF, else `ZXingWASM.readBarcodes(imageData,{formats, tryHarder:true, maxNumberOfSymbols:4})`; zxing prepared lazily with `locateFile` → `chrome.runtime.getURL('vendor/zxing/zxing_reader.wasm')`, `fireImmediately:true` | Raw text only |
| `pipeline/ocr.js` | `createOcrEngine({getURL, idleMs=180_000})` → `{warmUp, recognizeText, recognizeDigits, dispose}` wrapping a singleton `Tesseract.createWorker('eng', 1, {workerPath, corePath:…/tesseract-core-simd-lstm.js, langPath:…/vendor/tesseract/lang, workerBlobURL:false, cacheMethod:'none', gzip:true, logger})`; mutex around `setParameters` + `recognize`. Text pass `PSM.SPARSE_TEXT`; digits pass `PSM.SINGLE_LINE`, whitelist `0123456789-`; `user_defined_dpi:'300'`; `recognize(blob,{rectangle},{text:true,blocks:true})` | `OcrPage {text, confidence, words:[{text,confidence,bbox,lineText}]}` |
| `core/certParser.js` | Pure `parseCandidates({pages, barcodes}, rules)` → `CertCandidate[]` (§7) | No `chrome`, no DOM |
| `core/certUrls.js` | Pure URL builders and QR parsing (§8) | Same |
| `core/routing.js` | Pure `decide(candidates, settings, warnings)` → status | Same |
| `core/manualEntry.js` | Pure parser: `PSA 12345678`, `cgc cards 1401234567890`, `4012345-001`, official URL | Same |
| `pipeline/scanner.js` | `scan(input, {settings, signal, onProgress, acquire})` → `ScanResult`; checks `signal` between stages; post-abort results discarded | Only composing module |

**Pass plan** (≤ 8 `recognize` calls per scan):
1. Acquire (with `ocr.warmUp()` in parallel). 2. Preprocess. 3. Barcodes — an allow-listed QR matching the path pattern finishes the scan (OCR skipped). 4. Text pass over the full image. 5. Digits pass over ≤ 4 word/line boxes from step 4 with ≥ 5 digit-like chars; if none, whitelisted sparse text on the top band, then the bottom band rotated 180°. 6. No valid-length run and landscape (w > 1.15 h) → repeat 4–5 at 90° then 270°. 7. Parse, route.

| Step | Limit |
|---|---|
| Acquisition | 12 s |
| OCR init | 10 s |
| Each recognize call | 8 s |
| Whole scan | 25 s → `timeout` |

Engine failure: barcode results are still shown with warning `ocr-unavailable`.

## 7. Candidates and routing (data table `src/core/certRules.js`)

```js
export const RULES_VERSION = 1;
export const GRADERS = { psa: { lengths: [7, 8, 9, 10] }, 'cgc-comics': { lengths: [10] }, 'cgc-cards': { lengths: [10, 13] } };
export const TIE_ORDER = { default: ['psa', 'cgc-comics', 'cgc-cards'], 10: ['cgc-comics', 'cgc-cards', 'psa'] }; // D4
// [term, weight]; whole-word match on normalized UPPERCASE text; each term once; per-grader sum capped at 1
export const KEYWORDS = {
  psa:          [['PSA', .6], ['PSA/DNA', .6], ['GEM MT', .5], ['NM-MT', .5], ['EX-MT', .4], ['VG-EX', .4]],
  'cgc-comics': [['CGC', .4], ['CERTIFIED GUARANTY', .5], ['UNIVERSAL GRADE', .7], ['SIGNATURE SERIES', .6],
                 ['WHITE PAGES', .6], ['OFF-WHITE', .5], ['QUALIFIED', .4], ['RESTORED', .4], ['CONSERVED', .4],
                 [/\b9\.[2468]\b/, .4]],
  'cgc-cards':  [['CGC', .4], ['CERTIFIED GUARANTY', .5], ['GEM MINT', .5], ['PRISTINE', .6], ['NM/MINT', .5], ['MINT+', .3]],
};
export const DASH_FORM = { re: /(?<!\d)(\d{7})-(\d{3})(?!\d)/, grader: 'cgc-comics', weight: .4 }; // joined to 10 digits
export const OCR_FIXUPS = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' }; // only in tokens ≥6 chars with ≥75% digits
export const CERT_LABEL_RE = /\b(CERT(IFICATION)?|#)\b/;
export const SCORE = {
  base: { 'qr-url': .95, 'qr-url-unmatched-path': .85, barcode: .80, ocr: { min: .40, span: .30, confLo: 50, confHi: 90 } },
  bonus: { secondRead: .15, certLabel: .05, lengthUnique: .05, keywordResolved: .10 },
  penalty: { ocrFixup: .15, keywordConflict: .15, graderUnresolved: .20, noSlabVocabulary: .20, competitor: .10 },
  resolve: { minKeyword: .4, minMargin: .3, slabVocabularyMin: .3, conflictKeyword: .6 },
  thresholds: { autoOpen: .80, show: .30, competitor: .50, maxCandidates: 5, untrustedQrCap: .50 },
};
```

**Scoring** (per distinct digit string; reads of the same number merged):
1. **Start.** OCR: `ocr.min + ocr.span·clamp((meanWordConf−50)/40, 0, 1)`; barcode: `barcode`; allow-listed QR: `qr-url`. A QR URL on a non-allow-listed host contributes only its digits, as source `barcode` capped at 0.50, plus warning `qr-untrusted-host`.
2. **Read quality.** `+secondRead` for ≥ 2 independent reads; `+certLabel` if the line matches `CERT_LABEL_RE`; `−ocrFixup` if every read needed fixups.
3. **Grader.** `F` = graders whose `lengths` contain the length (empty → drop). QR → grader from host. `|F| = 1`: assign, `+lengthUnique` — unless another grader scores ≥ 0.6 on keywords while this one < 0.3 → `−keywordConflict`. `|F| > 1`: rank by keyword score (ties by `TIE_ORDER`); resolved only if best ≥ 0.4 **and** beats second by ≥ 0.3 → `+keywordResolved`; else `grader:null`, `graderOptions = F` ranked, `−graderUnresolved`.
4. **Slab vocabulary.** Source not `qr-url` and max keyword score < 0.3 → `−noSlabVocabulary`.
5. **Competition.** `−competitor` per *other* candidate ≥ 0.50.
6. **Final.** Clamp [0, 1], round 2 dp, drop < 0.30, sort desc, keep ≤ 5.

| Case | Calculation | Score | Result |
|---|---|---|---|
| J1: PSA, 8 digits, conf 88, both passes, "GEM MT" | .685+.15+.05 | **.885** | auto-open |
| J3: 13 digits | same as J1 | .885 | auto-open |
| J2: 10 digits with UNIVERSAL GRADE | .685+.15+.10 | .935 | auto-open |
| J5: 10 digits, no keywords | .835−.20−.20 | .435 | confirm; options cgc-comics, cgc-cards, psa |
| Barcode only, no slab vocabulary | .80+.05−.20 | .65 | confirm |

```js
/** @typedef {'psa'|'cgc-comics'|'cgc-cards'} Grader */
/** @typedef {{grader:Grader|null, graderOptions:Grader[], number:string, confidence:number,
 *   source:'qr-url'|'barcode'|'ocr'|'manual', evidence:string[]}} CertCandidate
 *   evidence codes: 'len:8','kw:GEM MT','pass:text','pass:digits','fixup','cert-label','dash-form',
 *                   'qr-host:www.cgccomics.com','qr-path-unmatched','barcode:Code128','conflict' */
/** @typedef {{method:AcquireMethod, resolution:'full'|'screen', width:number, height:number,
 *   origin:string|null, canRequestSharper:boolean}} ImageInfo */
/** @typedef {{jobId:string|null, status:'auto-open'|'confirm'|'none'|'error', candidates:CertCandidate[],
 *   imageInfo:ImageInfo|null, warnings:{code:'qr-untrusted-host'|'low-resolution'|'ocr-unavailable', detail?:string}[],
 *   error?:{code:ScanErrorCode, origin?:string},
 *   timings:{acquireMs:number, preprocessMs:number, barcodeMs:number, ocrInitMs:number, ocrMs:number, totalMs:number}}} ScanResult */
/** @typedef {{stage:'acquire'|'decode'|'barcode'|'ocr-init'|'ocr'|'parse', fraction?:number}} ScanProgress */
```

**Auto-open** (`routing.decide`) requires **all** of: `settings.autoOpen`; top candidate has a non-null grader; `top.confidence ≥ 0.80`; no other candidate with a different number ≥ 0.50; no `qr-untrusted-host` warning; `top.source ≠ 'manual'`. Otherwise `confirm` (or `none` with no candidates). Auto-open at most once per job id. The UI always shows the number read and never claims authenticity (R8).

## 8. URL builders, QR allow-list, opening (`src/core/certUrls.js`, `src/sidepanel/opener.js`)

```js
export const CERT_URL = {
  psa:          (n) => `https://www.psacard.com/cert/${n}`,
  'cgc-comics': (n) => `https://www.cgccomics.com/certlookup/${n}/`,
  'cgc-cards':  (n) => `https://www.cgccards.com/certlookup/${n}/`,
};
export const QR_HOSTS = new Map([
  ['psacard.com','psa'], ['www.psacard.com','psa'], ['cgccomics.com','cgc-comics'], ['www.cgccomics.com','cgc-comics'],
  ['cgccards.com','cgc-cards'], ['www.cgccards.com','cgc-cards'], ['cgccards.uk','cgc-cards'], ['www.cgccards.uk','cgc-cards'],
]);
export const QR_PATHS = { psa: /^\/cert\/(\d{7,10})(?:\/|$)/i, 'cgc-comics': /^\/certlookup\/(\d{10})(?:\/|$)/i,
                          'cgc-cards': /^\/certlookup\/(\d{10}|\d{13})(?:\/|$)/i };
/** throws RangeError unless /^\d+$/ and length ∈ GRADERS[grader].lengths */
export function buildCertUrl(grader, number) {}
/** @returns {{kind:'official', grader:Grader, number:string, host:string, pathMatched:boolean}
 *          | {kind:'untrusted-url', host:string, digits:string[]} | {kind:'not-url'}} */
export function parseQrPayload(text) {}
```

QR rules: only `http:`/`https:` (missing scheme → retry with `https://`); empty `username`/`password`/`port`; host must exactly match `QR_HOSTS` (URL parser normalizes punycode → lookalikes fail); path not matching `QR_PATHS` but exactly one valid-length digit run → `pathMatched:false`, base `.85`.
`cgccards.uk` is allow-listed for trusting the number only; the opened page is always the `.com` builder URL.

**Decoded URLs are never navigated.** `opener.openCert(candidate, job, settings)` is the only caller of `chrome.tabs.create`: `buildCertUrl(...)` → `chrome.tabs.create({url, active: !settings.openInBackground, windowId, index: src.index + 1, openerTabId: src.id})` (`src` from `chrome.tabs.get(job.tabId)`; omitted if gone).

## 9. Storage

```js
// chrome.storage.sync  'settings'  (≈80 B; per-item quota 8 KB)
{ v: 1, autoOpen: true, openInBackground: false, saveHistory: true }      // autoOpen=false ⇔ "Always ask before opening" (D5)
// chrome.storage.local 'history'  (newest first, ≤25, dedupe on grader+number; no image data, no URLs)
{ v: 1, entries: [{ grader: 'psa', number: '01234567', at: 1760000000000, source: 'ocr', pageHost: 'www.ebay.com' }] } // pageHost null for upload/paste/manual
// chrome.storage.session 'scanJob:<windowId>' → ScanJob (ephemeral; srcUrl/pageUrl live only here)
// chrome.storage.session 'seenJobs:<windowId>' → string[] (≤20 consumed job ids; A10)
// chrome.storage.session 'lastResult:<windowId>' → last completed result, no images/URLs (A5; cleared by Clear history, history off, window close)
```

Migrations (`shared/settings.js`, `shared/history.js`) are pure, run on read, return `{value, needsWrite}`:

| Stored data | Behaviour |
|---|---|
| Missing or invalid | Defaults; nothing written until the user changes something. |
| Older `v` | Step migrators, then write. |
| Newer `v` (other synced device) | Read known fields; never write back unless the user edits. |
| History with bad entries | Drop invalid entries individually. |

History is written when a cert is opened (auto or user) or copied, only if `saveHistory`. Turning `saveHistory` off deletes history after confirmation; "Clear history" always available. Concurrent panel writes: last-write-wins; panels refresh from `storage.onChanged`.

## 10. Trust boundaries and validation

| Crossing | Data | Rule |
|---|---|---|
| Page → `pageProbe` return | rect, URLs, data URL | Untrusted; `validateProbeResult`; size caps; page-supplied URLs only on the clicked image origin. |
| Browser → `info.srcUrl`/`pageUrl` | Page-controlled URLs | Scheme allow-list; fetch only where host access exists, credentials omitted; never navigated. |
| QR, barcode, OCR text | Attacker-craftable | Text only; digits extracted; URLs rebuilt by `certUrls`. |
| SW → panel job | `storage.session` | `parseScanJob` |
| Sync settings | Other device/version | Tolerant migration |
| User input | Manual entry, files | `parseManualEntry`; `acquireFromBlob` caps |

- **No `runtime.onMessage`/`onMessageExternal` listeners in v1.** Any future listener must require `sender.id === chrome.runtime.id`, `!sender.tab`, `sender.url` under `chrome.runtime.getURL('')`, and versioned `{v, requestId, op}` with allow-listed ops.
- **Rendering:** `textContent` only; never `innerHTML` with page/OCR text.
- **Remote code:** none — `workerPath`, `corePath`, `langPath`, zxing `locateFile` always overridden.

## 11. Permission rationale

| Permission | Purpose | If denied/absent |
|---|---|---|
| `contextMenus` | "Scan slab cert number" on `image` | Toolbar → side panel: upload, paste, manual |
| `activeTab` | Per-click access: probe injection, `captureVisibleTab`, same-origin fetch | n/a (granted per click) |
| `scripting` | Inject the one-shot `pageProbe` | n/a |
| `storage` | Job hand-off, settings, history | n/a |
| `sidePanel` | UI and pipeline host | Popup-window fallback runs the same page |
| optional `https://*/*` | One image origin at a time via the visible "Sharper scans on ‹host›" button (`permissions.request` first call in the handler); settings list granted sites with Remove | Capture fallback at screen resolution |

## 12. File layout and exclusive ownership

**frontend-engineer (FE):** `src/**`, `tests/unit/**`, `scripts/build.mjs`, `package.json`, `package-lock.json`, `.gitignore` (add `dist-e2e/`).
**QA:** `tests/e2e/**` (incl. `harness/`), `tests/fixtures/**`, `scripts/gen-fixtures.mjs`.
**Shared contracts (FE-owned; changes need an ADR amendment):** `src/shared/jobContract.js`, `src/core/types.js`, `src/core/certRules.js`, `scan()`/`acquireFromJob()` signatures, §13 test ids.

```
package.json            exact pins: tesseract.js 7.0.0, tesseract.js-core (lockfile 7.x), @tesseract.js-data/eng 1.0.0,
                        zxing-wasm 3.1.5, playwright 1.56.1, bwip-js 4.8.0
                        scripts: build | build:e2e | check | test | e2e | fixtures
scripts/build.mjs       clean+copy src→dist, vendor + LICENSE/NOTICE, dist/build-info.json {version, gitCommit, builtAt,
                        vendor:{name,version,sha256}}; --e2e → dist-e2e (§14); --check: no host_permissions/<all_urls>,
                        no e2e-harness/, all vendor files present, no http(s) URLs in src/** except CERT_URL/QR_HOSTS hosts
src/manifest.json                    §3
src/_locales/{en,nl}/messages.json   all UI strings; camelCase keys with prefixes menu*/state*/error*/action*/settings*/a11y*
src/icons/{16,32,48,128}.png         original artwork, no grader logos
src/background/sw.js                 menus, onClicked hand-off, panel behaviour, window cleanup
src/shared/jobContract.js            ScanJob create/parse/keys (pure)
src/shared/settings.js               defaults, migrateSettings (pure) + load/save adapter
src/shared/history.js                migrateHistory, addEntry reducer (pure) + adapter
src/shared/i18n.js                   t(key,subs), applyI18n(root) for data-i18n, sets <html lang>
src/core/types.js                    JSDoc typedefs only
src/core/certRules.js                §7 data table
src/core/certParser.js               text+barcodes → CertCandidate[]
src/core/certUrls.js                 builders, QR parsing, isRestrictedPage
src/core/routing.js                  decide()
src/core/manualEntry.js              manual input parser
src/pipeline/acquire.js              §5 strategies (chrome adapters)
src/pipeline/pageProbe.js            injected self-contained function
src/pipeline/probeValidate.js        probe validation (pure)
src/pipeline/preprocess.js           canvas transforms
src/pipeline/barcode.js              BarcodeDetector/zxing adapter
src/pipeline/ocr.js                  Tesseract engine singleton
src/pipeline/scanner.js              orchestrator
src/sidepanel/sidepanel.html|.css    markup; classic <script> for vendor IIFEs, then type=module main.js
src/sidepanel/main.js                bootstrap: target window, intake, scan lifecycle, wiring
src/sidepanel/jobIntake.js           §4 intake
src/sidepanel/ui.js                  state rendering, aria-live, focus management
src/sidepanel/inputs.js              paste/drop/upload → Blob
src/sidepanel/opener.js              openCert + history write
src/sidepanel/permissionsUi.js       Sharper-scans request, granted-sites list/remove
dist/vendor/tesseract/{tesseract.min.js,worker.min.js,tesseract-core-simd-lstm.js,tesseract-core-simd-lstm.wasm}
dist/vendor/tesseract/lang/eng.traineddata.gz      dist/vendor/zxing/{zxing-reader.iife.js,zxing_reader.wasm}
```

## 13. UI state contract (design + e2e)

- `document.body.dataset.state` ∈ `idle`, `scanning`, `auto-open`, `confirm`, `none`, `error`.
- **Required `data-testid`s:** `status-live` (`aria-live="polite"`), `progress`, `preview`, `result-number`, `result-grader`, `candidate-list`, `candidate-<i>`, `grader-select`, `number-input`, `open-button`, `copy-button`, `cancel-button`, `sharper-button`, `upload-input`, `manual-input`, `manual-submit`, `manual-error`, `error-message`, `history-list`, `history-clear`, `setting-autoOpen`, `setting-openInBackground`, `setting-saveHistory`.
- The designer owns visuals; ids and states are fixed. Footer includes "Not affiliated with PSA or CGC".

## 14. Test plan

**Unit (`node --test`, FE):** `certParser`/`certRules`/`routing` (all §7 worked checks, leading zeros, dash form, fixups, competition, untrusted-QR cap, **no auto-open below 0.80 or with `grader:null`**); `certUrls` (bad lengths; QR host/path matrix incl. userinfo, port, lookalike, missing scheme, `.uk`, http); `manualEntry`; `jobContract`; settings/history migrations; `probeValidate` (hostile values); `isRestrictedPage`.

**E2E (QA; Playwright 1.56.1 bundled Chromium, `launchPersistentContext` + `--load-extension=dist-e2e`):**
- `build:e2e` = dist + `e2e-harness/` (from `tests/e2e/harness/`) + manifest patch `host_permissions:["<all_urls>"]` (tests can't produce an activeTab grant). `npm run check` proves `dist/` has neither.
- Driving a job: serve fixtures on `127.0.0.1:A` (pages), `:B` (images, no CORS), `:C` (images with CORS); find the fixture tab/window via SW `evaluate`; open `sidepanel/sidepanel.html?w=<windowId>` (popup window for capture tests); write `scanJob:<w>` from the SW.
- Grader hosts stubbed with `context.route`; assert the new tab URL.

| Journey | Covered by |
|---|---|
| J1–J3, J5, J6 | Panel with injected jobs (extension-fetch) + harness `scan({kind:'blob'})` |
| J4 | QR fixtures: allow-listed, path-unmatched, foreign host → warning, no auto-open |
| J7 | Harness `acquire.strategies:['page-fetch','capture']` with `:B` image → `capture`/`screen`/`canRequestSharper` |
| J8 | Job targeting `chrome://version` → `restricted`, no uncaught errors |
| J9 | Keyboard-only manual entry, `aria-live` errors |
| J10 | `setInputFiles`, synthetic paste/drop `DataTransfer`, `context.setOffline(true)` |
| J11 | All requests are `chrome-extension://`, fixture origins or stubbed grader hosts |

Also: two quick jobs (only the second result shown/opened), panel reload (no re-run).

**OCR benchmark gate (D3):** ≥ 40 synthetic fixtures; top-1 ≥ 90% clean, ≥ 70% degraded (JPEG q40, 0.5×, blur, glare); **zero wrong auto-opens (hard blocker)**; warm/cold timings reported.

**Manual Chrome checks:** M1 context menu opens panel (fresh/already open) · M2 two quick clicks · M3 click after SW stopped · M4 activeTab same-origin fetch + capture on a real CDN · M5 Sharper-scans grant/deny/revoke · M6 Web Store/`chrome://` pages · M7 two windows · M8 Dutch UI, screen reader, keyboard · M9 Chrome 116 · M10 each grader URL resolves for a real public cert.

## 15. Risks

| Risk | Mitigation |
|---|---|
| R1 Grader URLs unverified | M10 before release; builders in one data table |
| R2 Wrong number opens a plausible record | 0.80 gate, slab-vocabulary penalty, zero-wrong-auto-open gate, number always shown |
| R3 Iframes/CORS/overlays | Capture fallback, per-origin grant, upload/paste |
| R4 QR/barcode content unknown | Unmatched path → .85; digits-only fallback |
| tesseract.js docs discourage `corePath` → single `.js` | Spike verified; exact pins; e2e gate |
| Vendor bundles contain jsDelivr default strings | Overrides mandatory; network-log test is runtime proof; build-info lists occurrences |
| `sidePanel.open` rejects | Popup-window fallback (`?w=`) |
| Global panel replaces another extension's panel | Inherent; accepted |
| Session quota with large `data:` URLs | 2 M-char cap; one slot per window |
| Large probe data URLs over IPC | 15 MB cap; QA measures |
| Panel reflows the page | Measure at capture time |

## 16. Migration and rollback

First release; schemas versioned and migrated on read; no destructive writes. Rollback = republish previous package. No new install-time permission without a re-consent decision. OCR engine is behind `ocr.js` (PaddleOCR swap possible if D3 fails).

## 17. Implementation slices

| Slice | Content | Owner | Depends on |
|---|---|---|---|
| S1 | package.json, build/check scripts, manifest, locales, icons, vendor copy | FE | — |
| S2 | `core/*` + unit tests | FE | — |
| S3 | `sw.js`, `jobContract`, `jobIntake`, `opener`, popup fallback | FE | S1 |
| S4 | `acquire`, `pageProbe`, `probeValidate` | FE | S3 |
| S5 | `preprocess`, `barcode`, `ocr`, `scanner` | FE | S1, S2 |
| S6 | UI states, settings, history, permissions UI, i18n | FE | S3–S5, design spec |
| S7 | Harness, e2e, benchmark | QA | this ADR; `build:e2e` |
| S8 | Manual checks M1–M10 | QA + user | S6 |

## 18. Evidence

Sources fetched directly by the architect: [cookbook.sidepanel-open](https://github.com/GoogleChrome/chrome-extensions-samples/tree/main/functional-samples/cookbook.sidepanel-open) · [side_panel.idl](https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/extensions/api/side_panel.idl) · [active_tab_permission_granter.cc](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/permissions/active_tab_permission_granter.cc) · [permissions_data.cc](https://raw.githubusercontent.com/chromium/chromium/main/extensions/common/permissions/permissions_data.cc) · [tesseract.js api.md](https://raw.githubusercontent.com/naptha/tesseract.js/master/docs/api.md) · [tesseract.js index.d.ts](https://raw.githubusercontent.com/naptha/tesseract.js/master/src/index.d.ts) · [zxing-wasm README](https://github.com/Sec-ant/zxing-wasm). developer.chrome.com was egress-blocked.

**Assumptions to verify:** `windows.getCurrent()` returns the panel's window (M7); activeTab enables extension-origin fetch for the tab origin (M4); `storage.session` 10 MB at 116; `executeScript` returns strings up to ~20 MB.
**Not run:** independent-evaluator scoring, browser execution, live grader URL verification.
