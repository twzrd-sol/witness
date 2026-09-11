# First paid run through the agent-rail loop, 2026-09-11

Raw evidence written by `scripts/loop-run.mjs` (the actor) for one Reader call
paid over x402 from the box's payer wallet, then attested by the live host.
`CHECK.txt` is the output of `scripts/loop-check.mjs` (the verifier, a separate
process) run against this directory: ten predicates, all recomputed from these
files, the trusted key fetched from the host, the settlement read from Solana.

Re-run the check yourself:

```bash
node scripts/loop-check.mjs --run=docs/consumer/evidence/loop-run-2026-09-11 --base=https://witness.outbid.sh
```

It needs only these files, `GET /pubkey`, and a Solana RPC. Change one byte of
`response.json` and it answers `INCOMPLETE (receipt_binds_run)`.
