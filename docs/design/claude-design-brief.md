# CertScanner — ontwerpbrief (voor Claude Design)

## 1. Wat is het?

**CertScanner** is een Chrome-extensie voor verzamelaars van gegradeerde trading cards en comics. Op een webpagina
(eBay, marktplaatsen, Facebook-groepen, forums, webshops) zoekt hij de foto's van **PSA**- en **CGC**-slabs (harde
plastic hoesjes met een label), leest het **certificaatnummer** van het label en opent de **officiële
verificatiepagina** van PSA of CGC. Alles gebeurt op het apparaat zelf (OCR + barcode/QR), zonder server, zonder
account en zonder uploads.

**Belofte in één zin:** "Eén klik en je ziet de officiële cert-pagina van de slab die je bekijkt."

## 2. Gebruikers en context

- Kopers en verzamelaars die een listing willen controleren zonder 8–13 cijfers over te typen.
- Ze kijken naar een productpagina met één of meerdere slabfoto's, vaak klein of wazig.
- Ze willen snel zekerheid, maar mogen niet misleid worden: **een geldig certnummer bewijst niet dat de slab echt is**
  (vervalsers hergebruiken echte nummers). Het ontwerp toont daarom altijd het gelezen nummer, hoe het gelezen is en
  de exacte URL die geopend wordt.

## 3. Hoofdflows

1. **Pagina scannen (primair):** klik op het CertScanner-icoon in de werkbalk of druk **Alt+Shift+S** → het zijpaneel
   opent → "Scanning image 2 of 6" → resultaat:
   - **Eén duidelijk nummer** → de officiële pagina opent automatisch in een nieuw tabblad; het paneel toont
     "Opened PSA cert page" met het nummer, de bron (tekst/barcode/QR), de URL, *Copy number*, *Open again* en
     *Wrong number? Edit*.
   - **Meerdere of twijfelachtige nummers** → lijst "Cert numbers on this page" met per rij een thumbnail, grader-chip,
     nummer, bron, URL en knoppen *Open* / *Copy* (of *Choose grader* als de grader onbekend is).
   - **Niets gevonden** → "No cert numbers found on this page" met tips.
2. **Eén foto:** rechtsklik op een foto → **"Scan slab cert number"** → zelfde paneel, resultaat voor die foto.
3. **Andere manieren (secundair):** foto slepen, plakken (Ctrl+V), bestand kiezen, of het nummer intypen met
   grader-keuze (PSA / CGC Comics / CGC Cards).

Officiële pagina's: PSA `psacard.com/cert/{nr}` · CGC Comics `cgccomics.com/certlookup/{nr}/` · CGC Cards
`cgccards.com/certlookup/{nr}/`.

## 4. Het oppervlak: Chrome-zijpaneel

- Eén scherm: het **Chrome side panel**, 320–500 px breed (door de gebruiker te verbreden), licht én donker thema
  (volgt het systeem), Engels en Nederlands (volgt Chrome).
- Geen popup, geen pagina-overlay, geen onboarding-tab. Een nieuw tabblad met de officiële cert-pagina is de uitkomst.
- Indeling van boven naar beneden:
  1. **Header:** logo (20 px) + "CertScanner" + knop **Settings**.
  2. **Taakkaart** (de huidige scan; verandert per status — zie §5).
  3. **Other ways to scan:** dropzone + *Choose image*, daaronder "Type a cert number" (veld + grader-segmented control
     + *Open cert page*).
  4. **Recent scans:** compacte rijen (grader-chip, nummer in monospace, tijd, *Open*, *Copy*).
  5. **Footer:** "Not affiliated with PSA or CGC · Images stay on this device".
- **Settings** is een tweede weergave in hetzelfde paneel (met ← Back): *Opening cert pages* (Always ask before
  opening, Open in a background tab), *Toolbar button and shortcut* (Toolbar button scans the page + huidige sneltoets
  + Change shortcut), *Scan history* (Keep scan history, Clear history), *Sites with full access* (lijst met Remove),
  *About*.

## 5. Statussen van de taakkaart (alle te ontwerpen)

| Status | Inhoud |
|---|---|
| **Idle** | Kop "Scan a slab", primaire knop **Scan this page**, hint "Or right-click a slab photo → Scan slab cert number" |
| **Scanning** | "Scanning…", thumbnail, stappenlijst (Loading image → Reading barcode → Reading text → Matching) met per stap Done / In progress / Not started / Skipped; bij paginascan "Scanning image 2 of 6"; knop **Cancel** |
| **Result (auto-opened)** | ✓ "Opened PSA cert page", thumbnail, grader-chip, groot nummer (monospace), "Read from text (OCR)", URL, *Copy number*, *Open again*, link *Wrong number? Edit*, notitie "Check that the cert page matches this slab. A valid number alone doesn't prove the slab is genuine." |
| **Edit** | Nummerveld (geselecteerd), grader-keuze, *Open cert page* |
| **Confirm** | "Check the number", uitleg waarom (bv. "This number fits both CGC Comics and CGC Cards. Choose one." / "The photo is small or unclear"), thumbnail + *Show larger*, bewerkbaar nummer, grader-keuze, *Open cert page*, *Copy number* |
| **Page results** | "Cert numbers on this page", "Found: 6. Open the one that matches the slab you're looking at.", "Checked 8 of 10 photos.", lijst met kaarten per nummer, waarschuwingen (bv. QR-code die naar een andere site wijst), *Scan this page again* |
| **None** | "No cert number found" / "No cert numbers found on this page" + tips (rechtsklik een specifieke foto, scherpere scan, upload) |
| **Error** | Icoon + kop + uitleg + actie, bv. "Chrome doesn't allow reading this page", "CertScanner can't read this tab right now — Click the CertScanner icon or press Alt+Shift+S", "Image is too large", "Couldn't open this image", "Drop the image file instead" |
| **Low resolution** | Notitie in Confirm/None: knop **Sharper scans on ‹site›** (Chrome vraagt dan toestemming voor die ene site) |

## 6. Componenten

Primaire knop (gevuld accent), secundaire knop (omlijnd), link-knop, icoonknop (32 px), segmented control voor
graders (stapelt verticaal onder 280 px), grader-chip (neutraal, **geen merkkleuren**), resultaatkaart/rij met
thumbnail (72 px, max 240 px bron), stappenlijst met status-iconen, meldingen (info / succes / waarschuwing / fout,
met linker accentrand), toggle-switch, dropzone (gestreept, hover/drag-over-status), invoerveld met inline-fout.
Cert-nummers altijd in monospace en groot (24 px; 18 px bij smalle breedte).

## 7. Design tokens (huidige implementatie)

| Token | Licht | Donker |
|---|---|---|
| Achtergrond | `#FFFFFF` | `#16181C` |
| Surface (kaarten) | `#F6F7F9` | `#1F2228` |
| Tekst | `#1A1D21` | `#E8EAED` |
| Tekst gedempt | `#545B66` | `#A9AFB8` |
| Rand controls / subtiel | `#6B7280` / `#E1E4E9` | `#8B929C` / `#2E3239` |
| Accent (teal) / hover / subtiel | `#0F6E66` / `#0B5A54` / `#E3F2F0` | `#5CC8BA` / `#7DD8CC` / `#16332F` |
| Tekst op accent | `#FFFFFF` | `#0B1F1D` |
| Succes / subtiel | `#1E7B34` / `#E8F5EC` | `#6FD08C` / `#15301E` |
| Waarschuwing / subtiel | `#7A4D00` / `#FFF6DB` | `#F5C46B` / `#3A2E12` |
| Fout / subtiel | `#B42318` / `#FDECEA` | `#FF8A80` / `#3A1D1B` |

- **Typografie:** systeemfont (system-ui, Segoe UI, Roboto…), monospace voor nummers; maten 12 / 13 / 14 (body) /
  16 (koppen) / 18 / 24 (nummer) px; gewichten 400 en 600.
- **Ruimte:** 4 · 8 · 12 · 16 · 20 · 24 · 32 px; zijmarge 16 px (12 px onder 360 px breed).
- **Vorm:** radius 6 px (controls), 10 px (kaarten), pil (chips); controlhoogte 36 px, invoer 40 px, min. doel 24 px.
- **Focus:** 2 px ring in accentkleur, 2 px offset. **Beweging:** 120 / 200 ms, `cubic-bezier(0.2,0,0,1)`;
  respecteert *reduced motion*.

## 8. Icoon

Eenvoudige generieke vorm: een slab-omtrek (afgeronde rechthoek met labelbalk bovenin) met een vergrootglas.
**Geen vinkje** (niets mag "geverifieerd" suggereren) en **geen PSA/CGC-logo's of -kleuren**. Formaten 16, 32, 48 en
128 px; moet op 16 px nog leesbaar zijn.

## 9. Ontwerpregels (niet onderhandelbaar)

- Nooit claimen dat een slab echt/authentiek is; de "valid number ≠ genuine slab"-notitie staat bij elk resultaat.
- Altijd tonen: het gelezen nummer, hoe het gelezen is (barcode / QR-code / tekst / getypt) en de exacte URL.
- Geen merkimitatie: naam "CertScanner", PSA/CGC alleen beschrijvend, disclaimer "Not affiliated with PSA or CGC".
- Toegankelijkheid WCAG 2.2 AA: AA-contrast in beide thema's, alles met toetsenbord bereikbaar, focus springt naar de
  kop van de taakkaart bij elke statuswissel, statusmeldingen via een `aria-live`-regio, geen betekenis alleen via
  kleur, 200 % zoom op 320 px zonder horizontaal scrollen.
- Geen uitgeschakelde knoppen: validatie bij versturen, fout direct onder het veld.
- Privacy zichtbaar maar rustig: "Images stay on this device" in de footer; toestemmingsvragen alleen wanneer ze
  helpen (Sharper scans), nooit bij installatie.

## 10. Voorbeeldprompt voor Claude Design

> Ontwerp het Chrome-zijpaneel (360 px breed, licht en donker) voor **CertScanner**, een extensie die PSA- en
> CGC-slabfoto's op een webpagina scant en de officiële cert-pagina opent. Gebruik de tokens, componenten en
> statussen uit deze brief. Lever de schermen: Idle, Scanning (paginascan "image 2 of 6"), Result (automatisch
> geopend), Confirm (grader onbekend), Page results (6 nummers), None, Error (geen toegang tot tabblad) en Settings.
> Houd het rustig, functioneel en betrouwbaar — een tool, geen marketingpagina. Geen PSA/CGC-logo's, geen vinkjes die
> "echt" suggereren; cert-nummers groot in monospace.

Referentie: echte schermafbeeldingen van de huidige build staan in `docs/quality/screenshots/`
(bv. `s0-idle-light.png`, `p2-page-results-light.png`, `s2-result-light.png`, `s3-confirm-dark.png`,
`v2-settings-light.png`); de volledige UX-specificatie staat in `docs/design/design-spec.md`.
