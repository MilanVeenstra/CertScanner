# CertScanner OCR benchmark (2026-10-12T15:00:48.234Z)

Build 4cc8ad2+dirty (e2e, 2026-10-12T14:48:27.000Z); Chromium 141.0.7390.37; 65 fixtures.

| Metric | Observed | Gate |
|---|---|---|
| Top-1 clean | 21/21 = 100% | >= 90% |
| Top-1 degraded | 38/41 = 92.7% | >= 70% |
| Wrong auto-opens | 0 | 0 |
| Wrong number shown (confirm-wrong + opened-wrong + fp) | 1 | - |
| Had to choose (>= 2 numbers, top right) | 0 | - |
| Auto-open precision | 50/50 = 100% | - |
| Auto-open rate (clean / degraded positives) | 85.7% / 78% | - |
| Grader correct when top-1 correct | 98.3% | - |
| Grader correct (clean / degraded) | 100% / 95.1% | - |
| Per grader top-1 / grader (n) | psa 96%/100% (25); cgc-comics 92.9%/92.9% (14); cgc-cards 93.3%/93.3% (15); bgs 100%/100% (8) | - |
| Card name in search terms (clean / degraded) | 90% / 69.2% | - |
| Warm UI time p50 / p95 / max | 638 / 1155 / 3606 ms | - |
| Warm scan() total p50 / p95 / max | 482 / 1051 / 3388 ms | - |
| Cold UI time | fresh-profile: 1059 ms; panel-reload-1: 982 ms; panel-reload-2: 979 ms; panel-reload-3: 1084 ms; panel-reload-4: 1030 ms | - |

Gate: **PASS**

| Outcome | n |
|---|---|
| auto-ok | 50 |
| auto-WRONG | 0 |
| opened-ok | 7 |
| opened-wrong | 0 |
| confirm-ok | 3 |
| confirm-choose | 0 |
| confirm-wrong | 1 |
| none-ok | 2 |
| none-miss | 2 |
| fp | 0 |
| error | 0 |

Top number correct 59/62; wrong number shown 1 (psa-c03-blur2); had to choose 0; nothing found on a positive 2 (cgcc-c09-blur2, cgcd-c17-blur2); slower than 5 s: none.

| Category | Outcomes | Warm UI p50 / p95 / max (ms) |
|---|---|---|
| clean | auto-ok 18, opened-ok 3 | 608 / 872 / 1017 |
| negative | confirm-ok 1, none-ok 2 | 721 / 1060 / 1060 |
| degraded | auto-ok 32, opened-ok 4, confirm-ok 2, confirm-wrong 1, none-miss 2 | 699 / 1469 / 3606 |

| Grader | Outcomes | Warm UI p50 / p95 / max (ms) |
|---|---|---|
| bgs | opened-ok 7, confirm-ok 1 | 872 / 1155 / 1155 |
| psa | auto-ok 24, confirm-wrong 1 | 620 / 1469 / 3606 |
| cgc-comics | auto-ok 13, none-miss 1 | 697 / 1020 / 1020 |
| cgc-cards | auto-ok 13, confirm-ok 1, none-miss 1 | 621 / 2004 / 2004 |
| none | confirm-ok 1, none-ok 2 | 721 / 1060 / 1060 |

| Fixture | Category | Degradations | Expected | Observed state | Shown number | Grader | Opened | UI ms | Outcome | Top pipeline candidates | Card name (expected → shown) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| bgs-c21 | clean | - | opened bgs 0012345678 | opened | 0012345678 | bgs | - | 1017 | opened-ok | 0012345678/bgs/0.95 | MISS: FIRE LIZARD ex 199 → - |
| bgs-c22 | clean | - | opened bgs 0011873452 | opened | 0011873452 | bgs | - | 588 | opened-ok | 0011873452/bgs/0.95 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| bgs-c23 | clean | - | opened bgs 0009876543 | opened | 0009876543 | bgs | - | 872 | opened-ok | 0009876543/bgs/0.95 | ok: BASE WATER TURTLE-HOLO 2 → BASE WATER TURTLE-HOLO 2 |
| psa-c01 | clean | - | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 666 | auto-ok | 04718263/psa/0.9 | ok: CHROME ROOKIE SLUGGER 27 → CHROME ROOKIE SLUGGER 27 |
| psa-c02 | clean | - | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 569 | auto-ok | 72910483/psa/0.9 | ok: BASE WATER TURTLE-HOLO 2 → BASE WATER TURTLE-HOLO 2 |
| psa-c03 | clean | - | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 688 | auto-ok | 109876543/psa/0.9 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| psa-c04 | clean | - | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 632 | auto-ok | 00573921/psa/0.9 | ok: FINEST REFRACTOR 88 → FINEST REFRACTOR 88 |
| psa-c05 | clean | - | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 609 | auto-ok | 056734128/psa/0.9 | ok: NEO LIGHTNING MOUSE 70 → NEO LIGHTNING MOUSE 70 |
| psa-c06 | clean | - | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 594 | auto-ok | 30561247/psa/0.9 | ok: UPPER STAR ROOKIE 1 → UPPER STAR ROOKIE 1 |
| psa-c07 | clean | - | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 553 | auto-ok | 5123478/psa/0.9 | ok: BASKETBALL HIGH FLYER 57 → BASKETBALL HIGH FLYER 57 |
| psa-c08 | clean | - | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 521 | auto-ok | 61834502/psa/1 | - |
| cgcc-c09 | clean | - | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 697 | auto-ok | 3984561002/cgc-comics/0.95 | ok: Cosmic Tales 1 → Cosmic Tales 1 |
| cgcc-c10 | clean | - | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 577 | auto-ok | 4087123006/cgc-comics/0.95 | ok: Night Avenger 423 → Night Avenger 423 |
| cgcc-c11 | clean | - | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 715 | auto-ok | 4102938015/cgc-comics/0.95 | ok: Star Rangers 12 → Star Rangers 12 |
| cgcc-c12 | clean | - | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 558 | auto-ok | 3765432011/cgc-comics/0.95 | ok: Mutant Squad 1 → Mutant Squad 1 |
| cgcc-c13 | clean | - | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 375 | auto-ok | 4155667002/cgc-comics/0.95 | ok: Deep Sea Saga 5 → Deep Sea Saga 5 |
| cgcd-c14 | clean | - | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 628 | auto-ok | 1402345678901/cgc-cards/0.9 | ok: Sword Set Electric Mouse Holo → Sword Set Electric Mouse Holo |
| cgcd-c15 | clean | - | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 566 | auto-ok | 1403987650123/cgc-cards/0.9 | ok: Scarlet Set Fire Lizard ex → Scarlet Set GCC Fire Lizard ex |
| cgcd-c16 | clean | - | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 615 | auto-ok | 3901234567/cgc-cards/0.95 | MISS: Celebrations Sea Dragon Holo → Celebrations Holo |
| cgcd-c17 | clean | - | auto-open cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | cgccards.com/certlookup/2938475610/ | 514 | auto-ok | 2938475610/cgc-cards/0.95 | ok: Base Set Water Turtle Holo NM/MINT+ → Base Set NM/MINT+ water Turtle Holo |
| cgcd-c18 | clean | - | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 608 | auto-ok | 1405551234567/cgc-cards/0.9 | ok: Vivid Set Thunder Bird MINT+ → Vivid Set MINT+ Thunder Bird |
| neg-c19 | negative | - | confirm - 6012349870 | confirm | 6012349870 | cgc-comics | - | 1060 | confirm-ok | 6012349870/?/0.45 | - |
| neg-c20 | negative | - | none - - | none | - | - | - | 632 | none-ok | - | - |
| psa-b01 | degraded | busy-art | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 778 | auto-ok | 07294618/psa/0.9 | ok: FIRE LIZARD ex 199 → FIRE LIZARD ex FIRE LIZARD ex 199 |
| cgcc-b02 | degraded | busy-art | auto-open cgc-comics 4011223004 | auto-open | 4011223004 | cgc-comics | cgccomics.com/certlookup/4011223004/ | 793 | auto-ok | 4011223004/cgc-comics/0.95 | ok: Cosmic Tales 300 → Cosmic Tales 300 |
| cgcd-b03 | degraded | busy-art | auto-open cgc-cards 1404440987654 | auto-open | 1404440987654 | cgc-cards | cgccards.com/certlookup/1404440987654/ | 753 | auto-ok | 1404440987654/cgc-cards/0.9 | ok: Base Electric Mouse 58 → Base Electric Mouse ELECTRIC MOUSE HP 60 58 |
| psa-b04 | degraded | busy-art | confirm psa 81726354 | auto-open | 81726354 | psa | psacard.com/cert/81726354 | 708 | auto-ok | 81726354/psa/0.9 | ok: BASE STAR ROOKIE 5 → BASE STAR ROOKIE 5 |
| psa-c01-jpeg40 | degraded | jpeg-q40 | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 603 | auto-ok | 04718263/psa/0.9 | ok: CHROME ROOKIE SLUGGER 27 → CHROME ROOKIE SLUGGER 27 |
| psa-c03-jpeg40 | degraded | jpeg-q40 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 622 | auto-ok | 109876543/psa/0.9 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| cgcc-c09-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 643 | auto-ok | 3984561002/cgc-comics/0.95 | ok: Cosmic Tales 1 → Cosmic Tales 1 |
| cgcd-c14-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 819 | auto-ok | 1402345678901/cgc-cards/0.9 | ok: Sword Set Electric Mouse Holo → Sword Set Electric Mouse Holo |
| cgcd-c16-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 585 | auto-ok | 3901234567/cgc-cards/0.95 | MISS: Celebrations Sea Dragon Holo → Celebrations seaDragon Holo |
| psa-c08-jpeg40 | degraded | jpeg-q40 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 620 | auto-ok | 61834502/psa/1 | - |
| cgcc-c13-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 391 | auto-ok | 4155667002/cgc-comics/0.95 | ok: Deep Sea Saga 5 → Deep Sea Saga 5 |
| psa-c02-half | degraded | scale-0.5 | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 386 | auto-ok | 72910483/psa/0.9 | ok: BASE WATER TURTLE-HOLO 2 → BASE WATER TURTLE-HOLO 2 |
| psa-c04-half | degraded | scale-0.5 | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 364 | auto-ok | 00573921/psa/0.9 | ok: FINEST REFRACTOR 88 → FINEST REFRACTOR 88 |
| cgcc-c10-half | degraded | scale-0.5 | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 455 | auto-ok | 4087123006/cgc-comics/0.8 | ok: Night Avenger 423 → Night Avenger 423 Gotham Ink |
| cgcd-c15-half | degraded | scale-0.5 | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 333 | auto-ok | 1403987650123/cgc-cards/0.9 | ok: Scarlet Set Fire Lizard ex → Scarlet Set Fire Lizard ex |
| psa-c08-half | degraded | scale-0.5 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 323 | auto-ok | 61834502/psa/0.9 | - |
| psa-c01-blur1 | degraded | blur-1px | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 663 | auto-ok | 04718263/psa/0.9 | ok: CHROME ROOKIE SLUGGER 27 → CHROME ROOKIE SLUGGER 27 |
| cgcc-c11-blur1 | degraded | blur-1px | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 703 | auto-ok | 4102938015/cgc-comics/0.95 | ok: Star Rangers 12 → Star Rangers 12 |
| cgcd-c14-blur1 | degraded | blur-1px | auto-open cgc-cards 1402345678901 | confirm | 1402345678901 | cgc-cards | - | 449 | confirm-ok | 1402345678901/cgc-cards/0.7 | MISS: Sword Set Electric Mouse Holo → - |
| psa-c03-blur2 | degraded | blur-2px | auto-open psa 109876543 | confirm | 10987454 (miss) | psa | - | 893 | confirm-wrong | 10987454/psa/0.48 100876043/psa/0.43 | MISS: PRIZM POINT GUARD 280 → - |
| cgcc-c09-blur2 | degraded | blur-2px | auto-open cgc-comics 3984561002 | none | - (miss) | - | - | 1020 | none-miss | - | MISS: Cosmic Tales 1 → - |
| cgcd-c17-blur2 | degraded | blur-2px | auto-open cgc-cards 2938475610 | none | - (miss) | - | - | 797 | none-miss | - | MISS: Base Set Water Turtle Holo NM/MINT+ → - |
| psa-c02-glare | degraded | glare | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 503 | auto-ok | 72910483/psa/0.9 | MISS: BASE WATER TURTLE-HOLO 2 → BASE WATER LE-HOLO 2 |
| psa-c06-glare | degraded | glare | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 508 | auto-ok | 30561247/psa/0.9 | MISS: UPPER STAR ROOKIE 1 → STAI 1 |
| cgcc-c10-glare | degraded | glare | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 966 | auto-ok | 4087123006/cgc-comics/0.95 | MISS: Night Avenger 423 → AL nt Avenger 423 |
| cgcd-c14-glare | degraded | glare | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 621 | auto-ok | 1402345678901/cgc-cards/0.9 | MISS: Sword Set Electric Mouse Holo → use Holo CC |
| psa-c03-rot-3 | degraded | rotate:-3 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 650 | auto-ok | 109876543/psa/0.9 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| cgcc-c09-rot5 | degraded | rotate:5 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 731 | auto-ok | 3984561002/cgc-comics/0.85 | ok: Cosmic Tales 1 → Cosmic Tales 1 |
| cgcd-c16-rot-6 | degraded | rotate:-6 | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 1004 | auto-ok | 3901234567/cgc-cards/0.95 | ok: Celebrations Sea Dragon Holo → Celebrations Holo Sea Dragon |
| psa-c07-rot2 | degraded | rotate:2 | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 590 | auto-ok | 5123478/psa/0.9 | ok: BASKETBALL HIGH FLYER 57 → BASKETBALL HIGH FLYER 57 |
| psa-c04-dark | degraded | dark-low-contrast | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 1469 | auto-ok | 00573921/psa/0.9 | ok: FINEST REFRACTOR 88 → FINEST REFRACTOR Ix 88 |
| cgcc-c12-dark | degraded | dark-low-contrast | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 953 | auto-ok | 3765432011/cgc-comics/0.94 | ok: Mutant Squad 1 → Mutant Squad 1 |
| cgcd-c18-dark | degraded | dark-low-contrast | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 2004 | auto-ok | 1405551234567/cgc-cards/0.9 | ok: Vivid Set Thunder Bird MINT+ → Vivid Set MINT+ Thunder Bird |
| psa-c05-dark | degraded | dark-low-contrast | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 3606 | auto-ok | 056734128/psa/0.9 | ok: NEO LIGHTNING MOUSE 70 → NEO LIGHTNING MOUSE 70 |
| psa-b01-jpeg40 | degraded | busy-art, jpeg-q40 | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 860 | auto-ok | 07294618/psa/0.9 | ok: FIRE LIZARD ex 199 → FIRE LIZARD ex FIRE LIZARD ex 199 |
| cgcd-c14-rot-4-jpeg60 | degraded | rotate:-4, jpeg-q60 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 638 | auto-ok | 1402345678901/cgc-cards/0.9 | ok: Sword Set Electric Mouse Holo → Sword Set Electric Mouse Holo |
| neg-c20-jpeg40 | negative | jpeg-q40 | none - - | none | - | - | - | 721 | none-ok | - | - |
| bgs-c21-jpeg40 | degraded | jpeg-q40 | opened bgs 0012345678 | opened | 0012345678 | bgs | - | 934 | opened-ok | 0012345678/bgs/0.95 | MISS: FIRE LIZARD ex 199 → - |
| bgs-c22-half | degraded | scale-0.5 | opened bgs 0011873452 | opened | 0011873452 | bgs | - | 337 | opened-ok | 0011873452/bgs/0.95 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| bgs-c21-blur1 | degraded | blur-1px | opened bgs 0012345678 | opened | 0012345678 | bgs | - | 905 | opened-ok | 0012345678/bgs/0.95 | MISS: FIRE LIZARD ex 199 → - |
| bgs-c23-glare | degraded | glare | opened bgs 0009876543 | confirm | 0009876543 | bgs | - | 1155 | confirm-ok | 0009876543/bgs/0.79 | MISS: BASE WATER TURTLE-HOLO 2 → - |
| bgs-c22-rot-3 | degraded | rotate:-3 | opened bgs 0011873452 | opened | 0011873452 | bgs | - | 699 | opened-ok | 0011873452/bgs/0.95 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
