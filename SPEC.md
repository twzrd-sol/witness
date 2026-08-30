# Witness weekend spec

Reuse `reader.outbid.sh` + `x402-reader`. New git tree. Do not put this in
`mpp`, `twzrd-cosigner`, `wzrd-final`, or `outbid/src`.

## Request

```json
{
  "url": "https://example.com/pricing",
  "extract": { "starter_price": "number", "currency": "string" },
  "assertion": "starter_price < 100",
  "replicas": 1
}
```

`url` must be `https:`. SSRF: no localhost, no link-local, no file:. Same spirit
as `x402-reader/src/ssrf.js` — copy the allowlist, do not import across trees
by absolute path.

## Quote then pay

1. `POST /quote` unpaid. Probe scrape (not browse). If extract cannot fill
   required keys → **422** `{reason}` **no 402**.
2. If probe works → **200** `{price_usdc: "0.01", replicas: 1, can_deliver: true}`.
3. `POST /witness` same body → **402** Exact USDC (Solana or Base, match reader).
   After settle: scrape again (or browse only if quote said `needs_browser` and
   client sent `browser: true`). Extract. Optional assertion. Sign receipt.

Do not 402 a request the quote would 422. Do not auto-upgrade scrape 422 to browse.

## Receipt (200)

`{value, assertion, observed_at, source_hash, evidence, agreement: "1-of-1",
receipt}` where `receipt` is ed25519 over the canonical JSON of the rest
(process key, `data/keystore` gitignored). Public `GET /pubkey`.

`source_hash` = sha256 of retrieved markdown/text. `evidence` = short cited
snippets, not the full page.

## Prices (operator)

Static witness $0.01 (covers reader $0.005 + coord). Browser $0.05 later.
replicas 3 later. No token split this weekend.

## Tests (no live reader, no live 402)

- SSRF refuse `http://127.0.0.1/`
- quote 422 when extract keys missing from fixture html
- quote 200 when fixture html fills extract
- receipt verify with process pubkey
- scrape 422 does not call browse

Inject a fake `retrieve(url)` in tests. Do not hit `reader.outbid.sh` in `npm test`.

## Out of scope

Intel `witness_agent_keys`. Outbid `/route` hop. Dashboards. ClawHub. Token.
Permissionless workers. Merge Rescue. Veto. Cosigner. `LIVE_PAY` on mpp.
≤150 LOC first increment: `/quote` + extract + ssrf + tests. Pay/sign next.
