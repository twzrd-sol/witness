# Reconciliation checklist — `codex/bounty-http-loop-20260910` -> `/home/twzrd/witness`

Measured 2026-09-10 ~20:00 UTC: branch `d66f6d8` vs the shared tree's **working copy**
(shared tree HEAD is still `868056a`; its edits remain uncommitted).

**Do not `git merge` this branch.** Reconcile file by file with the table below. The branch is a
snapshot of a moving tree, and for two files the snapshot is *ahead* of the shared tree, not behind.

## APPLIED to the shared tree 2026-09-10 ~20:05 UTC

All three rows are done. Shared tree `/home/twzrd/witness` went **157/157 -> 158/158 green**, and
the newly landed test passes there:

```
✔ parseable JSON primitives are bad_seller_offer, not bad_json
```

- `src/server.js` — parser guard applied (one line). File was already `M` before; still `M`.
- `test/seller-route.test.js` — branch test appended; file is now byte-identical to `d66f6d8`.
- `src/openapi.js` — **untouched**, sha256 `e3dd2222…` before and after, as the table required.

Nothing else in the shared tree changed: `git status --short` lists exactly the same six modified
and sixteen untracked entries as before the edit. Nothing staged, nothing committed, shared tree
still at HEAD `868056a`. Pre-edit copies of all three files, with hashes, are in
`~/_preserve-witness-reconcile-20260910/`.

**Heads-up for whoever owns the shared tree:** the Witness instance on port 4039 (pid 3076006)
started 17:50 UTC and now runs code older than disk. It still answers `bad_json` for a `42` body.
Restart it to pick up the guard. Port 4032 is production and was not touched.

## Measured drift: 3 of 23 committed source files

Nineteen files are byte-identical or exist only on the branch. Only three differ:

| File | Direction | Action |
|---|---|---|
| `src/server.js` | **Branch ahead** (1 line) | Take the branch line |
| `test/seller-route.test.js` | **Branch ahead** (1 test) | Take the branch test |
| `src/openapi.js` | **Neither ahead** (block moved) | Keep the **shared tree's** layout, discard the branch's |

Branch-only, no conflict possible: `src/bounty-board.js`, `src/bounty-listen.js`,
`src/bounty-openapi.js`, `test/bounty-board.test.js`, `scripts/bounty-internal-loop.mjs`,
`scripts/bounty-live-dryrun.mjs`, `scripts/lib/bounty-fixture.mjs`,
`scripts/verify-bounty-receipt.mjs`.

Identical, nothing to do: `src/listen.js`, `src/mcp.js`, `src/discovery.js`, `src/seller.js`,
`src/bounties.js`, `src/routes/seller.js`, `src/routes/bounties.js`, `test/mcp.test.js`,
`test/mcp-probe.test.js`, `test/seller.test.js`, `test/openapi.test.js`, `package.json`,
`package-lock.json`.

### `src/server.js` — the branch carries the agreed error taxonomy; the shared tree does not

```js
// branch (correct):
express.json({ limit: "64kb", strict: !req.path.startsWith("/seller/") })(req, res, next);
// shared tree:
express.json({ limit: "64kb" })(req, res, next);
```

Express's default `strict: true` rejects top-level JSON primitives in the body parser, so `null`,
`42`, `true` and `"offer"` never reach the seller handler and surface as `bad_json`. The settled
contract is: unparseable body -> `bad_json`; **parseable** body of the wrong shape (primitives
included) -> `bad_seller_offer`. Relaxing `strict` only under `/seller/` is what routes those
primitives to the handler that classifies them correctly.

Verified 2026-09-10 by substituting the shared tree's line into the branch and re-running
`test/seller-route.test.js`: **4 pass, 1 fail** — `parseable JSON primitives are
bad_seller_offer, not bad_json`. Reverted immediately; branch restored, 172/172 green.

The shared tree does not currently ship this behaviour and has no test covering it. Taking the
branch's line and its test is a fix going in, not peer work being clobbered.

### `test/seller-route.test.js` — one test present only on the branch

The branch appends `parseable JSON primitives are bad_seller_offer, not bad_json`, which pins the
contract above so it does not get "fixed" back later. Take it.

### `src/openapi.js` — same declarations, two independent TDZ fixes

Both trees hit the same bug (bounty schemas referencing `out()` before its initializer) and fixed
it differently:

- Branch: hoisted **only** `out` to the top of the file.
- Shared tree: moved the **whole helper block** (`body`, `out`, `textOut`, `pub`, `quoteRequest`,
  `EXAMPLE`, `badRequest`) above `bountyRecordSchema`.

The declarations and their values are identical in both; only their position differs. There is no
behavioural difference and nothing to preserve from the branch. **Keep the shared tree's version
outright** — it is the newer edit and the tidier fix. Re-run the suite afterwards; the branch's
bounty schema additions must still resolve `out` at module-eval time.

## Also on this list

- **`.gitignore` consolidation** (deferred from the amend request). `node_modules` in a linked
  worktree is a **symlink**, and `node_modules/` with a trailing slash matches directories only —
  which is why line 2 (`/node_modules`) exists and is *not* redundant. If you want one line
  instead of two, replace both with a bare `node_modules`: it matches directories, symlinks, and
  nested copies at any depth. Fold this into reconciliation; do not amend `d66f6d8` for it.
- **Shared-tree ownership.** Two sessions independently stood up a Witness instance for the same
  seller route within one minute (4039 from the shared tree at 17:50:46, 4042 from this worktree
  at 17:52:02), and `src/openapi.js` drifted between snapshot and commit. Before the next
  workstream: one session owns `/home/twzrd/witness` at a time; everyone else works in a worktree
  and reconciles through that owner.

## Order of operations

1. Leave `d66f6d8` alone. No amend.
2. Apply this table by hand. Run `npm test` in the shared tree after each file.
3. Operator supplies enrolled wallets + the 0600 actors file. **No further code before this.**
4. Re-run `scripts/bounty-live-dryrun.mjs` — expect `allow` + `can_spend: true`.
5. Run one external agent through the loop. First real evidence artifact.
6. Settlement adapter last; receipts stay `not_paid` until it exists and independently confirms
   amount, payee and network.
