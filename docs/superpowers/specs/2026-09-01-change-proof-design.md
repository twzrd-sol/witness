# Change Proof (prior receipt)

Date: 2026-09-01  
Status: approved (founder, 2026-09-01 session) — F1 core implemented (server.js + test/change.test.js); F2 = OpenAPI + copy  
Increment cap: 150 LOC (GLM implements; Grok reviews)

## Goal

Sell a signed delta, not another commodity fetch.

An agent already holding a Witness receipt asks: **has this public page changed since that observation, and what does it say now?** Change is relative to a **verified prior vantage**, not a client-invented hash.

The five quote-validated templates stay how you mint the first receipt. Change Proof is what you do with the second payment.

## Non-goals

- New HTTP path (`POST /change` is out)
- Naked `expected_source_hash` (checksum API, not an observation)
- Server-side “last Observatory row” as the prior (this host’s log is not the customer’s memory)
- Rejecting expired priors (perishable evidence is the baseline)
- replicas > 1, browse auto-upgrade, dashboards, Chromium, intel attest
- Cosigner / Kalshi

## Rail

Same `POST /quote` (free) then `POST /witness` ($0.01 USDC, x402). Quote evaluates any assertion and returns 422 before payment when it fails. Optional body field:

```json
{
  "url": "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  "extract": { "amount": "number" },
  "assertion": "amount < 1000000",
  "replicas": 1,
  "prior_receipt": { "...": "a previous Witness 200 body" }
}
```

`prior_receipt` is omitted on a first look. `methodFromRequest` stays `{url, retrieval, extract, assertion}` — `prior_receipt` is never inside `spec_hash`.

## Prior checks (fail closed, before retrieve)

Run in `handleQuote` so a bad prior never reaches the paywall (no 402, no reader spend).

1. If `prior_receipt` is absent → existing quote behavior (including assertion evaluation). Do not add `changed`.
2. If present and not a plain object (arrays rejected) → `422 {reason: "prior_invalid"}`.
3. `verifyReceipt(prior, process pubkey)` must be true → else `422 {reason: "prior_invalid"}`. Exception-safe: pre-validate `typeof prior.receipt === "string"` and wrap the verify in try/catch — a non-string truthy `receipt` (e.g. `123`) must fail to `422 prior_invalid`, never throw to a 500.
4. Prior must include string `source_hash` and object `method` → else `422 {reason: "prior_invalid"}`.
5. `specHash(methodFromRequest(body)) === prior.spec_hash` and `specHash(prior.method) === prior.spec_hash` → else `422 {reason: "prior_method_mismatch"}`. Compute the method once, using the same call the witness path uses: `methodFromRequest(body, deps.retrieval ?? "scrape")` — the quote-side prior check and the signed receipt method must not drift.
6. Do **not** consult `valid_until` on the prior. Expired is valid baseline.

Then existing SSRF / retrieve / extract / assertion checks. A failed assertion returns 422 on the free quote, so it never reaches payment; paid `/witness` repeats the check defensively and does not sign on failure.

## Quote 200 when a prior is attached

Existing fields plus:

```json
{
  "price_usdc": "0.01",
  "replicas": 1,
  "can_deliver": true,
  "changed": true,
  "previous_source_hash": "<prior.source_hash>",
  "source_hash": "<sha256 of this retrieve>"
}
```

`changed` is `source_hash !== previous_source_hash` (the retrieved bytes, not `value`). The extract can stay equal while the page still changed. Quote never signs. Client may skip pay when `changed` is false; they may still pay for a signed “unchanged” receipt.

## Paid receipt when a prior is attached

Existing signed fields plus:

| Field | Rule |
|---|---|
| `changed` | boolean, required |
| `previous_source_hash` | prior’s `source_hash`, required |

Both are inside the signed canonical rest. Receipts without a prior **omit** both fields so current verify + Observatory grouping stay valid.

`valid_until` on the **new** receipt remains `observed_at + 1h`. Retrieve-once still holds: paid `/witness` reuses quote text.

## Errors (never bill)

| reason | when |
|---|---|
| `prior_invalid` | missing shape, bad sig, missing `source_hash`/`method` |
| `prior_method_mismatch` | valid receipt, different experiment |
| existing `bad_json` / `bad_extract` / SSRF / `retrieve_*` / `extract_missing` / `assertion_failed` | unchanged |

A 422 from these never becomes a 402. On the paid path, prior 422s are post-settlement (same shape as `extract_missing` when the world shifts between quote and settle) — quote-first clients never reach that branch.

## Observatory

No code change this increment. Extra signed fields are ignored by `compareReceipts` (it already `verifyReceipt`s, then groups by `spec_hash` / `value`). A change receipt is another observation of the same method.

## Public copy

`/llms.txt` and `/skill.md` lead with the change question. Keep the five first-look templates. Do not restore the twice-pay operator ask. One worked example: quote template N → pay once → `POST /quote` again with `prior_receipt` set to that 200 body → pay only if you want the signed delta.

OpenAPI: optional `prior_receipt` on the quote/witness body; document quote 200 extras and the two new receipt properties.

## Tests (fixture retrieve, no live reader, no live 402)

- No `prior_receipt` → quote/receipt shapes unchanged (no `changed` key).
- Forged / unsigned prior → `422 prior_invalid`, retrieve is not called.
- Valid prior, different `url`/`extract`/`assertion` → `422 prior_method_mismatch`, retrieve is not called.
- Non-string truthy `receipt` field (e.g. `123`) → `422 prior_invalid`, never 500, retrieve not called.
- Expired prior (`valid_until` in the past), same method, same source text → quote `changed: false`; paid receipt `changed: false`, verifies.
- Expired prior, same method, different fixture text → quote `changed: true`; paid receipt `changed: true`, `previous_source_hash` matches prior, new `source_hash` differs, verifies.
- Unpaid deliverable with valid prior → 402 (not 422).

## Implementation sketch (not the plan)

- `checkPrior(prior, pubkey, method)` in `server.js` (receipt.js cannot import observatory.js — circular; server.js already imports both).
- `handleQuote` / `handleWitness` in `server.js` only.
- OpenAPI + llms/skill strings.
- `test/change.test.js`.

If the increment would exceed 150 LOC, drop OpenAPI prose first, not the fail-closed tests.
