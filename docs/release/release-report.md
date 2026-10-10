# CertScanner 0.1.0: release report

_Role: release-manager (specialist agent) · Date: 2026-10-10 · Canonical path: `docs/release/release-report.md`._
_This report is evidence. It does not override the user's decisions, the ADR or the QA and security reports._

## 1. Outcome

> **Nothing has been submitted, uploaded or published.**
> - No Chrome Web Store developer account, dashboard or credentials were used or requested.
> - No registration fee was paid.
> - The user asked for research, design and implementation, not for publication, so Store submission is **not authorized**.

| Release state | Status |
|---|---|
| Release documents (README, privacy policy, listing draft, permission justifications, manual checklist) | **Prepared**, as drafts for user review |
| Final local package (`certscanner-0.1.0.zip` from the final commit) | **Not built yet.** Waiting for FE to finish A9 page scan, then the QA re-run and security round 2. |
| Packaging rehearsal on `bb1666f` | **Pass**: deterministic, inspected (section 2.2). Not a release artifact. |
| Browser verified in branded Chrome (M1–M11, PS1–PS10) | **Not run.** Needs the user. |
| Store upload / review / publication / observed Store install | **Not done.** Not authorized. |

**Overall:** **not release-ready.** Blockers are listed in section 4. Once they are closed, the project can reach "package ready" without any external action. The Store steps after that need the user's own accounts and decision.

## 2. Artifact identity

### 2.1 Final release artifact (fill in after the final build)

| Field | Value |
|---|---|
| Version | `0.1.0` (`manifest.version` and `package.json`) |
| Minimum Chrome | `116` (`minimum_chrome_version`) |
| Source commit | `<final commit sha>` (suggested tag `v0.1.0`) |
| Working tree | must be clean (`build-info.gitDirty: false`; `npm run package` refuses a dirty tree) |
| Build environment | `<node -v>`, `<npm -v>`, `<OS>` |
| Command | `npm ci && npm test && SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package` |
| Package | `certscanner-0.1.0.zip`, built from `dist/` only, with the manifest re-validated inside the ZIP |
| ZIP size / entries | `<bytes>` / `<n>` |
| ZIP sha256 | `<sha256 printed by npm run package>` |
| `dist/manifest.json` sha256 | `<sha256>` |
| Vendor sha256 | in `dist/build-info.json` → `vendor[]` |

### 2.2 Packaging rehearsal (observed 2026-10-10, **not** the release artifact)

**Setup:**
- Run in a throw-away local clone in the session scratch directory, so the shared `dist/` was not touched.
- Source `bb1666fc8798edbe35c51358d19a0ee605be4ce0`, clean. At this commit A9 is a work-in-progress snapshot.
- Node 22.22.0.

| Step | Observed |
|---|---|
| `node scripts/build.mjs --check` | `built dist/ (release) - 63 files, 7.13 MiB`; **all checks passed**. PASS lines: manifest (MV3, exact permissions, no host_permissions/`<all_urls>`, incognito not_allowed, ADR CSP, scan-page command, referenced files exist); no e2e-harness; vendor 7 files + 11 licences with sha256; src 36 files, only grader hosts, no innerHTML/eval/remote/inline; OCR/zxing paths overridden; vendor CDN default strings (x4) overridden; `node --check`; locales en/nl parity (185 keys) |
| `SOURCE_DATE_EPOCH=1760054400 node scripts/build.mjs --package`, run twice | Both runs: `packaged certscanner-0.1.0.zip: 63 files, 4.43 MiB, manifest re-validated inside the ZIP`, sha256 **`e24ec236b234c8fb225f727a6e2377d0f668b4837b431c5a2050eeac048c4034`**. Identical, so deterministic. 4,650,220 bytes. |
| ZIP inspection (Python `zipfile`) | `testzip` OK. `manifest.json` at the root. Top level: `_locales background build-info.json core icons manifest.json pipeline shared sidepanel vendor`. No symlinks. No `.git`, `node_modules`, tests, `e2e-harness`, `.map`, `.mjs`, keys, `.crx` or nested ZIPs. Secret-pattern scan (Google API key, private key, GitHub/Slack/Stripe/AWS token shapes): **0 hits**. All entry timestamps 1980-01-01. `build-info`: target `release`, `gitDirty:false`, `e2eHarness:false`. |
| URL hosts inside the ZIP | Grader hosts only: `www.psacard.com`, `www.cgccomics.com`, `www.cgccards.com`. Also `cdn.jsdelivr.net` / `fastly.jsdelivr.net` default strings in the vendor bundles and their listing in `build-info.json` (SEC-10: overridden at runtime, never requested). |
| Skill static checker `check_extension.py dist` | 6 "errors" and 1 warning. These are the same false positives QA analysed in O6: `..` paths not normalised, `function(` matched as dynamic code, CSP-blocked Babel `Function(...)` fallbacks, and the documented optional `https://*/*`. |
| `npm test` (shared working tree, clean at `bb1666f`) | **140 tests, 140 pass, 0 fail** (784 ms) |

### 2.3 Stale ZIP in the working tree: do not upload

`/home/user/CertScanner/certscanner-0.1.0.zip`:
- 4,638,974 bytes, sha256 `da5c64e2d13272dd6a7d18bc79ac79878b6ff0fd97f4f4869fff77bc023fc3d2`;
- built on 2026-10-09 from `837e84d` with `--allow-dirty` (`build-info.gitDirty: true`);
- **predates A9**: it has no `commands` key.

The file is git-ignored and was left in place. The final `npm run package` overwrites it.

## 3. Release gates

Status values: **pass** · **fail** · **not-run** · **external** (needs the user or a third party).

| # | Gate | Status | Evidence / note | Next owner |
|---|---|---|---|---|
| G1 | Unit tests | **pass** (snapshot `bb1666f`) | 140/140 (section 2.2). Rerun on the final commit. | FE / release |
| G2 | Release check (`npm run check`) | **pass** (rehearsal `bb1666f`) | Section 2.2. QA also saw a pass on `5cf2742`. Rerun on the final commit. | release |
| G3 | Deterministic package + ZIP inspection | **pass** (rehearsal only) | Same sha256 twice; layout and contents clean. The final artifact isn't built yet. | release (after G4–G6) |
| G4 | E2E suite | **not-run** for the current scope | 35/35 passed on `5cf2742`, **before A9**. Page scan (toolbar, shortcut, panel button, page-results, aggregation, "Always allow") has no e2e evidence yet. | QA |
| G5 | OCR benchmark (D3) | **not-run** for the current scope | Passed on `5cf2742`: 100 % clean, 88.9 % degraded, **0 wrong auto-opens**. A9 adds a new auto-open path (multi-image aggregation), so zero wrong auto-opens must be shown again on the final build. | QA |
| G6 | Security review round 1 | **pass** (conditional, findings addressed) | `2cd4f86`: no critical or high findings. Fixed and verified by FE/QA: SEC-01, -02, -03, -04, -06, -08, -09, -11 and -12. SEC-05 licence files are shipped (upstream check is G12). SEC-10 is disclosed in the remote-code answer (`store-listing.md` §7, `permission-justifications.md`). SEC-07 is accepted. | — |
| G7 | Security review round 2 | **not-run** | Must cover the S6 UI, the A9 page probe (`pageImagesProbe`), page jobs, per-site "Always allow" grants, `lastResult` and the session `sharperDeclined` list. | security-reviewer |
| G8 | Performance | **not-run** | Open: O3 (dark images 2–5 s warm); A9 page scan budget is ≤ 30 s and 8 images; cold start ~1.3 s. | performance |
| G9 | Manual Chrome checks M1–M11 | **not-run** (external: needs the user) | Steps in `docs/quality/test-report.md` §8; summary in `manual-test-checklist.md`. | user (+ QA) |
| G10 | Manual page-scan checks PS1–PS10 | **not-run** (external: needs the user) | `manual-test-checklist.md` §B | user (+ QA) |
| G11 | Live grader URL verification (R1 / M10) | **not-run**: egress blocked | `psacard.com` and `cgc*.com` can't be reached from this environment. If a URL pattern is wrong, every opened page is wrong, so this is a **hard blocker before public release**. | user |
| G12 | Licence texts vs. upstream (SEC-05) | **not-run** | The texts in `third_party/licenses/` came from Debian packaging on 2026-10-09. They must be compared with the licence files of the exact versions compiled into tesseract.js-core 7.0.0 (Leptonica, libjpeg, libpng, LibTIFF, zlib) and zxing-wasm 3.1.5 (zxing-cpp). Needs read access to those upstream repositories. | release / orchestrator |
| G13 | Project licence file | **fail** | `package.json` declares `MIT`, but the repository has no `LICENSE` file. One is needed before the source or extension is distributed. It must carry the copyright holder's name, which the user must supply. Recommended: also copy it into `dist/`. | user + orchestrator (FE for the build copy) |
| G14 | Privacy policy matches the final code | **not-run** | `PRIVACY.md` was checked against the code at `bb1666f` (fetch options, probe fields, storage keys and TTLs, history fields). Re-check after FE finishes A9. | release |
| G15 | Privacy policy hosted at a public URL | **external** | `PRIVACY.md` is ready. Hosting it (for example a public repo file URL or GitHub Pages) is the user's call. Then FE wires up the About → "Privacy policy" link (`privacy_link`). | user, then FE |
| G16 | Store screenshots (1280×800 or 640×400) | **not-run** | The existing captures are 360 px-wide panel crops from before A9. Re-render plan: `store-listing.md` §5.2. Screenshot 3 (context menu) needs branded Chrome. | QA/FE + user |
| G17 | Small promo tile 440×280 | **not-run** | Missing; brief in `store-listing.md` §5.3 | designer / user |
| G18 | Listing copy, single purpose, permission justifications, data-use answers | **pass** (draft prepared) | `store-listing.md`, `permission-justifications.md`. Must be checked against the live dashboard (developer.chrome.com was blocked, so the GitHub copies of the docs dated 2021–2023 were used). | user |
| G19 | Homepage / support URL, `<maintainer contact>` | **external** | Placeholders only; no contact details were invented. | user |
| G20 | Developer account, identity/verification, registration fee | **external** | The docs say a one-time registration fee applies. **The amount was not verified and is not stated.** | user |
| G21 | Store submission | **not-run**: **not authorized, not done** | Needs an explicit user decision. If it is made: upload as unlisted / trusted testers with deferred publishing (`store-listing.md` §8). | user |
| G22 | Review acceptance, publication, observed Store install | **not-run** | Depends on G21. A submitted item is not an accepted one; only observed Store evidence counts. | user |

## 4. Findings and blockers (release manager)

| ID | Severity | Finding | Owner |
|---|---|---|---|
| RM-1 | **Blocker** | A9 page scan has no QA, benchmark or security evidence yet (G4, G5, G7). The test report and screenshots predate it. | QA, security-reviewer |
| RM-2 | **Blocker (Store)** | There is no public privacy-policy URL, support URL or contact. The extension handles website content, so a privacy policy is required even though processing is local (user-data FAQ Q14). | user |
| RM-3 | **Blocker (Store)** | No screenshot meets the required size or shows the A9 primary journey, and the required small promo tile is missing (G16, G17). | QA/FE, user |
| RM-4 | **Blocker (legal)** | SEC-05 upstream licence comparison is pending (G12), and the project's own `LICENSE` file is missing (G13). | release / orchestrator, user |
| RM-5 | **Blocker (public release)** | Live URL check R1/M10 has not been run (G11). | user |
| RM-6 | Minor (UX / listing accuracy) | The toolbar tooltip `action_title` reads "Open CertScanner" / "CertScanner openen". Since A9 (default `scanOnToolbarClick: true`), clicking the icon **scans the page**. Suggestion: a tooltip such as "Scan this page with CertScanner", or switch it with `chrome.action.setTitle` according to the setting. Design-spec CM-02 and §6.1 still show the pre-A9 tooltip and description. | FE / UX (src is FE-owned) |
| RM-7 | Minor (UX) | Settings → **Sharper scans** lists every granted site, including sites granted through "Always allow on ‹site›" (page access). The heading only describes image access. Consider a neutral heading such as "Site access". `PRIVACY.md` and the permission justifications describe both uses. | FE / UX |
| RM-8 | Info | A stale, dirty, pre-A9 ZIP is in the working tree (section 2.3). | — (overwritten by the final package) |
| RM-9 | Info | `SOURCE_DATE_EPOCH` only fixes `build-info.builtAt`; ZIP timestamps are always 1980-01-01. Use the commit time (`git log -1 --format=%ct`) so anyone can reproduce the release sha256 from the tag. | release |

## 5. Final packaging procedure (after RM-1 is closed)

1. **Preconditions:**
   - FE's A9 work is committed;
   - QA e2e and benchmark pass on that commit (G4, G5);
   - security round 2 has no open blocker (G7);
   - `LICENSE` is added (G13).
2. **Prepare a clean checkout:** `git status --porcelain` must be empty. Then run `npm ci`.
3. **Build and package:** `npm test`, then `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package`. Save the full output (sha256, file count, size, source commit).
4. **Inspect the ZIP:**
   - the manifest is at the root, with version `0.1.0`;
   - permissions, `commands` and `incognito` match `permission-justifications.md`;
   - there are no dev files, source maps or secrets;
   - the grader hosts are the only real URLs.
5. **Smoke-test the exact package:** unzip it into an empty folder, load that folder unpacked in branded Chrome, and run PS1 and M1.
6. **Record the result:** fill in section 2.1, re-check `PRIVACY.md` against the final code (G14), and tag `v0.1.0`. Keep the ZIP, its sha256 and this report together.
7. **Stop here** unless the user authorizes a Store upload.

## 6. Rollout, migration and rollback plan (for when the user decides to publish)

- **Migration:** this is the first release, so there is no earlier version to migrate from. The storage schemas are versioned and migrated when read:
  - settings v1 (four booleans in `sync`);
  - history v1;
  - `ScanJob` v1;
  - `lastResult` v1.

  Newer synced settings from another device are read tolerantly and never overwritten unless the user edits them. There is no backend, so there are no server migrations.
- **Staged rollout:**
  1. Upload as **unlisted** or to **trusted testers**, with **deferred publishing**.
  2. The user installs the Store-delivered build and runs `manual-test-checklist.md` §C.
  3. Publish publicly.
  4. For later updates, use the dashboard's percentage rollout if it is offered for this item (**verify live**).
- **Permissions:** adding an install-time permission or host permission in an update disables the extension for existing users until they accept it. Keep new access optional (ADR §16).
- **Rollback:** there is **no instant rollback**.
  - The Store serves only the latest published version. Rolling back means re-uploading the previous code under a **higher** version number (for example 0.1.1), and that upload goes through review.
  - Chrome picks up updates over hours. Unpublishing stops new installs but does not remove existing ones.
  - Keep every released ZIP and its sha256.
- **Grader URL changes:** if PSA or CGC change their URL scheme, an extension update is needed. All builders are in `src/core/certUrls.js`.
- **Monitoring and support:** there is no telemetry, by design and as promised in `PRIVACY.md`. Feedback channels are the Store support hub and the support URL (G19). No monitoring is configured, and none should be added without updating the privacy policy and the data-use form.

## 7. Assumptions

- The Store requirements come from the GitHub copy of the developer.chrome.com docs (files updated 2021-08-13 to 2023-10-05), read on 2026-10-10. The live site and dashboard could not be reached.
- The summary-length limit (132) and the screenshot sizes are assumed to still apply. The data-usage category names come from secondary sources.
- Recommending **Website content: Yes** and **Web history: No** is a judgment call. It must be confirmed against the live definitions (`store-listing.md` §7).
- `PRIVACY.md` describes the code at `bb1666f`. FE is still finishing A9, and any change to data handling must be reflected before release (G14).
- The privacy policy will be hosted at a public URL chosen by the user. `<maintainer contact>` stays a placeholder until the user provides a contact.

## 8. Sources checked (2026-10-10)

- GitHub `GoogleChrome/developer.chrome.com` (`raw.githubusercontent.com`, branch `main`), under `site/en/docs/webstore/`:
  - `images/index.md`
  - `cws-dashboard-listing/index.md`
  - `cws-dashboard-privacy/index.md`
  - `register/index.md`
  - `publish/index.md`
  - `best_practices/index.md`
  - `program-policies/user-data-faq/index.md`
  - `program-policies/limited-use/index.md`
- Web search on the data-usage disclosure categories:
  - [9to5Google, 2020](https://9to5google.com/2020/11/18/chrome-web-store-disclosure/)
  - [Chrome Web Store Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use/)
  - [Ghostery Limited Use disclosure example](https://account.ghostery.com/privacy/chrome-disclosure)
- `developer.chrome.com` itself: **blocked** (proxy `CONNECT` 403 / DNS `ENOTFOUND`).

## 9. Files written by the release manager

- `README.md` (rewritten)
- `PRIVACY.md` (new)
- `docs/release/release-report.md` (this file)
- `docs/release/store-listing.md`
- `docs/release/permission-justifications.md`
- `docs/release/manual-test-checklist.md`

Nothing in `src/**`, `tests/**` or `scripts/**` was changed.

## 10. Next owners

| Owner | Next steps |
|---|---|
| FE | Finish A9. Optional: RM-6 and RM-7. Wire up the privacy link after G15. Optionally copy `LICENSE` into `dist/`. |
| QA | e2e and benchmark for A9 (G4, G5); Store screenshots 1, 2, 4 and 5 at 1280×800 from the final build (G16); update CM-02. |
| Security reviewer | Round 2 (G7). |
| Performance | G8. |
| Release manager | G12 upstream licence comparison (when GitHub access to those repositories is available), G14, then the final package (section 5). |
| User | Run M1–M11 and PS1–PS10 (including M10/R1). Supply the copyright holder for `LICENSE`, the contact, the support and homepage URLs, and a host for the privacy policy. Capture screenshot 3 (context menu) and approve the promo tile. Decide whether to create a developer account and submit at all. |
