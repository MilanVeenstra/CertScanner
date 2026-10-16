# CertScanner

**Automatic cert scanner for PSA, CGC and BGS slabs: a Chrome extension (Manifest V3).**

CertScanner reads the certification number from photos of PSA, CGC and BGS (Beckett) graded slabs and opens that grader's official cert lookup page. You don't have to retype a 7- to 13-digit number from a small listing photo.

> **Not affiliated with PSA, CGC or Beckett.** PSA, CGC and Beckett are trademarks of their respective owners.
> **A cert lookup does not prove a slab is genuine.** It shows what the grader's database says about a number. Always check that the cert page matches the slab in the photo.

_Version 0.1.0. It is not published on the Chrome Web Store; for now you install it from source. See [`docs/release/release-report.md`](docs/release/release-report.md) for release status._

---

## What it does

- **Scan the page you're viewing.** Click the CertScanner toolbar icon or press **Alt+Shift+S**. CertScanner finds the large photos on the page (up to 8, visible ones first), reads their cert numbers on your device and shows them in Chrome's side panel.
  - If exactly one number is read clearly, its official cert page opens right away.
  - Otherwise you get a list ("Cert numbers on this page") with **Open** and **Copy** for each number.
- **Scan one specific photo.** Right-click a slab photo and choose **Scan slab cert number**.
- **Grader detected automatically.** PSA, CGC Comics, CGC Cards or BGS follows from the label (brand, grade wording, card or comic wording), the shape of the number and, on listing pages, the photo's alt text and page title. When it is still unclear, the most likely grader is preselected and you only check it.
- **Card name from the label.** Besides the cert number, CertScanner reads the card name, card number and grade from the label (a second, enlarged pass over the label, also when the number came from a QR code or barcode) and uses them for the prices.
- **Prices in the panel.** Right after a scan the panel shows the card's **current price** and **last sold** price for its grade (e.g. *PSA 10*), the price for every grade, and the recent sales in that grade, read on your device from the card's PriceCharting page. Below it, **eBay sales** for that card in its grade: the last sale, the median of recent sales, the cheapest Buy It Now offer and the latest sales, read from eBay's public sold search on your device (allow your eBay site once with **Show eBay sales here**; eBay's user agreement restricts automated reading, so this is for your own use and can be switched off). When PriceCharting or eBay first checks the browser, the page is read once in an inactive tab that closes again. For Pokémon slabs you can add your own free PokemonPriceTracker API key (Settings): the value then comes from recent eBay sales in that grade through its official API. With your own free PSA API key (Settings) a PSA cert also gives the card name, grade and population directly.
- **Prices for this card.** Under a result you see exactly what is searched, e.g. `PSA 10 · POKEMON CHARIZARD ex 199` (brand, name and card number from the label; year, set codes and rarity words left out because listing titles often omit them). **Sold on eBay** / **For sale on eBay** search that card in that grade without lots; **Change** lets you correct the card or grade. **Price per grade (PriceCharting)**, **Population report** and **This slab on eBay** (cert number) are below. Nothing is fetched until you click.
- **Fallbacks.** In the side panel you can:
  - drop, paste (Ctrl+V / ⌘V) or upload an image (JPEG, PNG, WebP or AVIF, up to 15 MB);
  - type a number such as `PSA 01234567` or `CGC 4012345001`.
- **You stay in control:**
  - The panel always shows the number that was read, how it was read (barcode, QR code or text), and the exact page that opens. **Wrong number? Edit** lets you correct it.
  - When a number is unclear, or several are found, CertScanner asks before opening anything.

| Grader | Official page that opens |
|---|---|
| PSA | `https://www.psacard.com/cert/<number>` |
| CGC Comics | `https://www.cgccomics.com/certlookup/<number>/` |
| CGC Cards | `https://www.cgccards.com/certlookup/<number>/` |
| BGS (Beckett) | `https://www.beckett.com/grading/card-lookup`: Beckett has no link per number, so the number is copied and you paste it into the form. Never opened automatically. |

## Privacy in one paragraph

CertScanner reads a page only when you click its icon, press the shortcut or right-click a photo. It never scans by itself.
- **What it reads:** image addresses, sizes and positions, plus the page title and photo alt text (only to tell PSA, CGC and BGS apart, on your device). No other page text. Images are processed on your device and never uploaded.
- **What it stores:** settings sync through Chrome; recent scans (grader, number, method and time) stay on this device, and you can turn history off or clear it; the last result is kept in Chrome's session storage for up to 12 hours.
- **What leaves your device:** the cert number, when the grader's official page opens in a tab (and to PSA's API if you saved your own PSA key); the card name and grade, which the panel sends to PriceCharting to show the value and, once you allow it, to eBay for its sold and Buy It Now searches; and the card, grade or cert number of a price link you click (eBay, PriceCharting or a population report). The only other request is reloading a photo from the site that already shows it, sent without cookies when CertScanner makes it. There is no server, no account, no analytics and no ads.
- **Incognito:** the extension does not run in incognito windows.

Full policy: [`PRIVACY.md`](PRIVACY.md).

---

## Snel aan de slag (Nederlands)

**Zonder npm (aanbevolen):**
1. Download deze repo op GitHub: **Code → Download ZIP**, en pak de ZIP uit.
2. Ga in Chrome naar `chrome://extensions` en zet rechtsboven **Ontwikkelaarsmodus** aan.
3. Klik op **Uitgepakte extensie laden** en kies de map **`extension`** (in de uitgepakte map `CertScanner-main`). In die map staat `manifest.json`.
4. Zet CertScanner vast in de werkbalk (puzzelstukje → punaise).

**Zelf bouwen (alleen als je de code aanpast):** installeer [Node.js](https://nodejs.org/) 20+, voer `npm ci` en `npm run build:extension` uit en laad opnieuw de map `extension/`.

**Gebruiken:**
- Klik op het CertScanner-icoon of druk op **Alt+Shift+S** (Mac: Option+Shift+S). De slabfoto's op de pagina worden gescand.
- Of klik met de rechtermuisknop op een slabfoto en kies **Certnummer van slab scannen**.
- Je kunt in het zijpaneel ook een afbeelding slepen, plakken of uploaden, of het nummer typen.
- CertScanner herkent zelf of het om PSA, CGC (comics of kaarten) of BGS gaat: aan het label, de vorm van het nummer en op verkooppagina's aan de titel van de foto. Is het nog onduidelijk, dan staat de meest waarschijnlijke grader al geselecteerd.
- **Kaartnaam van het label:** naast het certnummer leest CertScanner ook de kaartnaam, het kaartnummer en de grade van het label (met een extra, vergrote leesronde, ook als het nummer uit een QR-code of barcode kwam) en zoekt daarmee de prijzen op.
- **Prijzen in het paneel:** direct na een scan zie je de **huidige prijs** en **laatst verkocht** voor de grade van de slab, de prijs per grade en de recente verkopen in die grade, net als op PriceCharting. Daaronder staan de **eBay-verkopen** van die kaart in die grade: laatste verkoop, mediaan, goedkoopste 'Nu kopen'-aanbod en de laatste verkopen, op je apparaat gelezen uit de openbare 'verkocht'-zoekresultaten van eBay (één keer toestaan met **eBay-verkopen hier tonen**; eBay's gebruikersvoorwaarden beperken automatisch uitlezen, dus dit is voor eigen gebruik en kan uit). Wil PriceCharting of eBay eerst de browser controleren, dan wordt de pagina één keer in een inactief tabblad gelezen dat daarna weer sluit. Voor Pokémon-slabs kun je je eigen gratis PokemonPriceTracker API-sleutel toevoegen (Instellingen): de waarde komt dan uit recente eBay-verkopen in die grade, via hun officiële API. Met je eigen gratis PSA API-sleutel (Instellingen) haalt CertScanner bij een PSA-cert ook direct de kaartnaam, grade en populatie op.
- Onder een resultaat staat **Prijzen van deze kaart**, bijv. `PSA 10 · POKEMON CHARIZARD ex 199`. **Verkocht op eBay** en **Te koop op eBay** zoeken precies die kaart in die grade (zonder lots); met **Wijzig** pas je kaart of grade aan. Daaronder: **Prijs per grade (PriceCharting)**, **Populatierapport** en **Deze slab op eBay**. De eBay-site kies je in Instellingen (standaard ebay.com).
- Je wijzigt de sneltoets via `chrome://extensions/shortcuts`.

CertScanner is niet gelieerd aan PSA, CGC of Beckett. BGS-slabs worden ook herkend: omdat Beckett geen directe link per nummer heeft, kopieert CertScanner het nummer en opent de zoekpagina van Beckett, waar je het plakt. Een certcontrole bewijst niet dat een slab echt is; controleer altijd of de certpagina bij de slab op de foto past. De taal van de extensie volgt je Chrome-instellingen (Nederlands of Engels).

---

## Install without npm

The repo contains a ready-to-load build in **`extension/`**:

1. On GitHub choose **Code → Download ZIP** and unzip it (or `git clone`).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension`** folder (the one that contains `manifest.json`).
4. Pin CertScanner to the toolbar (puzzle icon → pin).

> Selecting the repository root or `src/` gives "Manifest file is missing" or a panel without the OCR engine; always pick `extension/` (or `dist/` after building).

## Install from source

**Requirements:**
- Node.js **20 or newer** (with npm);
- Google Chrome **116 or newer** (desktop).

`npm ci` downloads the pinned dependencies from the npm registry. The extension itself downloads nothing at runtime.

```sh
npm ci          # install the exact versions from package-lock.json
npm run build   # writes the extension to dist/
npm run build:extension   # build + refresh the committed extension/ folder
```

Then:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`dist/`** folder.
4. Pin CertScanner to the toolbar (puzzle icon → pin).

After pulling new code, run `npm run build` again and click the reload button on CertScanner's card in `chrome://extensions`.

> Load **`dist/`**, never `dist-e2e/`. `dist-e2e/` is a test build with access to all sites, for automated tests only.

## How to use

| To… | Do this |
|---|---|
| Scan the page you're viewing | Click the CertScanner icon, or press **Alt+Shift+S** (macOS: Option+Shift+S) |
| Change or remove the shortcut | `chrome://extensions/shortcuts` → CertScanner → "Scan this page for slab cert numbers" |
| Scan one photo | Right-click it → **Scan slab cert number** |
| Scan a saved image | Open the side panel and drop, paste or upload it |
| Look up a number you know | Type it in the panel (e.g. `PSA 01234567`), choose the grader if asked, then **Open cert page** |
| Reopen or copy an earlier number | **Recent scans** in the panel |
| See what this card sells for in its grade | Under a result: the price for its grade, every grade and the last sales are shown in the panel (allow once); **Change** corrects the card or grade; **Sold on eBay** opens the eBay search |

**Settings** (gear icon in the panel):

| Section | Setting | Default | Effect |
|---|---|---|---|
| Toolbar button and shortcut | **Toolbar button scans the page** | on | When off, clicking the icon only opens the panel (tooltip "Open CertScanner"). The shortcut still scans. **Change shortcut** opens `chrome://extensions/shortcuts`. |
| Opening cert pages | **Always ask before opening** | off | When on, nothing opens until you click **Open** |
| Opening cert pages | **Open in a background tab** | off | Keeps you on the page you're viewing |
| Prices & listings | **eBay site** | ebay.com | Which eBay the price links and the eBay sales search (ebay.com, .co.uk, .de, .nl, .fr, .ca, .com.au) |
| Prices & listings | **Show eBay sales in the panel** | on | Last sale, median, cheapest offer and latest sales from eBay's sold search (asks once for your eBay site) |
| Prices & listings | **Pass site checks in a background tab** | on | When PriceCharting or eBay checks the browser first, the page is read in an inactive tab that closes again; off: the panel asks you to open the site |
| Scan history | **Keep scan history** | on | Keeps the last 25 numbers on this device only; turning it off deletes them. **Clear history** empties the list. |

Under **Sites with full access**, Settings lists the sites you allowed through **Sharper scans on ‹site›** or **Always allow on ‹site›**, each with a **Remove** button. An **All sites** row appears after **Always allow on all sites**, or if broader access was granted in Chrome.

## Troubleshooting

| You see | What to do |
|---|---|
| "Chrome doesn't allow reading this page" | Chrome blocks extensions on `chrome://` pages, the Chrome Web Store, other extensions' pages and local files. Save or copy the image, then drop, paste or upload it in the panel. |
| "CertScanner can't read this page yet" | The panel's **Scan this page** button works only on a page CertScanner may read: after you used the icon, shortcut or right-click menu there (until you go to another site), or on a site you allowed. Click the icon or press the shortcut, or allow it once: the panel offers **Always allow on ‹site›** when it knows the site, else **Always allow on all sites**. You can remove that access later in Settings → **Sites with full access**. |
| "No cert numbers found on this page" | Thumbnails are too small to read, so open the listing's large photo first. Scroll lazy-loaded photos into view. Photos inside embedded frames aren't found by a page scan; right-click the photo instead. |
| "Scanned at screen resolution" / "Sharper scans on ‹site›" | The image host refused a direct download, so the visible screen was used. Click **Sharper scans on ‹site›** and allow that one site in Chrome's prompt, then **Scan again**. You can remove the access any time in Settings → **Sites with full access**. |
| Wrong number, or the wrong grader | Click **Wrong number? Edit** on the result, or pick the right number and grader in the list. Always compare the number with the slab label. |
| "Choose PSA, CGC Comics or CGC Cards" for a 10-digit number | A 10-digit number can belong to CGC Comics, CGC Cards or PSA. Choose the grader shown on the label. |
| "Text reader didn't start" | Click **Reload panel**. Barcode reading and typing a number still work in the meantime. |
| The shortcut does nothing | Another extension or your OS may be using Alt+Shift+S. Set a different key at `chrome://extensions/shortcuts`. |
| Nothing happens in an incognito window | This is by design: CertScanner does not run in incognito. |

## Development

| Command | What it does |
|---|---|
| `npm run build` | Copies `src/` and the vendor files to `dist/`. Writes `dist/build-info.json` with the version, git commit and vendor hashes. No bundler. |
| `npm test` | Unit tests (`node --test tests/unit`). Pure logic, no browser. |
| `npm run check` | Builds, then checks the release `dist/`: exact permissions, host access only to `www.pricecharting.com`, no `<all_urls>`, `incognito: not_allowed`, CSP, the `scan-page` command, vendor hashes and licences, no remote/inline code, locale parity, descriptions ≤ 132 characters. |
| `npm run e2e` | Builds `dist-e2e/` (test-only host access), then runs the Playwright end-to-end, privacy, security and OCR-benchmark suites in Chromium. Takes several minutes; `CERTSCANNER_SKIP_BENCH=1` skips the benchmark. |
| `npm run fixtures` | Regenerates and verifies the synthetic test images and pages in `tests/fixtures/`. They contain no real labels or logos. |
| `npm run package` | Builds, runs the full check and writes **`certscanner-<version>.zip`** from `dist/` only. Prints the sha256. Refuses a dirty working tree. Set `SOURCE_DATE_EPOCH` for a reproducible `build-info.json`. |

**End-to-end tests** need a Chromium that Playwright 1.56.1 can launch:
- run `npx playwright install chromium` once; or
- point `CERTSCANNER_CHROMIUM` at a Chromium/Chrome for Testing binary.

The e2e suites block all outside network access. The QA report lists the other variables (`CERTSCANNER_E2E_OUT`, `CERTSCANNER_E2E_DIST`).

**Conventions** (see the [architecture ADR](docs/architecture/architecture.md)):
- vanilla ES modules, no bundler;
- every UI string lives in `src/_locales/{en,nl}/messages.json`;
- text is rendered with `textContent` only;
- no runtime messaging listeners;
- every OCR/barcode asset is packaged.

## Project structure

```text
src/
  manifest.json            MV3 manifest (permissions: contextMenus, activeTab, scripting, storage, sidePanel)
  _locales/{en,nl}/        all UI text (English default, Dutch)
  background/sw.js         service worker: right-click menu, toolbar icon, shortcut → side panel hand-off
  sidepanel/               side panel UI, scan lifecycle, settings, permissions UI
  pipeline/                image acquisition, page probes, preprocessing, barcode, OCR, scanner, page scan
  core/                    pure logic: cert rules, parser, URL builders and QR allow-list, routing, manual entry
  shared/                  job contract, settings, history, i18n, last result, abort helper
  icons/                   16/32/48/128 PNG icons + SVG masters
scripts/
  build.mjs                build, --check, --package, --e2e
  gen-fixtures.mjs         synthetic fixtures and benchmark set
tests/
  unit/                    node --test unit tests
  e2e/                     Playwright suites (journeys, privacy, security, benchmark, fixtures)
  fixtures/                synthetic slab images, test pages, benchmark images
third_party/licenses/      licence texts for libraries compiled into the bundled WebAssembly
docs/                      research, architecture, design, quality and release documents
dist/                      build output (git-ignored); load this folder in Chrome
dist-e2e/                  test build (git-ignored); never load for real use or ship
```

## Documentation

| Document | Contents |
|---|---|
| [`docs/extension-contract.md`](docs/extension-contract.md) | Single purpose, surfaces, data, permission budget, behaviour rules |
| [`docs/research/research.md`](docs/research/research.md) | Product research: cert URLs and formats, OCR/barcode options, Store policy, competitors |
| [`docs/architecture/architecture.md`](docs/architecture/architecture.md) | ADR-001 architecture with amendments A1–A9 (page scan is A9) |
| [`docs/design/design-spec.md`](docs/design/design-spec.md) | UX design: journeys, states, copy (EN/NL), tokens, accessibility, icon |
| [`docs/implementation/frontend-handoff.md`](docs/implementation/frontend-handoff.md) | Implementation notes and results for slices S1–S6 |
| [`docs/quality/security-review.md`](docs/quality/security-review.md) | Security and privacy review, rounds 1 (`2cd4f86`) and 2 (`03d9589`) |
| [`docs/quality/test-report.md`](docs/quality/test-report.md) | QA: e2e results (52/52 at `03d9589`), OCR benchmark, manual checks M1–M11 and PS1–PS12 |
| [`docs/quality/performance-report.md`](docs/quality/performance-report.md) | Performance: latency, service worker, memory, package size |
| [`docs/quality/screenshots/`](docs/quality/screenshots/) | Real extension captures of the side-panel states (pre-page-scan build) |
| [`docs/release/release-report.md`](docs/release/release-report.md) | Release readiness, gates and artifact identity |
| [`docs/release/store-listing.md`](docs/release/store-listing.md) | Chrome Web Store listing draft (EN/NL), assets plan, privacy-tab answers |
| [`docs/release/permission-justifications.md`](docs/release/permission-justifications.md) | Why each permission is needed |
| [`docs/release/manual-test-checklist.md`](docs/release/manual-test-checklist.md) | Manual checks in real Chrome before release |
| [`PRIVACY.md`](PRIVACY.md) | Privacy policy |

## Third-party software

CertScanner bundles these components, unmodified, under `dist/vendor/`. `npm run check` fails if any licence file is missing.

| Component | Version | Licence | Used for |
|---|---|---|---|
| [tesseract.js](https://github.com/naptha/tesseract.js) | 7.0.0 | Apache-2.0 | OCR (text reader) API and worker |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core) | 7.0.0 | Apache-2.0 | Tesseract OCR compiled to WebAssembly. Its build statically links Leptonica (BSD-2-Clause), IJG libjpeg 9a, libpng 1.6.38, LibTIFF, zlib 1.2.12, giflib, libwebp and openlibm |
| [@tesseract.js-data/eng](https://www.npmjs.com/package/@tesseract.js-data/eng) | 1.0.0 | MIT (package); model data from tesseract-ocr/tessdata (Apache-2.0) | English OCR model |
| [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) | 3.1.5 | MIT; built from zxing-cpp (Apache-2.0) | Barcode and QR-code reader |

- **Licence texts:**
  - each package's own licence is copied next to it in `dist/vendor/`;
  - the texts for the libraries linked into the WebAssembly are in [`third_party/licenses/`](third_party/licenses/), copied to `dist/vendor/licenses/`;
  - the summary is in `dist/vendor/THIRD_PARTY_NOTICES.txt`.
- **Open release gate (SEC-05):** the texts in `third_party/licenses/` were taken from Debian packaging files. On 2026-10-10 they were compared with the upstream files at the commits that tesseract.js-core 7.0.0 and zxing-wasm 3.1.5 build from. The libpng text is the wrong licence version, and notices for giflib, libwebp, openlibm and zxing-cpp's bundled libzueci are missing. Details: [`docs/release/release-report.md`](docs/release/release-report.md) §5.
- **Development only:** Playwright and bwip-js are used for tests and are not shipped.

## License

CertScanner is released under the **MIT License**, as declared in `package.json`.

> The repository does not contain a `LICENSE` file yet. Add one, with the copyright holder's name and year, before publishing the source or the extension.
