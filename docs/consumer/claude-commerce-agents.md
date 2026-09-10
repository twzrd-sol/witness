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

| Blueprint | Witness (this branch) |
| --- | --- |
| Catalog / `search_products`, `get_product_detail` | `GET /api/offers/:id` returns the offer record; `OFFERS` is the catalog (one entry today). |
| Cart + `prepare_checkout(cart)` returning a URL | `POST /api/quotes {offer_id, quantity}` returns `cart` (items, subtotal, currency) and `checkout_url` at the merchant. |
| Checkout card rendered by the host | `GET /offers/:id` HTML: outcome, price, license, **Buy now** (merchant cart URL). |
| Skill / task the agent executes | `GET /api/offers/:id/task.json`: intent, requirements, merchant links, price. |
| `checkout` delegated, payment stays at merchant | `checkout: "merchant_hosted"` on the offer and the quote. Payment completes on the merchant's Shopify checkout. |
| Grounding: facts come from the backend, not the model | Price and variant come from the offer record, never from request JSON. |

The earlier framing on this branch stamped every quote response with
`handoff_required`, `payment_authorized:false`, and
`enforcement_scope:eligibility_only`, treating merchant checkout as a
limitation to be disclaimed. The blueprint treats it as the design, and this
branch now does the same: the quote is a cart plus a merchant checkout URL.
What stays are the factual labels: the price is `observed_item_price` (tax and
fees set the total at checkout), the task template carries
`authorization:null` (the recipient supplies authority and budget), and the
page says there is no merchant partnership. Those are true statements about
the surface, not stub markers.

## What Witness adds that the blueprint leaves open

The blueprint's provenance gates check *which tool* produced a value. They do
not check whether the merchant's page actually says what the agent claims it
says at the moment of purchase. That is Witness's job:

- **Pre-checkout observation.** `POST /witness` (x402-paid) fetches the
  merchant page, extracts the price, and returns a signed receipt with
  `verdict: supported | contradicted | incomplete | stale | unable_to_verify`.
  The shopping-preapproval harness (`scripts/shopping-preapproval.mjs` on
  the `pilot/offers-handoff` lineage, not yet on master) turns that verdict
  into an approve/block decision (`decideGate`) before a simulated checkout.
- **Where it plugs in.** Between "cart built" and "checkout URL rendered": a
  `StorefrontBackend.prepare_checkout` implementation can call Witness with
  the offer's `product_url` and the expected `price_minor`, and refuse to
  return the checkout URL on `contradicted` or `stale`. That is a
  provenance gate on the *merchant's live page*, not on the agent's own
  tool outputs.
- **Portable evidence.** The receipt is verifiable offline
  (`verifyReceipt` in `src/receipt.js`), so the buyer, the merchant, or a
  card network can check after the fact what the page said when the agent
  decided to buy.

## What would make Witness a blueprint backend

1. A `StorefrontBackend` adapter (Python, in the blueprint's package layout)
   whose `search_products` reads `GET /api/offers/:id` (or a list endpoint,
   once there is more than one offer), and whose `prepare_checkout` posts to
   `POST /api/quotes` and returns `checkout_url`.
2. A Witness call inside `prepare_checkout`, gated by the preapproval
   verdict, with the receipt attached to the checkout card the host renders.
3. Evals authored with `/author-commerce-evals` covering the
   contradicted-price path, so the gate is exercised, not assumed.

## Sources

- [anthropics/commerce-agents](https://github.com/anthropics/commerce-agents)
- [Anthropic debuts Claude features focused on agentic commerce — Digital Commerce 360, 2026-09-02](https://www.digitalcommerce360.com/2026/09/02/anthropic-debuts-claude-features-focused-on-agentic-commerce/)
- [Anthropic built the shopping brain and skipped the wallet — PYMNTS](https://www.pymnts.com/news/artificial-intelligence/2026/anthropic-built-the-shopping-brain-and-skipped-the-wallet/)
- [Claude Commerce Agents: Apache-2.0 blueprint — MarkTechPost, 2026-09-03](https://www.marktechpost.com/2026/09/03/anthropic-released-claude-commerce-agents-an-apache-2-0-blueprint-for-shopping-and-merchant-agents-across-retail-travel-telecom-and-entertainment/)
