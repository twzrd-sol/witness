# Post-settlement delivery proof (receipt spec, as shipped)

Status: implemented as `POST /delivery/attest` (#30, #31, #32), paid over x402
at the /witness price. 2026-09-11.

This document was written before the route existed. The route is the contract;
this page keeps the problem statement and the trust-boundary rules, and maps
the spec's original field names onto what actually ships so nobody codes
against the draft. Where the shipped behaviour differs from the draft, the
shipped behaviour is stated and the draft is not.

## Problem (verified)

Settlement proves money moved; it proves nothing was delivered. Every
reputation input in the current stack inherits this gap:

- TWZRD preflight corpus: `x402 settlements on Base indexed from
  high-confidence EIP-3009 USDC transfers` — payment ground truth only.
- CDP activity counters (merged `1b94bf49`): answer "did anyone call this
  endpoint," not "did the call return the thing." Deliberately guarded out
  of allow/warn/block for exactly this reason.
- Catalog probe (14,212 rows, 2026-09-10): $43,446/mo observed flow, 86.9%
  of diverse flow through two >$10 endpoints — including $1,000 × 32 calls
  across 7 payers to a counterparty with no delivery proof and no dispute
  path. Post-payment primitives (escrow, dispute, delivery attestation,
  order state, SLA) are near-absent from the catalog.

A wallet with a thousand clean settlements could have delivered nothing a
thousand times and score identically. The attest route closes that half of
the loop.

## Precedent (live)

PR #23 gates the checkout handoff on a *pre-spend* Witness observation:
product record must verify `supported` or the URL is withheld (409). The
attest route is the post-spend mirror: after payment clears, the buyer (or
the seller, or Witness itself) submits what came back, and Witness grades it
against the offer spec and signs the outcome. Same key, same verifier, same
fail-closed verdict vocabulary.

## What ships: `POST /delivery/attest`

Request: `{offer, request, observation}` — the three things the receipt binds.
The full shape, every refusal reason, and a copyable example are in
`GET /openapi.json`; the reference integrations are
`examples/delivery-seller.mjs` (sign at emit time) and
`examples/delivery-buyer.mjs` (obtain and verify).

Order on the route: parse, shape check, per-IP limiter, x402 paywall, model.
A request the route cannot read is a 400 before it sees a 402 or spends a
limiter slot. A well-formed unpaid request gets the 402 challenge ($0.01
USDC, Base or Solana, the /witness price). Over budget is 429
`attest_rate_limited`. Nothing is graded or signed on any of those.

Receipt (bare, signed, exactly as `/witness` returns its own):

```json
{
  "schema": "delivery-attestation/v0",
  "offer_hash": "<sha256 of the canonical offer>",
  "request_hash": "<sha256 of {request_body, settlement_ref, requested_at}>",
  "artifact_hash": "<sha256 of the observed artifact; null when nothing came back>",
  "delivery_verdict": "delivered | contradicted | incomplete | unable_to_verify",
  "reasons": ["<fixed vocabulary; empty when delivered>"],
  "evidence_mode": "buyer_attested | seller_integrated | verifier_observed",
  "declared_mode": "<what the caller claimed; evidence_mode is what was established>",
  "spec_origin": "buyer_authored | seller_published | ...",
  "seller_verification": "<what was CHECKED when a seller signature was carried, or null>",
  "observed_at": "<iso8601, the caller's clock>",
  "requested_at": "<iso8601>",
  "settlement_ref": "<settlement identifier when known, else null>",
  "verifier": "<this host>",
  "this_receipt_proves": ["<the limits of the evidence mode, verbatim>"],
  "this_receipt_does_not_prove": ["<what no delivery receipt establishes>"],
  "attested_at": "<iso8601, the signing clock>",
  "receipt": "<ed25519 over deep-canonical JSON of every other field>"
}
```

Verification is offline against `GET /pubkey`, exactly like observation
receipts: drop `receipt`, deep-canonical JSON, ed25519.

### Draft name → shipped name

| Draft (this page, first revision) | Shipped |
| --- | --- |
| `payment_reference` | `request.settlement_ref`, hashed into `request_hash`, echoed on the receipt; may be null |
| `artifact_kind` | `offer.deliverable_class` (free string, e.g. `data_json`) |
| `verdict` | `delivery_verdict` |
| `verdict_reason` (single) | `reasons[]` (fixed vocabulary, possibly several) |
| `vantage` | `verifier` |
| — | `evidence_mode` / `declared_mode`: the draft had no notion of who presented the artifact; the route has three modes and downgrades a claim it cannot verify |
| — | `spec_origin`: who wrote the spec the verdict is graded against; `seller_published` is what a seller-signed offer earns |
| — | `this_receipt_proves` / `this_receipt_does_not_prove`: the limits travel inside the signature |

## Trust-boundary rules (load-bearing)

1. Delivery receipts are **verified outcomes** and are admissible to trust
   decisions — this is precisely what distinguishes them from raw activity
   quality, which stays out of allow/warn/block per the `1b94bf49` guard.
   The boundary is *verified vs unobserved*, not *payment vs non-payment*.
2. A delivery receipt never proves more than its hashes and its evidence
   mode: it says the artifact matched the spec at observation time, as
   presented by whoever presented it, not that the merchant is honest in
   general. Read `evidence_mode` and `this_receipt_proves` before acting.
3. `unable_to_verify` (nothing came back, artifact observed outside the
   freshness window, unparseable timestamps) withholds, never penalizes.
   Physical goods and credentialed delivery are unobservable and stay out.
4. **Shipped behaviour differs from the draft here.** The draft said a missing
   payment reference makes the receipt `unable_to_verify`. The route accepts
   `settlement_ref: null`, hashes it as null into `request_hash`, records it
   on the receipt, and grades the artifact anyway. A receipt with no
   settlement reference therefore binds *what was promised* and *what
   arrived* but not *what was paid*; consumers that require all three must
   check `settlement_ref` themselves. This is a consumer-side policy, not
   something the route enforces.
5. Declaring the strong mode does not grant it. `seller_integrated` is only
   issued when the seller's signature verifies against the payee the buyer
   actually paid; otherwise the receipt is downgraded to `buyer_attested`
   and `seller_verification` says why.

## Pressure tests (answered in advance)

- *Non-delivery base rate.* Endpoint liveness (~2% broken) is a floor, not
  a rate — non-delivery is unobservable without dispute rails. The case
  rests on insurance logic (one stiffed $1,000 payment dwarfs years of
  $0.01 receipts), not measured fraud.
- *Seller opt-in.* Demand-side: mandates and the gate weight or require
  delivery-proof history; sellers opt in to reach gated demand. No seller
  altruism required. The x402 catalog rows now carry a `delivery` spec
  (`deliverable_class`, `spec`, `spec_origin`) so a buyer has a contract to
  grade against without inventing one.

## Non-goals

- Escrow, dispute resolution, or refunds. Proof only; enforcement is a
  separate rail.
- Physical goods or credentialed delivery (unobservable → `unable_to_verify`).
- Any change to settlement, preflight, or the activity-counter guard.
- Recording the fee paid for the attestation inside the receipt. The receipt
  binds the call it grades, not the fee paid to grade it.

## Open questions

1. Payment-reference canonical form across Base/Solana and facilitators.
   `settlement_ref` is a free string today; the route does not resolve it
   on-chain.
2. `verifier_observed` in practice: who pays for the call Witness makes
   itself, and how that receipt is priced.
3. Corpus ingestion path: how delivery receipts join the trust join
   without reintroducing raw-quality leakage (see rule 1).
