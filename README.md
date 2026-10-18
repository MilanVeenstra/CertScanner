# CertScanner

**A Chrome extension that reads the cert number from photos of PSA, CGC and BGS slabs and opens the grader's official cert page, with the card's value and eBay sales in the side panel.**

> Not affiliated with PSA, CGC or Beckett. A cert lookup does not prove a slab is genuine: always check that the cert page matches the slab in the photo.

## What it does

- **Scan a page:** click the CertScanner icon or press **Alt+Shift+S**. The large photos on the page are read and the cert numbers appear in the side panel. If exactly one number is read clearly, its cert page opens right away.
- **Scan one photo:** right-click a slab photo → **Scan slab cert number**.
- **Other ways:** drop, paste or upload an image in the panel, or type a number such as `PSA 01234567`.
- **Grader detected automatically:** from the label, the shape of the number and the listing title. If a number or grader is unclear, the panel asks you to choose. Your choice opens the cert page.
- **Value and sales:** the panel shows the card's price for its grade, the price per grade and recent sales (PriceCharting), plus the latest eBay sales for that card and grade. Optional free API keys (Settings) add PSA card data and PokemonPriceTracker prices for Pokémon cards.

| Grader | Page that opens |
|---|---|
| PSA | `https://www.psacard.com/cert/<number>` |
| CGC Comics | `https://www.cgccomics.com/certlookup/<number>/` |
| CGC Cards | `https://www.cgccards.com/certlookup/<number>/` |
| BGS (Beckett) | Beckett's lookup form; the number is copied for you to paste |

## How it works

- Everything runs in Chrome's side panel. The text reader (Tesseract OCR) and the barcode/QR reader are packaged with the extension and run on your device. Images are never uploaded.
- CertScanner only reads a page when you click the icon, press the shortcut or right-click a photo. A page you haven't used it on yet can be allowed once with **Always allow on ‹site›** or **Always allow on all sites**; remove that access in Settings.
- The panel always shows the number it read, how it read it and the page that will open. **Wrong number? Edit** corrects it.
- What leaves your device: the cert number when its cert page opens, and the card name and grade for the price lookups (PriceCharting; eBay once you allow it; PSA and PokemonPriceTracker only with your own key). There is no server, no account and no tracking. Recent scans stay on this device and can be turned off. Details: [`PRIVACY.md`](PRIVACY.md).

The panel is in English or Dutch, following your Chrome language.

## Installation

**Ready-made (no tools needed):**

1. On GitHub choose **Code → Download ZIP** and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension`** folder (the one with `manifest.json`).
4. Pin CertScanner to the toolbar (puzzle icon → pin).

After an update, download again and click the reload button on CertScanner in `chrome://extensions`.

**From source:** with Node.js 20+, run `npm ci` and `npm run build:extension`, then load the `extension/` folder as above. `npm test` runs the unit tests and `npm run e2e` the browser tests.

Requires Chrome 116 or newer (desktop). The shortcut can be changed at `chrome://extensions/shortcuts`.

## More

- Design and technical documents: [`docs/`](docs/)
- Bundled libraries: tesseract.js (Apache-2.0) and zxing-wasm (MIT); licence texts in [`third_party/licenses/`](third_party/licenses/)
- License: MIT (declared in `package.json`)
