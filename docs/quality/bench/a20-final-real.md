# CertScanner realistic benchmark, bench-real (2026-10-12T15:05:10.823Z)

Build 4cc8ad2+dirty (e2e, 2026-10-12T14:48:27.000Z); Chromium 141.0.7390.37; 66 fixtures (62 with a number).

| Metric | Observed | Gate |
|---|---|---|
| Wrong auto-opens | 0 | 0 |
| Top number correct (positives) | 62/62 | >= 60 |
| Wrong number shown | 1 | <= 1 |
| Had to choose | 5 | <= 5 |
| Nothing found on a positive | 0 | - |
| Warm UI time p50 / p95 / max | 732 / 2053 / 4154 ms | - |
| Warm scan() total p50 / p95 / max | 528 / 2119 / 4078 ms | - |

Gate: **PASS**

| Outcome | n |
|---|---|
| auto-ok | 41 |
| auto-WRONG | 0 |
| opened-ok | 9 |
| opened-wrong | 0 |
| confirm-ok | 7 |
| confirm-choose | 5 |
| confirm-wrong | 0 |
| none-ok | 3 |
| none-miss | 0 |
| fp | 1 |
| error | 0 |

Top number correct 62/62; wrong number shown 1 (neg-receipt); had to choose 5 (cgcd-c17-thumb250, pair-psa-c01-psa-c03, pair-cgcc-c09-cgcd-c14, pair-bgs-c22-psa-c06, pair-psa-c02-cgcc-c10-thumb); nothing found on a positive 0; slower than 5 s: none.

| Family | Outcomes | Warm UI p50 / p95 / max (ms) |
|---|---|---|
| phone | auto-ok 9, opened-ok 3 | 759 / 1203 / 1203 |
| thumb | auto-ok 10, opened-ok 2, confirm-choose 1 | 507 / 741 / 741 |
| keystone | auto-ok 3, opened-ok 1, confirm-ok 1 | 740 / 871 / 871 |
| reflect | auto-ok 4, confirm-ok 1 | 655 / 1067 / 1067 |
| crop | auto-ok 3, opened-ok 1, none-ok 1 | 568 / 673 / 673 |
| pair | confirm-choose 4 | 801 / 941 / 941 |
| moire | auto-ok 4, confirm-ok 1 | 870 / 4154 / 4154 |
| bg | auto-ok 4, opened-ok 1, confirm-ok 1 | 619 / 1221 / 1221 |
| sideways | auto-ok 3, opened-ok 1 | 1254 / 1889 / 1889 |
| dark | auto-ok 1, confirm-ok 2 | 2234 / 4040 / 4040 |
| negative | confirm-ok 1, none-ok 2, fp 1 | 855 / 2053 / 2053 |

| Fixture | Family | Expected | State | Shown | Grader | #cand | Opened | UI ms | Outcome | Pipeline candidates |
|---|---|---|---|---|---|---|---|---|---|---|
| psa-c01-phone | phone | psa 04718263 | auto-open | 04718263 | psa | 0 | psacard.com/cert/04718263 | 833 | auto-ok | 04718263/psa/0.9 |
| psa-c03-phone | phone | psa 109876543 | auto-open | 109876543 | psa | 0 | psacard.com/cert/109876543 | 828 | auto-ok | 109876543/psa/0.9 |
| psa-c05-phone | phone | psa 056734128 | auto-open | 056734128 | psa | 0 | psacard.com/cert/056734128 | 625 | auto-ok | 056734128/psa/0.9 |
| psa-c07-phone | phone | psa 5123478 | auto-open | 5123478 | psa | 0 | psacard.com/cert/5123478 | 639 | auto-ok | 5123478/psa/0.9 |
| cgcc-c09-phone | phone | cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | 0 | cgccomics.com/certlookup/3984561002/ | 634 | auto-ok | 3984561002/cgc-comics/0.95 |
| cgcc-c11-phone | phone | cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | 0 | cgccomics.com/certlookup/4102938015/ | 798 | auto-ok | 4102938015/cgc-comics/0.95 |
| cgcc-c12-phone | phone | cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | 0 | cgccomics.com/certlookup/3765432011/ | 759 | auto-ok | 3765432011/cgc-comics/0.95 |
| cgcd-c14-phone | phone | cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | 0 | cgccards.com/certlookup/1402345678901/ | 722 | auto-ok | 1402345678901/cgc-cards/0.9 |
| cgcd-c16-phone | phone | cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | 0 | cgccards.com/certlookup/3901234567/ | 825 | auto-ok | 3901234567/cgc-cards/0.95 |
| bgs-c21-phone | phone | bgs 0012345678 | opened | 0012345678 | bgs | 0 | - | 1203 | opened-ok | 0012345678/bgs/0.95 |
| bgs-c22-phone | phone | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 665 | opened-ok | 0011873452/bgs/0.95 |
| bgs-c23-phone | phone | bgs 0009876543 | opened | 0009876543 | bgs | 0 | - | 822 | opened-ok | 0009876543/bgs/0.95 |
| psa-c02-thumb225 | thumb | psa 72910483 | auto-open | 72910483 | psa | 0 | psacard.com/cert/72910483 | 316 | auto-ok | 72910483/psa/0.9 |
| psa-c04-thumb300 | thumb | psa 00573921 | auto-open | 00573921 | psa | 0 | psacard.com/cert/00573921 | 412 | auto-ok | 00573921/psa/0.9 |
| psa-c06-thumb400 | thumb | psa 30561247 | auto-open | 30561247 | psa | 0 | psacard.com/cert/30561247 | 514 | auto-ok | 30561247/psa/0.9 |
| psa-c01-thumb500 | thumb | psa 04718263 | auto-open | 04718263 | psa | 0 | psacard.com/cert/04718263 | 741 | auto-ok | 04718263/psa/0.9 |
| cgcc-c10-thumb300 | thumb | cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | 0 | cgccomics.com/certlookup/4087123006/ | 490 | auto-ok | 4087123006/cgc-comics/0.95 |
| cgcc-c09-thumb400 | thumb | cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | 0 | cgccomics.com/certlookup/3984561002/ | 617 | auto-ok | 3984561002/cgc-comics/0.95 |
| cgcc-c13-thumb350 | thumb | cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | 0 | cgccomics.com/certlookup/4155667002/ | 199 | auto-ok | 4155667002/cgc-comics/0.95 |
| cgcd-c15-thumb300 | thumb | cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | 0 | cgccards.com/certlookup/1403987650123/ | 328 | auto-ok | 1403987650123/cgc-cards/0.9 |
| cgcd-c18-thumb450 | thumb | cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | 0 | cgccards.com/certlookup/1405551234567/ | 549 | auto-ok | 1405551234567/cgc-cards/0.9 |
| cgcd-c17-thumb250 | thumb | cgc-cards 2938475610 | confirm | 2938475610 | cgc-cards | 2 | - | 437 | confirm-choose | 2938475610/cgc-cards/0.7 2038475610/cgc-cards/0.66 |
| bgs-c22-thumb400 | thumb | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 551 | opened-ok | 0011873452/bgs/0.95 |
| bgs-c21-thumb300 | thumb | bgs 0012345678 | opened | 0012345678 | bgs | 0 | - | 721 | opened-ok | 0012345678/bgs/0.95 |
| psa-c08-thumb400 | thumb | psa 61834502 | auto-open | 61834502 | psa | 0 | psacard.com/cert/61834502 | 507 | auto-ok | 61834502/psa/1 |
| psa-c04-keystone | keystone | psa 00573921 | auto-open | 00573921 | psa | 0 | psacard.com/cert/00573921 | 641 | auto-ok | 00573921/psa/0.9 |
| cgcc-c10-keystone | keystone | cgc-comics 4087123006 | confirm | 4087123006 | cgc-comics | 0 | - | 871 | confirm-ok | 4087123006/cgc-comics/0.76 |
| cgcd-c15-keystone | keystone | cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | 0 | cgccards.com/certlookup/1403987650123/ | 577 | auto-ok | 1403987650123/cgc-cards/0.9 |
| bgs-c23-keystone | keystone | bgs 0009876543 | opened | 0009876543 | bgs | 0 | - | 832 | opened-ok | 0009876543/bgs/0.95 |
| psa-c08-keystone | keystone | psa 61834502 | auto-open | 61834502 | psa | 0 | psacard.com/cert/61834502 | 740 | auto-ok | 61834502/psa/0.8 |
| psa-c06-reflect | reflect | psa 30561247 | auto-open | 30561247 | psa | 0 | psacard.com/cert/30561247 | 559 | auto-ok | 30561247/psa/0.9 |
| cgcc-c12-reflect | reflect | cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | 0 | cgccomics.com/certlookup/3765432011/ | 682 | auto-ok | 3765432011/cgc-comics/0.95 |
| cgcd-c18-reflect | reflect | cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | 0 | cgccards.com/certlookup/1405551234567/ | 655 | auto-ok | 1405551234567/cgc-cards/0.9 |
| bgs-c21-reflect | reflect | bgs 0012345678 | confirm | 0012345678 | bgs | 0 | - | 1067 | confirm-ok | 0012345678/bgs/0.79 |
| cgcc-c13-reflect | reflect | cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | 0 | cgccomics.com/certlookup/4155667002/ | 348 | auto-ok | 4155667002/cgc-comics/0.95 |
| psa-c02-crop-top | crop | psa 72910483 | auto-open | 72910483 | psa | 0 | psacard.com/cert/72910483 | 585 | auto-ok | 72910483/psa/0.9 |
| cgcc-c11-crop-left | crop | cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | 0 | cgccomics.com/certlookup/4102938015/ | 537 | auto-ok | 4102938015/cgc-comics/0.95 |
| cgcd-c14-crop-edge | crop | cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | 0 | cgccards.com/certlookup/1402345678901/ | 568 | auto-ok | 1402345678901/cgc-cards/0.9 |
| bgs-c22-crop-right | crop | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 529 | opened-ok | 0011873452/bgs/0.95 |
| psa-c05-crop-nonumber | crop | - - | none | - | - | 0 | - | 673 | none-ok | - |
| pair-psa-c01-psa-c03 | pair | 04718263/109876543 | confirm | 04718263 | psa | 2 | - | 941 | confirm-choose | 04718263/psa/0.8 109876543/psa/0.8 |
| pair-cgcc-c09-cgcd-c14 | pair | 3984561002/1402345678901 | confirm | 1402345678901 | cgc-cards | 2 | - | 801 | confirm-choose | 1402345678901/cgc-cards/0.8 3984561002/?/0.55 |
| pair-bgs-c22-psa-c06 | pair | 0011873452/30561247 | confirm | 30561247 | psa | 2 | - | 702 | confirm-choose | 30561247/psa/0.8 0011873452/?/0.55 |
| pair-psa-c02-cgcc-c10-thumb | pair | 72910483/4087123006 | confirm | 72910483 | psa | 2 | - | 833 | confirm-choose | 72910483/psa/0.8 4087123006/?/0.55 |
| psa-c03-moire | moire | psa 109876543 | auto-open | 109876543 | psa | 0 | psacard.com/cert/109876543 | 870 | auto-ok | 109876543/psa/0.9 |
| cgcc-c09-moire | moire | cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | 0 | cgccomics.com/certlookup/3984561002/ | 864 | auto-ok | 3984561002/cgc-comics/0.95 |
| cgcd-c16-moire | moire | cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | 0 | cgccards.com/certlookup/3901234567/ | 1087 | auto-ok | 3901234567/cgc-cards/0.95 |
| bgs-c21-moire | moire | bgs 0012345678 | confirm | 0012345678 | bgs | 0 | - | 4154 | confirm-ok | 0012345678/bgs/0.79(L) |
| psa-c08-moire | moire | psa 61834502 | auto-open | 61834502 | psa | 0 | psacard.com/cert/61834502 | 795 | auto-ok | 61834502/psa/1 |
| psa-c05-bg-cloth | bg | psa 056734128 | auto-open | 056734128 | psa | 0 | psacard.com/cert/056734128 | 619 | auto-ok | 056734128/psa/0.9 |
| cgcc-c12-bg-red | bg | cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | 0 | cgccomics.com/certlookup/3765432011/ | 733 | auto-ok | 3765432011/cgc-comics/0.95 |
| cgcd-c17-bg-wood | bg | cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | 0 | cgccards.com/certlookup/2938475610/ | 613 | auto-ok | 2938475610/cgc-cards/0.95 |
| bgs-c23-bg-cloth | bg | bgs 0009876543 | opened | 0009876543 | bgs | 0 | - | 910 | opened-ok | 0009876543/bgs/0.95 |
| psa-c07-bg-gradient | bg | psa 5123478 | auto-open | 5123478 | psa | 0 | psacard.com/cert/5123478 | 557 | auto-ok | 5123478/psa/0.9 |
| neg-c19-bg-wood | bg | - 6012349870 | confirm | 6012349870 | cgc-comics | 0 | - | 1221 | confirm-ok | 6012349870/?/0.45 |
| psa-c01-side90 | sideways | psa 04718263 | auto-open | 04718263 | psa | 0 | psacard.com/cert/04718263 | 1889 | auto-ok | 04718263/psa/0.9 |
| cgcc-c10-side270 | sideways | cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | 0 | cgccomics.com/certlookup/4087123006/ | 1377 | auto-ok | 4087123006/cgc-comics/0.95 |
| cgcd-c15-side90-thumb | sideways | cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | 0 | cgccards.com/certlookup/1403987650123/ | 1000 | auto-ok | 1403987650123/cgc-cards/0.9 |
| bgs-c22-side270 | sideways | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 1254 | opened-ok | 0011873452/bgs/0.95 |
| psa-c04-dark | dark | psa 00573921 | auto-open | 00573921 | psa | 0 | psacard.com/cert/00573921 | 1698 | auto-ok | 00573921/psa/0.9 |
| cgcd-c18-dark | dark | cgc-cards 1405551234567 | confirm | 1405551234567 | cgc-cards | 0 | - | 2234 | confirm-ok | 1405551234567/cgc-cards/0.78 |
| bgs-c21-dark | dark | bgs 0012345678 | confirm | 0012345678 | bgs | 0 | - | 4040 | confirm-ok | 0012345678/bgs/0.79(L) |
| neg-c20-phone | negative | - - | none | - | - | 0 | - | 855 | none-ok | - |
| neg-landscape-phone | negative | - - | none | - | - | 0 | - | 2053 | none-ok | - |
| neg-c19-thumb300 | negative | - 6012349870 | confirm | 6012349870 | cgc-comics | 0 | - | 732 | confirm-ok | 6012349870/?/0.45 |
| neg-receipt | negative | - - | confirm | 5012345678900 | cgc-cards | 2 | - | 889 | fp | 5012345678900/cgc-cards/0.4 8712345678901/cgc-cards/0.4 |
