# Offline buyer checklist + fixture storefront stub

2026-09-12. Wave9 FF. A local fixture storefront and a pre-spend buyer
checklist for the narrow x402 digital-product pilot. Fully offline. No live
store, no Catalog, no UCP, no reader probe, no 402 settle, no wallet.

This increment does not add routes to the live Witness host. It does not
rewrite `src/offers.js`. It does not replace the mandate Done-gate
(`src/shopping-mandate.js` `evaluateDone`).

## Fixture storefront stub

Library: `src/fixture-storefront.js`. Frozen catalog:
[`../../fixtures/storefront/catalog.json`](../../fixtures/storefront/catalog.json).
Schema: [`schemas/fixture-storefront-v1.json`](schemas/fixture-storefront-v1.json).

| Surface | Behaviour |
| --- | --- |
| `kind` | `witness.fixture_storefront.v1` |
| `live_shopify` | `false` (const) |
| `origin` | `local` |
| `listProducts` / `getProduct` | In-process catalog read |
| `quoteProduct` | 200 quote from catalog bytes; `source: fixture_catalog`, `probed: false` |
| HTTP stub | Loopback only (`127.0.0.1` / `::1`). `0.0.0.0` throws before listen |
| HTML | Banner: fixture, local only, no payment |

The committed catalog has two digital SKUs:

- `outbid-reader-scrape` — same offer the mandate example binds (`schemas/examples/digital-product-mandate.json`).
- `fixture-digital-note` — in-repo note at `https://fixture.witness.test/note` (`.test` host, never resolved).

`additionalProperties: false` on the schema. `store_url`, `cart_url`,
`checkout_url`, `variant_id`, and `cart_base` are rejected. A catalog string
that names a `*.my`+`shopify` host or a `shop`+`ify.com` host fails
`inspectCatalog`.

Optional local listen (not the live host):

```sh
HOST=127.0.0.1 PORT=4173 node scripts/fixture-storefront.mjs
```

`GET /`, `GET /health`, `GET /api/products`, `GET /api/products/:id`,
`POST /api/quotes`. A non-loopback `Host` header is `400 fixture_host_not_local`.
There is no pay route.

## Buyer checklist

Library: `src/offline-buyer-checklist.js` (`evaluateBuyerChecklist`).
Twelve steps; failed-closed is the default. Actor narration, HTTP 200, and
`success` flags cannot pass a step.

| Step | Evidence that satisfies it |
| --- | --- |
| `storefront_is_fixture` | Catalog (and optional `storefront` object) name `kind`, `live_shopify: false`, `origin: local` |
| `catalog_digital_only` | Every product is `rail: x402` and `checkout: x402` |
| `no_shopify_fields` | `inspectCatalog` accepts the catalog |
| `mandate_schema` | `validateMandate` on `shopping-mandate-v1` |
| `mandate_signature` | `verifyMandate` against the independently pinned issuer key |
| `mandate_fresh` | `now < expires_at` |
| `product_in_catalog` | `mandate.offer_id` exists in the fixture catalog |
| `quote_from_fixture` | Quote wrap HTTP 200; `source: fixture_catalog`; `probed: false`; `gate.reason: fixture_catalog`; no `checkout_url` / `cart` |
| `mandate_binds_quote` | Existing `bindMandateToQuote` |
| `amount_in_budget` | Quoted atomic + `reserved_minor` ≤ `max_total_minor` |
| `human_checkout_untouched` | Quote is not `merchant_checkout` / `merchant_hosted` and has no `checkout_url` or `cart` |
| `no_spend` | No `payment_attempted`, `paid`, `wallet`, or `keypair`; `payment_status` absent or `not_attempted` |

A passing report is:

```json
{
  "ready": true,
  "checklist": "passed",
  "failed": [],
  "completion": "incomplete",
  "checkout_approved": false,
  "payment_attempted": false,
  "check": { "approve": false, "reason": "checklist_passed_not_done" }
}
```

`ready: true` means the buyer may consider a later paid increment. It is not
`evaluateDone` complete. `checkout_approved` stays false. `check.approve` stays
false. A fixture quote plus a child `receipt_check` can still satisfy
`evaluateDone` — that is a different checker.

## Human-checkout invariant

`src/offers.js` `merchant_checkout` (Pixel Surplus cart permalink) stays the
human handoff rail. This increment must not:

- require a store URL to encode authority
- rewrite `handleOfferQuote`
- treat a merchant `checkout_url` as checklist-ready
- call a remote storefront, Catalog, or UCP
- mount the fixture on the live Witness listener

A bundle whose quote is a merchant cart fails `quote_from_fixture` and
`human_checkout_untouched`.

## What this increment does not do

- No `POST /authorize-purchase`, no reservation ledger, no live host routes.
- No live store, no card rail, no wallet load.
- No settlement checker. A passed checklist is not payment.
- A checklist report is not a signed authorization token for another service.

## Offline verification

```sh
node --test test/offline-buyer-checklist.test.js
npm test
git diff --check
```

Tests use ephemeral Ed25519 keys, the in-repo mandate example, and the fixture
catalog. Library paths mock `fetch` to throw. The HTTP stub is bound to
`127.0.0.1` only. No reader, 402, or remote storefront host is contacted.
