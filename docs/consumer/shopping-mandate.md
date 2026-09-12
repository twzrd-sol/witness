# Shopping mandate and Done-gate (digital-product pilot)

2026-09-12. Schema plus a library Done predicate for the narrow x402 digital-product
pilot. No Shopify store URL is required. `SHOPIFY_STORE_URL` is env-gated and a
no-op until set. This increment does not add routes, does not pay, and does not
touch the human merchant-checkout rail.

Mandate field names follow the consumer implementation contract
(`implementation-contract.md`) and the wzrd-final / twzrd-x402-gate `Mandate`
shape (`purposes`, resource scope, expiry, subject, operator signature). The
launch copy lives here: Witness already owns the shopping Done-gate
(`docs/shopping-completion-gate.md`, `scripts/verify-shopping-receipt.mjs`).
wzrd-final is not imported.

## What a mandate is

A mandate says what **may** be spent. It is not a quote, not a receipt, and not
Done. Canonical encoding: [`schemas/shopping-mandate-v1.json`](schemas/shopping-mandate-v1.json).
Unsigned example: [`schemas/examples/digital-product-mandate.json`](schemas/examples/digital-product-mandate.json).

| Contract field | Pilot encoding | Notes |
| --- | --- | --- |
| schema / domain version | `schema: witness.shopping_mandate.v1` | Separate domain from observation receipts and delivery attestations |
| audience | `witness.shopping.digital_product` | x402 digital products only |
| issuer key ID | `issuer_kid` | Identifier, not a public key |
| subject | `subject` | Bound agent / buyer |
| mandate ID | `mandate_id` | Durable id for later reservation (ledger not in this increment) |
| offer ID | `offer_id` | Catalog id on the x402 rail |
| merchant / payee identity | `merchant`, `payee` | Payee is the catalog-vouched settlement address |
| product / variant | `product` | Digital product name, not a Shopify variant id |
| quantity | `quantity` | 1..99; this increment checks one quoted call against the ceiling |
| currency | `USDC` | Fiat/card is the human rail |
| cumulative maximum | `max_total_minor` | Integer atomic USDC |
| expiry | `expires_at` | UTC; checked at Done, not at signing |
| recurring policy | `recurring: never` | No subscriptions |
| license / terms digest | `license_url`, `terms_digest` | Optional; a URL alone is not a commitment |
| wzrd-final `resourceAllow` | `resource_url` | Optional https scope: exact path or child on the same origin |
| wzrd-final `agentPubkey` | `subject` | Compared when the bundle names a subject |
| operator signature | `signature` | Ed25519 over `witness.shopping_mandate.v1` + canonical body |

`additionalProperties: false`. `store_url`, `cart_url`, `checkout_url`,
`product_url`, and Shopify `variant_id` are rejected. The pin used to verify
`signature` is supplied independently; a key carried in the document is not a
trust anchor.

Library: `src/shopping-mandate.js` (`validateMandate`, `signMandate`,
`verifyMandate`, `resolveStoreUrl`, `evaluateDone`).

## Env-gated store URL

`SHOPIFY_STORE_URL` is operator env, not a mandate field. Resolution schema:
[`schemas/shopify-store-url-env-v1.json`](schemas/shopify-store-url-env-v1.json).

| Env | `resolveStoreUrl` | Done |
| --- | --- | --- |
| unset, empty, whitespace | `enabled: false`, `reason: store_url_unset` (no-op) | digital-product path unchanged |
| valid `https://` URL, no userinfo | `enabled: true`, `reason: store_url_configured` | reported on `evaluateDone.store`; not a predicate; never fetched |
| set but not a usable https URL | `ok: false`, `reason: store_url_invalid` | reported; still not a Done predicate |

`evaluateDone` reads `opts.env` or `process.env`. It reports `{ env, enabled, reason }`
and does not echo the URL. A configured store URL cannot complete a merchant
checkout quote. `.env.example` documents the variable as optional.

## Done predicate

`completion === "complete" && checkout_approved === true` only when **all** of
the following hold. Incomplete is the default. Actor narration, HTTP 200,
`success` flags, and `X-Checkout-Approved` cannot satisfy this predicate.

| Predicate | Evidence that satisfies it |
| --- | --- |
| `mandate_schema` | Body matches `shopping-mandate-v1.json` / `validateMandate` |
| `mandate_signature` | `verifyMandate` against the independently pinned issuer key |
| `mandate_fresh` | `now < expires_at` |
| `rail_x402` | Mandate and quote both name `rail: x402` |
| `human_checkout_untouched` | Quote is not `merchant_checkout` / `merchant_hosted` and has no `checkout_url` or `cart` |
| `mandate_binds_quote` | `offer_id`, `merchant`, `currency`/`asset`, `payee` (in `accepts[]`), optional `resource_url` / `network` / `asset` match the quote |
| `quote_passed` | Quote HTTP 200 and `gate.status === "passed"` |
| `amount_in_budget` | Quoted `amount_atomic` + `reserved_minor` ≤ `max_total_minor` |
| `receipt_check` | Mechanical check report: `approve: true`, `reason: receipt_supported`, child `verifier_pid` ≠ this process, `receipt_hash` and `key_hash` are 64-hex |

`receipt_check` is the same class of evidence as
`scripts/verify-shopping-receipt.mjs`: a structured accepting report, not a
success flag. This increment evaluates a supplied report; it does not spawn the
child or take live payment.

This is **not** a duplicate of `scripts/loop-check.mjs` (on-chain settlement +
delivery attest) and **not** a replacement of the shopping-preapproval
GATE_METHOD path. Three checkers, three claims.

## Human-checkout invariant

`src/offers.js` `merchant_checkout` (Pixel Surplus / Shopify cart permalink)
stays the human handoff rail. Mandate/Done evaluation must not:

- require a store URL to encode authority
- rewrite `handleOfferQuote` for merchant offers
- treat a merchant `checkout_url` as Done
- call Shopify, Catalog, or UCP

A bundle whose quote is a merchant cart is `incomplete` with
`human_checkout_untouched` (and usually `rail_x402`) failed.

## What this increment does not do

- No `POST /authorize-purchase` route, no SQLite reservation ledger.
- No live Shopify, no required store URL, no card rail.
- No settlement checker. A signed mandate plus a quote is not payment.
- A report from `evaluateDone` is not a signed authorization token for another service.

## Offline verification

```sh
node --test test/shopping-mandate.test.js
npm test
git diff --check
```

Tests use ephemeral Ed25519 keys, the in-repo example, and local quote fixtures.
`fetch` is not consulted. No reader, 402, or Shopify host is contacted.
