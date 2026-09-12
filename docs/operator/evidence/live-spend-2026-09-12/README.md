# Live scrape / browse / intel PAY — 2026-09-12

Operator-approved spend against the deployed host (`2054818`, then still
serving that tree). This is **not** the issue #1 independent twice-pay
bundle: one `/witness` receipt, operator wallet, sponsored reader hops.

Re-check the signed scrape receipt offline:

```bash
node --test test/live-spend-2026-09-12.test.js
```

## What ran

| Step | Result |
|---|---|
| Unpaid `GET reader.outbid.sh/scrape?url=dummyjson…` | 402, `$0.005` |
| `POST /quote` scrape `{url: dummyjson/products/1, extract.stock, assertion}` | 200, `$0.01`, `retrieval: scrape`, `verdict: supported` |
| `POST /quote` browse `{url: pypi.org/pypi/requests/json, extract.version}` | 200, `$0.06`, `retrieval: browse` |
| Unpaid browse of JSON APIs (`dummyjson`, `httpbin/json`) | free `422 needs_login` — no auto-upgrade |
| `POST /witness` scrape, ceiling `$0.01` before sign | 200, stock **99**, Base tx `0xd131…f31b` |
| `agent-browser 0.35.1 --no-sandbox` on dummyjson | stock **99** (existing Chromium CLI; not in this repo) |
| Intel preflight of intel payTo `GFpL…` at `$0.05` | `warn`, `can_spend`, cap `$0.05` |
| `GET intel.twzrd.xyz/v1/intel/trust/F1Ab…`, ceiling `$0.05` | 200, `paid: true`, score **48**, v7, Base tx `0x7c740…f637` |

Payer for the two this-process settlements:
`0xB36e83aB5E6128bC0E1b76b3F59Fe2fD443F0788`.

Reader hops were paid by the `witness-serve` process (`X402_READER_PAYMENTS_ENABLED=1`,
ceilings `$0.005` scrape / `$0.05` browse). Those two lines in `spend-log.ndjson`
are inferred from unpaid 402 then a deliverable quote — no reader settlement
tx was recorded.

## Not in this bundle

- No intel `/v1/witness/attest` (device keys).
- No `LIVE_PAY` from mpp.
- No private key, payment header, or `.env`.
- Not a foreign twice-pay; do not run `scripts/verify-proof.mjs` on this directory.
