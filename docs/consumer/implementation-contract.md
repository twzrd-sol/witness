# Consumer pilot implementation contract

2026-09-10. Reviewable implementation target; not a statement of shipped functionality.

## First offer

Pixel Surplus, Vintage Polaroid Photo Frames, Desktop Commercial Use License, variant `46117070209071`. Catalog observed USD 600 minor units on 2026-09-10. The observed price is not a final quote. Public product: `https://pixelsurplus.com/products/vintage-polaroid-photo-frames`. Catalog-returned cart permalink: `https://pixel-surplus.myshopify.com/cart/46117070209071:1`.

The consumer page leads with the outcome: “Give your photos a vintage finish.” Explain that the buyer receives 22 PNG frames. Link directly to the merchant and provide an adjacent copyable agent task. Show the merchant, estimated item price, license selection, and delivery expectations. Do not claim partnership, guaranteed price, autonomous payment or fulfillment verified by TWZRD.

The reusable task asks an agent to obtain the correctly licensed pack, use it in a flattened photo composition, and return the finished output plus private order evidence. It instructs the recipient to supply fresh authority and an all-in budget. No original mandate, signature, wallet identity, email, shipping data, private order URL or purchased files enter the public template.

## HTTP contract

| Interface | Behavior |
| --- | --- |
| `GET /offers/:id` | Public read-only HTML. No checkout creation, reservation or paid observation. |
| `GET /api/offers/:id` | Same public offer as structured data, with `agent_execution:handoff_only` and `price_kind:observed_item_price`. |
| `GET /api/offers/:id/task.json` | Reusable intent and requirements; `authorization:null`. |
| `POST /api/quotes` | Without a configured authenticated merchant adapter: `handoff_required`, `final_quote_required`, public merchant link. With adapter: authenticated, subject-bound final quote. |
| `POST /authorize-purchase` | Authenticated subject + trusted operator-signed mandate + server-issued quote ID + durable purchase ID. Policy decision and evidence only until a tested payment adapter exists. |
| `GET /api/purchases/:id` | Authenticated same-subject status. Does not infer paid status from a decision or handoff. No transaction hash as authentication. |

## Mandate and quote binding

Canonical signed mandate fields: schema/domain version, audience, issuer key ID, subject, mandate ID, offer ID, merchant identity, payee identity, product/variant ID, quantity, currency, cumulative maximum total in integer minor units, expiry, recurring policy, license URL and license/terms content digest. Validate schema before verification and policy evaluation; caller-supplied public keys are never a trust anchor.

The final quote comes from the server's configured merchant adapter, not the caller's JSON. It must include all applicable tax, delivery and service fees; bind the quote to the authenticated subject and selected variant/quantity. Persist immutable quote IDs and content digests. A terms URL alone is not a commitment to its changing contents. A merchant display name is not a cryptographic merchant/payee identity.

Reject expired quotes, stale/unknown counterparty evidence, unavailable inventory, unknown totals, missing license/terms, changed payee, unsupported rail, malformed amounts and out-of-budget requests. A new price within an expressly flexible mandate may be re-evaluated without a new human prompt; changed required terms or unsupported authority cannot be silently waived.

## Durable eligibility decisions

Use SQLite transactions for the single-host pilot. A `BEGIN IMMEDIATE` transaction checks aggregate reserved capacity, binds mandate ID to immutable payload hash, and inserts a unique purchase ID with its immutable request hash before issuing the decision. Duplicate identical requests retrieve the original result. Duplicate identifiers with different input return `idempotency_conflict`; they never place another order.

Do not hold a database transaction over a remote trust/merchant request. Refresh and authenticate evidence first, then atomically check its validity and reserve. Ensure two processes cannot independently consume the same budget. On any ambiguous payment result, preserve the reservation and return a reconciliation state; never release it because a local timeout elapsed.

Use a dedicated consumer decision key and separate signature domains for mandates versus decisions. Evidence binds mandate and quote hashes, purchase ID, outcome, reason and time. Until the payment adapter exists, every allowed decision explicitly reports `payment_authorized:false`, `order_status:not_created`, and `enforcement_scope:eligibility_only`. A buyer may change their merchant checkout after handoff; TWZRD cannot enforce the final card charge in that path.

Public links carry only a task and offer identity. Authentication tokens and private session URLs must not be put in URL query parameters, public HTML, JSON-LD, social metadata, logs or optional shares. Read-only previews do not become conversion events. External/house/test attribution comes from server-controlled enrollment, not request body labels.

## Required verification

- Invalid signature, attacker-supplied key, wrong audience/subject, malformed expiry/amount and unsupported currency fail closed.
- Payee, merchant, product/variant, quantity, license or terms changes cannot retain prior approval.
- Missing counterparty adapter or unknown evidence never produces an invented trust score or allow.
- Concurrent $6 requests under a $10 cumulative mandate yield at most one allow; verify across processes and after restart.
- Identical retries preserve the original decision; conflicting retries cannot reuse a purchase ID.
- Expiry is checked at decision issuance, including time spent waiting for remote providers.
- Unauthenticated users and another subject cannot retrieve private quote or purchase state.
- HTML is escaped and non-HTTPS, credential-bearing or unsafe configured URLs are rejected.
- Crawlers and task GETs create no quotes, reservations, checkout sessions or payments.
- Fixtures are labeled, never broadcast, and never count as external conversions.

## Activation prerequisites

Local human handoff can work from public Catalog links. Autonomous purchase cannot be considered complete until TWZRD has its own registered supported agent profile, required buyer authorization, a merchant quote/payment/order adapter, the tested mandatory signer or delegated-payment boundary for that rail, and an authenticated reconciliation channel. Merchant consent is required before representing a partner integration or accessing merchant Admin/webhooks; a public storefront is not that consent.

A final external purchase trial additionally needs a real buyer mandate for the selected product, budget, currency and intended use. The research request and sample $10 ceiling do not authorize buying these products with existing wallet funds.
