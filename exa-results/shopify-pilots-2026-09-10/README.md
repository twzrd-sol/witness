# 15 ecommerce candidates for a TWZRD consumer pilot

Checked 2026-09-10. Start with **Pixel Surplus's Vintage Polaroid Photo Frames**: the live Catalog returned a $6 USD, non-shipping, non-subscription variant and a checkout permalink. A coding/design agent could use its PNG frames in a finished raster composition. **True Grit's $12 Grunge And Grime pack** is the second Shopify candidate. For a stronger developer workflow at a higher price, evaluate **Untitled UI** or **Streamline**, where purchased assets have documented programmatic delivery paths.

These are candidates, not partners or proven autonomous conversions. **Six passed UCP discovery and Catalog checkout-link checks. Zero were tested through payment or order confirmation.** No merchant was contacted and no checkout session was created.

Prices below are observed product prices, not final payable quotes. Rank favors visible task output, usable file formats, low cost, explicit license selection and verified discovery. It does not measure merchant trust or willingness to partner.

| Priority | Merchant / product landing | Observed price / selection | Verified access | Useful pilot task and remaining constraint |
| --- | --- | --- | --- | --- |
| 1 | [Pixel Surplus — Vintage Polaroid Photo Frames](https://pixelsurplus.com/products/vintage-polaroid-photo-frames) | $6 desktop commercial; $12 extended | **UCP + Catalog checkout URL** | Compose a finished photo collage with 22 PNG frames. Desktop license permits rasterized web artwork but restricts application embedding; select the correct use/license. |
| 2 | [True Grit — Grunge And Grime](https://www.truegrittexturesupply.com/products/grunge-and-grime) | $12 Adobe variant | **UCP + Catalog checkout URL** | Apply purchased texture to a finished poster; choose Adobe TIFF or an appropriate PNG variant. Per-user license and app compatibility matter; AI training is prohibited. |
| 3 | [Craftwork — Interfaces](https://craftwork.design/product/interfaces-illustrations) | From $18; choose license | Product landing | Build a page with purchased illustrations. Verify format, commercial license, account delivery and checkout access before purchase. |
| 4 | [Untitled UI — Icons](https://www.untitledui.com/icons) | PRO license; refresh selected tier | Product + license + npm documentation | Buy then use icons in a real app. Paid private npm access is a useful fulfillment path; higher pilot budget and account setup required. |
| 5 | [Streamline — lifetime assets](https://www.streamlinehq.com/lifetime) | Select family and seats | Purchase page documents ZIP, API and MCP access | Buy a specific set and retrieve an icon via MCP/API. One-time license available; native asset retrieval does not establish native payment access. |
| 6 | [RetroSupply — Ink Bleed for Photoshop](https://www.retrosupply.co/products/ink-bleed-for-photoshop) | Live Catalog $19 | **UCP + Catalog checkout URL** | Produce a comic-style image. Needs Photoshop automation; cached page extraction showed $16/unavailable, while live JSON and Catalog agreed on $19/available. Refresh before checkout. |
| 7 | [Heritage Type — Rough & Raw](https://www.heritagetype.com/products/rough-raw-brushes) | $14, one user | **UCP + Catalog checkout URL** | Lettering artwork with 14 brushes. Procreate dependency makes it weaker for headless coding agents. Email download documented. |
| 8 | [UI8 — 721 Flat Icons Bundle](https://ui8.net/flat-icons/products/731-flat-icons) | Refresh product/license price | Product landing | Build an interface using purchased icons. Verify account requirements and actual usable download formats. No checkout API tested. |
| 9 | [FilterGrade — 25 Handmade Print Textures](https://filtergrade.com/product/25-handmade-print-textures/) | Personal / Commercial / Extended selector | Indexed product page; direct fetch 403 | Add texture to a visible output. ZIP/JPG delivery documented; browser challenge and license selection require testing. |
| 10 | [Creative Market / IconsDrop — 120 icons](https://creativemarket.com/IconsDrop/283181557-120-Modern-E-commerce-Shopping-Icons) | Indexed listing $25; refresh commercial tier | Indexed product page; direct fetch 403 | Purchase SVG icons for an ecommerce UI. Price may depend on license; authentication and browser challenges make it a secondary pilot. |
| 11 | [ShoutBAM — Fade & Shade Photoshop](https://www.shoutbam.com/product/fade-shade-brush-set-photoshop) | Tools page lists $16; refresh selected product | Product landing | Create shaded artwork using Photoshop brushes. Requires application control and license review. Shares a supplier with Heritage Type's selected product; not independent supplier coverage. |
| 12 | [Creative Tim — Paper Kit 2 PRO](https://www.creative-tim.com/product/paper-kit-2-pro) | Select license and current price | Product + license page | Buy a kit and build a page. Check Bootstrap compatibility and SaaS permission: lower license tiers do not cover SaaS. Higher ticket size and overlapping free alternatives. |
| 13 | [Ugmonk — small Analog card sleeves](https://ugmonk.com/products/small-analog-card-sleeves-set-of-6-bright) | $12 for six | **UCP + Catalog checkout URL** | Buy supplies for an operator's planning system. Shipping/address/tax needed; fulfillment is not instant or agent-usable. Physical checkout control cohort. |
| 14 | [Craighill — Wilson Keyring](https://craighill.co/products/wilson-keyring) | $15 brass variant | **UCP + Catalog checkout URL** | Simple one-variant physical purchase. Requires destination and delivery tracking; weaker task-completion proof than a digital asset. |
| 15 | [Field Notes — Original Kraft](https://fieldnotesbrand.com/products/original-kraft) | Homepage lists $12.95 | Product/storefront; UCP path 404 | Buy notebooks for an operator. Human checkout comparison only until an actual API integration is identified. |

## Actual Catalog-returned checkout links

The links below were returned by `get_product`, not guessed from storefront HTML. They were not followed; opening a cart permalink may initialize checkout. All six selected variants reported available, with `selling_plan:false`. The first four reported `shipping:false`; Ugmonk and Craighill reported `shipping:true`.

| Store | Catalog checkout URL | Variant ID |
| --- | --- | --- |
| Pixel Surplus | [Desktop commercial frames](https://pixel-surplus.myshopify.com/cart/46117070209071:1) | `46117070209071` |
| True Grit | [Adobe Grunge And Grime](https://radpatches.myshopify.com/cart/39843061629114:1) | `39843061629114` |
| RetroSupply | [Photoshop Ink Bleed](https://retrosupply-co.myshopify.com/cart/43965923098711:1) | `43965923098711` |
| Heritage Type | [One-user Rough & Raw](https://htc-gmbh.myshopify.com/cart/40267251220658:1) | `40267251220658` |
| Ugmonk | [Six bright sleeves](https://ugmonk-2.myshopify.com/cart/46529508901014:1) | `46529508901014` |
| Craighill | [Brass Wilson Keyring](https://craighill.myshopify.com/cart/43465932439789:1) | `43465932439789` |

## Evidence and limits

[`readiness.json`](readiness.json) records timestamps, discovery URLs, actual merchant MCP endpoints, advertised capabilities, Catalog IDs, currency, availability, checkout links and hashes of Catalog responses. These are unsigned research observations, not paid Witness receipts.

The read-only sequence was `GET /.well-known/ucp`, `GET products.json` / a selected product's `.js`, `tools/list`, then `tools/call get_product`. Calls used [Shopify's documented sample agent profile](https://shopify.dev/docs/agents/catalog/storefront-catalog), not a registered TWZRD identity. Discovery advertised `2026-08-25`; the sample-profile calls negotiated `2026-04-08`. A production integration needs its own supported profile and access validation.

[Shopify's Checkout MCP docs](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp) distinguish general-access handoff from direct completion. A working `checkout_url` demonstrates the former; it does not establish the latter. No merchant authorization, final tax calculation, checkout completion, delivery access or webhook integration was tested.

Exa was used for 100 requested search results across product discovery and protocol/license verification, followed by selected page fetches and direct read-only checks. Results were deduplicated by storefront. This is not a claim of 100 independently validated stores. Unverified API access remains explicitly unverified.

Dropped: Poketo's old domain redirects to Pattern Brands instead of returning UCP/product JSON; a fetched BLKMARKET page mixed design assets with unrelated gambling copy; Texturelabs' proposed store URL could not be fetched. None was promoted into a working integration claim.

## First experiment

Use the same Pixel Surplus offer for (a) direct merchant cart link, (b) consumer offer page to the same cart link, and (c) agent task to fresh quote/mandate evaluation and supported checkout. Start with one operator whose task actually needs a photo composition and whose chosen license covers it. $10 is an illustrative all-in mandate ceiling, not authorization to spend the user's funds in this research.

The task template should request a finished composition, correct license, no subscription, and a fresh total including tax/fees. It must not include a mandate signature, credentials, checkout session link, or purchased files. Recipient supplies fresh authority. Optional sharing comes after delivery, once redistribution rights for the finished output are clear.

To measure paid-and-confirmed external outcomes, obtain merchant reporting/API/webhook access or buyer-consented order evidence. UTM tags alone cannot authenticate an order or distinguish a staged test from external demand. Do not count probes, fixture refusals, or normal checkout handoffs as purchases.

License references: [Pixel Surplus](https://pixelsurplus.com/pages/licensing), [True Grit current terms](https://www.truegrittexturesupply.com/pages/terms-and-conditions), [RetroSupply](https://www.retrosupply.co/pages/retrosupply-license), [Heritage Type](https://www.heritagetype.com/pages/licensing), [Untitled UI](https://www.untitledui.com/license), [UI8](https://ui8.net/terms), [Creative Tim](https://www.creative-tim.com/license). The linked True Grit v2 license applies to purchases on or before August 28, 2020 and should not govern a new pilot purchase.
