# CertScanner 0.1.0: permission justifications

_Role: release-manager · Date: 2026-10-10 · Status: **draft for the Chrome Web Store Privacy practices tab**. Nothing has been submitted._
_Source: `src/manifest.json` and `src/_locales/{en,nl}/messages.json` at `44ea7bf` (`src/` is identical to `03d9589`, the commit QA, performance and security round 2 tested); ADR-001 §3, §11, amendments A7 and A9; `docs/quality/security-review.md` (round 1 draft justifications; round 2 SEC-16). An improvement round (SEC-13…19) is in progress; re-check this file against the final commit._
_The Developer Dashboard lists the permissions found in the uploaded package. Check the list against the final ZIP's manifest and paste one paragraph per field. The field length limit was not verified, because developer.chrome.com was blocked from this environment; shorten the text if the dashboard rejects it._

## Manifest summary (release build)

```json
"permissions": ["contextMenus", "activeTab", "scripting", "storage", "sidePanel"],
"host_permissions": ["https://www.pricecharting.com/*"],
"optional_host_permissions": ["https://*/*"],
"commands": { "scan-page": { "suggested_key": { "default": "Alt+Shift+S" } } },
"incognito": "not_allowed",
"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }
```

**Deliberately not requested:**
- `host_permissions` beyond `www.pricecharting.com`, and `<all_urls>`
- `content_scripts`
- `tabs`, `webRequest`, `downloads`, `offscreen`, `clipboardRead`, `clipboardWrite`
- `web_accessible_resources` and `externally_connectable`

`npm run check` fails the build if any of these appear, or if the permission list differs from the one above.

## Single purpose (for reference)

CertScanner reads the certification number from photos of PSA or CGC graded slabs. The photos can be on the current page, a photo the user right-clicks, or an image the user uploads or pastes. It then opens that grader's official cert lookup page for the number.

---

## Required permissions

### `activeTab`
CertScanner gets temporary access to the current tab only after the user acts:
- clicks the toolbar icon;
- presses the "Scan this page" keyboard shortcut;
- chooses "Scan slab cert number" from the right-click menu on an image.

The access is used to find the slab photos on that page and read their pixels. CertScanner can load the image, or crop it from a capture of the visible tab when the image host refuses the download. The access ends when the user navigates to another site or closes the tab. Nothing is read from any tab the user has not acted on. This replaces broad host permissions: the extension declares no `host_permissions`.

### `scripting`
`scripting` is used only together with the `activeTab` grant, or with a site the user explicitly allowed. It runs one small, self-contained function once in the page's isolated world. The function either:
- lists the images on the page, with their address, size and on-screen position (page scan); or
- finds the one image the user right-clicked and, if needed, loads it in the page context.

It returns that data and exits. No listeners or code stay on the page. It does not read page text (apart from the page title and each image's alt text, used on-device as a grader hint), form fields or cookies. There are no declared content scripts.

When the user presses the panel's "Scan this page" button, a trivial function (`return true`) is first injected only to test whether CertScanner may read that tab; it reads nothing.

Prices (setting "Pass site checks in a background tab", on by default; ADR A21): when PriceCharting's Cloudflare check or eBay's bot check blocks the panel's own request, the same public page is opened once in an inactive tab of the user's window (`tabs.create`, `active: false`). A self-contained function reports the page state and, once the browser has passed the check, the page's HTML (`XMLSerializer`, read only); the tab is then closed (at most 30 s). This only runs on `www.pricecharting.com` and the eBay site the user allowed, both covered by host access. The HTML is parsed inert in the panel; only prices, dates and titles are kept in memory.

### `contextMenus`
Adds one item, "Scan slab cert number", to the right-click menu, only for images. Choosing it scans that specific photo and opens its official cert page. This is one of the two main ways to use the extension.

### `sidePanel`
The side panel is the extension's only interface. It shows:
- the photo being read and the scan progress;
- the cert number found and how it was read (barcode, QR code or text);
- the exact official page that opens, plus a confirmation step when the number is unclear;
- manual entry and upload/paste fallbacks, recent scans and settings.

The text-recognition engine runs inside this panel, so the panel must stay open while a scan runs.

### `storage`
Holds three kinds of data:
- **`host_permissions: https://www.pricecharting.com/*`:** the panel reads the scanned card's public PriceCharting search and product page (current price, price per grade, last sales) right after a scan. The user's PriceCharting cookies go along, as on a normal visit, because PriceCharting is behind Cloudflare's bot check; when the check still has to run, the page is read once in an inactive tab (see `scripting`), or, with that setting off, the panel asks the user to open PriceCharting and try again. Nothing is stored.
- **Optional host access `https://www.pokemonpricetracker.com/*`:** requested only when the user saves their own PokemonPriceTracker API key; used for Pokémon slabs to get eBay sales prices per grade from its official API (card name and number only). Removed again with the key.
- **Optional `https://www.ebay.com/*` (or the user's eBay site)** (within the declared optional `https://*/*`): requested only when the user clicks "Show eBay sales here". The panel then reads two public eBay searches for the card in its grade (sold listings newest first, Buy It Now cheapest first) to show the last sale, median, cheapest offer and latest sales. No cert number is sent. eBay has no open sold-listings API since the Finding API was retired (February 2025); the user chose this for personal use, knowing eBay's user agreement restricts automated reading. Nothing is stored.
- **Optional `https://api.psacard.com/*`** (within the declared optional `https://*/*`): requested only when the user saves their own PSA API key, to look up a PSA cert's name, grade and population.
- **`chrome.storage.sync`:** four on/off settings ("Toolbar button scans the page", "Always ask before opening", "Open in a background tab" and "Keep scan history") and the eBay site used by the price links. The price links (eBay search, 130point sales page) open in a new tab only on a click and need no extra permission.
- **`chrome.storage.local`:** an optional list of recent scans on this device. Each entry holds grader, cert number, how it was read and time; the list keeps at most 25. Users can switch it off or clear it ("Clear history").
- **`chrome.storage.session`:** short-lived data, cleared when Chrome closes: the toolbar/shortcut/menu → panel hand-off (page address without query or fragment, image address, tab and window ids); the last result per window (cert numbers, grader, method and one image or page host name, at most 12 hours); and the sites where the user dismissed "Sharper scans on ‹site›".

No images, page addresses or image addresses are stored persistently.

## Manifest key (not a permission)

### `commands` (`scan-page`, suggested Alt+Shift+S)
Defines a keyboard shortcut that starts a page scan, the same action as clicking the toolbar icon. Like the icon, the shortcut grants `activeTab` for the current tab only. Users can change or remove it at `chrome://extensions/shortcuts`. It needs no permission and grants no access by itself.

## Optional host permission

### `https://*/*` (optional, requested for one site at a time)
Nothing is granted at install. CertScanner asks for one exact origin (`https://<site>/*`) through Chrome's permission prompt. It asks only after the user clicks one of two visible buttons:
- **"Sharper scans on ‹site›"**, shown only when a photo could only be read at screen resolution. Access to that image host lets CertScanner load the full-size image for a more reliable reading.
- **"Always allow on ‹site›"**, which can appear when the user presses the panel's "Scan this page" button on a page the extension cannot read yet and the panel still knows that page's site from an earlier scan in the same tab. QA found this offer rarely reachable (test report O12). Access to that site lets the button work there without clicking the toolbar icon first.

Neither grant makes CertScanner scan anything automatically. A scan always starts from the user's click or shortcut. Extension downloads are made without cookies or referrer.

Granted sites are listed in the extension's Settings under "Sites with full access", each with a Remove button. An "All sites" row appears if a broader grant exists. Users can also remove access in Chrome's Site access settings.

The pattern is `https://*/*` rather than a fixed list because slab photos come from many marketplaces, forums and image CDNs that cannot be known in advance. Only `https` origins are offered.

## Other declarations reviewers may ask about

| Item | Justification |
|---|---|
| `"incognito": "not_allowed"` | The extension does not run in incognito windows, so a private-window scan can never reach the on-device scan history (security finding SEC-01). |
| CSP `'wasm-unsafe-eval'` | Required to compile the **packaged** WebAssembly text reader (Tesseract OCR) and barcode reader (zxing-cpp). No `unsafe-eval`, no remote script sources, no inline script. |
| `minimum_chrome_version: "116"` | `chrome.sidePanel.open()` from a user gesture and `AbortSignal.any` need Chrome 116. |
| Opening `psacard.com` / `cgccomics.com` / `cgccards.com` | The extension opens these pages in a normal tab (`chrome.tabs.create`), not by sending requests. No host permission is needed or requested for them. |

## Remote code

**No, I am not using remote code.**
- All JavaScript, WebAssembly and the OCR language model are packaged in the ZIP. The `workerPath`, `corePath` and `langPath` options of the OCR library and the barcode reader's `locateFile` are set to packaged files.
- The unmodified vendor bundles still contain their libraries' default jsDelivr URL strings (4 occurrences). These are never used: the code overrides them, and the e2e network log showed no CDN request (SEC-10).
- Babel helper fallbacks such as `Function("return this")` inside `try/catch` are blocked by the extension CSP and never fetch code (QA O6).
