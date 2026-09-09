# witness

Independent evidence that a public URL currently satisfies a JSON schema and an
optional assertion. Agents pay for a **receipt**, not HTML.

Retrieval is pre-flighted: `GET https://reader.outbid.sh/scrape?url=` and
`/browse`. This repo does not ship a browser. MCP client pattern: `x402-reader`.

## Weekend (operator-owned)

- `POST /quote` — unpaid. `{url, extract, assertion?, replicas: 1|3}`.
  200 `{price_usdc, can_deliver}` or 422.
- `/quote` is rate-limited per client (30 probes per minute by default;
  `QUOTE_RATE_LIMIT_PER_MINUTE` configures it) because a probe may consume a
  paid reader retrieval.
- `POST /witness` — 402 then, after pay, retrieve → extract → sign.
- `replicas: 1` this weekend. `3` is three isolated workers later.
- Failures after a 200 quote: structured error, no fake value.
- `GET /llms.txt` + one MCP tool.

Not Firecrawl. Not intel device-witness. Not a directory.

Success: one **foreign** agent buys twice. Listing in five registries is not success.

## Current coordination notes

- Chief driver hardening lives in `/home/twzrd/agent-bus/bin/chief-driver.sh`: the systemd
  start-limit brick path is disabled, queue age is logged for `grok`, `codex`,
  and `opencode-*`, stale queues are flagged, and a rate-limited backlog alert is
  queued to Grok.
- Relay hardening lives in `/home/twzrd/agent-bus/bin/relay-heartbeat.sh` and
  `/home/twzrd/agent-bus/bin/relay.sh`: stale PIDs are rejected by script identity,
  pidfiles are cleared on stop, and malformed inbox JSON is quarantined instead of
  stalling the route.
- The live proof path is separate from fixture tests: the tests prove the
  coordination layer and receipt plumbing, but the product proof still requires a
  foreign payer buying `/quote` and then `/witness` on the public service.
