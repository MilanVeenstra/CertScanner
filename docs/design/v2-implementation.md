# Design v2: how it is built in

Source: `CertScanner_v2_offline.html` from Claude Design (2026-10-13, "New features in the existing style"), 17 light
states and 5 dark ones at 360 px. The design was implemented 1:1 in `src/sidepanel/sidepanel.html`, `sidepanel.css`
and `ui.js`; behaviour, test ids, i18n (EN/NL) and permissions are unchanged unless listed below.

## What changed against the 10 October round

| Area | Design v2 | Where |
| --- | --- | --- |
| Icons | 24 px grid, round caps and joins, square corners (settings sliders, back, check, copy, external, triangle, info, x, image, page, loader, circle, filled step, minus, chevron, zoom) | sprite in `sidepanel.html` |
| Header | Logo + CERTSCANNER + sliders button; in Settings "← Back" + "Settings" (h1) | `.header-home` / `.header-settings` |
| Result | Cert check under the number: "✓ Opened <url>", how it was read, Open again, Copy number, "Wrong number? Edit", the "doesn't prove genuine" note | `tpl-result` |
| Value | Own section; source at the right of the heading; two tiles in one grey box (min 118 px); "For: … · Wrong card or grade? Change" on one line; Change opens a bordered form (Card, Grade, Show value) | `tpl-value`, `#result-extra` |
| eBay sales | Three figures without boxes, four sales as single lines (date, title, price), then Sold on eBay, For sale on eBay, This slab on eBay (the Market buttons merged here) | `tpl-value` |
| Market | "Price per grade" folded by default with a one-line preview; 3-column grid, recent sales, PriceCharting and population links | `tpl-market` |
| Check the number | One grey box with every reason (red triangle: what to check, grey "i": what only informs; an off-site QR code as the first reason with its title); chip above the number; "Show larger" with a zoom icon; "Possible numbers" as rows with one button each; sharper-scans box after the form | `tpl-confirm`, `tpl-reason` |
| Page results | Rows: photo, chip, number, how it was read, URL; Open / Choose grader, Copy, eBay sold on the right; notes in a grey box under the row; "✓ Opened" replaces Open | `tpl-page-row` |
| Errors | First way out is the strong button, the rest secondary; no access gets the red triangle | `ui.showError`, `ui.showPageAccess` |
| Other ways to scan | Open on Start, folded under a result, none, an error or no access; not shown while scanning, on the page list or with a number form; the number field is labelled "Type a cert number" with the example as placeholder | `#other-ways` |
| Recent scans | Start only | `ui.setTaskState` |
| Settings | Toggles 38×22 with the hint under the label; shortcut and "Change shortcut" on one row; keys with the input and "Save key" side by side, a check mark when the key works; shorter texts from the design | `#settings` |

## Added after the design

- Header button "New scan" (refresh icon, left of Settings): back to a clean Start screen, as when the panel is opened fresh; cancels a running scan and forgets the last result (user request 2026-10-14).
- "Show value" applies the card and grade and closes Change; picking a grade alone changes nothing; the grade list has no "All grades".
- "Check the number": clicking a grader opens that cert page and shows the result at once, as Open does (user request 2026-10-16); with the keyboard the arrows move the choice and Enter opens.
- "CertScanner can't read this page yet": when the panel can't name the site, the offer is "Always allow on all sites" (same box and fine print as "Always allow on ‹site›").
- Public release (ADR A25): the eBay sales section became "Look up sales" (eBay sold / for sale, This slab on eBay, PriceCharting, population report). The Value section is filled by PokemonPriceTracker with the user's key; without one it says how to add it ("Add key" opens Settings at the key field).

## Deliberate differences

- Thumbnails show the scanned photo; the striped box is the placeholder while scanning or without a photo.
- Beckett: "The number is copied. Paste it into Beckett's lookup form." appears after the lookup was opened (the copy happens on that click), not before.
- Value notes the design has no place for (why PokemonPriceTracker wasn't used, a different PriceCharting column, "grade not read") are a muted line under "For: …".
- The PSA key keeps today's usage line ("Lookups CertScanner sent to PSA today: n of 100").
- With several possible numbers the number form is folded away (as designed); it comes back when a chosen row still needs a grader.
- "Opens psacard.com/cert/…" under the Start form appears once a number is typed (the design shows a PSA link while the field is empty, which would be wrong for CGC and BGS numbers).
- The "Price per grade" preview shows the grade next to this slab's grade and the highest price, then "and N more".
