# CertScanner 0.1.0: manual pre-release checklist (branded Chrome)

_Role: release-manager · Date: 2026-10-10 · Status: **not run**. These checks need a person and a real Chrome; headless automation can't produce a real toolbar click, keyboard shortcut, right-click, activeTab grant or permission prompt._
_Detailed steps for M1–M11 are in `docs/quality/test-report.md` §8 (QA). Checks PS1–PS10 below cover the A9 page scan, which that report predates. If QA's updated report defines its own page-scan manual checks, those replace PS1–PS10._

## Setup

1. Build the exact release candidate: `npm ci && npm run build` on the tagged commit, or unzip the release ZIP into an empty folder.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select `dist/` (or the unzipped folder). Pin CertScanner.
3. Serve the synthetic test pages: `cd tests/fixtures && python3 -m http.server 8000`, then open `http://localhost:8000/pages/gallery.html`.
4. Write down the Chrome version (`chrome://version`), OS, date and `dist/build-info.json` `gitCommit`. Take a screenshot at each failing step.

## A. Checks from the QA report (steps in `docs/quality/test-report.md` §8)

| ID | Check | Pass when (short) |
|---|---|---|
| M1 | Right-click → panel opens (panel closed / already open) | Panel opens at once, `psacard.com/cert/01234567` opens next to the page, no prompt |
| M2 | Two quick right-click scans | Only the second result is shown or opened |
| M3 | Scan after the service worker stopped | Panel opens, confirm with `5012345678`, no error |
| M4 | activeTab on a real image CDN (for example a marketplace listing) | Works without a prompt; falls back to screen capture if the CDN refuses; no unexpected requests |
| M5 | Sharper scans grant / deny / revoke | Prompt names only that host; deny withdraws the offer; allow + Scan again → full resolution; Remove revokes it |
| M6 | Chrome Web Store and `chrome://` pages | Restricted message, upload works, no uncaught errors |
| M7 | Two windows | Only the window where you scanned reacts |
| M8 | Dutch UI, screen reader, keyboard, 200 % zoom | All text Dutch, announcements read, logical focus, no horizontal scroll |
| M9 | Chrome 116 (Chrome for Testing) | M1, M5-deny and an upload work with no console errors |
| M10 | Official URLs resolve (**closes risk R1**) | A real public cert number opens the right record on psacard.com, cgccomics.com and cgccards.com; a PSA leading zero is kept |
| M11 | Incognito not allowed | No "Allow in Incognito"; no menu item, action or panel in incognito; no history entry |

## B. Page scan (A9): proposed checks

| ID | Steps | Pass when |
|---|---|---|
| PS1 | On `gallery.html`, with the side panel closed, click the CertScanner toolbar icon. | The panel opens immediately and shows "Looking for slab photos on this page…", then "Scanning image N of M", then either the "Cert numbers on this page" list or an opened cert page. No permission prompt. The page does not scroll. |
| PS2 | Press **Alt+Shift+S** (macOS: Option+Shift+S). Then open `chrome://extensions/shortcuts`, change the shortcut, and use the new one. | The same behaviour as PS1 both times. The command is listed as "Scan this page for slab cert numbers". If no shortcut is set, the panel says "Click the CertScanner icon to scan the page you're viewing." |
| PS3 | Open a page with exactly one clear slab photo, for example the PSA fixture image opened on its own (`http://localhost:8000/psa-8digit-leading-zero.png`), and click the icon. Repeat with Settings → **Always ask before opening** on. | First run: exactly one tab opens with `psacard.com/cert/01234567`. Second run: no tab; the number is shown with Open/Copy. |
| PS4 | Scan a page with the icon, then go to a **different site** in the same tab and click the panel's **Scan this page** button. | The panel says "CertScanner can't read this page yet" and offers **Always allow on ‹host›**. Clicking it shows Chrome's prompt naming **only that host**. After Allow, the button scans. Settings lists the host, and **Remove** takes the access away again. |
| PS5 | Settings → turn off **Scan the page when I click the icon**. Click the icon. Restart Chrome, click again, then turn the setting back on. | When off, the icon only opens the panel and nothing is scanned, also after the restart. When on, the icon scans again. |
| PS6 | Click the icon on `chrome://version` and on a Chrome Web Store item page. | "Chrome doesn't allow reading this page"; uploading a fixture works; no uncaught errors in the panel or service-worker console. |
| PS7 | Click the icon on a page with no slab photos (a plain text article). | "No cert numbers found on this page" with tips; no tab opens; nothing is added to Recent scans. |
| PS8 | Click the icon on a long page with many large images, then press **Cancel** during a second run. | The whole scan ends within about 30 s and reads at most 8 photos, visible ones first. Cancel returns to idle within about 1 s and nothing opens later. |
| PS9 | Open DevTools on the side panel (right-click inside it → Inspect) → Network, then run PS1 on a real marketplace page. | The only requests are image loads from the page's image hosts and the opened official cert page. There is no other host, no CDN and no analytics. |
| PS10 | Open the gallery in two windows, each with the panel open, and click the icon in window A. | Only window A's panel scans; window B is unchanged. |

## C. After a Store upload (only when the user authorizes an upload)

- [ ] Install the **Store-delivered** build (unlisted or trusted-tester) in a fresh profile. Its version must match the uploaded ZIP.
- [ ] Repeat M1, PS1, M5 (deny) and M11 on that install.
- [ ] Check that the Store page shows the expected summary, description, screenshots, privacy policy link and permission warnings.

## D. Result record (fill in)

| ID | Chrome version / OS | Date | Result (pass / fail / blocked) | Notes / screenshot |
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
