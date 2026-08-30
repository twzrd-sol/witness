# witness

Independent evidence that a public URL currently satisfies a JSON schema and an
optional assertion. Agents pay for a **receipt**, not HTML.

Retrieval is pre-flighted: `GET https://reader.outbid.sh/scrape?url=` and
`/browse`. This repo does not ship a browser. MCP client pattern: `x402-reader`.

## Weekend (operator-owned)

- `POST /quote` — unpaid. `{url, extract, assertion?, replicas: 1|3}`.
  200 `{price_usdc, can_deliver}` or 422.
- `POST /witness` — 402 then, after pay, retrieve → extract → sign.
- `replicas: 1` this weekend. `3` is three isolated workers later.
- Failures after a 200 quote: structured error, no fake value.
- `GET /llms.txt` + one MCP tool.

Not Firecrawl. Not intel device-witness. Not a directory.

Success: one **foreign** agent buys twice. Listing in five registries is not success.
