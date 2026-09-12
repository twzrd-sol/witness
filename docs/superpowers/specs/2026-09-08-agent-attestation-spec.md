# Agent attestation for third-party sites

Date: 2026-09-08  
Status: draft — operator review  

## What changed in the field

This spec anchors only the verified facts the operator supplied:

1. **Cloudflare, Sept 15 2026 (default):** `Training+Agent` bot categories are blocked on ad pages for new domains and free customers; `Search` stays allowed. Pay Per Crawl is evolving to Pay Per Use.
2. **Rails live:**
   - **Cloudflare pay-per-crawl** returns HTTP 402 with allow / charge / block, with Cloudflare as the merchant of record.
   - **AWS WAF AI traffic monetization** (since June 15 2026) returns 402 with an x402 JSON price manifest.
3. **RSL 1.0** is a machine-readable *licensing declaration* carried via `robots.txt` (XML). It is explicitly severable from enforcement. **TDMRep** `.well-known` manifests are a sibling standard; they are not the same thing and should not be conflated.
4. **Google:** Gemini agent sessions are identifiable via user-agent plus headers, but the standard is incomplete — a header is an assertion, not proof.
5. **57.5% bot share** (Cloudflare Radar, June 3 2026) measures traffic, not willingness to pay. It says the surface is large and unpriced; it does not say anyone will buy a way to price it.

## The unclaimed piece

Cloudflare and AWS sit at the edge chokepoint. They are already monetizing the sites behind them. The ~80% of sites *not* behind those edges have no merchant of record, no WAF rule, and no way to tell a paying agent from a scraper faking a user-agent.

The unclaimed piece is the **agent side of attestation**:

> A third-party site with no edge contract receives a request and, before serving, verifies: “this requesting agent is good for the cost.”

This is not a new payment rail. It is an identity/attestation layer that sits on top of existing 402 rails and lets an ordinary site act as its own verifier.

## Grounding in what Witness already has

Witness is a working quote-first 402 system with the following primitives already deployed:

- `GET /pubkey` — pinned Ed25519 public key, offline-verifiable.
- `POST /quote` — free deliverability probe; returns 200 only if the observation can be produced.
- `POST /witness` — 402-protected paid observation; after payment, returns a signed receipt binding `method`, `source_hash`, `observed_at`, `valid_until`, `verdict`, and signature.
- Twice-pay pattern — two $0.01 settlements for two receipts on one `spec_hash`.
- `GET /.well-known/agent.json` — a discovery card already served.

The question is whether any of those primitives can be reused or extended so that a third-party site can verify an *agent* before it fetches, rather than verifying a *receipt* after the fetch.

## Candidate mechanisms (honest comparison)

| Mechanism | What it is | Good for | Bad for |
|---|---|---|---|
| **Signed agent card** (`/.well-known/agent.json` or similar) | A JSON card signed by an agent’s long-term key, listing allowed origins, rate limits, and a pubkey. | First-party identity; discoverability; static trust. | Does not prove the agent paid for *this* request; key theft / rotation is a real problem. |
| **Attestation bound into the 402 challenge** | The 402 response includes a signed challenge from the site, the agent signs it with its key and returns it with payment. | Per-request freshness; binds payment to this fetch. | Requires the agent to hold a key and sign per request; site must verify the signature and check the agent is not in a revocation list. |
| **Held Witness receipt as bond** | The agent presents a recent, paid Witness receipt for the target URL as proof it is willing to pay for observations. | Reuses the existing twice-pay rail; the receipt is already signed and time-bounded. | A receipt for `example.com/foo` is not a license to *fetch* `example.com/foo`; it is proof an observation was paid for. Misuse is a real risk. |

None of these is a drop-in solution. The right answer is likely a composition: agent card for identity, signed 402 challenge for per-request freshness, and a Witness receipt as an economic bond that the agent has paid for observations before.

## Threat model

The attacker is not a human with a browser. It is a bot that wants the same content for free.

1. **Spoofed user-agent.** The simplest attack: send `User-Agent: Gemini/1.0` and a forged header. Headers are assertions, not proof. Any attestation must require a signature the agent can only produce if it holds the corresponding private key.

2. **Paying agent that shares the result.** An agent pays once and posts the fetched content publicly. Attestation cannot prevent redistribution; it can only bind the *request* to an identity and rate-limit it.

3. **Stolen or replayed card.** An agent card or 402 attestation is intercepted and replayed by another bot. Defenses: short nonces, per-request signatures, `valid_until` windows, and a revocation channel. A replayed 402 challenge older than a short TTL must be refused.

4. **Transfer limits.** An agent card bound to one IP / key pair should not be usable by a fleet. The site can enforce rate limits per key, per card, and per receipt.

5. **False merchant of record.** A site claims an agent must pay but never delivers the content. This is a fraud problem, not a technical one; the agent needs a dispute rail (currently outside scope).

## Non-goals

This spec does not propose:

- Pricing all web traffic, or claiming that 57.5% of traffic will pay.
- A new dashboard, token, worker marketplace, or tweet.
- `LIVE_PAY` or any real-money rail beyond what Witness already uses.
- Replacing Cloudflare or AWS; this is for the long tail of sites without an edge contract.
- A legal/licensing framework; RSL and TDMRep already exist for declarations. This spec is about *proof*, not *policy*.

## Candidate flow

This is an option, not a decision:

1. **Discovery.** Agent learns site policy from `/.well-known/x402` or a new `/.well-known/attestation.json` endpoint. The policy says: `agent_card` required, `402_challenge` required, `witness_bond` optional.
2. **Agent presents card.** Agent sends a signed agent card (or a Witness receipt it holds) with the request.
3. **Site issues challenge.** Site responds 402 with a short-lived, signed challenge: `{nonce, url, price_usdc, expires_at}`.
4. **Agent signs and pays.** Agent signs the challenge with its key, sends payment, and includes the signature.
5. **Site verifies.** Site checks: signature over challenge, signature over agent card, card not expired, rate limit not exceeded, and optionally that a recent Witness receipt for the same `url` exists.
6. **Site serves.** If all pass, the site serves the content. The agent has been attested as good for the cost.

The exact fields, the merchant of record, and the revocation mechanism are left as open questions.

## Success criteria

The only success that counts is a *downstream decision*:

- A third-party site blocks fewer legitimate agents because it can verify them.
- An agent changes its behavior because a verified attestation lets it access a page a spoofed bot cannot.
- A Witness receipt or attestation is cited as the reason an agent did or did not act.

Internal tests, our own wallets, and directory listings do not count.

## Open questions for the operator

1. Is the target market really third-party sites without Cloudflare/AWS, or should Witness first integrate with one of those edges?
2. Should the attestation use the existing Witness signing key, or does the agent need its own keypair and `/.well-known/agent.json`?
3. Is the 402 challenge signed by the *site* or by a *third-party attester*? (The latter creates a trust-on-first-use problem.)
4. How does a site revoke a stolen or abusive agent card without a central registry?
5. What is the legal status of a Witness receipt as a bond? It proves payment for an observation, not a license to fetch. Should a new receipt type explicitly grant fetch rights?
6. Should the spec start with a tiny experiment: one agent, one site, one 402 attestation, one changed downstream decision?
