# CertScanner — extension contract

_Owner: orchestrator · Created 2026-10-09 · Status: provisional decisions marked (P), confirmed by the user's request marked (C)_

## Single purpose

Read the certification number from a photo of a **PSA** or **CGC** graded slab that is shown on a webpage
(or supplied by the user) and open the **official certification verification page** for that number. (C)

## Audience

Collectors and buyers of graded trading cards and comics who browse listings on eBay, marketplaces,
social media groups, forums and shop sites and want to verify a slab without retyping the number. (C)

## Product mode

**Local only.** All image processing (barcode + OCR) runs on-device inside the extension. No backend,
no account, no analytics. (P — chosen because nothing in the job needs a server and it keeps
image data on the user's machine.)

## Trigger and surfaces

| Surface | Role |
| --- | --- |
| Toolbar icon / keyboard shortcut: "Scan this page" | **Primary trigger** — finds the slab photos on the current page and reads them, no upload needed (C, 2026-10-09: "de pagina zelf scannen zonder eerst een foto te uploaden") |
| Context menu on images: "Scan slab cert number" | Primary trigger for one specific photo (C: "rechtermuisklik op de foto") |
| Side panel | Visible task state: image preview, progress, detected cert(s), grader, open/copy/edit, recent scans, paste/drop/upload, manual entry (P) |
| Toolbar action | Opens the side panel (P) |
| New tab with official cert page | Outcome (C) |

## Data and hosts

| Data | Where it goes |
| --- | --- |
| Image pixels of the clicked image | Processed in memory in the extension; never uploaded |
| Image URL (`srcUrl`) | Used to fetch the image; kept in session-only state for the current scan |
| Detected cert number + grader | Opened as a URL on the official grader site when the user (or the auto-open setting) confirms; last N scans kept in `chrome.storage.local` (user can clear) |
| Settings | `chrome.storage.sync` |

Official hosts opened (navigation only, no host permission needed): `www.psacard.com`, `www.cgccomics.com`,
`www.cgccards.com` (exact patterns confirmed in research).

## Permission budget (to be confirmed by architecture)

Install-time: `contextMenus`, `activeTab`, `sidePanel`, `storage`, `scripting` (for cropping the
on-screen image when the raw image cannot be fetched). No install-time host permissions and no
`<all_urls>`. Any broader image access must be an **optional** grant requested from a visible user action.

## Behaviour rules

1. Never open a URL decoded from a QR code unless it is on the official grader allowlist; otherwise
   only the extracted number is used.
2. Auto-open the official page only when exactly one high-confidence candidate exists (setting, default on);
   otherwise show candidates and let the user choose/edit.
3. All code, WASM and OCR language data are bundled (no remote code, no CDN downloads).
4. No affiliation with PSA or CGC is implied in name, UI or listing.

## Acceptance journeys

Defined in `docs/research/research.md` (research) and verified in `docs/quality/test-report.md` (QA).
