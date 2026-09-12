# Witness offers and Claude Commerce Agents

2026-09-10. How the consumer offer surface on this branch lines up with Anthropic's
Claude Commerce Agents blueprint (released 2026-09-02, Apache-2.0,
`anthropics/commerce-agents`), and where TWZRD/Witness adds something the
blueprint deliberately leaves out.

## What Anthropic shipped

- Two agent designs: a **shopping agent** (search catalog, compare, build cart,
  hand off to checkout, order/policy Q&A, memory) and a **merchant agent**
  (analytics, listings, inventory, pricing, campaigns, every write staged
  behind a human approval gate).
- One definition of prompt, skills, tool contracts, and gates, runnable on the
  Messages API, the Claude Agent SDK, and Managed Agents.
- A `StorefrontBackend` interface the shopping agent talks to:
  `search_products`, `get_product_detail`, `get_order_status`, `get_policy`,
  and `prepare_checkout(cart) -> checkout URL`.
- A safety harness enforced inside the tool call: role fencing, provenance
  gates on tool-produced values, caps, memory validation, grounding checks.
- Four vertical examples (retail, travel, telecom, entertainment) and a Claude
  Code plugin (`/scaffold-commerce-agent`, `/add-commerce-flow`,
  `/author-commerce-evals`, `/review-commerce-agent`).

What it explicitly does **not** ship: a payment protocol, a checkout, a product
catalog, an ad layer, or any transaction routed through Anthropic. The agent
builds the cart and returns a checkout URL. The merchant keeps checkout and the
payment. Visa, Mastercard, Accenture, and Shopify are partners on the far side of
that handoff.

## Mapping to this branch

| Blueprint | Witness |
| --- | --- |
| Catalog / `search_products`, `get_product_detail` | `GET /api/offers/:id` returns the offer record; `OFFERS` is the catalog. Two rails: `merchant_checkout` (Pixel Surplus, card at the merchant) and `x402` (outbid Reader, USDC 0.005 per call, agent pays). |
| Cart + `prepare_checkout(cart)` returning what the host needs to pay | `POST /api/quotes`. Merchant rail: `{offer_id, quantity}` returns `cart` and `checkout_url`. x402 rail: `{offer_id, input:{url}}` returns the resolved `request` and the live `accepts[]` to settle against. |
| Checkout card rendered by the host | `GET /offers/:id` HTML: outcome, rail, price, license, **Buy now** (merchant rail). |
| Skill / task the agent executes | `GET /api/offers/:id/task.json`: intent, requirements, merchant or resource, price. Both tasks route the agent through the gated quote first. |
| Payment stays outside the agent | `checkout: "merchant_hosted"` or `checkout: "x402"`. Witness never pays, reserves, or creates order state on either rail. |
| Grounding: facts come from the backend, not the model | Price, variant, payee, and checkout origin come from the offer record, never from request JSON. |

The stamps the first cut carried (`handoff_required`, `payment_authorized:false`,
`enforcement_scope`) are gone. What stays are the factual labels: the merchant
price is `observed_item_price` (tax and fees set the total at checkout), the
task template carries `authorization:null` (the recipient supplies authority
and budget), and the page says there is no merchant partnership.

## What Witness adds that the blueprint leaves open

The blueprint's provenance gates check *which tool* produced a value. They do
not check whether the counterparty still says, at the moment of purchase, what
the catalog claims. Witness does, inside `prepare_checkout`:

- **Merchant rail: the price is re-observed before the URL is handed over.**
  Each merchant offer carries a Witness method (`verified_by` on the catalog
  record): the merchant's public product record, the fields to extract, and
  the assertion `price == <catalog cents>`. `POST /api/quotes` runs it through
  the free quote path (no signing, no billing, no observation written). Only
  a `supported` verdict returns `checkout_url`. `contradicted`, `incomplete`,
  `unable_to_verify`, and any retrieve failure withhold it with a 409 whose
  `gate.observed` shows what the merchant actually says. Fail-closed, the
  same rule as `decideGate` in `scripts/shopping-preapproval.mjs`.
- **x402 rail: the payee is re-checked before the agent is told where to pay.**
  The catalog vouches for specific `accepts[]` (network, payee, amount, asset).
  The quote probes the live resource unpaid, expects a 402, and returns only
  the live entries that match the catalog. A changed payee or amount withholds
  with a 409 that shows the live challenge. This is the implementation
  contract's "changed payee cannot retain prior approval", on the agent rail.
- **Cost and abuse bounds.** A gate run costs the operator one reader call, so
  results are cached per offer for five minutes and a cache miss shares the
  `POST /quote` per-IP limiter (429).
- **Portable evidence remains the paid product.** The gate uses the free quote;
  an agent that wants a signed, offline-verifiable receipt of the observation
  pays `POST /witness` with the same method (`verifyReceipt` in `src/receipt.js`).

## Witness as a blueprint backend

`adapters/commerce-agents/` ships `witness_storefront.WitnessStorefront`, a
`StorefrontBackend` over these routes, so the blueprint's shopping agent runs
against Witness unchanged on the Messages API, the Agent SDK, or Managed Agents:

- `search_products` / `get_product_details` read `GET /api/offers` and
  `GET /api/offers/{id}`; each offer is one plain product with the rail as its
  category.
- The cart is in memory per session; `x402` offers raise `Unavailable` (the
  agent pays those per call, not through a cart).
- `checkout_handoff` posts each line to `POST /api/quotes`. A 200 becomes the
  merchant `CheckoutHandoff`; a 409 raises `HandoffWithheld`, so the host never
  renders a checkout card for a price the merchant no longer says.
- No orders are invented; policies come from the license links plus one
  passage on how checkout works.

Tests run against a fake Witness by default and against the public host with
`WITNESS_LIVE=1`. Remaining: evals authored with `/author-commerce-evals`
covering the contradicted-price and changed-payee paths.

## Sources

- [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents)
- [Anthropic debuts Claude features focused on agentic commerce — Digital Commerce 360, 2026-09-02](https://www.digitalcommerce360.com/2026/09/02/anthropic-debuts-claude-features-focused-on-agentic-commerce/)
- [Anthropic built the shopping brain and skipped the wallet — PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/anthropic-built-the-shopping-brain-and-skipped-the-wallet/)
- [Claude Commerce Agents: Apache-2.0 blueprint — MarkTechPost, 2026-09-03](https://www.marktechpost.com/2026/09/03/anthropic-released-claude-commerce-agents-an-apache-2-0-blueprint-for-shopping-and-merchant-agents-across-retail-travel-telecom-and-entertainment/)
