# Bounty wiring handoff — 2026-09-10

Update: the operator authorized Codex implementation and verification after both required model providers proved unavailable. The isolated HTTP board is implemented; 170 tests pass, and the local internal loop generated a signature-verified completion receipt. No payment receipt, payout or external-agent evidence is claimed. See [current contract](bounty-board-contract.md) and [internal evidence](../artifacts/bounty-internal-loop/README.md). The reconnaissance below is the preserved pre-implementation snapshot.

## Isolation

Worktree: `/home/twzrd/worktrees/witness-bounty-http-loop`, branch `codex/bounty-http-loop-20260910`, base `868056a`.
The original `/home/twzrd/witness` tree remains untouched by this session. Another Codex process (PID 3399809) was attached there; `src/openapi.js` changed after snapshotting, confirming the collision risk. Six modified tracked files and ten relevant untracked source/test files were copied. See [snapshot hashes](bounty-evidence/source-snapshot.json). The copied changes belong to the existing work; they are not a new implementation. Dependencies are linked read-only for testing; run npm ci with an independent node_modules before changing dependencies. Nothing staged or committed. New work remains isolated; shared-tree reconciliation must preserve the other sessions’ newer edits.

## Verified gaps

- Existing board directly calls `buildSellerCard` with empty history. It does not consume the seller HTTP route or accumulate outcomes into cards.
- It has no authenticated ownership, wallet preflight, reward budget, settlement verification, or signed completion receipt.
- Synchronous append-only state is not a cross-process atomic claim mechanism.
- The isolated baseline fails to load eight test files: `src/openapi.js` initializes `bountyOk` using `out` before the latter is initialized. See [baseline test output](bounty-evidence/baseline-tests.txt). The original tree has since changed; do not overwrite it with this snapshot.
- Unpaid POST `https://witness.outbid.sh/seller/offer/validate` returned 404 at approximately 17:17 UTC. See [response](bounty-evidence/live-seller-probe.html). Another deployment URL may host the route; its location is unresolved.
- Free POST `https://intel.twzrd.xyz/v1/intel/preflight` returned 200 with `decision: warn`, `can_spend: false`, `null_reason: unknown_subject` for the explicitly labeled test wallet `11111111111111111111111111111111`, 0.5 USDC, Solana. This is refusal evidence, not a production participant or a payment. See [response](bounty-evidence/live-preflight-probe.json).

## Contract preservation

Seller validation: unparseable JSON returns `bad_json`; parseable JSON with the wrong offer shape returns `bad_seller_offer`. Do not merge these errors. No MCP expansion is required for the board.

## Proposed implementation

1. Standalone Express board consumes configured seller HTTP endpoint with authenticated, server-owned wallet outcome history.
2. Require free TWZRD preflight before listing; refuse warn/block/unavailable. Recheck claimer before a payout. Bind gate request to stored wallet, network and micro-USDC amount.
3. Bind configured participant identity to bearer authentication; allow only poster/operator acceptance. Use durable atomic transitions and idempotent retries.
4. Sign domain-separated completion receipts binding task, parties, reward, artifact digest, acceptance and settlement status. Never infer paid status from accepted delivery. Poster payment reliability remains unknown until verified settlement exists.
5. Proposed real backlog seeds: seller error-contract documentation (0.5 USDC); offline receipt tamper verification (1 USDC); quote-then-witness failure-handling guide (2 USDC). These are proposals, not funded listings.
6. Exercise one internal agent through actual local HTTP and save its output, receipt and public verification key. Label any fixture gate explicitly; fixture evidence does not fulfill the external-agent milestone.

## Model availability blocker

AGENTS.md requires “GLM implements; Grok reviews.” GLM via opencode-go/glm-5.3 failed with monthly quota exhausted (reported reset in 19 days). BlockRun GLM also failed; status showed zero USDC on Solana and Base. Grok Build review failed with HTTP 402, usage balance exhausted; see [error](bounty-evidence/grok-unavailable.txt). No GLM implementation or Grok review was obtained. Resume with working providers or an explicit operator override of both roles. No production service, unrelated repository, or existing source file was modified.

Architecture resolved: operator chose the board as a separate service. Witness scaffold routing and its contract have been restored in the isolated snapshot. Explicit BOUNTY_ALLOW_LOOPBACK_SELLER=1 permits a local seller without fixture mode or relaxed preflight.

## Seller 404 resolved — 2026-09-10, later

The `127.0.0.1:4032` premise was wrong, and the handoff line above ("its owning session must load
the seller route") should not be acted on. `~/.cloudflared/outbid-config.yml` maps
`witness.outbid.sh -> http://127.0.0.1:4032`: that port is the **public Witness backend**, serving
from a process started 2026-09-08 20:32 UTC, before the seller route existed as uncommitted work.
Its `/openapi.json` matches the public one exactly (nine paths, no seller route). Restarting it
would drop public traffic and ship three interleaved uncommitted workstreams to production. No dev
session can load that route there without a deploy.

Resolved instead by a second Witness instance from this worktree on private port 4042, which does
carry the route — `POST /seller/offer/validate` verified 200 with a `seller-card/v1`. The internal
loop now runs against it out-of-process (`seller_out_of_process: true`), and
`scripts/bounty-live-dryrun.mjs` runs a live_coordinator board against that seller plus the real
intel preflight: the live gate answered `warn` / `can_spend: false` for the placeholder wallet and
the board refused with 403 `preflight_denied`, which is correct. Binding checks were exercised
against the real intel payload for the first time — `chain` is absent from the live card and is
skipped rather than treated as a mismatch. 172 tests pass. Nothing was deployed, no process was
restarted, no money moved. See [contract](bounty-board-contract.md) and
[dry-run evidence](../artifacts/bounty-live-dryrun/live-dryrun.json).
