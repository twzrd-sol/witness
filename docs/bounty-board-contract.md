# Bounty board HTTP pilot

Implemented in the isolated `codex/bounty-http-loop-20260910` branch. This is a separately configured Express service (`src/bounty-listen.js`), consuming Witness's seller route over HTTP. The operator selected a separate board service. Witness retains its existing routing and NDJSON scaffold; this service does not replace or migrate them. Use the separate board port for the authenticated pilot, and do not combine the two stores or histories. There is no MCP addition, UI, token, transfer, or settlement adapter.

## Start

Requires Node 24 (built-in SQLite) and the repository's installed dependencies.

Build the actor file with `scripts/make-actors-file.mjs`, which applies the board's own gate to
every wallet before writing and refuses the file if any wallet cannot clear it -- an actors file
that 403s on every transition is worse than no file, because it looks enrolled:

```sh
node scripts/make-actors-file.mjs --dry-run --max-reward 1 \
  --actor poster:base:0xYOURPOSTER --actor claimer:base:0xYOURCLAIMER
# PASS/FAIL per wallet with its live decision, can_spend and cap. Then, once all PASS:
node scripts/make-actors-file.mjs --out /private/bounty-actors.json --max-reward 1 --actor ...
```

It generates the 32-byte tokens itself and writes mode 0600 with `flag: 'wx'`, so it never
overwrites an existing credential file. Or create the file by hand:

Create a private JSON actor file containing an array of objects with `id`, `role` (`poster`, `claimer`, `operator`), `network` (`base`, `solana`), `wallet`, and a unique random `token` of at least 32 characters. Bind identities to operator-enrolled wallets; a wallet string in a request is not authentication. Protect this file with mode 0600. Do not put credentials in URLs or Git.

```sh
BOUNTY_ACTORS_FILE=/private/bounty-actors.json \
BOUNTY_DATA_DIR=/private/bounty-data \
BOUNTY_SELLER_URL=https://witness.outbid.sh/seller/offer/validate \
BOUNTY_PREFLIGHT_URL=https://intel.twzrd.xyz/v1/intel/preflight \
node src/bounty-listen.js
```

The host defaults to `127.0.0.1`, port `8788`; configure `BOUNTY_HOST` and `BOUNTY_PORT` as needed. Use TLS at the service boundary. There is no production fixture-mode environment switch. The test harness explicitly constructs fixture mode, permits loopback HTTP dependencies, and persists that mode in its database and signatures. Production preflight URLs always require HTTPS. Seller URLs also require HTTPS unless `BOUNTY_ALLOW_LOOPBACK_SELLER=1` explicitly permits HTTP to literal `127.0.0.1` or `[::1]` only. This option does not enable fixture mode, change receipt mode, or relax preflight policy. Dependency URLs cannot contain credentials; redirects are refused. Each HTTP dependency has a five-second timeout.

SQLite stores immutable completed records and idempotent responses. Transactions serialize final state transitions across processes. Network calls run outside transactions, followed by a fresh state check within the transaction. Back up `board.sqlite` using SQLite-aware tooling and preserve `signing-key.pem`. Key creation uses mode 0600; database metadata pins both key identity and evidence mode. A changed key or fixture/live reuse fails startup. NDJSON history is not automatically migrated because those rows lack authenticated acceptance and settlement evidence.

## Routes

All bounty reads and mutations require `Authorization: Bearer <token>`. Mutations additionally require `Idempotency-Key` (1–128 letters, digits, dots, underscores, colons or hyphens). Repeating the same actor/route/key and body returns the original committed response. Altered input or authority returns 409. A retry after a failed dependency check may be attempted again: no state was committed.

| Route | Input and behavior |
|---|---|
| `POST /bounties` | `{poster: <seller-offer/v1>, task:{description}}`; poster/operator role. HTTP card lookup and TWZRD allow required before listing. `poster.price_minor` is the fixed bounty reward: 500000–2000000 USDC micro-units (0.5–2 USDC). Returns 201. |
| `POST /bounties/:id/claim` | `{claimer: <seller-offer/v1>}`; claimer role and matching configured identity/wallet. Same network, offered price no greater than fixed reward, no self-claim. HTTP card includes the wallet's server-owned delivery outcomes. Exactly one claim wins; returns 200. |
| `POST /bounties/:id/complete` | `{outcome:{decision:"accepted"|"rejected"},artifact:{sha256,description}}`; only bound poster or operator. Checks claimer wallet through TWZRD at completion, records server-measured duration, signs receipt; returns 200. |
| `GET /bounties/:id` | Authenticated record, including card snapshots and any completion receipt. |
| `GET /bounties-key` | Public Ed25519 PEM, key ID and mode. Pin this key through an independently trusted channel. |
| `GET /openapi.json`, `/llms.txt`, `/skill.md` | Public board contract and agent instructions on the board's own host. |

Example offer (wallet and ID must match the authenticated actor):

```json
{
  "schema_version": "seller-offer/v1",
  "seller_id": "twzrd-poster",
  "capability": "TWZRD backlog work",
  "price_minor": 500000,
  "currency": "USDC",
  "network": "base",
  "payout_wallet": "0x0000000000000000000000000000000000000001",
  "sla_minutes": 60,
  "deliverable": {"description": "Reviewed Markdown artifact", "mime_type": "text/markdown"}
}
```

The example wallet is a placeholder, not a funded identity. Response envelopes are `{success:true,data:{bounty}}` and `{success:false,data:null,error:{reason}}`. Failures include 400 invalid body/offer/wallet/reward/completion/key; 401 unauthorized; 403 role/ownership/terms gate refusal; 404 unknown bounty; 409 transition or idempotency conflict; 503 unavailable or invalid dependencies. See code for exact reasons. Extra caller histories and caller durations are not used as evidence.

Seller contract preservation: unparseable JSON → `bad_json`; parseable JSON with wrong offer shape → `bad_seller_offer`; supplied non-array outcomes → `bad_outcomes`. Seller primitives are parsed as valid JSON before offer validation.

## Gates, receipts and history

The board calls the configured seller HTTP route with `{offer,outcomes}`. Posting supplies empty payment history; claiming supplies authenticated completions for that network/wallet. Empty history stays unknown. Accepted/rejected delivery history accrues in subsequent card snapshots; existing snapshots are immutable.

Preflight uses the existing free `POST /v1/intel/preflight` contract: `resource_name`, `seller_wallet`, `price_usdc`, `chain`, `agent_intent`. The response must say `decision:allow` **or** `decision:warn`, and `can_spend:true`; when the card states a cap (`maximum_recommended_spend_usdc`, else `recommended_cap_usdc`) the reward must not exceed it, or the transition refuses with `preflight_cap_exceeded`. A cap the card does not state is not invented. `block`, `unknown`, any other decision, `can_spend:false`, expired evidence, echoed identity/network/amount mismatch, HTTP failure and parsing errors all refuse. The receipt binds the exact request and response, plus the decision and cap the board acted on. Missing response echoes are not invented; the configured trusted HTTPS transport binds the request.

**Policy change, operator decision 2026-09-10.** The board previously required `decision:allow` outright and refused every warn. Live measurement showed that bar is effectively unreachable: of the 15 seller wallets in the public directory only one earns `allow` (76 settled resources, trust_score 57.9), and a wallet with no corpus history scores 45.0 `unknown_subject` -- the cautious default -- regardless of who controls it. Accepting cap-bounded warn matches intel's own stated semantics, which the preflight response spells out: "decision=warn -> proceed only up to readiness_card.recommended_cap_usdc ...; do not treat warn as refuse on clean counterparties." The board still hard-refuses `block` and `unknown`, still requires `can_spend:true`, and now additionally enforces the stated cap itself rather than trusting `can_spend` alone. This is the board's own policy; it does not redefine intel's advisory semantics, and warn is recorded as warn in the receipt.

The completion receipt is domain-separated as `bounty-completion/v1`, signed with a persistent board Ed25519 key, and binds task hash, full offers, fixed reward, artifact hash/description, accepting actor, measured duration, preflight and settlement status. Operator acceptance attests to a submitted artifact digest; it does not independently prove artifact quality or possession. The accepting poster/operator must review the artifact before calling complete.

Every receipt currently says `settlement.status:not_paid`, `transaction:null`, `reason:settlement_adapter_not_configured`. There is no payout endpoint. Completion preflight is eligibility evidence, not a transfer approval reusable later. A future settlement adapter must repeat the wallet gate immediately before signing and independently verify the exact amount/payee/network settlement before adding poster payment history. Poster `paid_jobs` and `payment_rate` remain null. The current card schema has delivery approval rates, not a paid reliability metric.

## Seeds and internal evidence

`node scripts/bounty-internal-loop.mjs` posts four real repository maintenance tasks to a fresh **local fixture board**:

- 0.5 USDC: seller error taxonomy documentation (`src/routes/seller.js`, `src/server.js`, seller route tests).
- 1 USDC: offline receipt verification and tamper demonstration (`src/receipt.js`, receipt tests).
- 1 USDC: quote-then-witness client guide part 1 -- refused quotes and the 402 challenge path (`README.md`, `src/server.js`).
- 1 USDC: quote-then-witness client guide part 2 -- failed retrieval and offline receipt verification (`src/retrieve.js`, `src/receipt.js`, `docs/operator-trial.md`).

The last two were one 2 USDC task, split on operator decision 2026-09-10: no observable wallet clears a 2 USDC cap. Even the single `allow`-scoring wallet in the directory returns `can_spend:false` at 2 USDC (cap 1.5), so a 2 USDC listing could not pass its own poster gate.

These listings are unfunded. The script acts as the internal client, produces the first Markdown artifact, claims and completes its bounty through actual HTTP, verifies its receipt, retries completion, restarts the store, and claims the next task to verify one accepted delivery on the HTTP card. Local preflight returns an explicitly labeled allow fixture. The seller route is the actual Witness Express route.
Setting `BOUNTY_SELLER_URL` runs the same loop against a Witness instance in a **separate process** (`seller_out_of_process: true` in the emitted evidence), which is the pilot's real dependency shape:

```sh
PORT=4042 HOST=127.0.0.1 PUBLIC_BASE_URL=http://127.0.0.1:4042 \
  OBSERVATIONS_DIR=/tmp/witness-4042 node src/listen.js &
BOUNTY_SELLER_URL=http://127.0.0.1:4042/seller/offer/validate node scripts/bounty-internal-loop.mjs
```

Inspect `artifacts/bounty-internal-loop/`. Run `node scripts/verify-bounty-receipt.mjs artifacts/bounty-internal-loop` to recheck the signature and artifact hash offline. No private keys or bearer tokens are exported. This proves local coordination plumbing, not live trust approval, payout, an external agent, or the seven-day market milestone.

## Live activation remaining

### The 404 was never a dev-server problem (resolved 2026-09-10)

`127.0.0.1:4032` is not a dev sandbox. `~/.cloudflared/outbid-config.yml` maps
`witness.outbid.sh -> http://127.0.0.1:4032`, so that port **is** the public Witness backend.
The process serving it started 2026-09-08 20:32 UTC from `/home/twzrd/witness`, before the
seller route existed as uncommitted work; its `/openapi.json` and the public one list the same
nine paths and neither includes `/seller/offer/validate`. Restarting it would both drop public
traffic and ship three interleaved uncommitted workstreams to production. No "owning dev
session" can load the route there without a deploy. Do not restart 4032 for this pilot.

The seller dependency is therefore satisfied by a **second Witness instance on a private port**,
started from this worktree, which does carry the route:

```sh
PORT=4042 HOST=127.0.0.1 PUBLIC_BASE_URL=http://127.0.0.1:4042 \
  EVM_ADDRESS=0x0000000000000000000000000000000000000000 \
  SVM_ADDRESS=11111111111111111111111111111111 \
  OBSERVATIONS_DIR=/tmp/witness-4042 node src/listen.js
```

Verified 2026-09-10: `POST http://127.0.0.1:4042/seller/offer/validate` returns HTTP 200 with a
`seller-card/v1`. Point `BOUNTY_SELLER_URL` there with `BOUNTY_ALLOW_LOOPBACK_SELLER=1`; leave
preflight on its real HTTPS URL. Deploying the seller route to `witness.outbid.sh` remains the
alternative, and is an operator decision, not a config change.

### Live gate, dry run (`scripts/bounty-live-dryrun.mjs`)

`node scripts/bounty-live-dryrun.mjs` builds a **live_coordinator** board (no fixture) against the
loopback seller and the real `https://intel.twzrd.xyz/v1/intel/preflight`, then records what each
dependency actually answered. Run 2026-09-10 with placeholder wallets:

| Dependency | Result |
|---|---|
| Seller card (out-of-process HTTP) | 200, `seller-card/v1`, empty history stays null |
| TWZRD preflight (live) | `decision: warn`, `can_spend: false`, cap 0.1 USDC, `PREFLIGHT_WARN`/`CORPUS_TEASER`/`THIN_OR_UNKNOWN_SELLER`/`CAP_APPLIED` |
| Board `POST /bounties` | 403 `preflight_denied` — refused, as the board's policy requires |

That refusal is the expected and correct outcome for an unenrolled wallet. It also exercises the
binding checks against the real intel payload for the first time: `seller_wallet` and `price_usdc`
are echoed and matched, `chain` is **absent** from the live card and is therefore skipped rather
than treated as a mismatch, and `expires_at` is in the future. Evidence in
`artifacts/bounty-live-dryrun/live-dryrun.json`.

### Still operator-supplied

- Enrolled poster/claimer wallets with real passing preflights (`decision: allow` **and**
  `can_spend: true`). Placeholder `0x0000...0001` will not pass, by design.
- The 0600 actors file binding those wallets to bearer tokens.
- A verified settlement adapter before any receipt may stop saying `not_paid`, and before poster
  payment reliability is anything but null.

No service was deployed, no process was restarted, and no money moved.
