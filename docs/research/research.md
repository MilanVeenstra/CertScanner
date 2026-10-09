# CertScanner — Product Research Brief

**Role:** product-researcher (native specialist agent) · **Date:** 2026-10-09 · **Execution:** web research only; orchestrator feasibility spike appended at the end.

**How sources were checked.** The session's egress proxy blocked direct fetches of developer.chrome.com, psacard.com,
api.psacard.com, cgccomics.com, cgccards.com, chromewebstore.google.com, MDN, chromestatus.com, the app stores and most
collector sites. Claims from those hosts come from search-engine excerpts and are marked **(excerpt)**. Chromium source,
MDN browser-compat-data (via GitHub) and npm registry metadata were read directly and are marked **(direct)**.

Tags: **F** = fact observed in a source · **I** = inference · **GAP** = not verified.

---

## 1. Audience, job, single purpose

- **Audience:** buyers and collectors browsing graded PSA or CGC slabs on eBay, Facebook, forums and shop sites.
- **Job:** "Is this slab's cert real, and does it match the photo?" Today that means reading 8–13 digits off a small photo and typing them into the grader's site.
- **Success:** one right-click opens the grader's official cert page with the correct number. No account, no upload.
- **Single-purpose statement:** *"Reads the certification number from a PSA or CGC graded-slab image you choose, or from a number you type, and opens that grader's official verification page."* Paste, drop, upload and manual entry are different inputs to the same purpose ([Quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines), excerpt).
- **Out of scope for v1:** price/population data, grade prediction, authenticity verdicts; PSA/DNA stand-alone COAs, CGC Video Games, CBCS/BGS/SGC/TAG; any backend or PSA/CGC API calls; Firefox/Safari.

## 2. Official cert URLs

| Grader | URL to open | Evidence |
|---|---|---|
| PSA (cards, incl. slabbed autos) | `https://www.psacard.com/cert/{n}` | **F** Indexed pages exist at `/cert/128260730`, `/Cert/01819919` and with a `/psa` suffix, e.g. `/cert/123535672/psa` ([1](https://www.psacard.com/cert/128260730), [2](https://www.psacard.com/cert/123535672/psa), [3](https://www.psacard.com/Cert/01819919)) (excerpt). **F** [/cert](https://www.psacard.com/cert) says "Verify the validity of PSA & PSA/DNA certification numbers" (excerpt). **GAP** whether `/cert/{n}` redirects to `/cert/{n}/psa`. |
| CGC Comics (and magazines) | `https://www.cgccomics.com/certlookup/{n}/` | **F** CGC's 2022-07-07 [QR announcement](https://www.cgccomics.com/news/article/10362/qr-code-comics/) names "CGCcomics.com/certlookup" (excerpt). **GAP** the `/{n}/` deep link is inferred from the cards site. |
| CGC Cards (former CSG) | `https://www.cgccards.com/certlookup/{n}/` | **F** Indexed pages `cgccards.com/CERTLOOKUP/1401036622258/10_0/`, `/CERTLOOKUP/4340250002/0_0/` ([4](https://www.cgccards.com/CERTLOOKUP/1401036622258/10_0/), [5](https://www.cgccards.com/CERTLOOKUP/4340250002/0_0/)) and `cgccards.uk/certlookup/6108376090` ([6](https://www.cgccards.uk/certlookup/6108376090)) (excerpt). **F** CSG and CGC Trading Cards merged under the CGC name in July 2023 ([CGC](https://www.cgccards.com/news/article/11754/cgc-cards-merger/)) (excerpt). **F** A cached lookup page showed "search limit" messages (excerpt). |
| Unified CGC lookup? | None found | **GAP** |
| CGC Video Games | Out of scope for v1 | **F** separate site [cgcvideogames.com](https://www.cgcvideogames.com/en-US/resources) (excerpt). |

Bot blocking/client rendering is irrelevant (**I**): the extension only opens a tab in the user's own browser.

## 3. Cert number formats and telling PSA from CGC

- **PSA:** 8 digits, sometimes with a leading zero (`01819919`, `04440304`), and 9 digits (`108114622`, `128260730`) (**F**). A third-party guide says "8–10 digits, bottom-right of the front label; repeated with a barcode on the reverse since Dec 2015; QR on the back of newer slabs" ([pregradecards](https://pregradecards.com/blog/psa-cert-lookup-guide-verify-slab-2026), secondary, excerpt).
- **CGC Comics:** 10 digits (e.g. `4676972020`, `4610940017` in [eBay titles](https://www.ebay.com/itm/137122819829)) (excerpt). Older labels reportedly 7–8 digits (unverified).
- **CGC Cards:** 13 digits starting `1401…` and 10 digits (`4340250002`, `6108376090`) (**F**).

**Can the number alone decide?** Only partly: 13 digits → CGC Cards; 8–9 digits → PSA (collides with old CGC comics);
10 digits → CGC Comics or Cards (or a future PSA number). Label keywords are needed (**I**):

- PSA: "PSA", grade strings such as "GEM MT 10", "MINT 9", "NM-MT 8", "AUTHENTIC".
- CGC comics: "CGC", "UNIVERSAL GRADE", "SIGNATURE SERIES", "QUALIFIED", "RESTORED", "…WHITE PAGES".
- CGC cards: "CGC" plus card wording such as "GEM MINT", "PRISTINE".
- Strip separators (`1234567-001` → `1234567001`); keep numbers as strings so leading zeros survive.
- No known check digit (GAP) → low-confidence results go to the user to confirm.

## 4. Barcodes and QR codes on labels

- **PSA:** back-label barcode + cert number since Dec 2015; QR on the back of newer labels (secondary, excerpt). Forum: the barcode holds only the cert number ([forum](https://forums.collectors.com/discussion/comment/9175159), excerpt). **GAP:** symbology and exact QR content.
- **CGC Comics:** QR codes on labels since July 2022 linking to the cert description (**F**, excerpt). **GAP:** exact URL.
- **CGC Cards:** "unique certification number and barcode"; QR on the back leads to the CGC Cards site ([holder-label](https://cgccards.com/card-grading/holder-label), excerpt).
- **I:** Marketplace photos usually show the front, where the code is absent (PSA) or small/blurry → barcode is a fast high-confidence path when it works; OCR is the main path.
- **Security rule:** never navigate to a decoded QR URL. Extract the number and rebuild the official URL; accept QR hosts only from an allow-list.

## 5. Official APIs

- **F:** [PSA Public API](https://www.psacard.com/publicapi/documentation): base `https://api.psacard.com/publicapi/`, path `/cert/GetByCertNumber/{certNumber}`; bearer token generated from a PSA login; 100 calls/day free (excerpt). **GAP:** API ToS. No CGC public API found.
- **Conclusion (I):** v1 only opens the official page — a per-user secret token can't ship in a public bundle, a shared 100/day cap would not scale, and it would add credential handling and privacy disclosure for no benefit to the core job.

## 6. On-device OCR options

**Tesseract.js — recommended for v1**
- **F:** `tesseract.js` 7.0.0, Apache-2.0, published 2025-12-15; 15–35% faster than v6; new `relaxedsimd` build ([npm](https://registry.npmjs.org/tesseract.js), [releases](https://github.com/naptha/tesseract.js/releases), direct).
- **F:** Core builds `tesseract-core{,-simd,-relaxedsimd}{,-lstm}.wasm(.js)`; only one LSTM variant is needed.
- **F:** `eng` model: 3.92 MB tessdata_fast, 14.7 MB tessdata_best; tesseract.js defaults to `4.0.0_best_int` ([FAQ](https://github.com/naptha/tesseract.js/blob/master/docs/faq.md)).
- **F:** Options: `workerBlobURL`, `workerPath`, `corePath`, `langPath`, `cacheMethod`, `gzip`; `setParameters({tessedit_char_whitelist, tessedit_pageseg_mode})`; `rectangle` ([api.md](https://github.com/naptha/tesseract.js/blob/master/docs/api.md)).
- **F:** By default worker/core/lang load from jsDelivr (= remote code) ([local-installation.md](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)).
- **F:** [Issue #961](https://github.com/naptha/tesseract.js/issues/961) MV3 recipe: bundle everything, `chrome.runtime.getURL(...)` paths, `workerBlobURL: false`, options as the 3rd `createWorker` argument, run from an extension page or offscreen document (content-script workers are blocked by page CSP).
- **F:** `Worker` is `Exposed=(Window,DedicatedWorker)` ([worker.idl](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/workers/worker.idl), direct) → the MV3 service worker cannot start a Worker. Tesseract must run in an offscreen document (reason `WORKERS`) or an extension page such as the side panel. `OffscreenCanvas` is `Exposed=(Window,Worker)`.
- **F:** CSP minimum `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` ([CSP doc](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), excerpt).
- **F:** Accuracy: ≥300 dpi (upscale), deskew, crop with border, PSM 6/7/11, digit whitelist ([tessdoc](https://raw.githubusercontent.com/tesseract-ocr/tessdoc/main/ImproveQuality.md)).

**Rejected/deferred alternatives**
- **TextDetector:** `status: "experimental"` in Chromium runtime flags (direct) → behind a flag. Rejected.
- **Prompt API / Gemini Nano with images:** `AIPromptAPIMultimodalInput` stable on desktop in Chromium main; BCD lists `LanguageModel` as Chrome 148 desktop (direct). Needs 22 GB disk + strong GPU/RAM ([get-started](https://developer.chrome.com/docs/ai/get-started), excerpt). Can hallucinate digits → optional v2 "second opinion" only.
- **PaddleOCR + onnxruntime-web:** `onnxruntime-web` 1.30.0 MIT; PP-OCRv5 mobile ≈21 MB → ~3× bundle and a self-built pipeline. Fallback if Tesseract misses the accuracy gate.

## 7. Barcode decoding

- **Native `BarcodeDetector`:** stable only on Android, ChromeOS and macOS; Windows/Linux "test" (direct). Use opportunistically.
- **zxing-wasm (recommended):** 3.1.5, MIT wrapper around zxing-cpp (Apache-2.0); reader wasm ≈1 MiB; default loads from jsDelivr → override `prepareZXingModule({overrides:{locateFile}})`; formats QR, Code128, Code39, ITF, DataMatrix…; `tryHarder`, `formats` ([README](https://github.com/Sec-ant/zxing-wasm), direct).
- Rejected: `@zxing/library` (maintenance mode), `@undecaf/zbar-wasm` (LGPL-2.1+).

## 8. Getting the image pixels with minimal permissions

**Facts:**
- `contextMenus` `image` context gives `srcUrl`, `mediaType`, `frameId`, `frameUrl`, `pageUrl` ([context_menus.json](https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/extensions/api/context_menus.json), direct).
- A context-menu click grants activeTab and dispatches `onClicked` with a user gesture ([menu_manager.cc](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/extensions/menu_manager.cc), direct; [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), excerpt).
- `captureVisibleTab` needs `<all_urls>` or `activeTab`; max 2 calls/s ([tabs.json](https://raw.githubusercontent.com/chromium/chromium/main/chrome/common/extensions/api/tabs.json), direct).
- Content-script requests follow page CORS; extension pages bypass CORS only for origins with host permission ([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests), excerpt).
- `permissions.request` must run during a user gesture ([permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions), excerpt).
- eBay `s-l500` → `s-l1600` swap is community-observed and undocumented ([eBay community](https://community.ebay.com/t5/Report-eBay-Technical-Issues/quot-Full-size-quot-gallery-images-are-only-500-pixels/td-p/34988290), excerpt).

**Recommended order of attempts (I):**
1. `data:` URL → decode directly.
2. activeTab + scripting into `frameId`: find the `<img>` matching `srcUrl`, return rect, DPR, natural size, largest `srcset` candidate; try page-context `fetch` (same-origin, CORS-enabled, `blob:`).
3. If an optional host permission for the image origin is granted, fetch full resolution from the extension.
4. Otherwise `captureVisibleTab` and crop to rect × DPR (displayed resolution only).
5. Offer "Sharper scans on this site" requesting just that origin, via `"optional_host_permissions": ["https://*/*"]`.
6. Restricted pages / injection failure → ask the user to upload or paste.

**GAP:** CORS headers on eBay/Facebook CDNs; activeTab reach into cross-origin child frames; overlay `<div>` sites without the `image` context.

## 9. Chrome Web Store policy

- **Remote code:** all WASM, workers and traineddata must be packaged ([MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements), excerpt). Add a check that fails if `cdn.jsdelivr.net` appears in the bundle.
- **Least privilege:** each permission needs a justification ([privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), excerpt).
- **Disclose local processing** ([user-data FAQ](https://developer.chrome.com/docs/webstore/user_data/), excerpt): "website content (images you select) processed on-device, never transmitted; the cert number is sent only by opening the grader's page".
- **Trademarks** ([impersonation & IP](https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property), excerpt): keep the name "CertScanner"; "for PSA and CGC slabs" only descriptively; no grader logos; "Not affiliated with PSA or CGC" disclaimer.

## 10. Competitors and prior art

| Alternative | Observed capability | Friction / gap |
|---|---|---|
| CertCheck for Chrome ([CWS](https://chromewebstore.google.com/detail/mofjoojkbejdalfenhcmbcgdjenpijok), excerpt) | Type a number, pick PSA/CGC/PGS, opens cert page; updated 2021-11-06, ~49 users | Manual typing; stale |
| PSA app ([App Store](https://apps.apple.com/us/app/psa-cert-verification/id996239729), excerpt) | Scan PSA labels | Phone only, PSA only, physical slab |
| CardGrade.io extension ([site](https://cardgrade.io/chrome-extension), excerpt) | Right-click card images for AI grade prediction (cloud) | Proves right-click UX; doesn't verify certs |
| GoCollect Cert Lookup ([help](https://gocollect.com/help-center/post/gocollect-cert-lookup), excerpt) | Number, image URL, upload or camera | Web tool; images go to their server (I) |
| eBay PSA data ([SCD, 2025-01-22](https://sportscollectorsdigest.com/news/ebay-adds-psa-population-reports-for-trading-card-listings-), excerpt) | PSA data when seller enters cert | eBay + PSA only |
| Google Lens in Chrome ([TechCrunch](https://techcrunch.com/2022/05/24/google-lens-comes-to-chrome-for-searching-using-images-from-webpages/), excerpt) | Select and copy text from images | Image goes to Google; user still copies/pastes/picks grader |
| CheckCOA, CertCheck Android ([checkcoa](https://checkcoa.com/), [Play](https://play.google.com/store/apps/details?id=com.mnm.certcheck.verification&hl=en_US), excerpt) | Camera OCR/QR | Not in the desktop browser |

**Differentiator (I):** one right-click on any site, on-device processing, both graders, official page opened directly.

## 11. Acceptance journeys

1. **PSA happy path.** Right-click a front-label photo containing `01234567` → "Scan cert number" → tab opens at `https://www.psacard.com/cert/01234567` (leading zero kept); result shows "PSA · 01234567 · OCR" with Edit.
2. **CGC comic.** 10-digit label with "UNIVERSAL GRADE"/"WHITE PAGES" → `https://www.cgccomics.com/certlookup/{n}/`.
3. **CGC card.** 13-digit `1401…` label → `https://www.cgccards.com/certlookup/{n}/`; 10 digits with card wording does the same.
4. **QR/barcode.** Back-of-slab QR decoded → number extracted, official URL rebuilt; off-allow-list QR host never opened, user warned.
5. **Ambiguous.** 10 digits with no keywords, low confidence, or two candidates → no automatic tab; candidates + grader selector + editable field → confirm to open.
6. **No number.** Non-slab image → "No certification number found", manual entry/upload offered; no tab.
7. **Fetch blocked.** CDN without CORS → crop fallback still works; "Sharper scans on <host>" prompt names only that host; declining keeps manual entry working.
8. **Restricted page** → clear "Chrome doesn't allow reading this page" + upload/paste; no uncaught worker errors.
9. **Manual entry.** `PSA 12345678` or a 13-digit CGC number → correct URL; invalid input → inline error via `aria-live`; fully keyboard operable (WCAG 2.2 AA).
10. **Paste / drop / upload** → same pipeline, works offline.
11. **Privacy.** Network log during a scan shows only the image origin (if fetched) and the final official page; no CDN requests; no host permissions at install.

## Recommendations

- **Manifest:** `contextMenus`, `activeTab`, `scripting`, `storage`, `sidePanel`; `optional_host_permissions: ["https://*/*"]` requested per origin; no install-time host access; CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`; `minimum_chrome_version` 116.
- **Pipeline:** pixels (§8) → BarcodeDetector/zxing-wasm → Tesseract keyword pass (PSM 11) + digits pass on upscaled label band → score candidates → auto-open only when confident.
- **v1:** right-click scan, PSA + CGC Comics/Cards, QR/barcode + OCR, result/confirm UI, manual entry, paste/drop/upload, per-origin opt-in, accessibility.
- **Later:** Prompt API second opinion, region-select screen scan, CGC Video Games, other graders, PaddleOCR if needed.
- **Rejected:** PSA API in a client extension; TextDetector; `<all_urls>`; CDN-loaded code; @zxing/library; zbar.

## Decisions (resolved by orchestrator 2026-10-09)

| ID | Decision | Resolution |
|---|---|---|
| D1 | Where results appear / OCR runs | Side panel opened synchronously in `onClicked`; it hosts the pipeline, Tesseract worker, results, manual entry and upload. No offscreen document. |
| D2 | Pixel acquisition | activeTab + capture fallback + per-origin optional host permission; no install-time host access. |
| D3 | OCR engine | Tesseract.js 7 (LSTM-only SIMD core, `eng` best_int) gated by synthetic fixture benchmark. |
| D4 | 10-digit CGC routing | Keywords decide; with no card/comic signal show both CGC choices and require confirmation. |
| D5 | Auto-open | Default on, only for a single high-confidence candidate with a known grader; setting "Always ask before opening". |
| D6 | Listing wording | Name "CertScanner", descriptive "for PSA and CGC slabs", disclaimer "Not affiliated with PSA or CGC". |

## Open risks

- **R1:** Live URL patterns unverified (grader hosts egress-blocked) — check manually in a real browser before release.
- **R2:** OCR accuracy on small/glare/JPEG marketplace photos; a wrong number opens a plausible but wrong record → confidence gating, always show the number read.
- **R3:** CDN CORS, iframes and overlays push scans to the lower-resolution capture fallback.
- **R4:** PSA barcode type/QR content and CGC QR content unknown.
- **R5:** CGC lookup rate limiting.
- **R6:** Formats can change → keep routing rules in a small data table.
- **R7:** Bundle ≈8–10 MB; cold start unmeasured.
- **R8:** A verified lookup ≠ an authentic slab (counterfeiters reuse real numbers) — the UI must not claim authenticity.

---

## Orchestrator feasibility spike (observed 2026-10-09)

Environment: Linux container, Playwright 1.56.1, bundled Chromium 141.0.7390.37 headless, Node 22.22.0.

| Check | Result |
|---|---|
| npm availability | `tesseract.js@7.0.0` (depends on `tesseract.js-core@^7.0.0`), `zxing-wasm@3.1.5`, `@tesseract.js-data/eng@1.0.0` install from the npm registry. Grader sites and jsDelivr are blocked from this container. |
| Asset sizes on disk | `tesseract-core-simd-lstm.wasm` 2.86 MB + loader 89 KB; `worker.min.js` 111 KB; `tesseract.min.js` 63 KB; `eng.traineddata.gz` (4.0.0_best_int) 2.95 MB; `zxing_reader.wasm` 0.97 MB + IIFE 37 KB → ≈7 MB total. |
| Tesseract in a loaded MV3 extension page | **Pass.** Unpacked extension with CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`, `workerBlobURL:false`, `chrome.runtime.getURL` paths, `cacheMethod:'none'`, `gzip:true`. Synthetic PSA-style label → text contained `81234567`; synthetic CGC-style label → `CERTIFICATION # 4012345001`. Init ≈0.5–0.75 s, recognition ≈0.2–0.3 s on a 452×548 image. |
| zxing-wasm in extension page | **Pass** for QR (`https://www.cgccomics.com/certlookup/4012345001/`). A Code128 barcode that had been down-scaled to ~1.2 px per module was **not** decoded at any scale/binarizer → realistic small barcodes will often fail; OCR stays primary. |
| Keyword detection | Large red "PSA" brand text was **not** returned by OCR in the spike → grader detection must not rely on the brand word alone (use grade wording + number length + preprocessing). |
