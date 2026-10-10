# Handoff: CertScanner side panel — restyle

**For the Claude Code agent. Read this file first, then open the screenshots.**

## What to do
Restyle the existing CertScanner Chrome side panel to match the screenshots in `screenshots/`. Keep all current behaviour, states, i18n (EN/NL), accessibility and permissions as they are. This is a **visual restyle**: replace the design tokens and component styles, and apply the four layout changes listed under "Layout changes". Do not add features.

The `.dc.html` files are HTML design references (prototypes), not production code. Do not copy them into the extension. Read them only when you need an exact value; all styles are inline. The screenshots are the source of truth for the look.

## Screenshots
**If you can only attach 5 images, attach these 4 sheets** (each shows several states side by side):
1. `screenshots/sheet-1-light-states-1-5.png` — Idle, Scanning, Result, Edit, Confirm
2. `screenshots/sheet-2-light-states-6-10.png` — Low resolution, Page results, None, Error, Settings
3. `screenshots/sheet-3-dark.png` — dark theme (Idle, Result, Confirm, Page results, Settings)
4. `screenshots/icon.png` — icon at all sizes and in the toolbar

Visible scrollbars in the screenshots are only there because of the capture. They are not part of the design; keep the browser default (thin) scrollbar.

Single states at 2× resolution (360 px panel), for detail:
Light, all states:
- `light-01-idle.png` — Idle (Other ways to scan open)
- `light-02-scanning.png` — Scanning, image 2 of 6, step list
- `light-03-result.png` — Result, auto-opened
- `light-04-edit.png` — Edit
- `light-05-confirm.png` — Confirm, grader unknown
- `light-06-lowres.png` — Confirm, low resolution + "Sharper scans on ‹site›"
- `light-07-page-results.png` — Page results (top part; the list scrolls)
- `light-08-none.png` — None, with tips
- `light-09-error.png` — Error, no access to tab
- `light-10-settings.png` — Settings

Dark: `dark-01-idle.png`, `dark-03-result.png`, `dark-05-confirm.png`, `dark-07-page-results.png`, `dark-10-settings.png`. The other dark states follow the same tokens.

Icon: `icon.png` (128/48/32/16 and toolbar, light + dark).

## Design tokens (replace the current teal set)
| Token | Light | Dark | Use |
|---|---|---|---|
| bg | `#FFFFFF` | `#151515` | panel background, input background |
| surface | `#F7F6F3` | `#212120` | notices, hover fill, placeholder thumbnails |
| text | `#141414` | `#F2F2EF` | body text, primary button fill, selected segment, chip border |
| text-muted | `#6B6A64` | `#A8A7A1` | secondary text, URLs, step status |
| control-border | `#8A8983` | `#7A7973` | inputs, secondary buttons, segmented control, toggle off |
| border | `#E3E2DE` | `#3A3A38` | section dividers, header/footer rule |
| row-line | `#EFEEEA` | `#2A2A28` | lines between list rows |
| accent (red) | `#B3122B` | `#F0475A` | errors, warnings, "in progress" step, primary hover |
| on-text | `#FFFFFF` | `#141414` | text on primary button / selected segment / on accent |

There is **no separate success, warning or info colour**. Meaning is carried by icon + word: success = check icon in text colour; warning = triangle in accent + the word "Warning:"; error = ban/triangle in accent; info = info icon in text-muted.

- **Radius: 0 everywhere** (buttons, inputs, chips, cards, toggles). No pills.
- **Font:** system-ui; monospace (`ui-monospace, SF Mono, Menlo, Consolas`) for cert numbers and URLs.
- **Sizes:** 12 (meta, footer) · 13 (buttons, labels) · 14 (body) · 18 (state heading, number in lists) · 24 (number in result). Weights 400/600/700/800; the wordmark is `CERTSCANNER`, 14 px, weight 900, letter-spacing .04em.
- **Spacing:** 4 · 8 · 10 · 12 · 16 px; side margin 16 px.
- **Heights:** primary button 40, secondary 36 (32 in compact rows), input 40, icon button 32, min target 24.
- **Focus:** 2 px outline in text colour, offset 2 px.
- **Shadows:** none.

## Components
- **Primary button:** fill = text colour, label = on-text, 14/700, label **left-aligned**, optional shortcut or icon on the right. Hover: fill = accent.
- **Secondary button:** 1.5 px control-border, transparent, 13/600. Hover: border = text, fill = surface.
- **Outline-strong button** (Try again, Open in lists, Sharper scans): 1.5 px text-colour border. Hover: inverted.
- **Link button:** 13/600, underline (offset 3 px).
- **Grader chip:** 1.5 px text-colour border, 11/700, no fill, no brand colours. Unknown grader: dashed control-border, muted text.
- **Segmented control:** cells separated by 1.5 px control-border lines; selected cell = text fill + on-text, 700. Uses `repeat(auto-fit, minmax(76px, 1fr))`, so it stacks below ~280 px.
- **Input:** 40 px, 1.5 px control-border, monospace 18 px (16 px in "Type a cert number"). Error: border + message in accent with a triangle icon, directly under the field.
- **Toggle:** square 38×22, 1.5 px border, square knob. On = text fill, knob on-text, knob right. Off = transparent, control-border, knob left.
- **Notice:** surface fill, 10×12 padding, icon + text. **No coloured left border.**
- **Dropzone:** 1.5 px dashed control-border; hover/drag-over = text-colour border + surface fill; text "Drop to scan this image".
- **Step list:** rows split by row-line; icon + label + status word (Done / In progress / Not started / Skipped). In progress = accent loader icon, label 700.
- **Scan progress:** a row of segments (one per image, 4 px high, 2 px gap): done = text, current = accent, rest = row-line.
- **Thumbnails:** 72×100 in Result/Confirm (Show larger: 200×278), 48×66 in Page results.

## Layout changes vs the current build
1. Sections (task card, Other ways to scan, Recent scans) are separated by a 1 px border line. They are not separate cards with a background.
2. **"Other ways to scan" is a disclosure.** Open by default in Idle; collapsed in Result, Page results, None and Error; hidden in Edit/Confirm (the task card already has the form).
3. Page-results thumbnails are 48 px instead of 72 px.
4. The footer is fixed at the bottom of the panel; the middle part scrolls.

## Icon
A square slab outline with a red label bar and a magnifier, with no checkmark. 24-unit grid:
```svg
<rect x="3" y="1.75" width="13.5" height="19" fill="#FFFFFF" stroke="#141414" stroke-width="2"/>
<rect x="3" y="1.75" width="13.5" height="4.5" fill="#B3122B"/>
<circle cx="15" cy="15" r="4.75" fill="#FFFFFF" stroke="#141414" stroke-width="2"/>
<path d="M18.6 18.6 22 22" stroke="#141414" stroke-width="2.5"/>
```
Export to 16/32/48/128 px PNG. The light version works on both light and dark Chrome toolbars.

## Files
- `screenshots/` — the look to build (start here)
- `CertScanner.dc.html` — overview of all states (light + dark), for reference
- `CertScanner Panel.dc.html` — the panel prototype, with all exact inline values
- `support.js` — only needed to open the `.dc.html` files in a browser
