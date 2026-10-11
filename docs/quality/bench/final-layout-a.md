# CertScanner OCR benchmark (2026-10-11T21:20:23.371Z)

Build 9f25d8e+dirty (e2e, 2026-10-11T21:03:00.000Z); Chromium 141.0.7390.37; 65 fixtures.

| Metric | Observed | Gate |
|---|---|---|
| Top-1 clean | 21/21 = 100% | >= 90% |
| Top-1 degraded | 36/41 = 87.8% | >= 70% |
| Wrong auto-opens | 0 | 0 |
| Auto-open precision | 49/49 = 100% | - |
| Auto-open rate (clean / degraded positives) | 85.7% / 75.6% | - |
| Grader correct when top-1 correct | 98.3% | - |
| Grader correct (clean / degraded) | 100% / 92.7% | - |
| Per grader top-1 / grader (n) | psa 96%/100% (25); cgc-comics 92.9%/92.9% (14); cgc-cards 86.7%/93.3% (15); bgs 87.5%/87.5% (8) | - |
| Card name in search terms (clean / degraded) | 90% / 66.7% | - |
| Warm UI time p50 / p95 / max | 1042 / 1955 / 5434 ms | - |
| Warm scan() total p50 / p95 / max | 793 / 1808 / 5115 ms | - |
| Cold UI time | fresh-profile: 1996 ms; panel-reload-1: 1637 ms; panel-reload-2: 1643 ms; panel-reload-3: 1668 ms; panel-reload-4: 1799 ms | - |

Gate: **PASS**

| Fixture | Category | Degradations | Expected | Observed state | Shown number | Grader | Opened | UI ms | Top pipeline candidates | Card name (expected → shown) |
|---|---|---|---|---|---|---|---|---|---|---|
| bgs-c21 | clean | - | opened bgs 0012345678 | confirm | 0012345678 | bgs | - | 1694 | 0012345678/bgs/0.79 | MISS: FIRE LIZARD ex 199 → - |
| bgs-c22 | clean | - | opened bgs 0011873452 | opened | 0011873452 | bgs | - | 1137 | 0011873452/bgs/0.95 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| bgs-c23 | clean | - | opened bgs 0009876543 | opened | 0009876543 | bgs | - | 1363 | 0009876543/bgs/0.95 | ok: BASE WATER TURTLE-HOLO 2 → BASE WATER TURTLE-HOLO 2 |
| psa-c01 | clean | - | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 1065 | 04718263/psa/0.9 | ok: CHROME ROOKIE SLUGGER 27 → CHROME ROOKIE SLUGGER 27 |
| psa-c02 | clean | - | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 943 | 72910483/psa/0.9 | ok: BASE WATER TURTLE-HOLO 2 → BASE WATER TURTLE-HOLO 2 |
| psa-c03 | clean | - | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 954 | 109876543/psa/0.9 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| psa-c04 | clean | - | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 969 | 00573921/psa/0.9 | ok: FINEST REFRACTOR 88 → FINEST REFRACTOR 88 |
| psa-c05 | clean | - | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 783 | 056734128/psa/0.9 | ok: NEO LIGHTNING MOUSE 70 → NEO LIGHTNING MOUSE 70 |
| psa-c06 | clean | - | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 648 | 30561247/psa/0.9 | ok: UPPER STAR ROOKIE 1 → UPPER STAR ROOKIE 1 |
| psa-c07 | clean | - | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 871 | 5123478/psa/0.9 | ok: BASKETBALL HIGH FLYER 57 → BASKETBALL HIGH FLYER 57 |
| psa-c08 | clean | - | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 921 | 61834502/psa/1 | - |
| cgcc-c09 | clean | - | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 1324 | 3984561002/cgc-comics/0.95 | ok: Cosmic Tales 1 → Cosmic Tales 1 |
| cgcc-c10 | clean | - | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 837 | 4087123006/cgc-comics/0.95 | ok: Night Avenger 423 → Night Avenger 423 |
| cgcc-c11 | clean | - | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 1142 | 4102938015/cgc-comics/0.95 | ok: Star Rangers 12 → Star Rangers 12 |
| cgcc-c12 | clean | - | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 1136 | 3765432011/cgc-comics/0.95 | ok: Mutant Squad 1 → Mutant Squad 1 |
| cgcc-c13 | clean | - | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 358 | 4155667002/cgc-comics/0.95 | ok: Deep Sea Saga 5 → Deep Sea Saga 5 |
| cgcd-c14 | clean | - | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 959 | 1402345678901/cgc-cards/0.9 | ok: Sword Set Electric Mouse Holo → Sword Set Electric Mouse Holo |
| cgcd-c15 | clean | - | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 867 | 1403987650123/cgc-cards/0.9 | ok: Scarlet Set Fire Lizard ex → Scarlet Set GCC Fire Lizard ex |
| cgcd-c16 | clean | - | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 854 | 3901234567/cgc-cards/0.95 | MISS: Celebrations Sea Dragon Holo → Celebrations Holo |
| cgcd-c17 | clean | - | auto-open cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | cgccards.com/certlookup/2938475610/ | 1026 | 2938475610/cgc-cards/0.95 | ok: Base Set Water Turtle Holo NM/MINT+ → Base Set NM/MINT+ water Turtle Holo |
| cgcd-c18 | clean | - | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 711 | 1405551234567/cgc-cards/0.9 | ok: Vivid Set Thunder Bird MINT+ → Vivid Set MINT+ Thunder Bird |
| neg-c19 | negative | - | confirm - 6012349870 | confirm | 6012349870 | cgc-comics | - | 1326 | 6012349870/?/0.45 | - |
| neg-c20 | negative | - | none - - | none | - | - | - | 1191 | - | - |
| psa-b01 | degraded | busy-art | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1262 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 | ok: FIRE LIZARD ex 199 → FIRE LIZARD ex FIRE LIZARD ex 199 |
| cgcc-b02 | degraded | busy-art | auto-open cgc-comics 4011223004 | auto-open | 4011223004 | cgc-comics | cgccomics.com/certlookup/4011223004/ | 1299 | 4011223004/cgc-comics/0.95 | ok: Cosmic Tales 300 → Cosmic Tales 300 |
| cgcd-b03 | degraded | busy-art | auto-open cgc-cards 1404440987654 | auto-open | 1404440987654 | cgc-cards | cgccards.com/certlookup/1404440987654/ | 1302 | 1404440987654/cgc-cards/0.9 | ok: Base Electric Mouse 58 → Base Electric Mouse ELECTRIC MOUSE HP 60 58 |
| psa-b04 | degraded | busy-art | confirm psa 81726354 | auto-open | 81726354 | psa | psacard.com/cert/81726354 | 1270 | 81726354/psa/0.9 | ok: BASE STAR ROOKIE 5 → BASE STAR ROOKIE 5 |
| psa-c01-jpeg40 | degraded | jpeg-q40 | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 1273 | 04718263/psa/0.9 | ok: CHROME ROOKIE SLUGGER 27 → CHROME ROOKIE SLUGGER 27 |
| psa-c03-jpeg40 | degraded | jpeg-q40 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 1029 | 109876543/psa/0.9 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| cgcc-c09-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 1080 | 3984561002/cgc-comics/0.95 | ok: Cosmic Tales 1 → Cosmic Tales 1 |
| cgcd-c14-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 1042 | 1402345678901/cgc-cards/0.9 | ok: Sword Set Electric Mouse Holo → Sword Set Electric Mouse Holo |
| cgcd-c16-jpeg40 | degraded | jpeg-q40 | auto-open cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | cgccards.com/certlookup/3901234567/ | 890 | 3901234567/cgc-cards/0.95 | MISS: Celebrations Sea Dragon Holo → Celebrations seaDragon Holo |
| psa-c08-jpeg40 | degraded | jpeg-q40 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 1012 | 61834502/psa/1 | - |
| cgcc-c13-jpeg40 | degraded | jpeg-q40 | auto-open cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | cgccomics.com/certlookup/4155667002/ | 650 | 4155667002/cgc-comics/0.95 | ok: Deep Sea Saga 5 → Deep Sea Saga 5 |
| psa-c02-half | degraded | scale-0.5 | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 514 | 72910483/psa/0.9 | ok: BASE WATER TURTLE-HOLO 2 → BASE WATER TURTLE-HOLO 2 |
| psa-c04-half | degraded | scale-0.5 | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 599 | 00573921/psa/0.9 | ok: FINEST REFRACTOR 88 → FINEST REFRACTOR 88 |
| cgcc-c10-half | degraded | scale-0.5 | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 810 | 4087123006/cgc-comics/0.8 | ok: Night Avenger 423 → Night Avenger 423 Gotham Ink |
| cgcd-c15-half | degraded | scale-0.5 | auto-open cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | cgccards.com/certlookup/1403987650123/ | 549 | 1403987650123/cgc-cards/0.9 | ok: Scarlet Set Fire Lizard ex → Scarlet Set Fire Lizard ex |
| psa-c08-half | degraded | scale-0.5 | auto-open psa 61834502 | auto-open | 61834502 | psa | psacard.com/cert/61834502 | 451 | 61834502/psa/0.9 | - |
| psa-c01-blur1 | degraded | blur-1px | auto-open psa 04718263 | auto-open | 04718263 | psa | psacard.com/cert/04718263 | 857 | 04718263/psa/0.9 | ok: CHROME ROOKIE SLUGGER 27 → CHROME ROOKIE SLUGGER 27 |
| cgcc-c11-blur1 | degraded | blur-1px | auto-open cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | cgccomics.com/certlookup/4102938015/ | 1102 | 4102938015/cgc-comics/0.95 | ok: Star Rangers 12 → Star Rangers 12 |
| cgcd-c14-blur1 | degraded | blur-1px | auto-open cgc-cards 1402345678901 | confirm | 1402345678901 | cgc-cards | - | 845 | 1402345678901/cgc-cards/0.7 | MISS: Sword Set Electric Mouse Holo → - |
| psa-c03-blur2 | degraded | blur-2px | auto-open psa 109876543 | confirm | 100876043 (miss) | psa | - | 848 | 100876043/psa/0.53 10987654/psa/0.35 | MISS: PRIZM POINT GUARD 280 → - |
| cgcc-c09-blur2 | degraded | blur-2px | auto-open cgc-comics 3984561002 | none | - (miss) | - | - | 1365 | - | MISS: Cosmic Tales 1 → - |
| cgcd-c17-blur2 | degraded | blur-2px | auto-open cgc-cards 2938475610 | none | - (miss) | - | - | 1508 | - | MISS: Base Set Water Turtle Holo NM/MINT+ → - |
| psa-c02-glare | degraded | glare | auto-open psa 72910483 | auto-open | 72910483 | psa | psacard.com/cert/72910483 | 1081 | 72910483/psa/0.9 | MISS: BASE WATER TURTLE-HOLO 2 → BASE WATER LE-HOLO 2 |
| psa-c06-glare | degraded | glare | auto-open psa 30561247 | auto-open | 30561247 | psa | psacard.com/cert/30561247 | 778 | 30561247/psa/0.9 | MISS: UPPER STAR ROOKIE 1 → STAI 1 |
| cgcc-c10-glare | degraded | glare | auto-open cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | cgccomics.com/certlookup/4087123006/ | 1696 | 4087123006/cgc-comics/0.95 | MISS: Night Avenger 423 → AL nt Avenger 423 |
| cgcd-c14-glare | degraded | glare | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 938 | 1402345678901/cgc-cards/0.9 | MISS: Sword Set Electric Mouse Holo → use Holo CC |
| psa-c03-rot-3 | degraded | rotate:-3 | auto-open psa 109876543 | auto-open | 109876543 | psa | psacard.com/cert/109876543 | 1176 | 109876543/psa/0.9 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| cgcc-c09-rot5 | degraded | rotate:5 | auto-open cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | cgccomics.com/certlookup/3984561002/ | 1180 | 3984561002/cgc-comics/0.85 | ok: Cosmic Tales 1 → Cosmic Tales 1 |
| cgcd-c16-rot-6 | degraded | rotate:-6 | auto-open cgc-cards 3901234567 | confirm | 2901234567 (miss) | cgc-cards | - | 1955 | 2901234567/cgc-cards/0.79 | MISS: Celebrations Sea Dragon Holo → - |
| psa-c07-rot2 | degraded | rotate:2 | auto-open psa 5123478 | auto-open | 5123478 | psa | psacard.com/cert/5123478 | 1016 | 5123478/psa/0.9 | ok: BASKETBALL HIGH FLYER 57 → BASKETBALL HIGH FLYER 57 |
| psa-c04-dark | degraded | dark-low-contrast | auto-open psa 00573921 | auto-open | 00573921 | psa | psacard.com/cert/00573921 | 2223 | 00573921/psa/0.9 | ok: FINEST REFRACTOR 88 → FINEST REFRACTOR Ix 88 |
| cgcc-c12-dark | degraded | dark-low-contrast | auto-open cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | cgccomics.com/certlookup/3765432011/ | 1102 | 3765432011/cgc-comics/0.94 | ok: Mutant Squad 1 → Mutant Squad 1 |
| cgcd-c18-dark | degraded | dark-low-contrast | auto-open cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | cgccards.com/certlookup/1405551234567/ | 2795 | 1405551234567/cgc-cards/0.9 | ok: Vivid Set Thunder Bird MINT+ → Vivid Set MINT+ Thunder Bird |
| psa-c05-dark | degraded | dark-low-contrast | auto-open psa 056734128 | auto-open | 056734128 | psa | psacard.com/cert/056734128 | 5434 | 056734128/psa/0.9 | ok: NEO LIGHTNING MOUSE 70 → NEO LIGHTNING MOUSE 70 |
| psa-b01-jpeg40 | degraded | busy-art, jpeg-q40 | auto-open psa 07294618 | auto-open | 07294618 | psa | psacard.com/cert/07294618 | 1065 | 07294618/psa/0.9 1997165/psa/0.35 2023151/psa/0.35 | ok: FIRE LIZARD ex 199 → FIRE LIZARD ex FIRE LIZARD ex 199 |
| cgcd-c14-rot-4-jpeg60 | degraded | rotate:-4, jpeg-q60 | auto-open cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | cgccards.com/certlookup/1402345678901/ | 713 | 1402345678901/cgc-cards/0.9 | ok: Sword Set Electric Mouse Holo → Sword Set Electric Mouse Holo |
| neg-c20-jpeg40 | negative | jpeg-q40 | none - - | none | - | - | - | 1160 | - | - |
| bgs-c21-jpeg40 | degraded | jpeg-q40 | opened bgs 0012345678 | confirm | 0012345678 | bgs | - | 1536 | 0012345678/bgs/0.79 | MISS: FIRE LIZARD ex 199 → - |
| bgs-c22-half | degraded | scale-0.5 | opened bgs 0011873452 | opened | 0011873452 | bgs | - | 462 | 0011873452/bgs/0.95 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
| bgs-c21-blur1 | degraded | blur-1px | opened bgs 0012345678 | confirm | 0012345678 | bgs | - | 1435 | 0012345678/bgs/0.79 | MISS: FIRE LIZARD ex 199 → - |
| bgs-c23-glare | degraded | glare | opened bgs 0009876543 | confirm | 009876543 (miss) | psa | - | 1175 | 009876543/psa/0.7 | MISS: BASE WATER TURTLE-HOLO 2 → - |
| bgs-c22-rot-3 | degraded | rotate:-3 | opened bgs 0011873452 | opened | 0011873452 | bgs | - | 860 | 0011873452/bgs/0.95 | ok: PRIZM POINT GUARD 280 → PRIZM POINT GUARD 280 |
