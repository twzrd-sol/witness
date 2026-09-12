# Wave21 ZZZ — live witness host probes (2026-09-12)

Real HTTP against `https://witness.outbid.sh`. No mocks. No deploy. No invented payer.

Re-run:

```bash
node scripts/wave21-live-host-probes.mjs --live \
  --out=docs/operator/evidence/wave21-zzz-2026-09-12
```

`--live` is required. A `--base` other than the documented host exits 2.

## Result

`CHECK.txt` is `LIVE_OK` — 30/30 named checks. Unpaid/402 paths proved the paywall.

| Surface | Live result |
|---|---|
| `GET /pubkey`, `/llms.txt`, `/openapi.json`, `/.well-known/x402` | 200 |
| `GET /witness` | **402**, resource `https://witness.outbid.sh/witness`, $0.01, Base + Solana |
| `POST /quote` documented method (`outbid.sh/top`) | **200** `can_deliver:true` `verdict:supported` `$0.01` scrape |
| `POST /quote` GATE_METHOD (`dummyjson.com/products/1`) | **200** `can_deliver:true` `verdict:supported` |
| `POST /quote` empty extract | **400** `bad_extract`, no challenge |
| `POST /witness` unpaid (both methods) | **402** same resource/price/rails |
| `POST /witness` `bad_extract` | **400**, no 402 |
| `POST /witness` forged `PAYMENT-SIGNATURE` | **402**, no receipt |
| `POST /delivery/attest` unpaid | **402**, resource `…/delivery/attest`, $0.01, both rails |
| `POST /delivery/attest` off-shape | **400** `bad_offer` |
| `POST /delivery/attest` forged | **402**, no receipt |
| `GET /delivery/attest` | **404** (POST-only; not a GET 402) |
| Done-gate `runOnce({mode:"dry"})` | quote 200 supported; `completion:incomplete`; `checkout_approved:false`; `paid:false` |

Challenge payTos (public):

- Solana: `F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM`
- Base: `0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F`

## Preflight and wash

TWZRD MCP `evaluate_x402_resource` on `GET /witness`: **warn**, cap **$0.01**, `is_x402:true`.  
`get_merchant_card` on the Solana payTo: `wash_flagged: null`, `decision: insufficient_evidence` (coverage gap, not clean).  
`is_wash_fleet` on that payTo: `classification: unknown`, `no_corpus_data`.

The script also fetched `GET https://intel.twzrd.xyz/v1/intel/merchant_card/{payTo}` live and got the same gap. `decideSpend` fail-closed: **`wash_unevaluated`**.

Unpaid/402 already proved the paywall, so a micro-pay was not required. There is no documented payer on this agent (`DOCUMENTED_PAYER_PATHS` is the operator receiver key, absent here). No wallet was minted.

## Spend log

`spend-log.ndjson`:

```
amount_usdc=0  status=not_attempted  payer=null  reason=wash_unevaluated
```

No USDC moved. Intel `$0.05` paid trust was not bought (not the witness paywall).

## Files

| File | What |
|---|---|
| `CHECK.txt` | PASS/FAIL matrix + `LIVE_OK` |
| `probes.json` | Sanitized statuses, 402 accepts, quote/Done-gate summaries |
| `preflight.json` | Live intel merchant_card + spend gate inputs |
| `twzrd-mcp-preflight.json` | MCP evaluate / readiness / merchant / wash (free) |
| `spend-log.ndjson` | One line; $0 |

No private keys, payment payloads, or `PAYMENT-SIGNATURE` values are stored.
