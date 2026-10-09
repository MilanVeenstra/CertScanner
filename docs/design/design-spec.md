# CertScanner: design specification (side panel, context menu, icon)

_Role: ux-designer · Date: 2026-10-09 · Status: **Planned** (concept spec; nothing implemented or captured yet)_
_Inputs: `docs/extension-contract.md`, `docs/research/research.md` (§11 journeys, D1–D6, R2/R8), branch `claude/sharp-turing-1et8ns` @ `d809e50`. The repo had no existing brand or UI, so this spec sets the visual direction._
_Evidence label: every wireframe below is a **concept**. No interactive prototype or real extension capture exists yet, and runtime visual evidence has not been produced._

---

## 0. Summary of design decisions

| # | Decision | Why |
|---|---|---|
| UX1 | **The side panel is the only UI.** It has a task-first Home view and a Settings sub-view. Section 2.2 explains the choice. | Shows the current scan first; uses one surface and two views; costs little to build. |
| UX2 | **The side panel must be window-scoped**, opened with `sidePanel.open({windowId})` and no tab-specific path. | If it were scoped to the tab, it would disappear when the cert tab opens. That would hide the result and "Wrong number? Edit". **Architecture must confirm.** |
| UX3 | **The number that was read is always shown** with its source (barcode, QR, text, typed) and the exact path that was or will be opened. | R2: a wrong number can open a real-looking but wrong record. |
| UX4 | **No authenticity claims.** A fixed note on every result says a cert lookup ≠ a genuine slab. Grader chips use neutral styling, with no brand colours or logos. | R8, D6. |
| UX5 | **The "Sharper scans" offer only appears where it helps:** the confirm and no-number states, after a screen-resolution capture. It never appears at install or after a successful auto-open. | Ask for access when the benefit is clear. |
| UX6 | **No disabled buttons.** Validation runs on submit, with errors next to the field. | Disabled controls are not discoverable and do not explain themselves. |
| UX7 | **Grader choice is a visible radio "segmented control"** (PSA / CGC Comics / CGC Cards). It stacks vertically when narrow. | One click; every option visible; native keyboard support. |

---

## 1. Journeys

### 1.1 Primary journey (J1, PSA happy path)

```
Page image ──right-click──▶ "Scan slab cert number"
   │  (onClicked: sidePanel.open({windowId}) synchronously, D1)
   ▼
Side panel S1 Scanning  [thumbnail placeholder → image]
   Loading image ✓ → Reading barcode ✓ (none) → Reading text ✓ → Matching ✓
   ▼  one high-confidence candidate, grader known, "Always ask" off
New tab: https://www.psacard.com/cert/01234567   (foreground by default)
   ▼  the panel stays visible (window-scoped)
Side panel S2 Result
   "Opened PSA cert page" · [PSA] · 01234567 · Read from text (OCR)
   psacard.com/cert/01234567 · [Copy number] [Open again] · Wrong number? Edit
   Note: a valid number alone doesn't prove the slab is genuine.
   ▼  history +1 (grader, number, time, method only)
```
The goal is to get from click to tab within a few seconds on a typical listing photo. **This is a target and has not been measured.** The spike measured 0.5–0.75 s for OCR start-up plus 0.2–0.3 s for recognition on a 452×548 image.

### 1.2 Alternate journeys (mapped to research §11)

| J | Flow |
|---|---|
| J2 CGC comic | Same as J1. Keywords ("UNIVERSAL GRADE", "WHITE PAGES") plus 10 digits give CGC Comics → `https://www.cgccomics.com/certlookup/{n}/` → S2 shows "Opened CGC Comics cert page". |
| J3 CGC card | A 13-digit `1401…` number, or 10 digits with card wording → `https://www.cgccards.com/certlookup/{n}/` → S2. |
| J4 QR/barcode | "Reading barcode" finds a number → "Reading text" is marked **Skipped** → Matching → auto-open with the rebuilt official URL; S2 shows "Read from barcode / QR code". **If the QR points to a host that is not on the allow-list**, nothing auto-opens. S3 shows the warning "QR code links to another site" with the exact host as plain text, and only the extracted number is offered. |
| J5 Ambiguous | 10 digits with no keywords, low confidence, ≥2 candidates, unknown grader or "Always ask" on → **S3 Confirm**. A reason line explains why; the user picks a candidate, edits the number, picks a grader and presses Open (or Enter) → tab → S2. |
| J6 No number | The image has no slab → **S4** "No cert number found" with **Type number** and **Choose image**. No tab opens. |
| J7 Fetch blocked | CORS blocks the fetch → crop from a screen capture → result. In S3/S4 the low-resolution notice offers **"Sharper scans on i.ebayimg.com"** → Chrome's own prompt. *Allow* → "Sharper scans are on…" + **Scan again** (full resolution). *Deny* → "No permission given…". The offer is not shown again for that host this session, and manual entry still works. |
| J8 Restricted page | Chrome Web Store, PDF viewer, other extension pages and similar → **S5/E1** "Chrome doesn't allow reading this page" + Choose image. No uncaught errors. |
| J9 Manual entry | Type `PSA 12345678` → the PSA segment selects itself → Enter → tab → field clears, focus stays in it, status announces it, history +1 ("Typed by you"). Invalid input → error next to the field via `aria-live`. |
| J10 Paste/drop/upload | Ctrl/⌘+V with an image, dropping a file, or **Choose image** → S1 → same pipeline. Works offline until the tab opens. |
| J11 Privacy | The UI loads no remote fonts, images or scripts. The footer says "Images stay on this device". The network log shows only the image origin (if fetched) and the opened cert page. |
| J12 Wrong auto-open | S2 → **Wrong number? Edit** → S2e (field pre-filled and selected) → Open → new tab → S2 "Corrected by you". The latest history entry is **replaced**, not duplicated. |
| J13 Cancel / replace | S1 → Cancel or Esc → S0 + "Scan cancelled." If a new trigger arrives during a scan, it replaces the old one silently and only the latest can open a tab. |
| J14 Always ask | Settings → turn on "Always ask before opening" → the next confident scan lands in S3 with the reason "You've set CertScanner to always ask before opening." |
| J15 Revoke | Settings → Sharper scans → **Remove** (or via chrome://extensions) → the next scan on that host falls back to capture and the offer can come back. |
| J16 History | Settings → **Clear history**, or turn off "Keep scan history", which deletes it immediately → Recent shows the empty or off text. |
| J17 Panel closed mid-scan | The scan stops (the pipeline lives in the panel, D1) and no tab opens. On reopen: S0, or the last *completed* state restored from `chrome.storage.session` without the thumbnail (Should). |
| J18 Uninstall | Chrome deletes the extension's storage. There is no server-side data. About says "Removing the extension deletes its scan history." |

### 1.3 Lifecycle coverage

| Stage | Behaviour |
|---|---|
| Install | No welcome tab and no install-time prompt. Permissions are only `contextMenus, activeTab, scripting, storage, sidePanel`. |
| First useful action | Right-click → scan (S1→S2). If the toolbar icon is opened first, S0 shows the exact menu wording plus drop/paste/upload/type. |
| Permission request | Only the per-host "Sharper scans" button (user gesture, names the exact host, offers "Not now"). Undo it in Settings. |
| Loading | S1 step list. After 8 s: "Still working…". Cancellable. |
| Success | S2 (auto or confirmed). Manual entry gets a status message and the S2 card update. |
| No results | S4. |
| Denied access | Chrome-restricted page → E1. Host permission denied → LR denied state. |
| Offline | Scanning works. Opening shows an offline note; Chrome's tab handles the network error. |
| Expired auth / quota / billing | **Not applicable**: no accounts, backend or paid tier. |
| Conflict | Ambiguous candidates → S3. Settings sync conflicts: last write wins (booleans only), with no UI. |
| Recovery | Every error state offers at least one working path (upload, type, try again, reload). |
| Uninstall / deletion | Clear history, turning history off, Remove site, and uninstall all remove data. |

---

## 2. Surfaces and information architecture

### 2.1 Surfaces

| Surface | Content |
|---|---|
| Context menu (contexts: `image`) | One item: "Scan slab cert number". Chrome shows it at top level with the extension icon. |
| Toolbar action | Tooltip "Open CertScanner". Click opens the side panel (`openPanelOnActionClick`). |
| Side panel (320–500+ px, resizable, light/dark) | Home view and Settings view. |
| New tab | The grader's official cert page (the outcome). |

### 2.2 Variants compared (choice: A)

| Variant | Task success | Accessibility | Consistency | Build cost |
|---|---|---|---|---|
| **A. Task-first single scroll (current scan → image input → manual entry → recent) + Settings sub-view via a header button** | Result is always at the top; repeat inputs are one scroll away. | Simple heading/landmark structure; one focus move per view change. | Same order in every state. | Low: two `<main>` blocks toggled with `hidden`. |
| B. Tabs (Scan / History / Settings) | Hides recent scans and manual entry behind tabs, adding a step. | Needs the ARIA tabs pattern; extra focus handling. | OK | Medium |
| C. One page with Settings in a `<details>` at the very bottom | Settings are buried under history. | Fine | OK | Lowest |

A wins on task success and is nearly as cheap to build as C.

### 2.3 Layout, landmarks and order

```
body
├─ header (banner)       [logo 20px] h1 "CertScanner"        [⚙ Settings]
├─ #status               role=status aria-live=polite aria-atomic=true (visually hidden; outside both mains)
├─ main#home
│   ├─ section#task      h2#task-heading (tabindex=-1), data-state=idle|scanning|result|edit|confirm|none|error
│   ├─ section#image-input  h2 "Scan an image"   (drop zone + Choose image)
│   ├─ section#manual    h2 "Type a cert number" (form#manual-form)
│   └─ section#recent    h2 "Recent scans"
├─ main#settings hidden  [← Back] h2#settings-heading "Settings" (tabindex=-1); h3 subsections
└─ footer (contentinfo)  "Not affiliated with PSA or CGC · Images stay on this device"
```
- **Tab order follows visual order:** header → task card controls → Choose image → cert input → grader radios → Open → recent rows (Open, Copy) → Show all → footer. While Settings is open, the header's Settings button is hidden.
- `<title>` is "CertScanner". `<html lang>` comes from the message `locale_code`, so it always matches the strings actually shown. `dir` comes from `@@bidi_dir`.
- Use CSS logical properties throughout (`margin-inline-start`, etc.).
- Content max-width is `40rem`, left-aligned. Inline padding is 16 px (12 px below 360 px).
- Section spacing is 24 px with a 1 px `--cs-border-subtle` divider. The task card has a `--cs-surface` background, `--cs-radius-md` and 16 px padding.

### 2.4 Responsive rules (panel width is the viewport width)

| Width (CSS px) | Rules |
|---|---|
| ≥ 360 | Default. Thumbnail (72 px) sits at the inline-start of the content. Button rows sit on one line. |
| < 360 | Inline padding 12 px. Button rows may wrap (gap 8 px). |
| < 280 (e.g. 320 px at ≥115% zoom) | Segmented control becomes a vertical full-width list. Buttons are full width. Thumbnail goes above the text. Recent rows stack the number above the buttons. Cert-number display drops to `--cs-text-num-sm`. |
| < 200 (320 px at 200% zoom) | Cert numbers may wrap (`overflow-wrap:anywhere`). Never horizontal scroll. |

No fixed heights on text containers (buttons use `min-height`). Text never truncates with an ellipsis, except host names longer than 40 characters inside buttons, which keep the full host in `title` and in the body text.

---

## 3. States

**Focus and announcement rules (all states)**
- **F1.** On each task-card state change, render the state, then call `#task-heading.focus({preventScroll:false})`.
- **F2.** If `document.hasFocus()` was **false** (for example, the scan came from the page's context menu), also post the state summary to `#status`. If the panel had focus, the focused heading is read and `#status` is not used, to avoid hearing it twice.
- **F3.** Short confirmations always go to `#status`: copied, cleared, removed, permission result, cancelled. To repeat an identical message, clear the region and set the text again after 100 ms.
- **F4.** Field errors live in their own persistent `aria-live="polite"` element (`#cert-error`, `#edit-error`) and are never copied into `#status`.
- **F5.** Exceptions:
  - Manual-entry success keeps focus in the cleared input.
  - Opening from Recent changes no focus.
  - A scan never moves focus away from a text field that is being typed into; it announces via `#status` instead.

### S0 Idle (also first run)
```
┌──────────────────────────────────────┐
│ ▣ CertScanner            [⚙ Settings]│
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │ Scan a slab                  (h2)│ │
│ │ Right-click a slab photo on a    │ │
│ │ web page and choose "Scan slab   │ │
│ │ cert number".                    │ │
│ │ Or drop, paste or upload an image│ │
│ │ below, or type the number.       │ │
│ └──────────────────────────────────┘ │
│ Scan an image                    (h2)│
│ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐ │
│ ╎          [image icon]            ╎ │
│ ╎     Drop a slab photo here       ╎ │
│ ╎      or paste with Ctrl+V        ╎ │
│ ╎        [⇪ Choose image]          ╎ │
│ ╎ JPEG, PNG, WebP or AVIF, up to 20 MB╎│
│ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ │
│ Type a cert number               (h2)│
│ Cert number                          │
│ [______________________________]     │
│ For example PSA 01234567 or CGC      │
│ 4012345001                           │
│ Grader                               │
│ ( PSA )( CGC Comics )( CGC Cards )   │
│ [ Open cert page ↗ ]                 │
│ Choose a grader to see the link.     │
│ Recent scans                     (h2)│
│ No scans yet.                        │
├──────────────────────────────────────┤
│ Not affiliated with PSA or CGC ·     │
│ Images stay on this device           │
└──────────────────────────────────────┘
```
- The task card has no controls in this state.
- `$MENU$` is filled from `context_menu_scan`, so the hint always matches the menu.
- Opening the panel does not move focus. After Cancel, focus goes to the heading.

### S1 Scanning
```
┌──────────────────────────────────────┐
│ Scanning…                        (h2)│
│ ┌──────┐  ✓ Loading image            │
│ │thumb │  ◌ Reading barcode   (bold) │
│ │ 72px │  ○ Reading text             │
│ └──────┘  ○ Matching                 │
│ From i.ebayimg.com                   │
│ [ Cancel ]                           │
└──────────────────────────────────────┘
```
- **Triggers:** context menu, drop, paste, Choose image, Scan again, Try again.
- **Thumbnail:**
  - A neutral placeholder (image icon on `--cs-surface`) until pixels arrive, then `object-fit: contain`.
  - Alt text is `image_alt_page`, `image_alt_file` or `image_alt_pasted`.
  - The caption `image_source_page` ("From host") or the file name sits under it.
- **Step list** (`<ol>`): each item is a 16 px icon, the label, and a visually hidden state ("Done", "In progress", "Not started", "Skipped").
  - The active step has `font-weight:600` and a spinner.
  - Skipped steps show a visible muted "· Skipped".
  - On the first use of OCR, the active "Reading text" step shows the sub-label "Starting text reader…".
- After 8 s, the muted line `scan_slow` appears.
- **Cancel** (secondary button) and **Esc** (when focus is inside the panel) stop the pipeline and return to S0. Status: "Scan cancelled." Focus goes to the S0 heading.
- `#task` has `aria-busy="true"` while scanning, removed on exit. Steps are not announced individually.
- Announcement: "Scanning image." (F2 rule).

### S2 Result (cert page opened)
```
┌──────────────────────────────────────┐
│ ✓ Opened PSA cert page           (h2)│
│ ┌──────┐  [PSA]                      │
│ │thumb │  01234567     (mono 24/600) │
│ └──────┘  Read from text (OCR)       │
│           psacard.com/cert/01234567  │
│ [⧉ Copy number] [↗ Open again]       │
│ Wrong number? Edit                   │
│ ┌ ⓘ Check that the cert page matches┐│
│ │  this slab. A valid number alone  ││
│ │  doesn't prove the slab is genuine.│
│ └───────────────────────────────────┘│
└──────────────────────────────────────┘
```
- The heading has a success check icon (`aria-hidden`); the text carries the meaning.
- The grader chip is neutral. The number has `dir="ltr"` and is selectable. The path line is muted text, not a link.
- **Background-tab setting on:** add the line "The page is in a background tab." and the secondary button **Go to tab** (`chrome.tabs.update(id,{active:true})`).
- **Offline** (`navigator.onLine===false`): add the muted note `offline_note` with an offline icon.
- **Copy number** → the label changes to "Copied" for 2 s and the status says "Number copied." If it fails, show `copy_failed` next to the button.
- **Open again** opens one more tab.
- **Wrong number? Edit** is a link-style button that leads to S2e.
- No "Sharper scans" offer in this state.
- Focus goes to the heading. Announcement: "Opened PSA cert page for 01234567."

### S2e Edit (inside the result card)
```
│ Edit number                      (h2)│
│ Cert number                          │
│ [01234567______________] (selected)  │
│ Grader  (●PSA)( CGC Comics )( CGC Cards )
│ [ Open cert page ↗ ]  [ Cancel ]     │
│ Opens psacard.com/cert/01234567      │
```
- On entry, focus goes to the number field with all text selected.
- Validation and parsing are the same as in section 4.
- Open → new tab → S2 with method "Corrected by you"; the latest history entry is replaced.
- Cancel or Esc → S2, with focus on "Wrong number? Edit".

### S3 Needs confirmation
```
┌──────────────────────────────────────┐
│ Check the number                 (h2)│
│ ⓘ This number fits both CGC Comics   │
│   and CGC Cards. Choose one.         │
│ ┌──────┐ [Show larger]               │
│ │thumb │ From i.ebayimg.com          │
│ └──────┘                             │
│ Possible numbers            (legend) │
│ ┌──────────────────────────────────┐ │
│ │(●) 4012345001        Best guess  │ │
│ │    Read from text (OCR)          │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │( ) 4012345007                    │ │
│ │    Read from text (OCR)          │ │
│ └──────────────────────────────────┘ │
│ Cert number                          │
│ [4012345001____________]             │
│ Grader                               │
│ ( PSA )( CGC Comics )( CGC Cards )   │
│ [ Open cert page ↗ ] [⧉ Copy number] │
│ Choose a grader to see the link.     │
│ ┌ ⓘ Scanned at screen resolution ──┐ │
│ │ (low-res notice, see N1)          │ │
│ └───────────────────────────────────┘ │
└──────────────────────────────────────┘
```
- **When it appears:** any auto-open condition fails: not exactly one high-confidence candidate, unknown or ambiguous grader, "Always ask" on, or an off-site QR.
- **Reasons:** a compact info block (no title) lists up to 2 reasons in this priority order: `reason_multiple` > `reason_cgc_both` > `reason_grader_unknown` > `reason_unclear` > `reason_always_ask`. The off-site QR warning (N2) is a separate warning block above the reasons.
- **Candidates:** shown only when there are 2 or more (top 3 at most), as a radio group (`fieldset` + legend "Possible numbers").
  - The first candidate has the text tag "Best guess".
  - The meta line is the method, plus "Likely PSA" or "Grader unknown" when relevant.
  - Selecting a candidate fills the field and sets the grader **only if** the candidate's grader is confident. It never submits.
- **Grader** is pre-selected only when known with confidence. For an ambiguous 10-digit CGC number, nothing is selected.
- **Show larger** is a toggle (`aria-expanded`). It expands the thumbnail to full width (max-height 60vh) so the user can compare the label with the field.
- **Open:**
  - With no grader → `err_grader`, and focus moves to the first grader radio.
  - With an invalid number → field error.
  - Otherwise → tab → S2 with the candidate's method, or "Corrected by you" if the field was edited.
- Enter in the field submits. Esc does nothing here, so work isn't lost by accident.
- Focus goes to the heading. Announcement: heading + first reason.
- *Optional, if the pipeline provides a word bounding box:* a 32 px-tall crop of where the digits were read, shown in each candidate card (alt "Where the number was read").

### S4 No number found
```
│ No cert number found             (h2)│
│ ┌──────┐ Try a sharper or closer     │
│ │thumb │ photo of the label, or type │
│ └──────┘ the number.                 │
│ [ Type number ] [⇪ Choose image ]    │
│ (N1 low-res notice / N2 QR warning)  │
```
- **Type number** scrolls to and focuses `#cert-input`. **Choose image** opens the file picker.
- No tab opens and nothing is saved to history.

### S5 Errors (task card, same layout: icon + h2 + body + actions)

| ID | Trigger | Tone | Heading / body keys | Actions |
|---|---|---|---|---|
| E1 | Restricted page (injection/capture refused) | warning | `err_restricted_*` | Choose image |
| E2 | `<img>` for `srcUrl` not found | warning | `err_not_found_*` | Try again (only if activeTab is still valid; architecture must confirm), Choose image |
| E3 | File or image over the byte/pixel limit | warning | `err_too_large_*` ($SIZE$) | Choose image |
| E4 | `captureVisibleTab` failed or image off-screen | warning | `err_capture_*` | Try again (conditional, as E2), Choose image |
| E5 | Tesseract/WASM failed to load, and barcode found nothing | danger | `err_engine_*` | Reload panel (`location.reload()`), Type number |
| E6 | Pasted or dropped item isn't an image | warning | `err_file_type_*` | Choose image |
| E7 | Image could not be decoded | warning | `err_decode_*` | Choose image |
| E8 | Link or HTML dropped without file data | warning | `err_dropped_link_*` ($MENU$) | Choose image |
| E9 | Unexpected failure | danger | `err_generic_*` | Try again, Type number |
| E10 | `tabs.create` failed (inline alert in S2/S3/S2e, not a full state) | danger | `err_open_tab` | (the Open button stays) |

Focus goes to the heading. Workers and the panel must not throw uncaught errors.

### N1 Low-resolution notice (embedded in S3/S4)

| Sub-state | Content | Focus / announcement |
|---|---|---|
| Offer | Info alert: title `lowres_title`; body `lowres_body` (image host); **[Sharper scans on i.ebayimg.com]** (secondary); fine print `lowres_fineprint`; link button **Not now** | none |
| Waiting | Chrome's own dialog is open (wording is Chrome's, roughly "Read and change your data on <host>"; **unverified**) | none |
| Granted | Success alert `perm_granted` + **[Scan again]** (secondary in S3, primary in S4) | focus Scan again; status `perm_granted` |
| Denied | Neutral alert `perm_denied`, no button | focus the alert (tabindex=-1); status `perm_denied` |
| Failed | `perm_failed` + the same button | status `perm_failed` |
| Not now | The notice collapses | focus the state heading |

- **Shown only when** all of these hold: the pixels came from screen capture, the image URL is `https:`, the host isn't already granted, and the host wasn't denied or dismissed this session (`chrome.storage.session`).
- **Never shown** for `http:`, `data:`, `blob:`, pasted or uploaded images.
- The request covers only `https://<exact image host>/*`.

### N2 Off-site QR warning (S3/S4)
- Warning alert: title `qr_offsite_title`; body `qr_offsite_body` (exact host, plain text, never a link).
- Add `qr_offsite_number` when a number was taken from it.
- This blocks auto-open.

### N3 Offline note
- A muted line with an icon, `offline_note`, in S2, S2e and S3 while offline.

### V2 Settings view
```
┌──────────────────────────────────────┐
│ ▣ CertScanner                        │
├──────────────────────────────────────┤
│ [← Back]  Settings               (h2)│
│ Opening cert pages               (h3)│
│ Always ask before opening     [○──]  │
│ When off, the cert page opens by     │
│ itself if exactly one number is read │
│ clearly.                             │
│ Open in a background tab      [○──]  │
│ Stay on the page you're viewing.     │
│ Scan history                     (h3)│
│ Keep scan history             [──●]  │
│ Saves the last 20 numbers on this    │
│ device only. Turning this off        │
│ deletes them.                        │
│ [ Clear history ]                    │
│ Sharper scans                    (h3)│
│ Sites CertScanner may load full-size │
│ images from:                         │
│ i.ebayimg.com             [ Remove ] │
│ About                            (h3)│
│ Images are processed on this device… │
│ A cert lookup shows what the grader's│
│ database says… can't tell whether…   │
│ Not affiliated with PSA or CGC.      │
│ PSA and CGC are trademarks of…       │
│ Language follows your Chrome settings│
│ Removing the extension deletes its   │
│ scan history.                        │
│ Version 1.0.0 · Privacy policy ↗     │
├──────────────────────────────────────┤
│ Not affiliated with PSA or CGC · …   │
└──────────────────────────────────────┘
```
- **Navigation:** open → focus `#settings-heading`. Back or Esc → Home, with focus on the header Settings button.
- **Defaults:** Always ask = off, Background = off, Keep history = on. Toggles are stored in `chrome.storage.sync` and saved the moment they change; there is no Save button.
- **Keep history off** deletes the stored history immediately. Status: "Scan history cleared."
- **Clear history** clears the list and status says "Scan history cleared." The button stays and keeps focus, now with `aria-disabled="true"` and the helper text "No saved scans." below it. If history is already empty, it appears in that state from the start.
- **Sites list:** comes from `chrome.permissions.getAll()`. It refreshes when the view opens and on `permissions.onAdded/onRemoved`.
  - **Remove** has accessible name "Remove <host>" (via `aria-labelledby`). Status: "Removed <host>."
  - Focus then moves to the next row's Remove button, or to the sites heading if the list is empty.
  - Empty list text: `settings_sites_empty`.
- **Privacy policy** is an `<a target="_blank" rel="noopener">`. The URL is a release dependency.
- Drop and paste are ignored in this view.

### Home sections (persistent across task states)
- **Recent scans:**
  - Newest first, with the 5 newest visible. **Show all (N)** / **Show fewer** toggles (`aria-expanded`); focus stays on the toggle.
  - Row: `[chip] 01234567` on the first line; relative time in muted text (`Intl.RelativeTimeFormat(locale_code)`) on the second line; **Open ↗** (secondary small) and a Copy icon button (32×32).
  - Accessible names come from `aria-labelledby` = button + number elements, e.g. "Open PSA 01234567" / "Openen PSA 01234567", and "Copy 01234567".
  - Empty text: `recent_empty`. History off: `recent_off`.
  - Stored per entry: `{grader, number, method, time}`. **No page URL, host or image.**

---

## 4. Manual entry (form `#manual-form`, also used by S2e/S3 fields)

**Field:** `<input id="cert-input" type="text" autocomplete="off" spellcheck="false" maxlength="64">`
- Visible label "Cert number". Hint `field_cert_hint` linked with `aria-describedby="cert-hint cert-error"`.
- Monospace 1rem font. No placeholder used as a label.

**Parsing (case-insensitive, after trimming):**
1. **Official URL** on the allow-list (`psacard.com/cert/…`, `cgccomics.com/certlookup/…`, `cgccards.com/certlookup/…`) → extract the grader and number. Any other URL → `err_link`. *(Should.)*
2. **Optional leading prefix:**
   - `psa` → PSA
   - `cgc comics` / `cgc comic` → CGC Comics
   - `cgc cards` / `cgc card` → CGC Cards
   - `cgc` → CGC family (Comics vs Cards still unresolved)
   - Filler tokens `cert`, `#`, `no.` and `nr.` are ignored.
3. **Remainder:** strip spaces, `-`, `.` and `/` (`1234567-001` → `1234567001`). Any other character → `err_chars`. Keep the number as a **string** so leading zeros survive.
4. **Length** comes from the routing data table. Provisional limits are MIN 7 and MAX 13; outside that → `err_length` ($MIN$, $MAX$, $COUNT$).

**Choosing the grader (radio group `#grader-group`, nothing selected initially):**
- **Order of precedence:** a typed prefix wins over an explicit radio click, which wins over inference.
- **A typed prefix** updates the radios live.
- **Inference** only fills the selection if the user hasn't clicked a radio since the field was last empty:
  - 13 digits → CGC Cards.
  - 8–9 digits → PSA.
  - Inferred choices show `grader_auto_hint` under the radios.
  - 10 digits, or a bare `cgc` prefix (except 13 digits) → nothing selected, and `reason_cgc_both` is shown as the hint.
- **Clicking a radio that conflicts with a typed prefix** removes the prefix from the field, so what is shown is always what will be used.
- **Usual-length warning:** if a grader is selected and the length is outside that grader's usual range, show `warn_length` in the error container in warning style. It appears 600 ms after typing stops or immediately on a grader change. It does **not** block submission.

**Submitting (Enter in the field or the Open button):**
- Validate in this order: empty → characters → length → grader.
- **On error:**
  - Set `aria-invalid="true"` and write the message into `#cert-error` (persistent, `aria-live="polite"`, danger text plus an error icon).
  - Focus stays in the input. For `err_grader`, focus moves to the first grader radio instead.
  - After the first failed submit, re-validate on every input change and clear the error as soon as the value is valid.
- **On success:**
  - `tabs.create` (foreground or background per the setting).
  - Clear the field and the grader selection; focus stays in the input.
  - Status `status_opened`. The task card shows S2 ("Typed by you"). History +1.

**URL preview** `#url-preview`: a muted line under Open.
- Shows "Opens psacard.com/cert/01234567" (scheme and `www.` removed), or `url_preview_pending` when no grader is chosen.
- Updates live and is **not** announced.

---

## 5. Image input (drop, paste, upload)

- **Drop zone** (`#drop-zone`): 2 px dashed `--cs-border-control`, `--cs-radius-md`, `--cs-surface` background, 16 px padding, centred text, min-height 112 px.
  - The zone itself is **not** focusable; the only control inside is **Choose image**.
  - It should not respond to hover; only the button inside does.
- **Drag-over:**
  - Applies while dragging anything over the Home view (`dragenter` on `main#home`).
  - Zone style: 2 px **solid** `--cs-accent` border, `--cs-accent-subtle` background, text swaps to "Release to scan" plus an icon change. The change is shape *and* text, not colour alone.
  - It reverts on `dragleave` out of Home, on drop, or on Esc.
  - Dropping anywhere in Home is accepted.
- **Accepted files:** `image/jpeg, image/png, image/webp, image/avif, image/gif, image/bmp`. Copy only lists the first four.
  - A non-image file → E6. A link or HTML without file data → E8. Over the limit → E3.
- **Paste:** Ctrl+V (⌘V on macOS) in the Home view.
  - An image on the clipboard → scan. This applies even when focus is in `#cert-input`; in that case `preventDefault` the text paste.
  - Text, with focus outside a text field → put it into `#cert-input` and focus that field (no auto-submit).
- **Choose image:** a `<button>` that triggers a hidden `<input type="file" id="file-input">`.
- Uploaded or pasted images: the thumbnail caption shows the file name (or "Pasted image"). Pixels are kept only in memory; revoke object URLs when the state is cleared.

---

## 6. Copy, i18n and manifest text

**Rules**
- Every visible string comes from `_locales/{en,nl}/messages.json`. `default_locale` is `"en"`. Keys are snake_case. Include a `description` for translators (the notes column below).
- **Placeholders** use Chrome syntax: message `"Opened $GRADER$ cert page"` with `"placeholders": {"grader": {"content": "$1", "example": "PSA"}}`.
- **Strings are set with `textContent`, never `innerHTML`.**
- **No string concatenation for grammar.** Counts appear only where they're always ≥ 2, or in neutral "Label (N)" form. Dates and relative times use `Intl` with `locale_code`.
- **Brand and grader names are never translated:** CertScanner, PSA, CGC Comics, CGC Cards.
- Dutch uses informal "je" (as Chrome NL does). Quotes are “…” in EN and ‘…’ in NL.
- **Avoid the words** "verified", "authentic", "genuine" / "echt" except in the negative notes.
- Cert numbers, hosts and paths are wrapped with `dir="ltr"`.

### 6.1 Manifest and browser chrome

| Key | EN | NL | Notes |
|---|---|---|---|
| ext_name | CertScanner | CertScanner | `"name": "__MSG_ext_name__"` |
| ext_description | Right-click a PSA or CGC slab photo to open its official cert page. Reads the number on-device. Not affiliated with PSA or CGC. | Rechtsklik op een PSA- of CGC-slabfoto om de officiële certpagina te openen. Leest op je apparaat. Niet gelieerd aan PSA of CGC. | Hand count: EN 127, NL 128 characters (limit 132). QA to verify with a script. |
| action_title | Open CertScanner | CertScanner openen | `action.default_title` |
| context_menu_scan | Scan slab cert number | Certnummer van slab scannen | `contextMenus.create({contexts:["image"]})`; also fills $MENU$ |
| locale_code | en | nl | Not visible; sets `<html lang>` and the `Intl` locale |

```json
"name": "__MSG_ext_name__",
"description": "__MSG_ext_description__",
"default_locale": "en",
"action": { "default_title": "__MSG_action_title__", "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png" } },
"icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" }
```

### 6.2 Header, idle, image input

| Key | EN | NL | Notes |
|---|---|---|---|
| nav_settings | Settings | Instellingen | Header button and Settings h2 |
| nav_back | Back | Terug | |
| a11y_new_tab | (opens in a new tab) | (opent in een nieuw tabblad) | Visually hidden suffix on Open buttons and external links |
| idle_heading | Scan a slab | Slab scannen | |
| idle_body | Right-click a slab photo on a web page and choose “$MENU$”. | Klik met rechts op een slabfoto op een webpagina en kies ‘$MENU$’. | MENU = context_menu_scan |
| idle_body_alt | Or drop, paste or upload an image below, or type the number. | Of sleep, plak of upload hieronder een afbeelding, of typ het nummer. | |
| input_heading | Scan an image | Afbeelding scannen | |
| drop_title | Drop a slab photo here | Sleep een slabfoto hierheen | |
| drop_active | Release to scan | Loslaten om te scannen | Drag-over |
| paste_hint | or paste with $SHORTCUT$ | of plak met $SHORTCUT$ | |
| shortcut_paste_mac | ⌘V | ⌘V | |
| shortcut_paste_other | Ctrl+V | Ctrl+V | |
| upload_button | Choose image | Afbeelding kiezen | |
| drop_formats | JPEG, PNG, WebP or AVIF, up to $SIZE$ | JPEG, PNG, WebP of AVIF, tot $SIZE$ | SIZE from size_mb |
| size_mb | $COUNT$ MB | $COUNT$ MB | Limit set by architecture (assumed 20) |

### 6.3 Manual entry and validation

| Key | EN | NL | Notes |
|---|---|---|---|
| manual_heading | Type a cert number | Certnummer typen | |
| field_cert_label | Cert number | Certnummer | All number fields |
| field_cert_hint | For example PSA 01234567 or CGC 4012345001 | Bijvoorbeeld PSA 01234567 of CGC 4012345001 | |
| grader_legend | Grader | Grader | |
| grader_psa | PSA | PSA | |
| grader_cgc_comics | CGC Comics | CGC Comics | |
| grader_cgc_cards | CGC Cards | CGC Cards | |
| grader_auto_hint | Selected from what you typed. | Gekozen op basis van wat je typte. | |
| open_button | Open cert page | Certpagina openen | + a11y_new_tab |
| url_preview | Opens $URL$ | Opent $URL$ | URL e.g. psacard.com/cert/01234567 |
| url_preview_pending | Choose a grader to see the link. | Kies een grader om de link te zien. | |
| err_empty | Enter a cert number. | Vul een certnummer in. | |
| err_chars | Use digits, optionally after PSA or CGC. | Gebruik cijfers, eventueel na PSA of CGC. | |
| err_length | Cert numbers have $MIN$ to $MAX$ digits. This one has $COUNT$. | Certnummers hebben $MIN$ tot $MAX$ cijfers. Dit nummer heeft er $COUNT$. | |
| err_grader | Choose PSA, CGC Comics or CGC Cards. | Kies PSA, CGC Comics of CGC Cards. | |
| err_link | That link isn't a PSA or CGC cert page. | Die link is geen certpagina van PSA of CGC. | |
| warn_length | Unusual length for $GRADER$. Check the number before opening. | Ongebruikelijke lengte voor $GRADER$. Controleer het nummer voordat je opent. | Doesn't block |

### 6.4 Scanning

| Key | EN | NL | Notes |
|---|---|---|---|
| scan_heading | Scanning… | Bezig met scannen… | |
| step_load | Loading image | Afbeelding laden | |
| step_barcode | Reading barcode | Barcode lezen | |
| step_text | Reading text | Tekst lezen | |
| step_match | Matching | Nummer bepalen | |
| step_state_done | Done | Klaar | Visually hidden |
| step_state_active | In progress | Bezig | Visually hidden |
| step_state_waiting | Not started | Nog niet gestart | Visually hidden |
| step_state_skipped | Skipped | Overgeslagen | Visible |
| step_text_starting | Starting text reader… | Tekstlezer starten… | |
| scan_slow | Still working. Large images take longer. | Nog bezig. Grote afbeeldingen duren langer. | After 8 s |
| cancel_button | Cancel | Annuleren | Also used in S2e |
| image_alt_page | Image from $HOST$ | Afbeelding van $HOST$ | |
| image_alt_file | Your image: $NAME$ | Jouw afbeelding: $NAME$ | |
| image_alt_pasted | Pasted image | Geplakte afbeelding | Also the caption |
| image_source_page | From $HOST$ | Van $HOST$ | Caption |
| image_larger | Show larger | Groter tonen | aria-expanded=false |
| image_smaller | Show smaller | Kleiner tonen | aria-expanded=true |
| status_scan_started | Scanning image. | Afbeelding wordt gescand. | |
| status_scan_cancelled | Scan cancelled. | Scan geannuleerd. | |

### 6.5 Result, edit, confirm, none

| Key | EN | NL | Notes |
|---|---|---|---|
| result_heading | Opened $GRADER$ cert page | Certpagina van $GRADER$ geopend | |
| result_bg_note | The page is in a background tab. | De pagina staat op een tabblad op de achtergrond. | |
| go_to_tab | Go to tab | Naar tabblad | |
| method_barcode | Read from barcode | Gelezen uit barcode | |
| method_qr | Read from QR code | Gelezen uit QR-code | |
| method_ocr | Read from text (OCR) | Gelezen uit tekst (OCR) | |
| method_typed | Typed by you | Door jou getypt | |
| method_edited | Corrected by you | Door jou verbeterd | |
| edit_link | Wrong number? Edit | Verkeerd nummer? Wijzigen | |
| open_again | Open again | Opnieuw openen | |
| copy_button | Copy number | Nummer kopiëren | |
| copy_done | Copied | Gekopieerd | 2 s |
| copy_failed | Couldn't copy. Select the number and copy it yourself. | Kopiëren mislukt. Selecteer het nummer en kopieer het zelf. | |
| status_copied | Number copied. | Nummer gekopieerd. | |
| verify_note | Check that the cert page matches this slab. A valid number alone doesn't prove the slab is genuine. | Controleer of de certpagina bij deze slab past. Een geldig nummer alleen bewijst niet dat de slab echt is. | Always shown in S2 |
| status_opened | Opened $GRADER$ cert page for $NUMBER$. | Certpagina van $GRADER$ geopend voor $NUMBER$. | |
| offline_note | You're offline. The page will load when you reconnect. | Je bent offline. De pagina laadt zodra je weer verbinding hebt. | |
| err_open_tab | Couldn't open a new tab. Try again. | Kan geen nieuw tabblad openen. Probeer het opnieuw. | |
| edit_heading | Edit number | Nummer wijzigen | |
| confirm_heading | Check the number | Controleer het nummer | |
| candidates_legend | Possible numbers | Mogelijke nummers | |
| candidate_best | Best guess | Beste gok | |
| candidate_grader_guess | Likely $GRADER$ | Waarschijnlijk $GRADER$ | |
| candidate_grader_unknown | Grader unknown | Grader onbekend | |
| reason_multiple | Found $COUNT$ possible numbers. Pick the one on the label. | $COUNT$ mogelijke nummers gevonden. Kies het nummer op het label. | COUNT ≥ 2 |
| reason_cgc_both | This number fits both CGC Comics and CGC Cards. Choose one. | Dit nummer past bij zowel CGC Comics als CGC Cards. Kies er een. | |
| reason_grader_unknown | Couldn't tell which grader this is. Choose one. | Niet duidelijk welke grader dit is. Kies er een. | |
| reason_unclear | The photo is small or unclear. Compare the number with the label. | De foto is klein of onduidelijk. Vergelijk het nummer met het label. | |
| reason_always_ask | You've set CertScanner to always ask before opening. | Je hebt ingesteld dat CertScanner altijd eerst vraagt. | |
| qr_offsite_title | QR code links to another site | QR-code linkt naar een andere site | |
| qr_offsite_body | It points to $HOST$, not PSA or CGC, so it wasn't opened. | Hij verwijst naar $HOST$, niet naar PSA of CGC, en is daarom niet geopend. | Host as plain text |
| qr_offsite_number | Only the number in it was used. | Alleen het nummer erin is gebruikt. | |
| none_heading | No cert number found | Geen certnummer gevonden | |
| none_body | Try a sharper or closer photo of the label, or type the number. | Probeer een scherpere of grotere foto van het label, of typ het nummer. | |
| type_number_button | Type number | Nummer typen | |

### 6.6 Errors

| Key | EN | NL |
|---|---|---|
| err_restricted_heading | Chrome doesn't allow reading this page | Chrome staat het lezen van deze pagina niet toe |
| err_restricted_body | Save or copy the image, then drop, paste or upload it here. | Sla de afbeelding op of kopieer hem, en sleep, plak of upload hem hier. |
| err_not_found_heading | Couldn't find the image | Afbeelding niet gevonden |
| err_not_found_body | The page may have changed. Scroll the image into view and try again, or upload it. | De pagina is misschien veranderd. Scroll naar de afbeelding en probeer het opnieuw, of upload hem. |
| err_too_large_heading | Image is too large | Afbeelding is te groot |
| err_too_large_body | Choose an image up to $SIZE$, or crop it to the label. | Kies een afbeelding tot $SIZE$, of snijd hem bij tot het label. |
| err_capture_heading | Couldn't capture the image | Afbeelding vastleggen mislukt |
| err_capture_body | Make sure the image is fully visible in the tab, then try again. | Zorg dat de afbeelding helemaal zichtbaar is op het tabblad en probeer het opnieuw. |
| err_engine_heading | Text reader didn't start | Tekstlezer is niet gestart |
| err_engine_body | Barcode scanning and typing the number still work. Reload the panel to try again. | Barcodes scannen en het nummer typen werken nog. Laad het paneel opnieuw om het nog eens te proberen. |
| err_file_type_heading | That's not an image | Dat is geen afbeelding |
| err_file_type_body | Use a JPEG, PNG, WebP or AVIF file. | Gebruik een JPEG-, PNG-, WebP- of AVIF-bestand. |
| err_decode_heading | Couldn't open this image | Kan deze afbeelding niet openen |
| err_decode_body | The file may be damaged. Try another image. | Het bestand is misschien beschadigd. Probeer een andere afbeelding. |
| err_dropped_link_heading | Drop the image file instead | Sleep het afbeeldingsbestand zelf |
| err_dropped_link_body | Links can't be scanned. Right-click the image on the page and choose “$MENU$”, or save it and drop the file. | Links kunnen niet worden gescand. Klik met rechts op de afbeelding en kies ‘$MENU$’, of sla hem op en sleep het bestand. |
| err_generic_heading | Something went wrong | Er ging iets mis |
| err_generic_body | Try again, or type the number. | Probeer het opnieuw of typ het nummer. |
| retry_button | Try again | Opnieuw proberen |
| reload_button | Reload panel | Paneel opnieuw laden |

### 6.7 Low resolution and permission

| Key | EN | NL |
|---|---|---|
| lowres_title | Scanned at screen resolution | Gescand op schermresolutie |
| lowres_body | Images on this page come from $HOST$. Allow full-size images from that site for sharper scans. | Afbeeldingen op deze pagina komen van $HOST$. Sta afbeeldingen op volle grootte van die site toe voor scherpere scans. |
| lowres_button | Sharper scans on $HOST$ | Scherpere scans op $HOST$ |
| lowres_fineprint | Chrome will ask you to allow access to $HOST$. CertScanner only uses it to load images you scan. Remove it any time in Settings. | Chrome vraagt of je toegang tot $HOST$ toestaat. CertScanner gebruikt die alleen om afbeeldingen te laden die je scant. Je kunt dit altijd intrekken in Instellingen. |
| lowres_dismiss | Not now | Niet nu |
| perm_granted | Sharper scans are on for $HOST$. | Scherpere scans staan aan voor $HOST$. |
| rescan_button | Scan again | Opnieuw scannen |
| perm_denied | No permission given. Scans on $HOST$ will use screen resolution. | Geen toestemming gegeven. Scans op $HOST$ gebruiken schermresolutie. |
| perm_failed | Chrome couldn't show the permission request. Try again. | Chrome kon de toestemmingsvraag niet tonen. Probeer het opnieuw. |

### 6.8 Recent, settings, about, footer

| Key | EN | NL | Notes |
|---|---|---|---|
| recent_heading | Recent scans | Recente scans | |
| recent_empty | No scans yet. | Nog geen scans. | |
| recent_off | History is off. You can turn it on in Settings. | Geschiedenis staat uit. Je kunt hem aanzetten in Instellingen. | |
| recent_open | Open | Openen | Name = button + number via aria-labelledby |
| recent_copy | Copy | Kopiëren | Visually hidden label for the icon button |
| recent_show_all | Show all ($COUNT$) | Alles tonen ($COUNT$) | |
| recent_show_fewer | Show fewer | Minder tonen | |
| settings_opening_heading | Opening cert pages | Certpagina's openen | |
| setting_always_ask | Always ask before opening | Altijd vragen voor het openen | role=switch, default off |
| setting_always_ask_hint | When off, the cert page opens by itself if exactly one number is read clearly. | Als dit uit staat, opent de certpagina vanzelf als er precies één nummer duidelijk is gelezen. | |
| setting_background | Open in a background tab | Openen op een achtergrondtabblad | default off |
| setting_background_hint | Stay on the page you're viewing. | Je blijft op de pagina die je bekijkt. | |
| settings_history_heading | Scan history | Scangeschiedenis | |
| setting_history | Keep scan history | Scangeschiedenis bewaren | default on |
| setting_history_hint | Saves the last $COUNT$ numbers on this device only. Turning this off deletes them. | Bewaart de laatste $COUNT$ nummers, alleen op dit apparaat. Uitzetten wist ze. | COUNT = 20 (assumed) |
| clear_history | Clear history | Geschiedenis wissen | |
| history_empty | No saved scans. | Geen opgeslagen scans. | |
| status_history_cleared | Scan history cleared. | Scangeschiedenis gewist. | |
| settings_sites_heading | Sharper scans | Scherpere scans | |
| settings_sites_body | Sites CertScanner may load full-size images from: | Sites waarvan CertScanner afbeeldingen op volle grootte mag laden: | |
| settings_sites_empty | None yet. You'll be offered this when a scan could be sharper. | Nog geen. Je krijgt dit aangeboden als een scan scherper kan. | |
| remove_button | Remove | Verwijderen | Name = button + host |
| status_site_removed | Removed $HOST$. | $HOST$ verwijderd. | |
| settings_about_heading | About | Over | |
| about_privacy | Images are processed on this device and never uploaded. A cert number only leaves your device when the grader's page opens. | Afbeeldingen worden op dit apparaat verwerkt en nooit geüpload. Een certnummer verlaat je apparaat pas als de pagina van de grader opent. | |
| about_lookup | A cert lookup shows what the grader's database says about a number. It can't tell whether the slab in a photo is genuine. | Een certcontrole toont wat de database van de grader over een nummer zegt. Of de slab op een foto echt is, kan die niet zeggen. | R8 |
| about_disclaimer | Not affiliated with PSA or CGC. | Niet gelieerd aan PSA of CGC. | Footer uses it without the period, or as is |
| about_trademarks | PSA and CGC are trademarks of their respective owners. | PSA en CGC zijn handelsmerken van hun respectieve eigenaren. | |
| about_language | Language follows your Chrome settings. | De taal volgt je Chrome-instellingen. | |
| about_uninstall | Removing the extension deletes its scan history. | Als je de extensie verwijdert, wordt de scangeschiedenis gewist. | |
| about_version | Version $VERSION$ | Versie $VERSION$ | From `getManifest().version` |
| privacy_link | Privacy policy | Privacybeleid | URL is a release dependency |
| footer_local | Images stay on this device | Afbeeldingen blijven op dit apparaat | |

---

## 7. Design tokens

All colour pairs below were computed by hand with the WCAG 2.x relative-luminance formula. **QA must re-measure them with a contrast tool.**

```css
:root {
  color-scheme: light dark;

  /* ── Colour: light ── */
  --cs-bg:              #FFFFFF;
  --cs-surface:         #F6F7F9;   /* task card, drop zone, chips */
  --cs-text:            #1A1D21;
  --cs-text-muted:      #545B66;
  --cs-border-control:  #6B7280;   /* inputs, buttons, radios, toggles, drop zone (≥3:1) */
  --cs-border-subtle:   #E1E4E9;   /* decorative dividers only */
  --cs-accent:          #0F6E66;   /* primary, links, selection, focus */
  --cs-accent-hover:    #0B5A54;
  --cs-accent-subtle:   #E3F2F0;   /* selected segment/candidate, info alert, drag-over */
  --cs-on-accent:       #FFFFFF;
  --cs-focus:           #0F6E66;
  --cs-success:         #1E7B34;  --cs-success-subtle: #E8F5EC;
  --cs-warning:         #7A4D00;  --cs-warning-subtle: #FFF6DB;
  --cs-danger:          #B42318;  --cs-danger-subtle:  #FDECEA;

  /* ── Type ── */
  --cs-font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif;
  --cs-font-mono: ui-monospace, "Cascadia Mono", "Segoe UI Mono", "SF Mono", Menlo, Consolas, "Roboto Mono", "Liberation Mono", monospace;
  --cs-text-xs: 0.75rem;     /* 12px, lh 1.4  – footer, chips, captions (minimum size) */
  --cs-text-sm: 0.8125rem;   /* 13px, lh 1.45 – hints, meta, fine print */
  --cs-text-md: 0.875rem;    /* 14px, lh 1.5  – body, buttons, labels */
  --cs-text-lg: 1rem;        /* 16px, lh 1.4  – h1, section h2, inputs */
  --cs-text-xl: 1.125rem;    /* 18px, lh 1.35 – task-state h2, candidate numbers */
  --cs-text-num: 1.5rem;     /* 24px, lh 1.2  – cert number display (mono, 600, letter-spacing .04em, tabular-nums) */
  --cs-text-num-sm: 1.125rem;
  --cs-weight-regular: 400;
  --cs-weight-strong: 600;

  /* ── Space (4px base, rem so it scales with text) ── */
  --cs-space-1: 0.25rem;  --cs-space-2: 0.5rem;  --cs-space-3: 0.75rem;
  --cs-space-4: 1rem;     --cs-space-5: 1.25rem; --cs-space-6: 1.5rem; --cs-space-8: 2rem;

  /* ── Shape and size ── */
  --cs-radius-sm: 6px;    /* buttons, inputs, thumbnail */
  --cs-radius-md: 10px;   /* cards, alerts, drop zone */
  --cs-radius-full: 999px;/* chips, segments, toggle */
  --cs-control-h: 2.25rem;   /* 36px buttons, segments */
  --cs-input-h: 2.5rem;      /* 40px text inputs */
  --cs-icon-btn: 2rem;       /* 32px icon buttons */
  --cs-target-min: 1.5rem;   /* 24px absolute minimum (link buttons) */
  --cs-thumb: 4.5rem;        /* 72px thumbnail */

  /* ── Focus ── */
  --cs-focus-width: 2px;
  --cs-focus-offset: 2px;    /* use outline, not box-shadow (survives forced colours) */

  /* ── Motion ── */
  --cs-dur-fast: 120ms;      /* hover, drag-over */
  --cs-dur-base: 200ms;      /* "Show larger" expand */
  --cs-ease: cubic-bezier(0.2, 0, 0, 1);
  --cs-spin: 900ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    --cs-bg:             #16181C;
    --cs-surface:        #1F2228;
    --cs-text:           #E8EAED;
    --cs-text-muted:     #A9AFB8;
    --cs-border-control: #8B929C;
    --cs-border-subtle:  #2E3239;
    --cs-accent:         #5CC8BA;
    --cs-accent-hover:   #7DD8CC;
    --cs-accent-subtle:  #16332F;
    --cs-on-accent:      #0B1F1D;
    --cs-focus:          #5CC8BA;
    --cs-success: #6FD08C;  --cs-success-subtle: #15301E;
    --cs-warning: #F5C46B;  --cs-warning-subtle: #3A2E12;
    --cs-danger:  #FF8A80;  --cs-danger-subtle:  #3A1D1B;
  }
}

:focus-visible { outline: var(--cs-focus-width) solid var(--cs-focus); outline-offset: var(--cs-focus-offset); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation: none !important; scroll-behavior: auto !important; }
}

@media (forced-colors: active) {
  /* buttons/inputs/segments keep 1px ButtonBorder; selected segment/candidate: 2px Highlight border + check icon;
     toggle "on": thumb uses Highlight; icons use currentColor */
}
```

**Contrast table (computed)**

| Pair | Light | Dark | Requirement |
|---|---|---|---|
| text / bg | 16.5 | 14.7 | 4.5 |
| text / surface | 15.4 | 13.2 | 4.5 |
| muted / bg | 6.85 | 8.05 | 4.5 |
| muted / surface | 6.39 | 7.22 | 4.5 |
| accent (links) / bg | 6.10 | 8.82 | 4.5 |
| accent / surface | 5.69 | 7.91 | 4.5 |
| on-accent / accent (primary button) | 6.10 | 8.47 | 4.5 |
| on-accent / accent-hover | 8.06 | 10.2 | 4.5 |
| text / accent-subtle | 14.3 | 11.3 | 4.5 |
| accent / accent-subtle (selected border, info icon) | 5.29 | 6.73 | 3 |
| border-control / bg | 4.83 | 5.66 | 3 (non-text) |
| border-control / surface | 4.51 | 5.08 | 3 |
| danger / bg (field errors) | 6.57 | 7.79 | 4.5 |
| danger / danger-subtle | 5.75 | 6.58 | 3 (icon/border) |
| warning / warning-subtle | 6.73 | 8.22 | 3 |
| success / success-subtle | 4.74 | 7.50 | 3 |
| muted / any *-subtle | ≥ 5.95 | ≥ 6.02 | 4.5 |
| focus / bg | 6.10 | 8.82 | 3 |

**Rule:** alert titles and bodies always use `--cs-text` and `--cs-text-muted`. Tone colours are only for the icon and the 4 px inline-start border.

---

## 8. Components

| Component | Spec |
|---|---|
| **Button: primary** | `<button>`; min-height `--cs-control-h`; padding-inline 16 px; `--cs-radius-sm`; bg `--cs-accent`; text `--cs-on-accent` 600 `--cs-text-md`. Hover: `--cs-accent-hover`. Active: same, inset 1 px. Optional 16 px leading icon (↗ for "opens tab" + hidden `a11y_new_tab`). At most **one primary per state**. Never `disabled`. |
| **Button: secondary** | Same size; transparent bg; 1 px `--cs-border-control`; text `--cs-text`. Hover: bg `--cs-surface` (on the surface card: bg `--cs-bg`). |
| **Button: link** | `<button class="link">` for in-panel actions (Edit, Type number, Not now, Show all). Text `--cs-accent`, **always underlined**, min-height 24 px, padding-block 4 px. External links are `<a>` with ↗ and the hidden new-tab text. |
| **Icon button** | 32×32, `--cs-radius-sm`, 16 px icon. Accessible name via `aria-labelledby` or visually hidden text, plus `title` for a tooltip. |
| **Text field** | Visible label above (600 `--cs-text-md`); input min-height `--cs-input-h`; 1 px `--cs-border-control`; `--cs-radius-sm`; bg `--cs-bg`; mono 1rem for cert fields. Focus: outline ring. Invalid: 2 px `--cs-danger` border + `aria-invalid` + error row (icon + text, `--cs-danger`). Hint below in muted `--cs-text-sm`. |
| **Segmented control** (grader) | `<fieldset>` (no border) + visible `<legend>`. Real `<input type=radio>` visually hidden but focusable; `<label>` styled as a pill segment, min-height 36 px, padding-inline 12 px, 1 px `--cs-border-control`, joined, outer ends `--cs-radius-full`. **Selected:** `--cs-accent-subtle` bg + 2 px `--cs-accent` border + **check icon before the label** + 600 weight. Focus ring on the label via `:has(:focus-visible)`. Arrow keys follow native radio behaviour. `flex-wrap: wrap`; below 280 px it becomes a vertical stack with each segment full width and `--cs-radius-sm`. |
| **Candidate card** | `<label>` wrapping a native radio (`accent-color: var(--cs-accent)`) and content. Min-height 48 px; padding 12 px; 1 px `--cs-border-control`; `--cs-radius-md`. Content: number (mono `--cs-text-num-sm` 600, ltr); tag "Best guess" (chip style); meta line muted `--cs-text-sm`. **Selected:** 2 px `--cs-accent` border + `--cs-accent-subtle` bg. Hover: border `--cs-text-muted`. Focus ring on the card. |
| **Grader chip** | Inline pill: `--cs-text-xs` 600, padding 2 px 8 px, 1 px `--cs-border-control`, bg `--cs-surface`, text `--cs-text`. **Same neutral style for every grader** (no brand colours). |
| **Cert number display** | `<p class="cert" dir="ltr">`: mono `--cs-text-num` 600, `letter-spacing:.04em`, `font-variant-numeric: tabular-nums`, no digit grouping, `overflow-wrap:anywhere` only below 200 px. |
| **Status / alert** | Container: `--cs-radius-md`; 4 px inline-start border in the tone colour; bg tone-subtle; padding 12 px; 16 px icon with a **distinct shape per tone** (info ⓘ circle-i, success ✓ circle-check, warning ⚠ triangle, danger ✕ circle-x); optional title 600 then body. Tones: info (accent), success, warning, danger. State headings in the task card use the same icons inline before the h2 text. |
| **Step list** | `<ol>`, 8 px row gap. Icons: pending ○ outline (muted); active spinner = 270° arc in `--cs-accent` rotating `--cs-spin` linear; done ✓ filled circle `--cs-success`; skipped ⊖ circle-dash (muted). Text: pending/skipped muted, active `--cs-text` 600, done `--cs-text`. Reduced motion: active icon is a static half-filled circle ◐. |
| **Thumbnail** | 72×72 box, `--cs-radius-sm`, 1 px `--cs-border-subtle`, bg `--cs-surface`, `object-fit: contain`. "Show larger" expands it to full content width, max-height 60vh (height transition `--cs-dur-base`, none with reduced motion). |
| **Toggle switch** | `<label>` row (min-height 40 px, whole row clickable): text at inline-start, switch at inline-end, hint below (via `aria-describedby`). `<input type=checkbox role=switch>` visually styled as a track (36×20, `--cs-radius-full`). **Off:** bg `--cs-bg`, 1 px `--cs-border-control`, 14 px thumb in `--cs-border-control` at inline-start. **On:** track `--cs-accent` filled, thumb `--cs-on-accent` at inline-end. Thumb transition `--cs-dur-fast`. State shows as position + fill (not colour alone). |
| **Drop zone** | See section 5. Default: dashed border. Drag-over: solid accent border + accent-subtle bg + "Release to scan" + icon swap, transition `--cs-dur-fast`. |
| **Recent row** | `<li>`, 8 px padding-block, 1 px `--cs-border-subtle` bottom. Grid: [chip + number / time] [Open] [Copy icon]. Below 280 px the buttons wrap to a second line. |
| **Header** | 48 px min-height, padding-inline 16/12 px, bottom border subtle. 20 px logo (`aria-hidden`), h1 `--cs-text-lg` 600, Settings secondary button (gear + text) at inline-end. Not sticky. |
| **Footer** | `--cs-text-xs` muted, top border subtle, padding 12 px 16 px, items separated by " · " (wrap allowed). |

**In-panel icons:** inline SVG, 16 px, 1.5 px stroke, `currentColor`, `aria-hidden="true"`. Set: gear, arrow-left, upload, image, copy, external-link, pencil, check, circle-check, circle-i, triangle-alert, circle-x, spinner, circle, circle-dash, wifi-off, tab. No icon fonts and no remote assets.

---

## 9. Motion

| Element | Motion | Reduced motion |
|---|---|---|
| Hover/active colours | `--cs-dur-fast` ease | none |
| Drag-over | border/bg `--cs-dur-fast` | instant |
| Spinner | rotate 360° per `--cs-spin`, linear, infinite | static ◐ icon + the visible "In progress" text is already in the DOM (visually hidden) |
| Show larger | max-height `--cs-dur-base` | instant |
| Toggle thumb | translate `--cs-dur-fast` | instant |
| View switch, state changes | **none** (instant swap) | none |
| Scrolling on focus | default (not smooth) | default |

No flashing, no parallax, and no motion that carries meaning on its own.

---

## 10. Accessibility criteria (WCAG 2.2 AA)

| SC | Requirement in CertScanner |
|---|---|
| 1.1.1 | Thumbnail alt text from §6.4; all decorative SVGs `aria-hidden`; icon buttons have names. |
| 1.3.1 / 2.4.6 | banner/main/contentinfo; one h1; h2 per section and task state; h3 in Settings; `fieldset`/`legend` for grader and candidates; `<ol>` steps; `<ul>` recent and sites; labels tied with `for`; hints and errors via `aria-describedby`. |
| 1.3.2 / 2.4.3 | DOM order = visual order; no positive `tabindex`; headings use `tabindex=-1` only as focus targets. |
| 1.4.1 | Selection = check icon + border weight; errors = icon + text; steps = icon shape + text; toggles = thumb position + fill; links always underlined. |
| 1.4.3 / 1.4.11 | Token table in §7 (text ≥ 4.5:1; UI boundaries, focus and state indicators ≥ 3:1). |
| 1.4.4 / 1.4.10 | rem units; works at 200% text size and at 320 px panel width + 200% zoom (≈160 CSS px) with no horizontal scrolling (§2.4). |
| 1.4.12 | No fixed heights or clipping on text; works with the text-spacing override. |
| 1.4.13 | Only native `title` tooltips; no custom hover content. |
| 2.1.1 / 2.1.2 | Everything is reachable by keyboard; drag-and-drop has Choose image and paste as alternatives; no traps. |
| 2.1.4 | No single-letter shortcuts. Ctrl/⌘+V, Enter, Esc only. |
| 2.4.2 / 3.1.1 | `<title>CertScanner</title>`; `lang` from `locale_code`. |
| 2.4.7 / 2.4.11 | 2 px outline, 2 px offset, ≥ 3:1. No sticky elements that could cover focus. `scrollIntoView` on focus. |
| 2.5.3 | Accessible names start with or contain the visible label ("Open PSA 01234567", "Remove i.ebayimg.com"). |
| 2.5.7 | Dragging is never required. |
| 2.5.8 | All targets ≥ 24×24 CSS px; buttons ≥ 36 px tall; icon buttons 32×32; at least 8 px gap between adjacent targets. |
| 3.2.1 / 3.2.2 | Focusing or selecting a radio never submits or opens anything. Settings save on change without changing context. Auto-open happens only after the user asked for a scan and is explained in Settings (D5). |
| 3.3.1 / 3.3.2 / 3.3.3 | Visible labels and examples; specific error text with how to fix it. |
| 3.3.7 | Edit pre-fills the previous number and grader; candidates pre-fill the field. |
| 4.1.2 | Native controls; `role=switch` on checkbox toggles; `aria-expanded` on Show larger and Show all; `aria-invalid`; `aria-disabled` on an emptied Clear history. |
| 4.1.3 | One `role=status aria-live=polite aria-atomic=true` region outside the views; field-error live containers; `aria-busy` on `#task` while scanning (§3 rules F1–F5). |

**Keyboard map**

| Key | Context | Action |
|---|---|---|
| Tab / Shift+Tab | everywhere | Move in visual order |
| Arrow keys | grader / candidate radios | Change selection (native) |
| Enter | number field | Submit (open) |
| Space / Enter | buttons, toggles | Activate |
| Esc | scanning | Cancel scan |
| Esc | edit (S2e) | Cancel edit → focus Edit |
| Esc | Settings view | Back → focus Settings button |
| Esc | while dragging | Remove drag-over style |
| Ctrl/⌘+V | Home view | Paste image (scan) or text (into field) |
| F6 (Chrome) | browser | Move focus between page and side panel (documented for QA) |

---

## 11. Icon direction (no grader logos; no check mark, so nothing suggests "verified")

**Concept:** a portrait **slab outline** with a solid label band and a card window, overlapped bottom-right by a **magnifier** with a "#" (number) in the lens.
- Colours: teal `#0F6E66`, ink `#1A1D21`, white `#FFFFFF`, light teal `#E3F2F0`.
- A **white halo** behind the magnifier keeps it visible on dark toolbars.
- Draw as SVG and **export PNG** at 16/32/48/128 (Chrome manifest icons must be raster).
- The 128 px art stays inside the central ~96×96 area (Web Store padding guidance).

**128 px master**
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect x="21" y="17" width="58" height="90" rx="9" fill="#FFFFFF" stroke="#0F6E66" stroke-width="6"/>
  <path d="M21 26a9 9 0 0 1 9-9h40a9 9 0 0 1 9 9v14H21z" fill="#0F6E66"/>
  <rect x="30" y="26" width="26" height="5" rx="2.5" fill="#FFFFFF"/>
  <rect x="62" y="26" width="8" height="5" rx="2.5" fill="#FFFFFF"/>
  <rect x="32" y="49" width="36" height="46" rx="4" fill="#E3F2F0" stroke="#0F6E66" stroke-width="4"/>
  <g stroke="#FFFFFF" stroke-linecap="round" fill="none">
    <circle cx="80" cy="79" r="18" stroke-width="14"/>
    <path d="M93 92l12 12" stroke-width="16"/>
  </g>
  <circle cx="80" cy="79" r="18" fill="#FFFFFF" stroke="#1A1D21" stroke-width="7"/>
  <path d="M93 92l12 12" stroke="#1A1D21" stroke-width="9" stroke-linecap="round"/>
  <path d="M76 71v16M84 71v16M72 75h16M72 83h16" stroke="#0F6E66" stroke-width="3.5" stroke-linecap="round"/>
</svg>
```

**48 px:** the master scaled ×0.375. **Remove the "#"** and the small second label mark; keep the single label bar.

**32 px (hand-tuned, viewBox 0 0 32 32):**
- Slab: `rect x=5 y=3 w=16 h=26 rx=2.5`, stroke 2 teal, white fill.
- Band: filled teal down to y=10.
- Card window: `rect x=8.5 y=13 w=9 h=12 rx=1`, stroke 1.5, fill `#E3F2F0`.
- Lens: `cx=21 cy=20 r=5.5`, stroke 2.5 ink, white fill. Handle `M25 24 L28.5 27.5`, stroke 3.5, round.
- Halo: lens stroke 6.5 white; handle 7.5 white.
- No text bars, no "#".

**16 px (hand-tuned, aligned to the pixel grid)**
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <rect x="2.5" y="1.5" width="8" height="13" rx="1.5" fill="#FFFFFF" stroke="#0F6E66"/>
  <path d="M2 3a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v2H2z" fill="#0F6E66"/>
  <circle cx="10.5" cy="10.5" r="3" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="3"/>
  <path d="M12.6 12.6l1.8 1.8" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="10.5" cy="10.5" r="3" fill="#FFFFFF" stroke="#1A1D21" stroke-width="1.5"/>
  <path d="M12.6 12.6l1.8 1.8" stroke="#1A1D21" stroke-width="2" stroke-linecap="round"/>
</svg>
```

**Icon acceptance:**
- The shape is recognisable at 16 px on both light (`#FFFFFF`) and dark (`#35363A`) toolbars.
- No red/blue colour pairings that echo PSA or CGC branding. No letters "PSA" or "CGC". No check mark.

---

## 12. QA acceptance checklist

**Setup.** Use the built extension loaded unpacked in an isolated Chromium profile (Playwright persistent context), plus a manual pass in branded Chrome for the toolbar, side panel, context menu and permission prompt.
- **Fixtures** are synthetic label images:
  - PSA `01234567`
  - CGC Comics `4012345001` with "UNIVERSAL GRADE"
  - CGC Cards `1401234567890`
  - 10 digits with no keywords
  - two candidates
  - blurry
  - non-slab
  - QR to an allow-listed host and QR to `example.test`
- **Test pages:** a CORS-blocked image host, a `data:` image, and a Chrome Web Store page (restricted).
- **Hard-to-reach states** (E3, E5) may use a dev-only preview harness. Those screenshots must be labelled **"prototype capture"**, not "extension capture".

### Global
- [ ] G-01 Panel load makes **zero** requests outside `chrome-extension://` (no fonts, images or CDN).
- [ ] G-02 With Chrome UI in Dutch, every string is NL (brand and grader names excepted). With English or any other language, every string is EN. `<html lang>` matches.
- [ ] G-03 Light/dark follows the system theme. No hard-coded colours outside the token file.
- [ ] G-04 Every pair in the §7 contrast table passes when measured.
- [ ] G-05 At 320, 400 and 500 px: no horizontal scrollbar; no clipped or ellipsised NL text (except host names over 40 characters in buttons).
- [ ] G-06 At 320 px + 200% zoom: reflows (segmented control stacks, buttons go full width); every function is still available.
- [ ] G-07 Every target ≥ 24×24; buttons ≥ 36 px tall; icon buttons 32×32 (DevTools box model).
- [ ] G-08 A focus ring is visible on every focusable element in both themes, never clipped or covered.
- [ ] G-09 Tab order matches §2.3; no traps; Shift+Tab reverses it.
- [ ] G-10 One banner, one visible main, one contentinfo; exactly one h1; no skipped heading levels.
- [ ] G-11 `#status` exists at load, is empty, visually hidden and outside both mains.
- [ ] G-12 With reduced motion emulated: no spinning and no transitions.
- [ ] G-13 With forced colours emulated: buttons, inputs, selected segment/candidate, toggle state and focus are all visible.
- [ ] G-14 "Not affiliated with PSA or CGC" is visible in the footer of both views. No grader logos, brand colours or brand fonts anywhere.
- [ ] G-15 `messages.json` contains "verified", "authentic" or "genuine"/"echt" only inside the negative notes (`verify_note`, `about_lookup`).
- [ ] G-16 Cert numbers are monospace and `dir=ltr`, and leading zeros survive in the display, clipboard, URL and history.
- [ ] G-17 axe-core reports 0 critical/serious issues in S0, S1, S2, S2e, S3, S4, E1, N1 (offer/granted/denied) and Settings.
- [ ] G-18 With the text-spacing override (1.4.12), no content is lost.

### Context menu, action, manifest
- [ ] CM-01 Right-clicking an image shows "Scan slab cert number" / "Certnummer van slab scannen". It is absent for text and links that aren't images.
- [ ] CM-02 Toolbar tooltip is "Open CertScanner" / "CertScanner openen"; clicking opens the side panel.
- [ ] CM-03 `ext_description` is ≤ 132 characters in both locales (scripted check).
- [ ] CM-04 Icons 16/32/48/128 are PNG and legible on light and dark toolbars.
- [ ] CM-05 After the cert tab opens in the foreground, the side panel is **still visible** in that window (UX2).

### S0 Idle
- [ ] I-01 Heading "Scan a slab". The body quotes the exact menu title for the active locale.
- [ ] I-02 Paste hint shows ⌘V on macOS and Ctrl+V elsewhere.
- [ ] I-03 Opening the panel moves no focus. Recent shows "No scans yet." with history on.

### S1 Scanning
- [ ] SC-01 The scanning state with a placeholder thumbnail appears before the image finishes loading.
- [ ] SC-02 The four steps appear in order. The active step is bold with a spinner. Every step exposes its state as text to a screen reader.
- [ ] SC-03 The barcode fixture shows "Reading text · Skipped" as visible text.
- [ ] SC-04 Cancel and Esc stop the scan. **No tab opens later.** The panel returns to S0, announces "Scan cancelled." and focuses the S0 heading.
- [ ] SC-05 `#task[aria-busy=true]` while scanning; the attribute is removed afterwards.
- [ ] SC-06 "Scanning image." is announced once (NVDA and VoiceOver); steps are not announced.
- [ ] SC-07 Thumbnail alt text is correct for page, upload and paste sources.
- [ ] SC-08 With a slowed fixture, "Still working…" appears after 8 s.
- [ ] SC-09 Two quick triggers lead to exactly one tab, for the second image.

### S2 Result
- [ ] R-01 The PSA fixture opens exactly `https://www.psacard.com/cert/01234567`. The panel shows "Opened PSA cert page", the PSA chip, "01234567", "Read from text (OCR)" and "psacard.com/cert/01234567".
- [ ] R-02 The CGC Comics fixture opens `https://www.cgccomics.com/certlookup/4012345001/`; the CGC Cards fixture opens `https://www.cgccards.com/certlookup/1401234567890/`.
- [ ] R-03 `document.activeElement` is the result heading. When triggered from the page, "Opened … for …" is announced.
- [ ] R-04 Copy puts the exact digits on the clipboard, shows "Copied" for 2 s and announces "Number copied.".
- [ ] R-05 Open again opens exactly one more tab.
- [ ] R-06 The verify note is always present (EN and NL).
- [ ] R-07 With the background setting on: the tab is inactive, the note is shown, and "Go to tab" activates the tab.
- [ ] R-08 With DevTools offline: the offline note is shown and the scan still completes.
- [ ] R-09 The history entry contains only grader, number, method and time (inspect `storage.local`).
- [ ] R-10 No "Sharper scans" offer is shown in S2.

### S2e Edit
- [ ] ED-01 Edit pre-fills and selects the number and pre-selects the grader. Open loads the corrected URL, the method shows "Corrected by you", and the latest history entry is replaced (count unchanged).
- [ ] ED-02 Esc or Cancel returns to S2 with focus on "Wrong number? Edit".

### S3 Confirm
- [ ] CF-01 No automatic tab opens for: 10 digits without keywords, blurry, two candidates, "Always ask" on, or off-site QR.
- [ ] CF-02 The reason text matches the cause (§3 priority, max 2).
- [ ] CF-03 Candidates form a radio group with the legend "Possible numbers". Arrow keys change the selection and fill the field. "Best guess" appears as text.
- [ ] CF-04 For an ambiguous 10-digit number, no CGC option is pre-selected. Open → "Choose PSA, CGC Comics or CGC Cards." and focus moves to the first grader radio.
- [ ] CF-05 The URL preview updates live and is not announced. With no grader it shows the pending text.
- [ ] CF-06 Enter in the field submits and the correct URL opens → S2.
- [ ] CF-07 In grayscale (DevTools vision emulation), the selected candidate and segment are still identifiable.
- [ ] CF-08 Off-site QR: the warning shows the exact host as non-link text, and the network log shows **no** request to that host.

### S4 No number
- [ ] NO-01 The non-slab fixture shows "No cert number found". No tab opens and nothing is added to history.
- [ ] NO-02 "Type number" focuses `#cert-input`. "Choose image" opens the native picker.

### N1 Low resolution / permission
- [ ] LR-01 On a CORS-blocked fixture, the notice appears only in S3/S4 and names the **image** host.
- [ ] LR-02 Clicking it shows Chrome's prompt. After allowing, chrome://extensions shows only `https://<host>/*` in site access. *(Record Chrome's prompt wording in a screenshot.)*
- [ ] LR-03 Allow → "Sharper scans are on…", focus on "Scan again"; the rescan fetches from the image origin through the extension.
- [ ] LR-04 Deny → "No permission given…", focus on the notice, no re-prompt this session, manual entry works.
- [ ] LR-05 "Not now" hides the notice for the session and focuses the state heading.
- [ ] LR-06 Settings lists the host. Remove revokes it (`permissions.contains` → false) and announces "Removed <host>.".
- [ ] LR-07 Never offered at install, in S2, or for `http:`, `data:`, `blob:`, pasted or uploaded images.

### S5 Errors
- [ ] ER-01 A Chrome Web Store page gives E1, with no uncaught errors in the panel or worker consoles.
- [ ] ER-02 E2–E9 each show their heading, body and actions as in the §3 table, with focus on the heading. "Try again" appears only where defined.
- [ ] ER-03 E5 (engine assets removed in a dev build): Reload panel reloads, and manual entry still works before the reload.
- [ ] ER-04 Dropping a .txt file gives E6. Dropping an over-limit file gives E3 showing the limit. Dragging an `<img>` from a page without file data gives E8.

### Manual entry
- [ ] M-01 `PSA 12345678` + Enter → `https://www.psacard.com/cert/12345678`; PSA selects itself while typing.
- [ ] M-02 `cgc 1401234567890` → CGC Cards URL.
- [ ] M-03 `cgc 4012345001` → no CGC option selected, the "fits both" hint shows, and Enter gives `err_grader`. Choosing CGC Comics → the comics URL.
- [ ] M-04 `01234567` → PSA pre-selected with "Selected from what you typed."; the leading zero is kept.
- [ ] M-05 `1234567-001` becomes `1234567001`.
- [ ] M-06 Empty, `abc` and `12345` give the matching errors (`err_length` shows count 5). `aria-invalid=true`, the error is linked by `aria-describedby`, announced once, and focus stays in the input.
- [ ] M-07 Clicking a radio that conflicts with the typed prefix removes the prefix.
- [ ] M-08 An official URL pasted into the field is parsed; another site's URL gives `err_link`.
- [ ] M-09 Success clears the field, keeps focus there, announces it, and adds history with "Typed by you".
- [ ] M-10 The whole flow works by keyboard only.

### Image input
- [ ] IN-01 Dragging over Home shows the solid accent border and "Release to scan". It reverts on leave, drop or Esc. A dropped PNG goes to S1.
- [ ] IN-02 Ctrl/⌘+V with an image on the clipboard scans, even when focus is in `#cert-input`.
- [ ] IN-03 Ctrl/⌘+V with text while focus is outside a field puts the text into `#cert-input` and focuses it.
- [ ] IN-04 Paste, drop and upload work with the network disabled.
- [ ] IN-05 Drop and paste are ignored in the Settings view.

### Recent
- [ ] RC-01 Newest first, with a relative time in the UI locale.
- [ ] RC-02 Accessible names: "Open PSA 01234567" / "Openen PSA 01234567"; "Copy 01234567" / "Kopiëren 01234567".
- [ ] RC-03 More than 5 entries → "Show all (N)" with `aria-expanded`; focus stays on the toggle.
- [ ] RC-04 History off → the "History is off…" text and no list.

### Settings
- [ ] ST-01 Settings → focus on the "Settings" heading. Back or Esc → Home, focus on the Settings button.
- [ ] ST-02 Toggles are `role=switch` with visible labels and hints, Space toggles them, and they persist after a panel reload.
- [ ] ST-03 Defaults: Always ask off, Background off, Keep history on.
- [ ] ST-04 Turning history off empties history storage and announces "Scan history cleared.".
- [ ] ST-05 Clear history keeps focus on the button, which becomes `aria-disabled=true` with "No saved scans.".
- [ ] ST-06 About shows the privacy, lookup ≠ authenticity, disclaimer, trademark, language, uninstall, version and privacy-link items. The privacy link opens a new tab.

### Screenshot targets (label each as "actual extension capture" with build hash, Chrome version, OS, date, fixture and state)

| State | EN light 320 | NL dark 320 | EN light 480 | 320 @ 200% |
|---|---|---|---|---|
| S0 idle | ✓ | ✓ | ✓ | ✓ |
| S1 scanning | ✓ | ✓ | | |
| S2 result (+ background note) | ✓ | ✓ | ✓ | |
| S2e edit | ✓ | | | |
| S3 confirm (2 candidates + cgc_both + low-res offer) | ✓ | ✓ | ✓ | ✓ |
| S4 none + low-res granted | ✓ | ✓ | | |
| N1 denied | ✓ | | | |
| E1 restricted | ✓ | ✓ | | |
| Manual entry with error | ✓ | ✓ | | ✓ |
| Settings (with 1 site, history on) | ✓ | ✓ | | ✓ |
| Context menu item + toolbar tooltip (branded Chrome) | ✓ | ✓ (NL UI) | | |

---

## 13. Handoff

**Outcome**
- Design spec delivered: journeys, IA, all states, copy (about 150 EN/NL keys), tokens, components, accessibility criteria, icon geometry and QA checklist.
- Work state: **Planned**. No prototype or runtime capture was produced, because this role had no file-write or browser access in this run.

**Artifacts**
- This document, for the orchestrator to save at `docs/design/design-spec.md`.
- Built from `docs/extension-contract.md` and `docs/research/research.md` on branch `claude/sharp-turing-1et8ns` @ `d809e50`.

**Checks done**

| Check | Result |
|---|---|
| Colour contrast (WCAG formula, by hand) | All pairs meet AA (§7). **Not measured with a tool.** |
| Manifest description length (hand count) | EN 127, NL 128 characters. **Not checked with a script.** |
| Visual, keyboard, screen-reader, zoom | **Not run.** Belongs to QA. |

**Findings and blockers for architecture (consequential)**
1. **UX2:** the side panel must be window-scoped so the result stays visible after the cert tab opens. Otherwise "Wrong number? Edit" is lost. Needs confirmation.
2. Is "Try again" possible for E2/E4? Is activeTab still valid on the same tab after the first injection?
3. Limits are needed: maximum file size and pixel count (copy assumes 20 MB), digit MIN/MAX (assumed 7–13), each grader's usual length ranges (for `warn_length`), and history size N (assumed 20).
4. The pipeline must report the method per candidate (barcode / QR / OCR), confidence, grader guess with confidence, the reason codes listed in §3, whether capture fallback was used, the image host, and (optional) word bounding boxes for snippets.
5. Restoring the last completed state from `chrome.storage.session` on panel reopen is a **Should**.

**Assumptions**
- The context-menu title follows the contract ("Scan slab cert number"), not research J1 ("Scan cert number").
- Turning "Keep scan history" off deletes saved history.
- History stores no page URLs, hosts or images.
- No welcome tab on install.
- Dutch copy uses informal "je".

**Unverified points QA must cover**
- Chrome's exact host-permission prompt wording.
- Whether `aria-live` announcements from an unfocused side panel are read by NVDA, JAWS and VoiceOver. Heading focus is the fallback.
- Whether the context-menu item appears on restricted pages.

**Next owners**
- Architecture: confirm items 1–4.
- Builder: implement tokens, components and states with the IDs in §2.3.
- QA: run §12 and record evidence according to the browser QA report format.
- Release: privacy policy URL, listing copy and disclaimer.
