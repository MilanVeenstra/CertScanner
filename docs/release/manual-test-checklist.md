# CertScanner 0.1.0: manual pre-release checklist (branded Chrome)

_Role: release-manager · Date: 2026-10-10 · Status: **not run**. These checks need a person and a real Chrome; headless automation can't produce a real toolbar click, keyboard shortcut, right-click, activeTab grant or permission prompt._
_Source: `docs/quality/test-report.md` §9 (QA, written against `03d9589`). M1–M11 and PS1–PS12 below are QA's checks in short form. PS1–PS12 replace this file's earlier PS1–PS10. PS4 was rewritten because QA found the "Always allow" offer practically unreachable (O12). If QA changes §9 after the improvement round, §9 wins._

## Setup

1. Build the exact release candidate: `npm ci && npm run build` on the release commit, or unzip the release ZIP into an empty folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `dist/` (or the unzipped folder). Pin CertScanner.
3. Serve the synthetic test pages: `cd tests/fixtures && python3 -m http.server 8000`. Pages:
   - `http://localhost:8000/pages/gallery.html`
   - `http://localhost:8000/pages/listing.html` (variants `?details=1`, `?slab=0`, `?photos=0`)
4. Write down the Chrome version (`chrome://version`), OS, the screen's DPR (`devicePixelRatio`), date and `dist/build-info.json` `gitCommit`. Take a screenshot at each failing step.

## A. Image journeys M1–M11 (QA §9)

| ID | Steps | Pass when |
|---|---|---|
| M1 | Right-click `#img-psa-leading-zero` on the gallery → "Scan slab cert number". Do it with the panel closed, then with it open. | The panel opens at once; `psacard.com/cert/01234567` opens next to the gallery; no prompt |
| M2 | Right-click scan the PSA image, then within 1 s `#img-rotated` | Only `cgccomics.com/certlookup/4012345001/` opens |
| M3 | Stop the worker in `chrome://serviceworker-internals`, then right-click scan `#img-ambiguous` | The panel opens; confirm shows `5012345678` with no grader; no error |
| M4 | Right-click a slab photo on a real listing whose image is on a CDN host | Works without a prompt; screen-capture fallback if the CDN refuses; DevTools shows only the image host and the official page |
| M5 | "Sharper scans on ‹site›" on a real https CDN: Deny → Allow → Scan again → Settings → "Sites with full access" → Remove | The prompt names only that host; each step as described; at most one tab per scan |
| M6 | On `chrome://version` and a Web Store item: right-click, use the icon, then upload `tests/fixtures/psa-9digit.png` | "Chrome doesn't allow reading this page"; upload works; no uncaught errors |
| M7 | Gallery in windows A and B, each with a panel; scan in A | Only A reacts; the tab opens in A |
| M8 | Dutch UI (`LANGUAGE=nl` on Linux), screen reader (NVDA/VoiceOver/ChromeVox), keyboard only, 200 % zoom | All strings Dutch and untruncated; one announcement per result; logical focus; errors read out; no horizontal scrolling |
| M9 | Chrome for Testing 116, fresh profile: M1, M5-deny, an upload, **PS1** | No console errors |
| M10 | Open each builder URL for a real public cert number (**closes risk R1**) | The right record on psacard.com, cgccomics.com and cgccards.com; PSA leading zero kept |
| M11 | `chrome://extensions` Details; an incognito window | No "Allow in Incognito"; no menu item, icon action or panel in incognito; no history entry |

## B. Page scan PS1–PS12 (QA §9)

| ID | Steps | Pass when |
|---|---|---|
| PS1 | On `gallery.html`, with the panel closed, click the CertScanner icon. Repeat with the panel open. | The panel opens immediately: "Looking for slab photos…", then "Scanning image N of 8", then "Cert numbers on this page" with about 6 rows (thumbnail, number, grader, exact path). No prompt, no page scrolling, no tab. |
| PS2 | Press **Alt+Shift+S** (macOS Option+Shift+S). Change the shortcut in `chrome://extensions/shortcuts` and use it. Then clear it and reopen the panel. | Same as PS1 each time. Settings shows the current shortcut. With none set, the idle hint says to click the icon. |
| PS3 | Click the icon on `listing.html`. Repeat with Settings → "Always ask before opening" on. | First run: exactly one tab `psacard.com/cert/108114622` next to the listing; Recent scans +1. Second run: a one-row list, no tab. |
| PS4 | (a) On a real https site where CertScanner has no access, click the panel's **Scan this page** without using the icon. (b) Click the icon on that site, then navigate the same tab to a *different* https site and click **Scan this page**. | (a) and (b) both show "CertScanner can't read this page yet" with the icon/shortcut copy. Expect **no** "Always allow on ‹site›" offer (O12); if one appears, record it. If an offer is shown: Allow → the prompt names only that host → the scan runs → Settings → "Sites with full access" lists the host → Remove revokes it. |
| PS5 | Settings → turn off "Toolbar button scans the page"; click the icon; restart Chrome; click again; turn it back on. | Off: the icon only opens the panel (tooltip "Open CertScanner"), also after the restart. On: the icon scans (tooltip "Scan this page for slab cert numbers"). |
| PS6 | Click the icon on `chrome://version` and on a Web Store item. | "Chrome doesn't allow reading this page"; upload works; no uncaught errors in the panel or worker console |
| PS7 | Click the icon on `listing.html?photos=0` and on a plain text article. | "No cert numbers found on this page" with 3 tips; no tab; nothing in Recent scans |
| PS8 | On a long real page with many large photos, click the icon; on a second run press **Cancel** during "Scanning image 2". | At most 8 photos, visible first, done within about 30 s. Cancel returns to idle within 1 s and nothing opens later. |
| PS9 | Panel DevTools → Network while doing PS1 on a real marketplace listing. | Only the page's image hosts and the opened official page; no other host, CDN or analytics |
| PS10 | Gallery in windows A and B, each with a panel; click the icon in A. | Only A scans; B unchanged |
| PS11 | On a real listing whose photos come from a CDN that refuses extension fetches, run PS1 at 100 % zoom on a DPR 1 monitor, then on a HiDPI/Retina screen (DPR 2). | Numbers are read from the screen capture or skipped, never wrong. Record found / not found per DPR (QA §8, DPR-1 limit). |
| PS12 | Stop the worker (`chrome://serviceworker-internals` → Stop, or 30 s idle with DevTools closed), then click the icon and press the shortcut. | The panel opens and scans each time; no error |

## C. After a Store upload (only when the user authorizes an upload)

- [ ] Install the **Store-delivered** build (unlisted or trusted-tester) in a fresh profile. Its version must match the uploaded ZIP.
- [ ] Repeat M1, PS1, M5 (deny) and M11 on that install.
- [ ] Check that the Store page shows the expected summary, description, screenshots, privacy policy link and permission warnings.

## D. Result record (fill in)

| ID | Chrome version / OS / DPR | Date | Result (pass / fail / blocked) | Notes / screenshot |
|---|---|---|---|---|
| M1 | | | | |
| M2 | | | | |
| M3 | | | | |
| M4 | | | | |
| M5 | | | | |
| M6 | | | | |
| M7 | | | | |
| M8 | | | | |
| M9 | | | | |
| M10 | | | | |
| M11 | | | | |
| PS1 | | | | |
| PS2 | | | | |
| PS3 | | | | |
| PS4 | | | | |
| PS5 | | | | |
| PS6 | | | | |
| PS7 | | | | |
| PS8 | | | | |
| PS9 | | | | |
| PS10 | | | | |
| PS11 | | | | |
| PS12 | | | | |
