# Price sources for the public release (research, 2026-10-19)

Question: which APIs can give CertScanner the value of a graded card in its grade, and how should a public Chrome Web Store version get prices compared with today? Three research passes (other providers; eBay and PriceCharting; Store publishing) on 2026-10-19. The researchers could not open most pages directly (DNS blocked) and worked from search extracts of the providers' own pages; the Chrome Web Store API was read directly. Re-read the terms before signing up. Not legal advice.

## Today

| Source | How | Fit for a public release |
|---|---|---|
| PriceCharting | Search and product **HTML** fetched with the user's cookies; on a Cloudflare check an inactive tab is opened and read (`tabReader.js`, setting `readViaTab`) | **High risk.** ToS: "apps and other software cannot share the price data without express written permission"; API data is "internal use only" |
| eBay sold + Buy It Now | Public search **HTML** read the same way, including the "Pardon Our Interruption" tab | **High risk.** User Agreement bans robots, scrapers and data-gathering tools without permission; requests run in the user's logged-in session |
| PokemonPriceTracker | Official API, the user's own key (BYOK) | OK (personal use per user) |
| PSA public API | Cert data and population, the user's own key | OK; cert data only, no prices |
| Link-outs (eBay sold search, PriceCharting, population reports) | Opens a tab on a click | Low risk |

Chrome Web Store policy also forbids facilitating "unauthorized access to content on websites, such as circumventing ... restrictions", and since 2026-08-01 every data flow must be disclosed and strictly necessary. Conclusion: the HTML reading and the background-tab check must not ship in the public version.

## Providers

Keys: a developer key can't be shipped inside an extension (Chrome's own guidance: let users bring a key or proxy through your server). So each source is either **BYOK** or **behind a small server**.

| Provider | Graded data | Access and price (as published) | Public use | Fit |
|---|---|---|---|---|
| **PokemonPriceTracker** (in use) | eBay sales per grade: PSA, CGC, BGS, SGC (free plan: PSA only). Pokémon EN/JP | Free 100 credits/day; API $9.99/mo; Business $99/mo | Personal/non-commercial on every plan; commercial use needs Business. Non-revenue hobby tools mentioned as allowed (confirm) | Pokémon, high |
| **PokeTrace** | eBay sales per grade: PSA, BGS, CGC, SGC, ACE, TAG; TCGplayer/Cardmarket raw | Free 250/day (raw only); Pro $19.99/mo incl. graded; Scale $99/mo | Pro and Scale advertise a commercial licence; redistribution terms to confirm | Pokémon, high |
| **CardHedger** | Sports + TCG comps since 2020 (PSA, BGS, SGC, CGC, HGA); **price by cert number** (`fmv-by-cert`, batch of 100) | From $49/mo, 7-day trial | Keys server-side; reproduction needs permission | Sports, high |
| Scrydex | Graded low/market/high per grade, several TCGs, population | Growth $99/mo for graded | No redistribution without permission; keys server-side | Medium |
| TCG Price Lookup | Graded averages from eBay, 8 games | Pro $49.99/mo (commercial) | | Medium |
| JustTCG, TCGdex, Scryfall | Raw prices only (TCGdex: free, no key) | | | Raw fallback |
| **PriceCharting API** (and SportsCardsPro) | Current values only (no sales history). Card fields: `manual-only-price` = PSA 10, `bgs-10-price`, `condition-17-price` = CGC 10, `condition-18-price` = SGC 10; grades 7-9.5 not split by grader | Legendary $49/mo; 1 call/s | "Internal use only"; sharing in an app needs a commercial licence and written permission | Only with a licence |
| **eBay Browse API** | **Active listings only**: graded condition 2750, descriptors grader 27501 / grade 27502 / cert 27503 | Free; 5,000 calls/day, more after a Growth Check | Client secret must stay on a server; listing data at most 6 h old | "For sale from" |
| eBay Marketplace Insights | Sold items, 90 days | Limited release, closed to new developers | | Not available |
| PSA public API (in use) | Cert lookup (name, grade, population); no prices | Free, 100 calls/day per user | | Cert data |
| GemRate | Cert lookup + combined population for PSA/BGS/SGC/CGC cards; no prices | Partner API, price unpublished | | Population |

No usable API: TCGplayer (closed to new developers), Cardmarket (not accepting applications), pokemontcg.io (deprecated, keys stop 2027-03-01), Card Ladder, Market Movers, Alt, Collectr, 130point, GoCollect, CovrPrice, CGC, Beckett, SGC, TAG. Most graded "sold" data in the paid APIs is itself aggregated from eBay sales; a second such source is a backup, not an independent comp.

## Options

| | A. Only the user's own keys | B. Small CertScanner price server |
|---|---|---|
| What runs where | Extension calls PokemonPriceTracker / PSA with the user's key; everything else is a link-out | A Cloudflare Worker holds the keys, caches per card + grade (24 h comps, ≤ 6 h eBay listings), rate-limits per anonymous install id + IP |
| Value for a new user | None until they create a key (free PokemonPriceTracker key: PSA grades only) | Right after the scan, for everyone |
| Cost to the owner | $0 | Worker ~$5/mo + data: PokeTrace Pro $19.99 or PokemonPriceTracker Business $99; CardHedger ≥ $49 for sports |
| Privacy | No server (as today) | Server sees card name, number, grader, grade and IP; no photos, no cert numbers; must be disclosed |
| Store review | Low risk | Low risk; the extension needs no extra permission (the server answers with CORS) |

## Recommendation

1. **Remove from the public build:** PriceCharting and eBay HTML reading, `tabReader.js`, the `readViaTab` setting, the install-time `pricecharting.com` host permission.
2. **Keep:** PSA and PokemonPriceTracker with the user's own key (power users), all link-outs (eBay sold search in the grade, PriceCharting, population reports).
3. **Add a small price server (option B), Pokémon first:** graded sold values from PokeTrace Pro or PokemonPriceTracker (after the provider confirms the use in writing), "for sale from" from the eBay Browse API. The panel keeps the same Value / eBay layout; "last sold" and "median" come from the comps source, "for sale from" from eBay.
4. **Later:** sports through CardHedger (also price by cert number); comics through a PriceCharting commercial licence or link-outs only; population through GemRate.
5. **Money:** if the extension should cover its costs, eBay Partner Network links need EPN's written approval for a downloadable tool, and disclosure in the listing and the UI.

Open questions for the providers (email before building): PokemonPriceTracker and PokeTrace (may a free public extension show values from one paid plan to all users; display and caching rules), CardHedger (prices, cert-lookup allowance), PriceCharting (commercial licence price), eBay (Browse API production access for this use; Growth Check), PSA (current daily quota).

## Sources

PokemonPriceTracker: pokemonpricetracker.com/terms, /api-reference, /graded-pokemon-card-api, /faq · PokeTrace: poketrace.com/docs, /pricing, /faq · CardHedger: api.cardhedger.com/docs, ai.cardhedger.com/terms · Scrydex: scrydex.com/pricing, /terms · TCG Price Lookup: tcgpricelookup.com/pricing · JustTCG: justtcg.com/docs · TCGdex: tcgdex.dev/markets-prices · pokemontcg.io: dev.pokemontcg.io · TCGplayer: developer.tcgplayer.com · Cardmarket: help.cardmarket.com/en/cardmarket-api · PSA: psacard.com/publicapi/documentation · GemRate: docs.gemrate.com · PriceCharting: pricecharting.com/api-documentation, /page/terms-of-service, /pricecharting-pro; sportscardspro.com/api-documentation · eBay: developer.ebay.com/docs/api-deprecation (Finding API off 2025-02-05), /api-docs/buy/browse/overview.html, /api-docs/user-guides/static/mip-user-guide/mip-enum-condition-descriptor-ids-for-trading-cards.html, /api-docs/static/oauth-client-credentials-grant.html, /develop/get-started/api-call-limits, /join/api-license-agreement; Marketplace Insights: edp.ebay.com/api-docs/buy/marketplace-insights/static/overview.html; User Agreement: ebay.com/help/policies/member-behaviour-policies/user-agreement?id=4259; EPN: partnernetwork.ebay.com/page/software-applications-and-downloadable-tools · Chrome: developer.chrome.com/docs/extensions/ai (keys), /docs/webstore/program-policies/malicious-and-prohibited, /blog/cws-policy-updates-2026, /docs/webstore/program-policies/affiliate-ads · Cloudflare: developers.cloudflare.com/kv/platform/pricing, /workers/runtime-apis/bindings/rate-limit/, /workers/runtime-apis/cache/
