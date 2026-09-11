# Done predicate for the agent-rail loop

2026-09-11. The first mechanical Done predicate on a live paid path. It exists
because an agent's recap is not evidence: done is granted by a checker that did
not do the work, or it is not granted.

## Actor and verifier are different programs

- `scripts/loop-run.mjs` is the actor. It runs the gate, pays one x402 call,
  and posts the result to `POST /delivery/attest`. It writes raw files and
  prints the directory it wrote. It never prints a verdict.
- `scripts/loop-check.mjs` is the verifier. It reads that directory, recomputes
  every hash from the raw files, fetches the trusted pubkey itself, reads the
  settlement from the chain, and compares the offer against the live catalog.
  It prints `DONE` or `INCOMPLETE (which predicates failed)` and exits 0 or 1.

They share no code path. The verifier imports Witness's library verify functions
(`verifyDelivery`, `checkSpec`, the hash functions), which is the point: the
library is the designated checker, and a receipt the route issues must satisfy
the library's own verifier, not a reimplementation.

## The eleven predicates

| Predicate | Evidence that satisfies it |
| --- | --- |
| `gate_passed` | quote.json is 200, `gate.status` is `passed`, `accepts[]` non-empty |
| `request_matches` | request.json url and method equal the quote's `request` |
| `paid_call_ok` | response.json is 200 and its body parses as JSON |
| `settlement_on_chain` | the tx exists, has no error, the run's payer signed it, and one vouched `payTo` received exactly the quoted amount of the quoted asset (pre/post token balances) |
| `receipt_verifies` | `verifyDelivery(receipt, key)` is valid, key from `GET /pubkey` or `--pubkey` |
| `receipt_binds_run` | `offer_hash`, `request_hash`, `artifact_hash` in the receipt equal hashes recomputed from offer.json, request.json plus the chain tx, and the response body |
| `settlement_bound` | `receipt.settlement_ref` equals the on-chain tx signature |
| `spec_holds` | `checkSpec(artifact, offer.spec)` returns `delivered`, computed by the verifier |
| `offer_matches_catalog` | offer.json's spec, class, price and origin equal the live `GET /api/offers/{id}` record |
| `verdict_delivered` | `receipt.delivery_verdict` is `delivered` |
| `attest_settled` | when the host advertises a paywall in `GET /.well-known/x402`, the attest call's own settlement tx exists, the run's payer signed it, and the host's payTo received exactly the advertised amount; on a host with no paywall this passes and says so |

All eleven must hold. `INCOMPLETE` is the default and a legal terminal state.

## Scoring

Every check appends `{ts, run, done, failed[]}` to `data/loop-runs/ledger.ndjson`.
`node scripts/loop-check.mjs --score` prints runs, done, and pass rate. The number
that matters is predicate pass rate, not how the run was described.

## What writing the predicate found

Before this, `verifyDelivery` refused every receipt the live route issued
(`signer_mismatch`): the route signed without the `signer` field the library
puts inside the signed body. The buyer example passed because it verified with
its own hand-rolled check. The route now includes `signer`, the OpenAPI schema
documents it, the both-direction contract test pins it, and a test asserts the
library verifier accepts what the route serves.

## Running it

```bash
node scripts/loop-run.mjs --offer=outbid-reader-scrape --url=https://example.com \
     --keypair=~/.witness-payer/solana-keypair.json --out=data/loop-runs/<id>
node scripts/loop-check.mjs --run=data/loop-runs/<id> --base=https://witness.outbid.sh
node scripts/loop-check.mjs --score
```

The actor spends two payments on the live host: USDC 0.005 for the Reader and
USDC 0.01 for the attestation (#34 put the attest route behind the /witness
paywall). The verifier spends nothing and needs only the run directory, the
host's pubkey and well-known descriptor, and a Solana RPC.
