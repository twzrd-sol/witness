# Post-settlement delivery proof (receipt shape spec)

Status: spec, unimplemented. 2026-09-11.

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
thousand times and score identically. This spec closes that half of the loop.

## Precedent (already live)

PR #23 gates the checkout handoff on a *pre-spend* Witness observation:
product record must verify `supported` or the URL is withheld (409). This
spec is the post-spend mirror: after payment clears, Witness observes the
delivered artifact against the offer spec and signs the outcome. Same
key, same verifier, same fail-closed verdict vocabulary — second-signature
shaped, like the twice-pay pattern.

## Receipt shape

```json
{
  "offer_hash": "<sha256 of the canonical offer record>",
  "payment_reference": "<settlement identifier: tx signature / receipt id>",
  "artifact_hash": "<sha256 of the observed delivered artifact>",
  "artifact_kind": "data_feed | compute_output | credential | file | other",
  "observed_at": "<iso8601>",
  "verdict": "delivered | contradicted | incomplete | unable_to_verify",
  "verdict_reason": "<fixed vocabulary, null when delivered>",
  "vantage": "<observer id>",
  "receipt": "<ed25519 over deep-canonical JSON, existing key>"
}
```

- `offer_hash` binds *what was promised*; `artifact_hash` binds *what
  arrived*; `payment_reference` binds *what was paid*. All three or the
  receipt is meaningless.
- Verdict vocabulary mirrors the observation contract. `delivered` means
  the artifact satisfies the offer spec; anything else withholds trust,
  never asserts fraud.
- Verification is offline against the published key, exactly like
  observation receipts. A buyer, a merchant, or a network can check after
  the fact what was delivered when the decision was made.

## Trust-boundary rules (load-bearing)

1. Delivery receipts are **verified outcomes** and are admissible to trust
   decisions — this is precisely what distinguishes them from raw activity
   quality, which stays out of allow/warn/block per the `1b94bf49` guard.
   The boundary is *verified vs unobserved*, not *payment vs non-payment*.
2. A delivery receipt never proves more than its three hashes: it says the
   artifact matched the spec at observation time, not that the merchant is
   honest in general.
3. `unable_to_verify` (artifact unobservable: physical goods, gated
   delivery, credentialed download) withholds, never penalizes. Start with
   natively observable artifacts only.
4. No receipt is minted without all three bindings. A missing payment
   reference is `unable_to_verify`, not a loophole.

## Pressure tests (answered in advance)

- *Non-delivery base rate.* Endpoint liveness (~2% broken) is a floor, not
  a rate — non-delivery is unobservable without dispute rails. The case
  rests on insurance logic (one stiffed $1,000 payment dwarfs years of
  $0.05 checks), not measured fraud.
- *Seller opt-in.* Demand-side: mandates and the gate weight or require
  delivery-proof history; sellers opt in to reach gated demand. No seller
  altruism required.

## Non-goals

- Escrow, dispute resolution, or refunds. Proof only; enforcement is a
  separate rail.
- Physical goods or credentialed delivery (unobservable → `unable_to_verify`).
- Any change to settlement, preflight, or the activity-counter guard.

## Open questions

1. Payment-reference canonical form across Base/Solana and facilitators.
2. Artifact observation protocol per `artifact_kind` (who fetches, what
   bytes hash).
3. Corpus ingestion path: how delivery receipts join the trust join
   without reintroducing raw-quality leakage (see constraint above).
