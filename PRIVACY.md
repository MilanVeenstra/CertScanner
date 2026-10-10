# CertScanner privacy policy

**Effective date:** 10 October 2026 · **Applies to:** CertScanner for Chrome, version 0.1.0 and later until this policy is updated.
**Contact:** `<maintainer contact>`

CertScanner is a browser extension. It reads the certification number from a photo of a PSA or CGC graded slab and opens that grader's official cert page. This policy covers what the extension handles, where that data goes, and how you can remove it.

> **Short version.** CertScanner reads images on your own device and never uploads them. It has no server, no account, no analytics and no ads. A cert number leaves your device only when the grader's official page opens in a tab. Your settings sync through Chrome. Your recent scans stay on this device, and you can delete them at any time.

---

## 1. What CertScanner handles and why

CertScanner only reads a page when you ask it to. You do that by clicking the CertScanner toolbar icon, pressing the keyboard shortcut (default **Alt+Shift+S**), using the panel's **Scan this page** button, or right-clicking a photo and choosing **Scan slab cert number**. It never scans pages in the background or when you open a new page.

| Data | When | How it is used | Kept |
|---|---|---|---|
| **Pixels of the images you scan.** These are photos on the current page, a photo you right-click, or an image you upload, paste or drop into the panel. | During a scan | Read on your device to find a barcode, QR code or printed cert number. | In memory only, until the panel closes or the next scan starts. Never saved and never uploaded. |
| **A list of the photos on the page**, for page scans. The list holds each image's web address, size and position on screen. | When you start a page scan | Used to pick the photos large enough to be a slab label: up to 8, visible ones first. Only the page itself is checked, not frames embedded in it. **No page text, form data, cookies or other page content is read.** | In memory, for the scan only. |
| **A screenshot of the visible part of the tab.** | Only when an image can't be loaded directly | Cropped to the photo(s) being scanned. The rest is thrown away right away. | In memory only. Never saved and never uploaded. |
| **Scan hand-off details.** These are the address of the page you scan (site and path only; the query string and anything after `#` are removed), the right-clicked image's address if there is one, and Chrome's internal tab and window numbers. | During a scan | Passed from the toolbar, shortcut or right-click menu to the panel. Used to load the image, to check that Chrome allows reading the page, and to make sure the tab hasn't changed during the scan. | Chrome session storage. Deleted as soon as the panel picks up the scan. If the panel never does, it is ignored after 2 minutes and deleted when the window or Chrome closes. |
| **Cert numbers that were read**, the grader, how each number was read, and the image's host name. | After a scan | Shown in the panel. The last result is restored if you close and reopen the panel. | Chrome session storage. Up to 12 hours, and cleared when Chrome closes. No images. |
| **Recent scans:** grader, cert number, how it was read (barcode, QR code, text, typed or corrected) and time. | When a cert page is opened or a number is copied, if **Keep scan history** is on (the default) | Shown under **Recent scans** so you can reopen or copy a number. | On this device only (`chrome.storage.local`), last 25 entries. **No images, page addresses or image addresses are stored.** |
| **Settings:** four on/off choices. These are *Always ask before opening*, *Open in a background tab*, *Keep scan history* and *Scan the page when I click the icon*. | When you change them | Applied to how the extension behaves. | `chrome.storage.sync`. If Chrome sync is on, Chrome copies them to your other signed-in devices. |
| **Sites you said "Not now" or no to** for Sharper scans. | When you dismiss the offer | Stops the same offer from appearing again in this session. | Chrome session storage; cleared when Chrome closes. |
| **Clipboard.** | Only when you paste into the panel, or click **Copy** | Reads the image or text you paste. Writes the cert number when you click Copy. | Not stored by CertScanner. |

## 2. What leaves your device

CertScanner itself operates **no server** and receives **no data** from you. Two kinds of network request can happen.

1. **Opening the official cert page.** CertScanner opens a new tab at the grader's official address, which contains the cert number:
   - `https://www.psacard.com/cert/<number>`
   - `https://www.cgccomics.com/certlookup/<number>/`
   - `https://www.cgccards.com/certlookup/<number>/`

   This happens by itself only when exactly one number was read clearly and you haven't turned on *Always ask before opening*. Otherwise it happens when you click **Open**. Your browser then visits that site like any other page you open. The visit is covered by that grader's own privacy policy. CertScanner is not affiliated with PSA or CGC.
2. **Loading the image you scan.** To read a photo at full resolution, CertScanner may download it again from the website that already shows it to you. When CertScanner downloads the image itself, it sends no cookies and no referrer. In some cases it asks the page to load the image instead, just as the page loads its own images (often straight from the browser cache).

A web address found inside a QR code is never opened. Only the number in it is used, and the official address is always built by CertScanner itself.

## 3. What CertScanner does not do

- No analytics, telemetry, crash reporting, advertising or tracking.
- No selling, renting or sharing of data with anyone.
- No accounts, sign-in or cookies of its own.
- No remote code. All program code, the text reader (OCR) and its language data are packaged inside the extension.
- No reading of page text, forms, passwords or browsing history.
- **Incognito:** CertScanner is set to not run in incognito windows (`"incognito": "not_allowed"`), so nothing from a private window can reach your scan history.

## 4. Permissions and why they are needed

| Permission | Why |
|---|---|
| `activeTab` | Gives temporary access to the tab you're on, and only after you click the icon, press the shortcut or use the right-click menu. CertScanner needs it to find and read the slab photos there. |
| `scripting` | Runs a small one-time function in that tab. The function lists the page's photos, or finds the photo you clicked, then stops. It leaves nothing running on the page. |
| `contextMenus` | Adds **Scan slab cert number** to the right-click menu on images. |
| `sidePanel` | Shows progress, results, confirmation and manual entry in Chrome's side panel. |
| `storage` | Saves your settings and recent scans, and passes a scan from the toolbar or menu to the panel. |
| Keyboard shortcut (`commands`) | Lets you start a page scan with Alt+Shift+S. This is a setting, not a permission. You can change or remove it at `chrome://extensions/shortcuts`. |
| **Optional:** access to a single website (`https://<site>/*`) | Asked only when you click **Sharper scans on ‹site›** or **Always allow on ‹site›**. Chrome then shows its own prompt naming that one site. With it, CertScanner can load full-size images from that site, or scan that site from the panel button without clicking the icon first. It never scans by itself. |

**Removing optional site access.** You can remove a site you allowed in two places:
- In CertScanner, open **Settings**, go to **Sharper scans** and click **Remove**.
- In Chrome, go to `chrome://extensions`, open CertScanner's **Details** and change **Site access**.

## 5. Your choices and how to delete data

- **Turn off scan history:** open Settings and switch off **Keep scan history**. This deletes the saved entries right away.
- **Clear scan history:** Settings → **Clear history**.
- **Always ask before opening:** Settings → **Always ask before opening**. Nothing opens until you click **Open**.
- **Stop the icon from scanning:** Settings → **Scan the page when I click the icon** (off). The icon then only opens the panel.
- **Remove everything:** uninstall CertScanner. Chrome deletes its scan history, session data and site access. The four settings may stay in your Chrome sync data until you reset sync.

## 6. Security

Images are processed inside the extension's own pages, which run under a strict content security policy. Only the extension's packaged code can run there. The extension accepts no messages from web pages. Results from pages, QR codes and text recognition are treated as untrusted input and checked before use.

## 7. Children

CertScanner is a general-purpose tool and is not directed at children. It doesn't knowingly collect any personal information from anyone.

## 8. Chrome Web Store User Data Policy

CertScanner's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements. Website content is used only on your device to provide the single feature described above. It is never transferred, sold or used for advertising.

## 9. Changes

If CertScanner's data handling changes, this policy will be updated and the effective date changed. If a change involves new data or a new permission, it will be described in the release notes, and Chrome will ask for any new permission.

## 10. Contact

Questions or requests: `<maintainer contact>`

---

## Samenvatting in het Nederlands

_Deze samenvatting is ter informatie. Bij verschillen geldt de Engelse tekst hierboven._

- **Wat CertScanner doet:** het leest het certificaatnummer van een foto van een PSA- of CGC-slab en opent de officiële certpagina van de grader.
- **Alleen als jij het vraagt:** CertScanner leest een pagina alleen als je op het icoon klikt, op **Alt+Shift+S** drukt, op **Deze pagina scannen** klikt of met rechts op een foto klikt en **Certnummer van slab scannen** kiest. Het scant nooit vanzelf op de achtergrond.
- **Op je apparaat:** foto's worden op je eigen apparaat gelezen, in het geheugen, en nooit geüpload.
  - Bij een paginascan kijkt CertScanner alleen naar de adressen, afmetingen en posities van de afbeeldingen, niet naar tekst of andere inhoud van de pagina.
  - Kan een afbeelding niet direct geladen worden, dan wordt een schermafbeelding van het zichtbare deel van het tabblad gemaakt. Die wordt in het geheugen bijgesneden tot de foto en daarna weggegooid.
- **Wat je apparaat verlaat:** alleen het openen van de officiële certpagina met het certnummer (psacard.com, cgccomics.com of cgccards.com). Daarnaast kan de afbeelding opnieuw worden gedownload van de website die haar al toont; CertScanner stuurt daarbij geen cookies of referrer mee. CertScanner heeft zelf geen server en ontvangt niets.
- **Wat wordt bewaard:**
  - De instellingen (vier aan/uit-keuzes) gaan via Chrome-synchronisatie.
  - Recente scans (grader, nummer, manier van lezen, tijd; maximaal 25) blijven alleen op dit apparaat. Er worden geen afbeeldingen of webadressen bewaard.
  - Gegevens van de lopende scan staan alleen in het sessiegeheugen van Chrome en verdwijnen als Chrome sluit.
- **Geen** analytics, advertenties, tracking, verkoop of delen van gegevens. Geen account. Geen code van buitenaf.
- **Incognito:** CertScanner werkt niet in incognitovensters.
- **Optionele toegang per site:** alleen na jouw klik op **Scherpere scans op ‹site›** of **Altijd toestaan op ‹site›**, en Chrome vraagt eerst om toestemming voor die ene site. Je kunt die toegang intrekken op twee plekken:
  - in CertScanner: Instellingen → Scherpere scans → **Verwijderen**;
  - in Chrome: `chrome://extensions` → CertScanner → Details → Sitetoegang.
- **Verwijderen:**
  - Instellingen → **Geschiedenis wissen**.
  - Of zet **Scangeschiedenis bewaren** uit; dat wist de opgeslagen scans meteen.
  - Of verwijder de extensie.
- **Contact:** `<maintainer contact>`
