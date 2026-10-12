# CertScanner realistic benchmark, bench-real (2026-10-12T14:20:58.559Z)

Build 58754af (e2e, 2026-10-12T11:32:11.000Z); Chromium 141.0.7390.37; 66 fixtures (62 with a number).

| Metric | Observed | Gate |
|---|---|---|
| Wrong auto-opens | 0 | 0 |
| Top number correct (positives) | 58/62 | >= 60 |
| Wrong number shown | 3 | <= 1 |
| Had to choose | 6 | <= 5 |
| Nothing found on a positive | 2 | - |
| Warm UI time p50 / p95 / max | 660 / 2289 / 3619 ms | - |
| Warm scan() total p50 / p95 / max | 513 / 2320 / 3443 ms | - |

Gate: **FAIL**

| Outcome | n |
|---|---|
| auto-ok | 38 |
| auto-WRONG | 0 |
| opened-ok | 7 |
| opened-wrong | 0 |
| confirm-ok | 7 |
| confirm-choose | 6 |
| confirm-wrong | 2 |
| none-ok | 3 |
| none-miss | 2 |
| fp | 1 |
| error | 0 |

Top number correct 58/62; wrong number shown 3 (bgs-c21-reflect, bgs-c21-moire, neg-receipt); had to choose 6 (bgs-c21-phone, cgcd-c17-thumb250, pair-psa-c01-psa-c03, pair-cgcc-c09-cgcd-c14, pair-bgs-c22-psa-c06, pair-psa-c02-cgcc-c10-thumb); nothing found on a positive 2 (psa-c01-side90, cgcd-c15-side90-thumb); slower than 5 s: none.

| Family | Outcomes | Warm UI p50 / p95 / max (ms) |
|---|---|---|
| phone | auto-ok 9, opened-ok 2, confirm-choose 1 | 745 / 901 / 901 |
| thumb | auto-ok 10, opened-ok 1, confirm-ok 1, confirm-choose 1 | 481 / 669 / 669 |
| keystone | auto-ok 2, opened-ok 1, confirm-ok 2 | 599 / 912 / 912 |
| reflect | auto-ok 4, confirm-wrong 1 | 605 / 663 / 663 |
| crop | auto-ok 3, opened-ok 1, none-ok 1 | 565 / 733 / 733 |
| pair | confirm-choose 4 | 838 / 967 / 967 |
| moire | auto-ok 4, confirm-wrong 1 | 1061 / 3540 / 3540 |
| bg | auto-ok 4, opened-ok 1, confirm-ok 1 | 683 / 923 / 923 |
| sideways | auto-ok 1, opened-ok 1, none-miss 2 | 1284 / 1407 / 1407 |
| dark | auto-ok 1, confirm-ok 2 | 2289 / 3619 / 3619 |
| negative | confirm-ok 1, none-ok 2, fp 1 | 777 / 3182 / 3182 |

| Fixture | Family | Expected | State | Shown | Grader | #cand | Opened | UI ms | Outcome | Pipeline candidates |
|---|---|---|---|---|---|---|---|---|---|---|
| psa-c01-phone | phone | psa 04718263 | auto-open | 04718263 | psa | 0 | psacard.com/cert/04718263 | 819 | auto-ok | 04718263/psa/0.9 |
| psa-c03-phone | phone | psa 109876543 | auto-open | 109876543 | psa | 0 | psacard.com/cert/109876543 | 522 | auto-ok | 109876543/psa/0.9 |
| psa-c05-phone | phone | psa 056734128 | auto-open | 056734128 | psa | 0 | psacard.com/cert/056734128 | 826 | auto-ok | 056734128/psa/0.9 |
| psa-c07-phone | phone | psa 5123478 | auto-open | 5123478 | psa | 0 | psacard.com/cert/5123478 | 825 | auto-ok | 5123478/psa/0.9 |
| cgcc-c09-phone | phone | cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | 0 | cgccomics.com/certlookup/3984561002/ | 621 | auto-ok | 3984561002/cgc-comics/0.95 |
| cgcc-c11-phone | phone | cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | 0 | cgccomics.com/certlookup/4102938015/ | 636 | auto-ok | 4102938015/cgc-comics/0.95 |
| cgcc-c12-phone | phone | cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | 0 | cgccomics.com/certlookup/3765432011/ | 554 | auto-ok | 3765432011/cgc-comics/0.95 |
| cgcd-c14-phone | phone | cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | 0 | cgccards.com/certlookup/1402345678901/ | 901 | auto-ok | 1402345678901/cgc-cards/0.9 |
| cgcd-c16-phone | phone | cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | 0 | cgccards.com/certlookup/3901234567/ | 635 | auto-ok | 3901234567/cgc-cards/0.95 |
| bgs-c21-phone | phone | bgs 0012345678 | confirm | 0012345678 | bgs | 2 | - | 815 | confirm-choose | 0012345678/bgs/0.79(L) 2023151/psa/0.3 |
| bgs-c22-phone | phone | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 745 | opened-ok | 0011873452/bgs/0.95 |
| bgs-c23-phone | phone | bgs 0009876543 | opened | 0009876543 | bgs | 0 | - | 835 | opened-ok | 0009876543/bgs/0.95 |
| psa-c02-thumb225 | thumb | psa 72910483 | auto-open | 72910483 | psa | 0 | psacard.com/cert/72910483 | 329 | auto-ok | 72910483/psa/0.9 |
| psa-c04-thumb300 | thumb | psa 00573921 | auto-open | 00573921 | psa | 0 | psacard.com/cert/00573921 | 384 | auto-ok | 00573921/psa/0.9 |
| psa-c06-thumb400 | thumb | psa 30561247 | auto-open | 30561247 | psa | 0 | psacard.com/cert/30561247 | 493 | auto-ok | 30561247/psa/0.9 |
| psa-c01-thumb500 | thumb | psa 04718263 | auto-open | 04718263 | psa | 0 | psacard.com/cert/04718263 | 669 | auto-ok | 04718263/psa/0.9 |
| cgcc-c10-thumb300 | thumb | cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | 0 | cgccomics.com/certlookup/4087123006/ | 440 | auto-ok | 4087123006/cgc-comics/0.95 |
| cgcc-c09-thumb400 | thumb | cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | 0 | cgccomics.com/certlookup/3984561002/ | 551 | auto-ok | 3984561002/cgc-comics/0.95 |
| cgcc-c13-thumb350 | thumb | cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | 0 | cgccomics.com/certlookup/4155667002/ | 185 | auto-ok | 4155667002/cgc-comics/0.95 |
| cgcd-c15-thumb300 | thumb | cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | 0 | cgccards.com/certlookup/1403987650123/ | 376 | auto-ok | 1403987650123/cgc-cards/0.9 |
| cgcd-c18-thumb450 | thumb | cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | 0 | cgccards.com/certlookup/1405551234567/ | 518 | auto-ok | 1405551234567/cgc-cards/0.9 |
| cgcd-c17-thumb250 | thumb | cgc-cards 2938475610 | confirm | 2938475610 | cgc-cards | 2 | - | 333 | confirm-choose | 2938475610/cgc-cards/0.7 2038475610/cgc-cards/0.63 |
| bgs-c22-thumb400 | thumb | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 517 | opened-ok | 0011873452/bgs/0.95 |
| bgs-c21-thumb300 | thumb | bgs 0012345678 | confirm | 0012345678 | bgs | 0 | - | 521 | confirm-ok | 0012345678/bgs/0.79(L) |
| psa-c08-thumb400 | thumb | psa 61834502 | auto-open | 61834502 | psa | 0 | psacard.com/cert/61834502 | 481 | auto-ok | 61834502/psa/1 |
| psa-c04-keystone | keystone | psa 00573921 | auto-open | 00573921 | psa | 0 | psacard.com/cert/00573921 | 599 | auto-ok | 00573921/psa/0.9 |
| cgcc-c10-keystone | keystone | cgc-comics 4087123006 | confirm | 4087123006 | cgc-comics | 0 | - | 511 | confirm-ok | 4087123006/cgc-comics/0.76 |
| cgcd-c15-keystone | keystone | cgc-cards 1403987650123 | auto-open | 1403987650123 | cgc-cards | 0 | cgccards.com/certlookup/1403987650123/ | 463 | auto-ok | 1403987650123/cgc-cards/0.9 |
| bgs-c23-keystone | keystone | bgs 0009876543 | opened | 0009876543 | bgs | 0 | - | 912 | opened-ok | 0009876543/bgs/0.95 |
| psa-c08-keystone | keystone | psa 61834502 | confirm | 61834502 | psa | 0 | - | 660 | confirm-ok | 61834502/psa/0.65 |
| psa-c06-reflect | reflect | psa 30561247 | auto-open | 30561247 | psa | 0 | psacard.com/cert/30561247 | 605 | auto-ok | 30561247/psa/0.9 |
| cgcc-c12-reflect | reflect | cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | 0 | cgccomics.com/certlookup/3765432011/ | 663 | auto-ok | 3765432011/cgc-comics/0.95 |
| cgcd-c18-reflect | reflect | cgc-cards 1405551234567 | auto-open | 1405551234567 | cgc-cards | 0 | cgccards.com/certlookup/1405551234567/ | 653 | auto-ok | 1405551234567/cgc-cards/0.9 |
| bgs-c21-reflect | reflect | bgs 0012345678 | confirm | 00123456 | psa | 0 | - | 562 | confirm-wrong | 00123456/psa/0.4 |
| cgcc-c13-reflect | reflect | cgc-comics 4155667002 | auto-open | 4155667002 | cgc-comics | 0 | cgccomics.com/certlookup/4155667002/ | 326 | auto-ok | 4155667002/cgc-comics/0.95 |
| psa-c02-crop-top | crop | psa 72910483 | auto-open | 72910483 | psa | 0 | psacard.com/cert/72910483 | 565 | auto-ok | 72910483/psa/0.9 |
| cgcc-c11-crop-left | crop | cgc-comics 4102938015 | auto-open | 4102938015 | cgc-comics | 0 | cgccomics.com/certlookup/4102938015/ | 435 | auto-ok | 4102938015/cgc-comics/0.95 |
| cgcd-c14-crop-edge | crop | cgc-cards 1402345678901 | auto-open | 1402345678901 | cgc-cards | 0 | cgccards.com/certlookup/1402345678901/ | 583 | auto-ok | 1402345678901/cgc-cards/0.9 |
| bgs-c22-crop-right | crop | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 512 | opened-ok | 0011873452/bgs/0.95 |
| psa-c05-crop-nonumber | crop | - - | none | - | - | 0 | - | 733 | none-ok | - |
| pair-psa-c01-psa-c03 | pair | 04718263/109876543 | confirm | 04718263 | psa | 2 | - | 967 | confirm-choose | 04718263/psa/0.8 109876543/psa/0.8 |
| pair-cgcc-c09-cgcd-c14 | pair | 3984561002/1402345678901 | confirm | 1402345678901 | cgc-cards | 2 | - | 838 | confirm-choose | 1402345678901/cgc-cards/0.8 3984561002/?/0.55 |
| pair-bgs-c22-psa-c06 | pair | 0011873452/30561247 | confirm | 30561247 | psa | 2 | - | 718 | confirm-choose | 30561247/psa/0.8 0011873452/?/0.55 |
| pair-psa-c02-cgcc-c10-thumb | pair | 72910483/4087123006 | confirm | 72910483 | psa | 2 | - | 859 | confirm-choose | 72910483/psa/0.8 4087123006/?/0.55 |
| psa-c03-moire | moire | psa 109876543 | auto-open | 109876543 | psa | 0 | psacard.com/cert/109876543 | 1045 | auto-ok | 109876543/psa/0.9 |
| cgcc-c09-moire | moire | cgc-comics 3984561002 | auto-open | 3984561002 | cgc-comics | 0 | cgccomics.com/certlookup/3984561002/ | 1061 | auto-ok | 3984561002/cgc-comics/0.95 |
| cgcd-c16-moire | moire | cgc-cards 3901234567 | auto-open | 3901234567 | cgc-cards | 0 | cgccards.com/certlookup/3901234567/ | 1239 | auto-ok | 3901234567/cgc-cards/0.95 |
| bgs-c21-moire | moire | bgs 0012345678 | confirm | 012345678 | psa | 0 | - | 3540 | confirm-wrong | 012345678/psa/0.55(L) |
| psa-c08-moire | moire | psa 61834502 | auto-open | 61834502 | psa | 0 | psacard.com/cert/61834502 | 627 | auto-ok | 61834502/psa/1 |
| psa-c05-bg-cloth | bg | psa 056734128 | auto-open | 056734128 | psa | 0 | psacard.com/cert/056734128 | 683 | auto-ok | 056734128/psa/0.9 |
| cgcc-c12-bg-red | bg | cgc-comics 3765432011 | auto-open | 3765432011 | cgc-comics | 0 | cgccomics.com/certlookup/3765432011/ | 735 | auto-ok | 3765432011/cgc-comics/0.95 |
| cgcd-c17-bg-wood | bg | cgc-cards 2938475610 | auto-open | 2938475610 | cgc-cards | 0 | cgccards.com/certlookup/2938475610/ | 617 | auto-ok | 2938475610/cgc-cards/0.95 |
| bgs-c23-bg-cloth | bg | bgs 0009876543 | opened | 0009876543 | bgs | 0 | - | 848 | opened-ok | 0009876543/bgs/0.95 |
| psa-c07-bg-gradient | bg | psa 5123478 | auto-open | 5123478 | psa | 0 | psacard.com/cert/5123478 | 557 | auto-ok | 5123478/psa/0.9 |
| neg-c19-bg-wood | bg | - 6012349870 | confirm | 6012349870 | cgc-comics | 0 | - | 923 | confirm-ok | 6012349870/?/0.45 |
| psa-c01-side90 | sideways | psa 04718263 | none | - | - | 0 | - | 1356 | none-miss | - |
| cgcc-c10-side270 | sideways | cgc-comics 4087123006 | auto-open | 4087123006 | cgc-comics | 0 | cgccomics.com/certlookup/4087123006/ | 1407 | auto-ok | 4087123006/cgc-comics/0.95 |
| cgcd-c15-side90-thumb | sideways | cgc-cards 1403987650123 | none | - | - | 0 | - | 847 | none-miss | - |
| bgs-c22-side270 | sideways | bgs 0011873452 | opened | 0011873452 | bgs | 0 | - | 1284 | opened-ok | 0011873452/bgs/0.95 |
| psa-c04-dark | dark | psa 00573921 | auto-open | 00573921 | psa | 0 | psacard.com/cert/00573921 | 1966 | auto-ok | 00573921/psa/0.9 |
| cgcd-c18-dark | dark | cgc-cards 1405551234567 | confirm | 1405551234567 | cgc-cards | 0 | - | 2289 | confirm-ok | 1405551234567/cgc-cards/0.78 |
| bgs-c21-dark | dark | bgs 0012345678 | confirm | 0012345678 | bgs | 0 | - | 3619 | confirm-ok | 0012345678/bgs/0.6(L) |
| neg-c20-phone | negative | - - | none | - | - | 0 | - | 777 | none-ok | - |
| neg-landscape-phone | negative | - - | none | - | - | 0 | - | 3182 | none-ok | - |
| neg-c19-thumb300 | negative | - 6012349870 | confirm | 6012349870 | cgc-comics | 0 | - | 605 | confirm-ok | 6012349870/?/0.45 |
| neg-receipt | negative | - - | confirm | 5012345678900 | cgc-cards | 2 | - | 826 | fp | 5012345678900/cgc-cards/0.4 8712345678901/cgc-cards/0.4 |
