# CertScanner 0.1.0: Chrome Web Store listing draft (EN + NL)

> **Out of date (2026-10-19): rewrite before submitting.** This draft predates the price features. The single purpose, description, permission justifications and data-use answers must cover the price lookups (the card name and grade go to price sources), and the price sources themselves change for the public release (see `docs/research/price-sources-2026.md`). Publishing steps: [`publishing.md`](publishing.md).

_Role: release-manager · Date: 2026-10-10 · Status: **draft, not submitted**. Nothing has been uploaded to the Chrome Web Store, and no developer account was used._
_Inputs: `src/manifest.json` and `src/_locales/{en,nl}/messages.json` at `44ea7bf` (`src/` identical to `03d9589`); ADR-001 (A7–A9); design spec §6.1/§11; security review rounds 1–2 (SEC-16 label fixes applied here); QA test report (52/52 at `03d9589`). An improvement round (SEC-13…19) is in progress; re-check the quoted strings against the final commit._

## 0. How the Store requirements were checked

`developer.chrome.com` and `chromewebstore.google.com` are blocked from this environment (proxy `CONNECT` 403; on 2026-10-10 a second fetch of `developer.chrome.com/docs/webstore/images` failed with DNS `ENOTFOUND`). I used other sources instead:
- the **public source of the docs** on GitHub (`GoogleChrome/developer.chrome.com`, files under `site/en/docs/webstore/`), read on 2026-10-10;
- a web search, for the data-usage categories;
- a web search on 2026-10-10 whose result snippets from `developer.chrome.com/docs/webstore/images` and `/docs/webstore/best-listing` still state: one 440×280 small promo tile is required, screenshots are 1280×800 or 640×400, the marquee tile is 1400×560 and optional, and the store icon is 128×128. These are search snippets, not a read of the live page.

That GitHub repository holds **older copies** of the pages. Every item marked **(verify live)** must be checked against the live Developer Dashboard before upload.

| Requirement | Source (GitHub copy, page "updated" date) | Value used here |
|---|---|---|
| Required images | `images/index.md` (2021-08-13); `cws-dashboard-listing/index.md` (2023-05-01) | **Required:** 128×128 store icon, at least 1 screenshot, small promo tile. **Optional:** marquee tile. **(verify live)** |
| Screenshots | same | 1280×800 (preferred) or 640×400. At least 1, at most 5. Square corners, no padding (full bleed). Can be localized per language. **(verify live)** |
| Small promo tile | same | 440×280, PNG or JPEG, **required**. Not localizable. **(verify live)** |
| Marquee promo tile | same | 1400×560, optional. Needed only to be eligible for a marquee feature. |
| Store icon | `images/index.md` | 128×128 PNG with about 96×96 artwork and transparent padding; must work on light and dark backgrounds. |
| Summary | Manifest `description`, limit 132 characters | The localized `ext_description` (section 1). Changing it requires a new package. |
| Privacy tab | `cws-dashboard-privacy/index.md` (2023-10-05) | Single purpose, a justification per permission, remote-code declaration, data-usage checkboxes and certifications, privacy policy URL. |
| Privacy policy needed even for local-only handling | `program-policies/user-data-faq/index.md` (2023-05-01), Q14 and the Limited Use section | Yes. `PRIVACY.md` includes an affirmative Limited Use statement (§8). |
| Categories | `best_practices/index.md` (2023-09-29) | Section 2. **(verify live)** |
| Registration | `register/index.md` (2023-08-02) | A **one-time registration fee** is charged. **The amount was not verified and is not stated here.** Developer verification steps follow the live dashboard. |

---

## 1. Item basics

| Field | EN | NL | Notes |
|---|---|---|---|
| Name | CertScanner | CertScanner | `ext_name`. Not translated, and contains no grader name. |
| Summary (= manifest `description`) | Scans the PSA and CGC slab photos on a page and opens the official cert page. Reads on-device. Not affiliated with PSA or CGC. | Scant de PSA- en CGC-slabfoto's op een pagina en opent de officiële certpagina. Leest op je apparaat. Niet gelieerd aan PSA of CGC. | **EN 126 / NL 131 characters** (Python `len`, measured 2026-10-10; limit 132). Must stay identical to `src/_locales/*/messages.json` `ext_description`. `npm run check` enforces ≤ 132. |
| Default language | English | | `default_locale: "en"` |
| Additional listing language | | Dutch (Nederlands) | Matches `_locales/nl`. Provide the NL detailed description and, optionally, NL screenshots. |
| Version | 0.1.0 | | `manifest.version`. Each later upload needs a higher version. |

## 2. Category

- **Suggested primary category: Shopping.** The docs describe it as extensions that "enhance the online shopping experience". Users check slab cert numbers while browsing marketplace listings before they buy.
- **Alternative: Tools**, described as "tools that don't fit into other categories". Use it if the reviewer or the user prefers a neutral category.
- **(verify live)** The category names come from the 2023 GitHub copy.

## 3. Detailed description

Plain text: the Store does not render Markdown. The single purpose comes first, then features, privacy and disclaimers. No keyword lists, no rankings, no "verified"/"authentic" claims.

### EN

```text
CertScanner reads the certification number from photos of PSA and CGC graded slabs and opens that grader's official cert lookup page.

HOW IT WORKS
• Scan a page: click the CertScanner icon or press Alt+Shift+S. CertScanner looks at the large photos on the page you're viewing (up to 8, visible ones first), reads their cert numbers and lists them in the side panel. If exactly one number is read clearly, its official cert page opens right away.
• Scan one photo: right-click a slab photo and choose "Scan slab cert number".
• Other ways: drop, paste or upload an image, or type the number.

Supported cert pages: PSA (psacard.com), CGC Comics (cgccomics.com) and CGC Cards (cgccards.com).

YOU STAY IN CONTROL
• The panel always shows the number that was read, how it was read (barcode, QR code or text) and the exact page that opens. Wrong number? Edit it.
• If a number isn't clear, or several numbers are found, CertScanner asks before opening anything.
• Settings: always ask before opening, open in a background tab, keep, clear or turn off scan history, and choose whether the toolbar button scans the page.
• The keyboard shortcut can be changed at chrome://extensions/shortcuts.

PRIVATE BY DESIGN
• Images are read on your device and never uploaded. No account, no analytics, no ads.
• A cert number only leaves your device when the grader's official page opens in a tab.
• CertScanner only reads a page when you click the icon, press the shortcut or right-click a photo. It looks at image addresses and positions (and the page title and photo alt text, to tell PSA, CGC and BGS apart), not at other page text.
• Optional site access ("Sharper scans on <site>") is requested for one site at a time, only when it helps, and can be removed in Settings under "Sites with full access".
• Does not run in incognito windows.

GOOD TO KNOW
• A cert lookup shows what the grader's database says about a number. It cannot tell whether the slab in a photo is genuine. Check that the cert page matches the slab.
• Chrome doesn't let extensions read chrome:// pages or the Chrome Web Store. Save the image and upload it instead.
• Small thumbnails are hard to read. Open the listing's large photo, then scan.

Not affiliated with PSA or CGC. PSA and CGC are trademarks of their respective owners.

Privacy policy: <PRIVACY_POLICY_URL>
```

### NL

```text
CertScanner leest het certificaatnummer van foto's van PSA- en CGC-slabs en opent de officiële certpagina van die grader.

ZO WERKT HET
• Pagina scannen: klik op het CertScanner-icoon of druk op Alt+Shift+S. CertScanner bekijkt de grote foto's op de pagina die je bekijkt (maximaal 8, zichtbare eerst), leest de certnummers en zet ze in het zijpaneel. Is er precies één nummer duidelijk gelezen, dan opent de officiële certpagina meteen.
• Eén foto scannen: klik met de rechtermuisknop op een slabfoto en kies 'Certnummer van slab scannen'.
• Andere manieren: sleep, plak of upload een afbeelding, of typ het nummer.

Ondersteunde certpagina's: PSA (psacard.com), CGC Comics (cgccomics.com) en CGC Cards (cgccards.com).

JIJ HOUDT DE CONTROLE
• Het paneel toont altijd welk nummer is gelezen, hoe (barcode, QR-code of tekst) en welke pagina precies opent. Verkeerd nummer? Wijzig het.
• Is een nummer niet duidelijk, of zijn er meerdere gevonden, dan vraagt CertScanner eerst wat je wilt openen.
• Instellingen: altijd vragen voor het openen, openen op een achtergrondtabblad, scangeschiedenis bewaren, wissen of uitzetten, en kiezen of de werkbalkknop de pagina scant.
• De sneltoets wijzig je via chrome://extensions/shortcuts.

PRIVACY
• Afbeeldingen worden op je apparaat gelezen en nooit geüpload. Geen account, geen analytics, geen advertenties.
• Een certnummer verlaat je apparaat alleen als de officiële pagina van de grader opent in een tabblad.
• CertScanner leest een pagina alleen als jij op het icoon klikt, de sneltoets gebruikt of met rechts op een foto klikt. Het kijkt naar adressen en posities van afbeeldingen (en de paginatitel en alt-tekst van foto's, om PSA, CGC en BGS uit elkaar te houden), niet naar andere tekst op de pagina.
• Optionele toegang per site ('Scherpere scans op <site>') wordt alleen gevraagd als het helpt, en kun je in Instellingen onder 'Sites met volledige toegang' weer verwijderen.
• Werkt niet in incognitovensters.

GOED OM TE WETEN
• Een certcontrole toont wat de database van de grader over een nummer zegt. Of de slab op een foto echt is, kan die niet zeggen. Controleer of de certpagina bij de slab past.
• Chrome laat extensies geen chrome://-pagina's of de Chrome Web Store lezen. Sla de afbeelding dan op en upload hem.
• Kleine miniaturen zijn moeilijk te lezen. Open de grote foto van de advertentie en scan dan.

Niet gelieerd aan PSA of CGC. PSA en CGC zijn handelsmerken van hun respectieve eigenaren.

Privacybeleid: <PRIVACY_POLICY_URL>
```

Every UI term quoted above matches `messages.json` at `44ea7bf`:
- context menu: "Scan slab cert number" / "Certnummer van slab scannen";
- edit link: "Wrong number? Edit" / "Verkeerd nummer? Wijzigen";
- offer button: "Sharper scans on ‹site›" / "Scherpere scans op ‹site›" (`lowres_button`);
- Settings section: "Sites with full access" / "Sites met volledige toegang" (`settings_sites_heading`);
- toolbar setting: "Toolbar button scans the page" / "Werkbalkknop scant de pagina" (`setting_scan_on_click`);
- "Clear history" / "Geschiedenis wissen".

**If FE changes any of these strings, update this draft.**

## 4. Single-purpose statement (Privacy tab)

```text
CertScanner reads the certification number from photos of PSA or CGC graded slabs (the photos on the current page when the user clicks the toolbar icon or presses the shortcut, a photo the user right-clicks, or an image the user uploads or pastes) and opens that grader's official cert lookup page for the number. Typing a number is a manual fallback for the same purpose. It does not grade cards, show prices, or judge authenticity.
```

## 5. Graphic assets

### 5.1 Store icon
- `src/icons/128.png` (copied to `dist/icons/128.png`): 128×128 RGBA PNG with transparent corners. Measured opaque artwork box: x 18–112, y 14–111, about 95×98 px. That roughly matches the 96×96 guidance; the magnifier sticks out at the bottom right, which the guidance allows for irregular shapes.
- The design (spec §11) is a generic slab outline with a magnifier and "#". It has no grader logo, no PSA/CGC letters, no grader brand colours and no check mark. **Ready**, subject to a visual check on dark backgrounds in the dashboard preview.

### 5.2 Screenshots: must be **re-rendered**. None of the existing captures can be uploaded as they are.

The captures in `docs/quality/screenshots/` are real extension captures (S6 build, `837e84d` + dirty tree, headless Chromium 141), but:
- They show the **side panel alone, at 360 px wide and 1017–1592 px tall**. The Store needs **1280×800 or 640×400**, full bleed.
- They **predate A9 (page scan)**. The idle state does not show "Scan this page", and there is no page-results capture. Screenshots must show shipped behaviour.

Plan: 5 screenshots at **1280×800**. Each is a Chrome window showing a synthetic listing page with the CertScanner side panel open, captured from the **final release build** (`dist/` of the tagged commit).
- Use synthetic fixtures only: no real grader logos or card artwork, and no capture of psacard.com or cgc*.com pages.
- Keep the panel footer "Not affiliated with PSA or CGC" visible.
- Record build hash, Chrome version, OS and date for each.

| # | Shows | Source state | Basis |
|---|---|---|---|
| 1 | **Page scan results:** synthetic listing page with 2–3 slab photos, panel showing "Cert numbers on this page" with Open/Copy per row | `body[data-state="page-results"]` (A9) | **New capture.** QA added `tests/fixtures/pages/listing.html`, but it holds one slab (it auto-opens), and `?details=1` adds a plausible wrong PSA row (QA O8). A clean multi-slab variant is still needed. `gallery.html` contains test-only images (foreign QR, overlay, lazy). |
| 2 | **Opened cert page result:** "Opened PSA cert page", number, "Read from text (OCR)", exact path, verify note | S2 | Re-render of `s2-result-light.png` beside the page |
| 3 | **Right-click a photo:** context menu "Scan slab cert number" on a slab photo | native menu | **Manual capture in branded Chrome.** Headless runs can't render the native context menu. |
| 4 | **Confirm when unsure:** "Check the number", grader choice for an ambiguous 10-digit number, URL preview | S3 | Re-render of `s3-confirm-light.png` |
| 5 | **Settings and privacy:** "Toolbar button and shortcut", "Opening cert pages", "Scan history" with Clear history, "Sites with full access", About text | V2 | Re-render of `v2-settings-light.png` (A9 adds the "Toolbar button and shortcut" section) |

- **Optional NL set:** the same 5 captures with the Chrome UI language set to Dutch (`LANGUAGE=nl` on Linux), uploaded as localized screenshots for `nl`.
- **Dark theme:** optional, for screenshot 2 or 4 only.
- **Do not mix in** the 320 px / 200 % zoom accessibility captures.

### 5.3 Promo tiles
| Asset | Size | Status | Direction |
|---|---|---|---|
| Small promo tile | 440×280 PNG/JPEG | **Missing (required)** | Teal brand colours from spec §7/§11, the icon artwork enlarged, and a slab outline with a "#" label. Promo tiles cannot be localized, so use **no text, or only the brand name "CertScanner"**. No PSA/CGC logos or names, no check mark, no "verified" wording. Don't just reuse a screenshot. |
| Marquee promo tile | 1400×560 | Optional, not planned for 0.1.0 | Same direction, if a feature request is ever made. |
| Promo video | YouTube URL | Optional, not planned | Not needed. |

## 6. Additional fields

| Field | Proposed value | Status |
|---|---|---|
| Homepage URL | Public repository page or project site | **External: user decides.** The repository must be public for the GitHub links to work. |
| Support URL | Repository Issues page, or a support e-mail page | **External: user decides.** Use `<maintainer contact>` until then. |
| Official URL (verified publisher) | Only if the user verifies a site in Google Search Console | Optional |
| Mature content | No | Ready |
| Privacy policy URL | Public URL of `PRIVACY.md`, e.g. its GitHub file URL on the default branch, or a GitHub Pages copy | **External: hosting required before submission.** FE should then add the same URL to the panel's About → "Privacy policy" link. `privacy_link` exists but isn't rendered, because no URL was available (frontend handoff, S6 deviations). |

## 7. Privacy practices tab: draft answers

> **Draft. Verify every answer against the live dashboard definitions** before ticking anything. The answers must match `PRIVACY.md` and the extension's actual behaviour. Under the user-data FAQ (Q3 of the "Limited use" section), a mismatch can lead to the item being taken down.

**Single purpose:** section 4.
**Permission justifications:** one paragraph per field from `docs/release/permission-justifications.md`.
**Remote code:** **"No, I am not using remote code."**
- All JS, WebAssembly and OCR data are packaged.
- The vendor bundles still contain default jsDelivr URL strings. They are overridden at runtime and never requested (SEC-10; the e2e NetLog shows zero CDN requests).
- CSP-blocked Babel `Function(...)` fallbacks are not remote code (QA O6).

**Data usage: what the extension collects.** The definitions below come from press coverage and the user-data FAQ, not from the live form.

| Category | Proposed | Reason |
|---|---|---|
| Personally identifiable information | No | No names, e-mail addresses, accounts or IDs of people. A slab cert number identifies a graded item, not a person. |
| Health information | No | n/a |
| Financial and payment information | No | n/a |
| Authentication information | No | No logins, passwords or cookies are read; extension downloads omit credentials. |
| Personal communications | No | n/a |
| Location | No | n/a |
| Web history | **No, decide against the live definition** | No list of visited pages is kept. The current page's site and path exist only in session storage during the hand-off. History entries hold no page or image addresses and no host names. The last result keeps one image or page host name in session storage for at most 12 hours. If the live definition covers any transient handling of the current page URL or host, tick it: over-disclosing is safer than under-disclosing. |
| User activity | No | No click, keystroke, scroll or network monitoring. Recent scans are records the user chooses to keep, on the device only. |
| **Website content** | **Yes** | Images (pixels) and image addresses from pages the user chooses to scan are processed on the device. The user-data FAQ (Q2) lists "taking screenshots or capturing data from a web page" as handling user data, even when nothing is transmitted. |

**Certifications (all three apply):**
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

## 8. Distribution tab (proposal)

| Field | Proposal |
|---|---|
| Payment | Free |
| Visibility | First upload: **Unlisted** or private/trusted testers, for the user's own install check (M1–M11 on the Store build). Switch to **Public** only after that passes. |
| Regions | All regions (no region-specific content) |
| Publishing | Use **deferred publishing** so an approved item does not go live until the user publishes it. Staged submissions expire if not published in time (per the `publish` doc). |

## 9. Reviewer test instructions (draft)

```text
No account, login or payment is needed. The extension has no server.

1. Install, then open any public web page that shows a photo of a PSA or CGC graded slab (for example a marketplace listing found by searching "PSA 10" or "CGC 9.8"), or open this synthetic test image: <PUBLIC_URL_OF tests/fixtures/psa-8digit-leading-zero.png>.
2. Click the CertScanner toolbar icon (or press Alt+Shift+S). The side panel opens and scans the photos on the page. When one number is read clearly, the official cert page opens in a new tab; otherwise the panel lists the numbers or asks you to confirm.
3. Right-click a slab photo and choose "Scan slab cert number" to scan just that photo.
4. In the side panel you can also upload or paste an image, or type a number such as "PSA 01234567".
Synthetic test numbers may show "not found" on the grader's site; that is expected. The extension only opens the official page and does not judge authenticity.
Optional permission: "Sharper scans on <site>" (and, rarely, "Always allow on <site>") appears in the panel; clicking it requests that single https origin. Granted sites are listed in Settings under "Sites with full access" with a Remove button.
```

The `<PUBLIC_URL_OF …>` placeholder works only if the repository, or a copy of the fixture, is public. Otherwise delete that clause.

## 10. Trademark and policy self-check

| Check | Result |
|---|---|
| Name has no grader trademark | Pass: "CertScanner" |
| Grader names used only to describe what it works with | Pass: "for PSA and CGC slab photos", "official cert page" |
| Disclaimer in summary, description, UI footer and About | Pass: "Not affiliated with PSA or CGC." (EN/NL). The trademark line is in About and the description. |
| No authenticity claim | Pass. The description and UI say a lookup can't prove the slab is genuine (R8). |
| No grader logos, colours or screenshots of grader sites | Pass for the icon. **Screenshots and promo tile must keep this** (section 5). |
| No keyword stuffing | Pass |
| Single purpose | Pass. Page scan, right-click, upload, paste and typing are inputs to one purpose. |
