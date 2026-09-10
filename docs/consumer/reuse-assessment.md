# Consumer purchasing: reuse assessment

Inspected 2026-09-10. This is a source-code assessment, not a claim that these components have been deployed together.

The consumer layer should serve one offer and a reusable purchase task, then use the merchant's existing checkout. TWZRD evaluates the mandate and supplies evidence. Witness continues to sell independent observations; its payment receipt does not confirm a Shopify order.

| Existing piece | Location | Reuse and boundary |
| --- | --- | --- |
| Canonical JSON and Ed25519 signing | `witness/src/receipt.js` | Reuse canonicalization and crypto primitives; give mandates and decisions separate signature domains and keys. An observation receipt is not a purchase mandate. |
| Persistent signing keys | `witness/src/keystore.js` | Reuse storage with a consumer-specific directory. Never load the live Witness key as purchase authority. |
| Shopping preapproval harness | `witness/scripts/shopping-preapproval.mjs` | Reuse its quote-before-pay sequence and verified-evidence rule. Its DummyJSON target is a fixture; its direct wallet loop is not merchant checkout or a cumulative spending boundary. |
| Canonical payment intent | `twzrd-trust/twzrd-x402-gate/src/intent.ts`, `intent-adapters.ts` | Existing AP2-style cart adapter maps merchant, payee, currency, total, checkout URL and mandate into PaymentIntent. It is explicitly a reference adapter, not a Shopify UCP client or AP2 signature verifier. |
| Mandate policy | `twzrd-trust/twzrd-x402-gate/src/policy-runtime.ts` | Reuse purpose/resource restrictions, counterparties, amount limits and fixed decisions behind an adapter. Verify signed mandates first; unsigned policy objects alone are not authorization. USD naming/conversion means do not pass arbitrary currencies through it. |
| Spend controls | `twzrd-trust/twzrd-x402-gate/src/spend-control.ts`, `spend-ledger-file.ts` | Reuse policy semantics. File ledger explicitly does not support cross-process sharing; use transactional reservation storage for a server handling concurrent purchases. A ledger records spend but does not by itself prevent signing outside the gate. |
| Evidence and purchase lifecycle | `twzrd-trust/agent-commerce-kit/contract/agent-commerce-loop.schema.json`, `twzrd-x402-gate/src/payment-decision.ts`, `outcome-attestation.ts` | Reuse separate settlement/delivery statuses, durable IDs, subject-bound decisions and house/sponsored/external attribution. Kit simulator is not live commerce evidence. |
| Mandatory signer participation | `wzrd-final/packages/twzrd-cosigner/` | Existing payer-controlled Turnkey 2-of-2 child organization makes TWZRD a required voter. Supports decoded Solana transactions; it does not gate Shopify cards/Shop Pay or prove Base support. Do not build a new custodial signing service around a generic endpoint. |
| V7 freshness commitment | `worktrees/codex-v7-e2e-2026-09-09/crates/twzrd-receipt/src/v7.rs`, `sdk/src/intel-v7.test.ts` | V7 commits reputation freshness along with the V6 reputation commitment. Reuse verified freshness when consuming reputation, without treating reputation as merchant identity, license, fulfillment, or spending permission. V7 is present in migration worktrees; no `/home/twzrd/v7` repository exists. |

`twzrd-trust` is a public mirror. Only its gate contains a buildable source/test surface; other top-level published artifacts should not be rebuilt from incomplete mirror scripts. All referenced repositories remain unmodified.

## What must be added

1. Public offer HTML and matching JSON, read-only previews, and a task template with no inherited spending permission.
2. Merchant-authenticated final quote adapter. Catalog prices are discovery data; they are not final totals including applicable tax and fees.
3. Operator-signed, subject-bound mandate verification and a transactionally reserved total budget. Bind merchant, payee, product/variant/quantity, currency, license and terms; reject altered or expired input.
4. Private status and signed eligibility decisions with durable idempotency. A pending payment must retain capacity and reconcile rather than initiating a new payment.
5. One supported signer/payment adapter with no bypass by the purchasing agent before advertising autonomous completion. Until then, the result is `handoff_required`, with `payment_authorized:false` and `order_status:not_created`.

## Verified Shopify boundary

Six stores returned valid UCP discovery JSON, tool schemas and Catalog `get_product` results containing `checkout_url`; see the dated research artifact. Calls used Shopify's documented example profile solely for read-only diagnostics. This is not a registered TWZRD integration or direct-completion test.

The [Checkout MCP documentation](https://shopify.dev/docs/agents/carts-and-checkout/checkout-mcp) says general access finishes via the merchant's `continue_url`; authenticated higher-trust integrations may complete eligible sessions. Preserve escalation and use the protocol's idempotency keys. The [Storefront Catalog documentation](https://shopify.dev/docs/agents/catalog/storefront-catalog) supplies the example profile and request schemas used here.

Do not add an x402 payment in front of an ordinary Shopify order. A standard x402 payment does not guarantee arbitrary metadata/memo support, and a transaction hash is neither purchase authorization nor authentication for private order status. Any future external-payment bridge requires merchant agreement and a durable purchase record spanning both systems.

The [current Shop skill](https://shop.app/SKILL.md) differs from the pasted description: it documents a CLI and delegated budget commands. Its checkout section still explicitly calls for purchase-detail confirmation before completion, including its delegated-budget path. A merchant-issued payment instrument and eligible session are also required. Treat this as a changing third-party integration contract, not proof that every agent is authorized to pay. Read its current safety and legal conditions before choosing it for a commercial integration.

## Pilot measurement

Count an external purchase only after authenticated merchant order confirmation. Keep `policy_denied`, `policy_allowed_handoff_required`, `payment_pending`, `order_pending`, `confirmed`, `delivered`, and `refunded` distinct. A UTM click provides referral information, not an authenticated order join; confirmed conversion needs merchant reporting, a partner webhook/API, or buyer-consented order evidence. No partnership, purchase, or organic conversion was established by this research.
