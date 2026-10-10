# CertScanner 0.1.0: release report

_Role: release-manager (specialist agent) · Date: 2026-10-10 (update 2) · Canonical path: `docs/release/release-report.md`._
_Source for this update: HEAD `44ea7bf` on `claude/sharp-turing-1et8ns`; `src/` at HEAD is identical to `03d9589`, the commit QA, performance and security round 2 tested. FE is running an improvement round (SEC-13…19, memory/thumbnail fixes) in the working tree; that work is **not** covered here._
_This report is evidence. It does not override the user's decisions, the ADR or the QA, performance and security reports._

## 1. Outcome

> **Nothing has been submitted, uploaded or published.**
> - No Chrome Web Store developer account, dashboard or credentials were used or requested.
> - No registration fee was paid.
> - The user has not asked for Store submission, so it is **not authorized**.

| Release state | Status |
|---|---|
| Release documents (README, privacy policy, listing draft, permission justifications, manual checklist) | **Prepared** as drafts for user review; SEC-16 label fixes applied in this update |
| A9 page scan evidence (QA, benchmark, performance, security round 2) | **Pass / conditional pass** at `03d9589` (§3) |
| Final local package | **Pending final package.** The orchestrator packages after the improvement round and the QA re-run. |
| Browser verified in branded Chrome (M1–M11, PS1–PS12) | **Not run.** Needs the user. |
| Store upload / review / publication / observed Store install | **Not done.** Not authorized. |

**Overall: not release-ready.** Code-side evidence for A9 now exists, but the improvement round must land and be re-tested, SEC-05 found licence-notice gaps (§5), and the Store/legal gates in §4 need the user.

## 2. Artifact identity

### 2.1 Final release artifact: **pending final package**

| Field | Value |
|---|---|
| Version | `0.1.0` (`manifest.version` and `package.json`) |
| Minimum Chrome | `116` (`minimum_chrome_version`) |
| Source commit | pending (suggested tag `v0.1.0`) |
| Working tree | must be clean (`build-info.gitDirty: false`) |
| Build environment | pending (`node -v`, `npm -v`, OS) |
| Command | `npm ci && npm test && SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package` |
| ZIP size / entries / sha256 | pending |
| `dist/manifest.json` sha256 | pending |
| Vendor sha256 | `dist/build-info.json` → `vendor[]` |

### 2.2 Evidence builds at `03d9589` (observed by specialists; **not** release artifacts)

| Build | Identity | Observed by |
|---|---|---|
| Release `dist/` | `build-info` gitCommit `03d9589…`, gitDirty `false`; `manifest.json` sha256 `0aec47bb6c9faf3baf5f3bd21946a65652cebab78336a4247526aa30a3f9a2e1` | QA, performance, security |
| Test `dist-e2e/` | `manifest.json` sha256 `88fb2414b131391e91e9e0f64767b756c6e084a4568d2fec796010c055784062` (adds `<all_urls>`) | QA, performance, security |
| Test ZIP | `SOURCE_DATE_EPOCH=1760000000 … --package --allow-dirty` on a `git archive` export: 64 entries, 4,658,943 B, sha256 `094f816f…c44b`, identical on two runs | security round 2, performance |

The packaging rehearsal on `bb1666f` (sha256 `e24ec236…8c4034`, 63 files, deterministic, inspected clean) is superseded by these builds.

### 2.3 Stale ZIP in the working tree: do not upload

`/home/user/CertScanner/certscanner-0.1.0.zip` (re-checked 2026-10-10): 4,638,974 bytes, 60 entries, sha256 `da5c64e2d13272dd6a7d18bc79ac79878b6ff0fd97f4f4869fff77bc023fc3d2`, built from `837e84d` with `gitDirty: true`, **no `commands` key (pre-A9)**. It is git-ignored and left in place; the final `npm run package` overwrites it.

## 3. Release gates

Status values: **pass** · **conditional** · **fail** · **not-run** · **external** (needs the user or a third party).

| # | Gate | Status | Evidence / note | Next owner |
|---|---|---|---|---|
| G1 | Unit tests | **pass** at `03d9589` | 164/164 (QA §3; security round 2). Rerun on the final commit. | FE / release |
| G2 | Release check (`npm run check`) | **pass** at `03d9589` | All checks passed; en/nl parity 204 keys; descriptions 126/131 chars (QA §3, security round 2) | release |
| G3 | Deterministic package + ZIP inspection | **pass** (test builds only) | Identical sha256 on two runs at `03d9589` (§2.2). Final artifact pending. | orchestrator / release |
| G4 | E2E suite | **pass** at `03d9589`; **re-run needed** | 52/52, incl. 15/15 page-scan cases (QA §1). Must re-run after the improvement round. | QA |
| G5 | OCR benchmark (D3) | **pass** at `03d9589`; **re-run needed** | 100 % clean (18/18), 88.9 % degraded (32/36), **0 wrong auto-opens**, auto-open precision 48/48 (QA §6). | QA |
| G6 | Security review round 1 | **pass** (closed) | All round-1 code findings re-verified fixed in round 2, except SEC-05 (G12), SEC-07/SEC-10 (accepted/disclosed). | — |
| G7 | Security review round 2 | **conditional pass** at `03d9589` | No critical/high/medium. SEC-13, -14, -15 (Low) and SEC-17, -18, -19 (Info) are being fixed by FE in the improvement round; SEC-13 is recommended before a public 1.0. **SEC-16 (docs, Store-blocking) fixed by the release manager in this update.** Fixes need re-verification on the final commit. | FE, then security / QA |
| G8 | Performance | **conditional** | Every ADR latency budget passes (image scan max 5.06 s / 25 s; page scan 8.1 s p95 / 30 s; idle clean). **Memory flagged:** renderer PSS 568 MiB after 25 scans, no ADR budget; cause is full-size thumbnails. Improvement round (downscaled thumbnails) in progress; re-measure pending. | architect (budget), FE, performance |
| G9 | Manual Chrome checks M1–M11 | **not-run** (external) | `manual-test-checklist.md` §A | user (+ QA) |
| G10 | Manual page-scan checks PS1–PS12 | **not-run** (external) | `manual-test-checklist.md` §B (replaces PS1–PS10; PS4 rewritten for O12) | user (+ QA) |
| G11 | Live grader URL check (R1 / M10) | **not-run** (external) | `psacard.com` and `cgc*.com` are blocked here. A wrong URL pattern breaks every opened page: **hard blocker before public release.** | user |
| G12 | Licence texts vs upstream (SEC-05) | **fail** (comparison done) | §5: libpng text is the wrong licence version; giflib, libwebp, openlibm and libzueci notices missing; smaller corrections. | FE / build owner, then release |
| G13 | Project `LICENSE` file | **fail** (external decision) | `package.json` says MIT; no `LICENSE` file. Needs the copyright holder's name from the user. | user, then orchestrator |
| G14 | Privacy policy matches code | **pass** at `44ea7bf` (`src` = `03d9589`); **re-check** | SEC-16 fixed: labels match `messages.json`; history (`pageHost` always `null`) and `lastResult` (one host name, 12 h, session) described precisely. Re-check after SEC-13 (probe visibility, RM-13) and SEC-18 (Clear history / `lastResult`, RM-11) land. | release |
| G15 | Privacy policy hosted at a public URL; contact | **external** | `PRIVACY.md` ready; `<maintainer contact>` placeholder. Then FE wires About → "Privacy policy" (`privacy_link`). | user, then FE |
| G16 | Store screenshots 1280×800 (or 640×400) | **not-run** | Existing captures are 360 px panel crops from before A9. Plan in `store-listing.md` §5.2. | QA/FE + user |
| G17 | Small promo tile 440×280 | **not-run** | Missing (required). Brief in `store-listing.md` §5.3. | designer / user |
| G18 | Listing copy, single purpose, permission justifications, data-use answers | **pass** (draft) | Updated for SEC-16. Verify against the live dashboard. | user |
| G19 | Homepage / support URL / contact | **external** | Placeholders only. | user |
| G20 | Developer account, verification, registration fee | **external** | A one-time fee applies per the docs; amount not verified or stated. | user |
| G21 | Store submission | **not-run: not authorized** | Needs an explicit user decision; then unlisted / trusted testers with deferred publishing. | user |
| G22 | Review acceptance, publication, observed Store install | **not-run** | Depends on G21. Submitted is not accepted. | user |

## 4. Findings and blockers (release manager)

| ID | Severity | Finding | Owner |
|---|---|---|---|
| RM-1 | **Blocker** | Improvement round (SEC-13…19, thumbnails) not yet committed. Package only after: FE commit → QA e2e + benchmark re-run → security spot-check of SEC-13/14/15 → performance memory re-measure. | FE, QA, security, performance |
| RM-2 | **Blocker (Store)** | No public privacy-policy URL, support URL or contact (G15, G19). | user |
| RM-3 | **Blocker (Store)** | No screenshot at 1280×800 showing A9; small promo tile missing (G16, G17). | QA/FE, user |
| RM-4 | **Blocker (legal)** | SEC-05 comparison found gaps (§5, G12). `LICENSE` file missing (G13). | FE / build owner, user |
| RM-5 | **Blocker (public release)** | Live URL check M10 not run (G11). | user |
| RM-6 | Closed | Toolbar tooltip now "Scan this page for slab cert numbers" and switches to "Open CertScanner" when the setting is off. | — |
| RM-7 | Closed | Settings heading is now "Sites with full access" / "Sites met volledige toegang". | — |
| RM-8 | Info | Stale pre-A9 ZIP in the working tree (§2.3). | overwritten by the final package |
| RM-9 | Info | Use `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)` until SEC-15 makes commit time the default. | release / FE |
| RM-10 | Minor (docs dependency) | QA O12: "Always allow on ‹site›" is practically unreachable. The docs now call it rare. If the architect drops it or moves to `permissions.addHostAccessRequest` (Chrome 133+), update `PRIVACY.md` §4, README troubleshooting, `permission-justifications.md` and `store-listing.md` §9. | architect, then release |
| RM-11 | Minor (pending FE) | SEC-18: at `44ea7bf`, **Clear history** and turning off **Keep scan history** do not clear `lastResult:<windowId>`. `PRIVACY.md` therefore describes the last result neutrally (replaced, 12 h, cleared when Chrome closes). If FE's fix lands, add "Clear history also clears the last result" to `PRIVACY.md` §5 (EN + NL). | FE, then release |
| RM-12 | Info | `sidepanel.html` fallback text for the sites heading is still "Sharper scans" (replaced at runtime by `settings_sites_heading`). Cosmetic. | FE (optional) |
| RM-13 | Minor (pending FE) | FE's uncommitted SEC-13 change to `pageImagesProbe.js` also reads each image's computed CSS visibility/opacity and does a hit test at its centre (`topmostAtCenter`, plus a `total` count). If it ships, add "and whether each image is hidden or covered" to the photo-list row of `PRIVACY.md` §1 (EN + NL) and to the `scripting` justification. Still no page text or other content. | release (after FE commit) |

## 5. SEC-05: upstream licence comparison (performed 2026-10-10)

**Upstream identity used.**
- tesseract.js-core `v7.0.0`: `.gitmodules` and `build-scripts/*.sh` read from `raw.githubusercontent.com/naptha/tesseract.js-core/v7.0.0/`. Submodule commits read from the GitHub tree page `naptha/tesseract.js-core/tree/v7.0.0/third_party` (WebFetch): leptonica `4af068b`, libjpeg (LuaDist mirror) `6c0fcb8`, libpng `a37d483`, libtiff `b51bb15`, zlib `21767c6`, giflib `fa37672`, libwebp `20ef03e`, openlibm `ae2d916`, tesseract (Balearica fork) `2a9c1c4`. Each short SHA resolved on `raw.githubusercontent.com` (libtiff on `gitlab.com`).
- Cross-check against the shipped `tesseract-core-simd-lstm.wasm`: `1.6.38.git` = `png.h` at `a37d483`; `1.2.12` = `ZLIB_VERSION` at `21767c6`; `Copyright (C) 2014, Thomas G. Lane, Guido Vollbeding` = `JCOPYRIGHT` of IJG libjpeg **9a** at `6c0fcb8`. So the compiled JPEG library is IJG libjpeg 9a, not libjpeg-turbo.
- zxing-wasm `v3.1.5`: `.gitmodules` and `src/cpp/CMakeLists.txt` from raw; zxing-cpp submodule `2ecec3f` (GitHub tree page via WebFetch).
- Link inputs: Balearica/tesseract `CMakeLists.txt` at `2a9c1c4` links `libgif.a`, `libjpeg.a`, `libopenlibm.a`, `libpng.a`, `libtiff.a`, `libtiffxx.a`, `libwebp*.a`, `libz.a`. The shipped WASM contains libwebp strings (`VP8Decode()`, `VP8GetHeaders()`) and Leptonica's real GIF code (`pixReadMemGif`, `failed to create GIF color map`). openlibm has no identifying strings, so its presence can't be confirmed from the binary.

**Results.**

| Component | Shipped file (`third_party/licenses/`) | Upstream file compared | Outcome |
|---|---|---|---|
| Leptonica | `leptonica.BSD-2-Clause.txt` | `leptonica-license.txt` @ `4af068b` | Terms identical (BSD-2). Copyright line differs: shipped "2001-2024", upstream "2001-2020". **Use upstream text.** |
| IJG libjpeg 9a | `libjpeg-turbo-and-IJG.debian-copyright.txt` | `README` "LEGAL ISSUES" @ `6c0fcb8` | IJG terms identical; year "1991-2010" vs "1991-2014". The file describes libjpeg-turbo, which is not what is compiled. **Replace with the IJG 9a LEGAL ISSUES text.** The required acknowledgement is already in `THIRD_PARTY_NOTICES.txt` and enforced by `--check`. |
| libpng 1.6.38 | `libpng.debian-copyright.txt` | `LICENSE` @ `a37d483` | **Mismatch:** the Debian file carries the older libpng licence wording and Debian packaging terms, not "PNG Reference Library License version 2" that governs 1.6.38. **Replace with upstream `LICENSE`.** |
| LibTIFF | `libtiff.debian-copyright.txt` | `COPYRIGHT` @ `b51bb15` | Licence terms identical (Sam Leffler / SGI). Debian file adds extra holders and a `debian/*` stanza. Acceptable; upstream file preferred. |
| zlib 1.2.12 | `zlib.debian-copyright.txt` | `zlib.h` header @ `21767c6` | Terms identical; year "1995-2013" vs "1995-2022". Update the year. |
| zxing-cpp | `zxing-cpp.Apache-2.0.txt` | `LICENSE` @ `2ecec3f` (no `NOTICE` file, 404) | Identical Apache-2.0 text, except `{}` vs `[]` in the appendix boilerplate. **OK.** |
| Tesseract | (shipped as tesseract.js-core's Apache-2.0 `LICENSE`) | `LICENSE` @ `2a9c1c4` (no `NOTICE`, 404) | Apache-2.0; no extra notice file. **OK.** |
| **giflib** | **missing** | `COPYING` @ `fa37672` (MIT-style, Eric S. Raymond) | Linked. Notice must be included. **Add.** |
| **libwebp** | **missing** | `COPYING` + `PATENTS` @ `20ef03e` (BSD-3-Clause, Google) | Linked; binary redistribution must reproduce the notice. **Add.** |
| **openlibm** | **missing** | `LICENSE.md` @ `ae2d916` (MIT/BSD/ISC mix) | On the link line; presence unverified. **Add (conservative).** |
| **libzueci** (inside zxing-cpp) | **missing** | header of `core/src/libzueci/zueci.h` @ `2ecec3f` (BSD-3-Clause, "Copyright (C) 2022 gitlost") | Compiled when `ZXING_ENABLE_UNICODE` (default ON) with readers ON; presence unverified. **Add (conservative).** zxing-wasm also links `stb` (public domain / MIT); an acknowledgement is optional. |

**Outcome:** SEC-05 stays **open (fail)**. Fix (FE / build owner; `third_party/**`, `scripts/build.mjs` and `THIRD_PARTY_NOTICES` are not release-manager files): replace the Leptonica, IJG and libpng texts with the upstream files above; update the zlib year; add giflib, libwebp (+ `PATENTS`), openlibm and libzueci; list them in `THIRD_PARTY_NOTICES.txt` and require them in `--check`; update `third_party/licenses/README.md`. The fetched upstream texts are in the session scratchpad `…/scratchpad/lic/` (not committed). Then the release manager re-runs this comparison on the final `dist/vendor/licenses/`.

**Not verified:** legal sufficiency. This is a text comparison, not legal advice.

## 6. Final packaging procedure (after RM-1 is closed)

1. **Preconditions:** improvement round committed; QA e2e + benchmark pass on that commit (G4, G5); security has no open blocker for SEC-13/14/15 (G7); SEC-05 fixes in place (G12); `LICENSE` added (G13).
2. **Clean checkout:** `git status --porcelain` empty; `npm ci`.
3. **Build and package:** `npm test`, then `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package`. Save the full output (sha256, file count, size, commit).
4. **Inspect the ZIP:** manifest at the root, version `0.1.0`; permissions, `commands` and `incognito` match `permission-justifications.md`; no dev files, source maps or secrets; grader hosts are the only real URLs; licence files match §5.
5. **Smoke-test the exact package:** unzip into an empty folder, load it unpacked in branded Chrome, run PS1 and M1.
6. **Record:** fill in §2.1; re-check `PRIVACY.md` against the final code (G14, RM-11); tag `v0.1.0`; keep ZIP, sha256 and this report together.
7. **Stop** unless the user authorizes a Store upload.

## 7. Rollout, migration and rollback plan (for when the user decides to publish)

- **Migration:** first release; no earlier version. Storage schemas are versioned and migrated on read: settings v1 (four booleans in `sync`), history v1, `ScanJob` v1, `lastResult` v1. Newer synced settings are read tolerantly and not overwritten unless the user edits them. No backend.
- **Staged rollout:**
  1. Upload as **unlisted** or **trusted testers**, with **deferred publishing**.
  2. The user installs the Store-delivered build and runs `manual-test-checklist.md` §C.
  3. Publish publicly.
  4. For later updates, use percentage rollout if offered (**verify live**).
- **Permissions:** a new install-time permission in an update disables the extension until users accept it. Keep new access optional (ADR §16).
- **Rollback:** no instant rollback. Re-upload the previous code under a **higher** version (for example 0.1.1); it goes through review. Chrome picks up updates over hours. Unpublishing stops new installs only. Keep every released ZIP and its sha256.
- **Grader URL changes:** need an extension update; builders are in `src/core/certUrls.js`.
- **Monitoring and support:** no telemetry, by design and as promised in `PRIVACY.md`. Feedback via the Store support hub and the support URL (G19).

## 8. Assumptions

- Store requirements come from the GitHub copy of the developer.chrome.com docs (2021–2023) and 2026-10-10 search snippets (`store-listing.md` §0). The live site and dashboard could not be reached.
- **Website content: Yes** and **Web history: No** are judgment calls to confirm against the live definitions (`store-listing.md` §7).
- The submodule commits in §5 come from GitHub's tree pages read through WebFetch; the version cross-check against the shipped WASM supports them for libpng, zlib and libjpeg.
- `PRIVACY.md` describes `src/` at `44ea7bf`. FE's in-progress changes to `pageImagesProbe.js`, `pageAggregate.js` and `probeValidate.js` (seen in the working tree) are not reviewed here.

## 9. Sources checked (2026-10-10)

- Project: `docs/quality/test-report.md` (QA, `03d9589`), `docs/quality/performance-report.md`, `docs/quality/security-review.md` (rounds 1–2), `src/_locales/{en,nl}/messages.json`, `src/shared/history.js`, `src/shared/lastResult.js`, `src/sidepanel/main.js`, `src/sidepanel/opener.js` at `44ea7bf`.
- Upstream licence sources: as listed in §5 (`raw.githubusercontent.com`, `gitlab.com`, GitHub tree pages via WebFetch).
- Store docs: GitHub `GoogleChrome/developer.chrome.com` (`site/en/docs/webstore/…`); web search snippets for [Supplying Images](https://developer.chrome.com/docs/webstore/images) and [Creating a great listing page](https://developer.chrome.com/docs/webstore/best-listing). Direct fetch of `developer.chrome.com`: **failed** (`ENOTFOUND`).

## 10. Files written by the release manager (this update)

- `README.md`, `PRIVACY.md`
- `docs/release/release-report.md` (this file), `store-listing.md`, `permission-justifications.md`, `manual-test-checklist.md`

Nothing in `src/**`, `tests/**`, `scripts/**` or `third_party/**` was changed.

## 11. Next owners

| Owner | Next steps |
|---|---|
| FE | Finish the improvement round; SEC-05 licence fixes (§5); optional RM-12; wire the privacy link after G15. |
| QA | Re-run e2e + benchmark on the improvement-round commit; Store screenshots 1, 2, 4, 5 at 1280×800 (G16). |
| Security reviewer | Spot-check SEC-13/14/15/17/18/19 fixes on the final commit. |
| Performance | Re-measure renderer memory after the thumbnail fix. |
| Architect | Memory budget (G8); O12 "Always allow" decision (RM-10); O8. |
| Release manager | RM-11 wording once SEC-18 lands; re-run §5 on the final `dist/vendor/licenses/`; G14 re-check; final ZIP inspection with the orchestrator. |
| User | M1–M11 and PS1–PS12 (incl. M10); `LICENSE` copyright holder; contact, support and homepage URLs; privacy-policy hosting; screenshot 3 (context menu); promo tile approval; whether to create a developer account and submit at all. |
