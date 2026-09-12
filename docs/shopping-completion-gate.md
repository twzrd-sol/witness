# Shopping preapproval: mechanical completion gate

## Done predicate (first)

`completion === "complete" && checkout_approved === true` means only that the
shopping **preapproval** predicate passed. It does not mean a purchase happened.
The actual `runOnce({ mode: "live", ... })` path must receive a receipt and obtain
an accepting result from `scripts/verify-shopping-receipt.mjs`, launched as a
separate OS process. Actor narration, quote verdicts, HTTP 200, and success flags
cannot satisfy this predicate.

The fixed offline child reuses `src/receipt.js`'s `verifyReceipt` (Ed25519),
`evalAssertion`, canonicalization, and `src/observatory.js`'s method hash and
one-hour validity contract. It requires:

- Signature under an independently supplied pinned Ed25519 SPKI public key.
- Exact expected method (source URL, retrieval, extraction, assertion), matching
  signed spec hash, requested URL and top-level assertion. The expected purchase
  is the existing fixed `GATE_METHOD` card, not a method learned from the receipt.
- Valid observation/expiry times, exactly the contract's one-hour lifetime,
  not future-observed, and not expired (expiry boundary blocks).
- Receipt evidence fields, numeric price, supported verdict, and a price value
  that satisfies the expected assertion.

The parent requires successful process exit plus a structured accepting report
bound to receipt hash, expected method, key hash and child PID. Missing evidence,
malformed output, process launch failure, timeout, crash, or mismatches leave
`completion: "incomplete"`, `checkout_approved: false`. The process has a five
second deadline, bounded output, and a minimal environment without inherited
Node preload options. No wallet is passed to it.

## Configuration and compatibility

Live CLI adds `--trusted-pubkey=<base64 DER SPKI public key>`; the existing
`--keypair` identifies the paying wallet, not the verification key. Provision
the public pin through an independent trusted channel **before** running the
buyer. Missing/malformed pins block before a quote, wallet read, or payment.
The script no longer fetches `/pubkey` from the same host after paying.

Dry mode remains quote-only, no wallet or payment: legacy `approve`, `decision`
and zero exit on supported quote describe the **simulation**. Dry mode always
reports `completion: "incomplete"`, `checkout_approved: false`, and
`check.reason: "not_run"`. Do not use dry CLI exit status as proof of completion.
`decideGate` remains a simulation helper, not a live authorization API.
CLI `process.exit(0)` is reserved for `checkout_approved === true`. A supported
dry quote still prints `approve: true` for the simulation, then exits 1.

`logRun` persists completion, checkout approval, the mechanical check (including
hashes/PID/time on valid evidence), and payment-attempt status. A POST attempt
sets `payment_attempted: true`, `payment_status: "unknown"`; `paid` stays false
(unconfirmed), never becomes proof of settlement. No settlement checker is added.
The injectable `paymentTransport` is a trusted programmatic test seam, unavailable
as a CLI option; tests supply fixture receipts without loading a wallet.

## Trust boundary and limitations

Separate process means **fault separation, not hostile same-user isolation**.
The caller/operator, pinned-key configuration, expected method, local clock,
Node runtime, verifier code and filesystem remain trusted. An adversary that can
rewrite code or control the caller can bypass this harness. A report is not a
signed authorization token for another service. This script still models checkout;
no real merchant checkout is implemented.

The deployed `/witness` shape is the existing v1 signed receipt, not the v2
retained-source bundle consumed by `verifyEvidence`. Do not silently convert one
into the other or claim full source replay: a display snippet may be truncated.
This gate verifies the v1 signature, binding, freshness and assertion consistency;
it does not independently refetch the source, establish source truth, prove
settlement/delivery, or prevent reuse within the signed validity window.

## Offline verification

From this worktree with Node 24 on PATH:

```sh
node --test test/shopping-completion.test.js test/shopping-preapproval.test.js test/shopping-mandate.test.js test/human-checkout-untouched.test.js
npm test
git diff --check
```

The mandate-bound digital-product Done-gate (no store URL required;
`SHOPIFY_STORE_URL` no-ops until set; human checkout untouched) is documented
in `docs/consumer/shopping-mandate.md`.

Tests use ephemeral signing keys and local fixtures. They exercise the live
control path with payment transport replaced, real child verification, tampering,
wrong key/method/source, missing evidence, stale/future timestamps, inconsistent
price, verifier crash/timeout/malformed output, success-flag-only output, dry
semantics and persisted check evidence. No network payment is performed.
