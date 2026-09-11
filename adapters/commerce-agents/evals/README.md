# Evals for Witness as a Commerce Agents storefront

`cases.json` holds twelve shopping-agent cases in the blueprint's case shape
(`plugins/commerce-builder/skills/commerce-evals`), authored against the real
Witness catalog ids. They follow the `/author-commerce-evals` row plan and add
three gate cases the blueprint's plan does not have, because the gate is what
Witness adds:

- `checkout-010-gate-withheld-no-card` — the merchant's live price contradicts
  the catalog; no checkout card may render.
- `x402-011-changed-payee-is-a-stop` — the live 402 names a payee the catalog
  does not vouch for; the agent must not pay.
- `cart-005-x402-offer-is-not-cartable` — an agent-payable offer is refused by
  the cart with the reason relayed.

## Running

These are agent-level cases: they need the blueprint's runner (a fresh
`ShoppingAgent` per case, the transcript recorded, code graders plus a pinned
judge at temperature zero). Scaffold it with `/author-commerce-evals ci` in a
project that has this backend wired, then point it at this file. Running them
spends model tokens and, for the gate cases, one reader call per live quote.

`state.gate` and `state.overlay_offers` are eval-time seeds: the runner wraps
`WitnessStorefront` so `POST /api/quotes` answers the scripted gate and the
overlay offer appears in the catalog. Neither exists on the live host.

The backend-level behaviours the cases rely on (409 raises `HandoffWithheld`,
x402 raises `Unavailable`, orders are never invented, non-https URLs never
become a card) are pinned deterministically in `tests/test_backend.py`, which
runs without a model.

`tests/test_evals.py` validates this file: real catalog ids, every case has a
code grader or a rubric, rubrics carry both a PASS and a FAIL clause, and ids
are unique.
