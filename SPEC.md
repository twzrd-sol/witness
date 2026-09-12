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

1. `POST /quote` unpaid. Probe the requested retrieval (`scrape` default).
   A scrape JS wall is **422** `{reason: "needs_browser"}` **no 402** — the
   caller opts into `retrieval: "browse"` on a new request. Never auto-upgrade.
2. If the probe works → **200** `{price_usdc, retrieval, replicas: 1, can_deliver: true}`
   (`0.01` scrape / `0.06` browse).
3. `POST /witness` same body → **402** Exact USDC at the quoted price.
   After settle: reuse the quote retrieve (do not scrape twice). Extract.
   Optional assertion. Sign receipt. Method binds `retrieval`.

Do not 402 a request the quote would 422. Do not auto-upgrade scrape 422 to browse.

## Receipt (200)

`{value, assertion, observed_at, source_hash, evidence, agreement: "1-of-1",
receipt}` where `receipt` is ed25519 over the canonical JSON of the rest
(process key, `data/keystore` gitignored). Public `GET /pubkey`.

`source_hash` = sha256 of retrieved markdown/text. `evidence` = short cited
snippets, not the full page.

## Prices (operator)

Static witness scrape $0.01 (covers reader $0.005 + coord). Explicit browse $0.06 (reader $0.05 + coord).
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
First increment (no standing LOC cap): `/quote` + extract + ssrf + tests. Pay/sign next.
