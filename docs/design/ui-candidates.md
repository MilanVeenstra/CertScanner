# Side panel: three information-architecture candidates (result and idle)

_Role: UX designer · 2026-10-11 · Status: concept (ASCII wireframes, no prototype). Source read at 3957a00:
`src/sidepanel/{sidepanel.html,sidepanel.css,ui.js,main.js,certField.js,priceData.js}`, `src/core/priceLinks.js`,
locales, `docs/design/*`, `tests/e2e/lib/env.mjs`. All candidates keep the restyle tokens (black/white, red #B3122B only
for problems, square corners, 1.5 px lines, type 12/13/14/18/24, spacing 4/8/10/12/16)._

## 1. Why the current layout reads as "vague"

| # | Observation |
|---|---|
| D1 | The heading names an event ("Opened PSA cert page"), not the slab; card and grade appear ~330 px lower. |
| D2 | The slab's identity is split: grader chip and number at the top, grade chip, card name and set inside "Prices for this card". "PSA" appears 4× above the fold. |
| D3 | The value comes after five verification blocks (tiles start ~480 px down). |
| D4 | "Prices for this card" mixes in-panel data (PriceCharting), searches that open a tab (eBay) and population (PSA), plus a 3-line note about two sources. |
| D5 | "Change" and "Wrong number? Edit" don't say what they change. |
| D6 | The whole price box is one `aria-live` region: a screen reader may read the grid and sales list in full. |
| D7 | Idle prints the shortcut twice and says "Choose a grader to see the link." while the grader buttons are hidden. |
| D8 | Grader detection is invisible; confirm preselects the best guess but the button doesn't say so. |
| D9 | Page-scan results show no value. |

## 2. Shared rules (all candidates)

### 2.1 Invariants

| ID | Rule |
|---|---|
| I1 | The safety note is in the same block as the cert-page action and visible without a click. |
| I2 | How the number was read and the exact display URL (monospace, `dir=ltr`) are visible in the default view; `result-number` and `result-url` stay visible (`readResult()` needs them). |
| I3 | Every state change focuses `#task-heading`; `#status` stays the only general live region. |
| I4 | No disabled buttons; validation on submit with the error under the field. |
| I5 | 320 px and 200% zoom: no horizontal scroll, every control reachable. |
| I6 | No check icon in or next to the identity (nothing reads as "verified"). |
| I7 | The value source is always visible ("PriceCharting · US dollars"); the background tab is disclosed while it is open. |
| I8 | Value appears only once the slab is settled; confirm never looks up a value. |
| I9 | Existing `data-testid`s keep their meaning. |

### 2.2 Heading rule

`#task-heading` shows the slab identity: grade badge plus card name ("PSA 10 Charizard ex #199"). Without a card name
it shows "PSA 81234567"; when the name arrives the text updates in place once, focus does not move again, and
`#status` announces the value once. "Opened PSA cert page" moves to the status announcement and to a visible
"✓ Opened psacard.com/cert/…" line next to the cert action.

### 2.3 Fixes needed whichever candidate wins

- `setting_ebay_site_hint` is untrue ("never fetches prices itself"): rewrite.
- `prices_unreadable` EN/NL say different things and point at a button that isn't shown.
- `prices_note` says "above" and mixes two sources: split into a value-source line and an eBay note.
- `prices_not_found` refers to an unnamed "Change".
- Idle under an empty field: "The grader is detected from the number."
- Remove `aria-live` from `.price-data`; announce one value summary through `#status`.
- No "card" wording for CGC Comics.

### 2.4 Value-area states

Loading (fixed height, no shimmer) → ok (tiles, Change, View on PriceCharting; one announcement) · need-card (form,
"Show value") · not-found / unreadable / challenge / error (Try again, Open PriceCharting) · no-permission. When the
value fails, the cert-check area never changes. Grade not read: dashed grader-only badge, tiles say "any grade".

### 2.5 "The system must know PSA, BGS or CGC by itself"

G1 show what was detected and how (grader inside the badge, plus a source line when the pipeline provides it).
G2 the guess becomes the one-click default: the confirm primary button names it ("Open CGC Cards cert page").
G3 manual entry: grader buttons only when the number fits several graders. Limit: how often the grader is known
depends on the pipeline, not the design.

## 3. Candidate A: answer-first single scroll

One identity block, then sections in the order a collector asks: what is it → what is it worth (headline tiles) → is
the cert real (Cert check) → market detail (price per grade, sales, population, eBay). Everything stays expanded.

```
 ┌──────┐ [PSA 10]
 │thumb │ Charizard ex #199            ◀ h2
 │72×100│ Pokemon Scarlet & Violet 151
 └──────┘ PSA cert 81234567     (mono)
 Value                                 ◀ h3   y≈200
 ┌────────────────────┬────────────────────┐
 │ Current · PSA 10   │ Last sold · PSA 10 │
 │ $612.99            │ $625.00 · 9 Oct    │
 └────────────────────┴────────────────────┘
 PriceCharting · US dollars · Wrong card or grade? Change
 Cert check                            ◀ h3   y≈340
 ✓ Opened psacard.com/cert/81234567 · Read from text (OCR)
 [↗ Open again]  [⧉ Copy number]  ✎ Wrong number? Edit
 ⓘ Check that the cert page matches this slab. A valid number alone doesn't prove the slab is genuine.
 Market                                ◀ h3
 Price per grade (3×3 grid, this grade filled) · Recent sales · PSA population · View on PriceCharting
 Search eBay: [Sold on eBay] [For sale on eBay] · This slab on eBay · note
 Scan another slab [⌄] · Recent scans
```

BGS: Cert check says "Not opened yet: Beckett has no page per number." with **Open Beckett lookup** as the only
primary button ("Copies the number, then opens beckett.com/grading/card-lookup"); after the click the line becomes
"✓ Opened …" and the paste hint appears. Idle: the right-click hint moves into "Other ways to scan" as row 1; the
duplicate shortcut line goes. Cost S–M (~1–1.5 days); page ≈1,400 px long with prices, eBay below the fold.

## 4. Candidate B: tabs inside the result (Value | Cert | eBay)

A short identity header and an always-visible verify strip (opened URL, Open again, short safety note), then three
ARIA tabs; Value is selected on every new result. Idle gets Photo | Cert number tabs. Each panel is short (Value fits
360×700 without scrolling). Requires a roving-tabindex tab component used twice, hides 2 of 3 panels by default
(Ctrl+F and linear screen-reader reading miss them), and tabs were rejected for top-level navigation in design-spec
§2.2. Cost M–L (~2–3 days).

## 5. Candidate C: summary card plus drawers

One framed summary card answers identity, value and cert check (with the full safety note) in ~470 px; depth sits in
disclosure drawers (Price per grade, Recent sales, eBay and population) whose open state is remembered locally. Idle
merges photo and number into one box. Tiles at y≈160. Cost M (~2 days, +1 day for per-row value in page results).
Risks: dense card at 320 px, hidden-by-default drawers, a framed card is a small departure from "sections, not cards".

## 6. Confirm, page results and Settings

- **Confirm:** same identity layout with a dashed grader chip; primary button names the guess; no value until
  confirmed.
- **Page results:** "eBay sold" becomes **Details**, which opens the result without opening a tab, with "Back to the
  results" on top (A/B); C adds an inline Value drawer per row.
- **Settings:** regroup to Scanning · Cert pages · Value and eBay · History · About.

## 7. Comparison (designer's estimate)

| Criterion | A | B | C |
|---|---|---|---|
| Tiles top at 360 px | ≈200 px | ≈300 px | ≈160 px |
| Cert action + safety note visible by | ≈530 px | ≈240 px (short note) | ≈470 px |
| Hidden by default | nothing | 2 of 3 panels | grid, eBay |
| Accessibility complexity | lowest | highest | low |
| Fit with established direction | high | medium | high |
| Cost | S–M | M–L | M |

Designer's recommendation: C, with A as fallback when "nothing hidden" and lowest cost weigh more. The evaluator
scores independently.

## 8. Acceptance criteria (for whichever wins)

AC1 tiles fully visible at 360×700 without scrolling · AC2 `readResult()` returns number and URL for PSA, CGC Comics,
CGC Cards and BGS · AC3 safety note in the cert-action block · AC4 focus on `#task-heading`, one value announcement,
no `aria-live` on `.price-data` · AC5 no horizontal scroll at 320 px/200% in EN and NL · AC6 no check icon in the
identity, no disabled buttons · AC7 Open again moves ≤ 8 px between loading and ok · AC8 need-card validation on
submit · AC9 current grade cell has "(this slab's grade)" · AC10 BGS opens no tab before the click · AC13 NL strings
for every new key.

## 9. Findings for the orchestrator

1. Policy review: the PriceCharting tab fallback (inactive tab + read page HTML to pass Cloudflare's check) may
   conflict with PriceCharting's terms and Chrome Web Store expectations about automated access.
2. `setting_ebay_site_hint` is untrue and must be fixed regardless.
3. Optional privacy control: a "Look up value automatically" switch (default on).
4. `grader_from_*` lines need the pipeline's grader source; otherwise leave them out.
