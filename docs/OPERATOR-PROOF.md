# Operator Proof — twice-pay evidence bundle

This is the sanitized artifact an **independent** operator returns for the
issue #1 "twice-pay" proof. It is designed so anyone can check it offline
without trusting TWZRD infrastructure, and it **never** contains a private
key, secret, or x402 payment header.

> Canonical method (byte-identical for both pays):
> ```json
> {"url":"https://outbid.sh/top","extract":{"rank":"number"},"assertion":"rank < 100","replicas":1}
> ```

## Flow (operator side)

1. `POST /quote` with the method body — expect `200 {"can_deliver":true}`.
2. `POST /witness` with the **same body** + x402 payment — keep the signed receipt.
3. Repeat step 2 with **byte-identical** bytes — keep the second receipt.
4. `GET /pubkey` → save the base64 ed25519 key.
5. `GET /observatory` → note the `total` for your shared `spec_hash`.

## The bundle you return

```json
{
  "method":      { "url": "https://outbid.sh/top", "retrieval": "scrape",
                   "extract": { "rank": "number" }, "assertion": "rank < 100" },
  "payer":       "<your public payer address — no key>",
  "receipts":    [ <receipt #1>, <receipt #2> ],
  "settlements": [ "<settlement id 1>", "<settlement id 2>" ],
  "observatory": { "spec_hash": "<shared spec_hash>", "total": 2 }
}
```

Field rules:

| field | rule |
|---|---|
| `method` | The exact request shape you paid for. `retrieval` defaults to `scrape`. |
| `payer` | Public address of the wallet that paid. **Never** a private key. |
| `receipts` | Exactly two full receipt objects as returned by `POST /witness`. |
| `settlements` | Two **distinct** settlement identifiers (strings, or `{"id": "..."}`). Never the payment payload/header itself. |
| `observatory` | Optional but recommended cross-check: the `spec_hash` and `total` you saw on `GET /observatory`. |

## Verify it offline

Anyone with Node 18+ can check the bundle without any network access:

```bash
node scripts/verify-proof.mjs evidence.json --pubkey "$(curl -s https://witness.outbid.sh/pubkey | jq -r .pubkey)"
# PROOF VALID — two distinct settlements, two signed receipts, one spec_hash.
```

Exit code `0` = valid; `1` = at least one invariant failed (each printed).
Omit `--pubkey` to skip signature verification and check structure only.

## What the checker enforces

- **Forbidden fields** — the bundle must not contain a private key, secret, or payment header.
- **Method** — public `https` URL, non-empty `extract`, valid `retrieval`; recomputes `spec_hash` from the canonical method.
- **Two receipts** — each must carry `agreement:"1-of-1"`, a `method` that hashes to its own `spec_hash`, a well-formed `source_hash`, and `valid_until > observed_at`.
- **Signatures** — both receipts verify with the supplied pubkey over deep-canonical JSON.
- **Byte-identical pays** — both receipts bind the same canonical method (no drift between pays).
- **Two distinct settlements** — two different identifiers; never the same one twice.
- **Observatory cross-check** — if present, `spec_hash` matches and `total >= 2`.

## Sponsorship

If TWZRD reimbursed the two $0.01 payments, the run is **sponsored** — say so
in the issue comment. The paying wallet is still the operator's own; that is
what makes the proof independent.
