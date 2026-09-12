# Human-commerce depth test (no-purchase experiment)

Date: 2026-09-11. Operator-run. Recorded as product evidence, not a failed experiment.

## Result: no purchase

- Wallet spend: none (0.2 SOL untouched).
- Swap: proposed, never approved; left to expire. Do not approve later.
- Card obtained: no.
- Shopify form submitted: no.
- Merchant order or payment created: no.
- Merchant contacted: no.
- Browser closed at the end of the attempt.

## What was measured

The full human-rail stack for a $6 digital product (Pixel Surplus frames,
`pixel-surplus-vintage-polaroid`):

```text
crypto → passkey-gated swap → USDC → prepaid card issuer → card form → Shopify
```

- Overhead: $1.50–6.50 on a $6 item (prepaid card at 3%, min $0.50, plus swap friction).
- The card issuer was down for the whole attempt.
- Every checkout field (card number, CVV, name, email, billing address) is a
  human identity artifact. An agent holds none of them natively.

## Finding

Checkout requires rented human identity plus fixed overhead that swamps
low-value digital goods. Shopify/UCP is a useful handoff surface; it is not
the native destination for autonomous agents. A card is an identity costume,
not an agent identity — the wallet that pays already is one, and settlement
already is authentication.

## Consequence

- The Witness offer surface stays positioned as a handoff adapter
  (discovery, observed price/license, merchant checkout URL, explicit
  non-partnership language), not the autonomous-commerce product.
- The native product loop is preflight + signed receipt + counterparty
  quality over agent-priced A2A resources where repeat multi-payer demand is
  provable and a pre-spend check is economically justified.
- No Shopify payment adapter until agent payment authorization, buyer
  mandate, merchant quote binding, private order reconciliation, and a
  wallet-identity-preserving rail exist.
