# Witness as a Claude Commerce Agents backend

`witness_storefront.WitnessStorefront` implements the blueprint's
[`StorefrontBackend`](https://github.com/anthropics/commerce-agents/blob/main/shopping-agent/core/shopping_agent/backend.py)
over the Witness offer surface, so the blueprint's shopping agent can run against it
on the Messages API, the Agent SDK, or Managed Agents without changes.

| Backend method | Witness route | Notes |
| --- | --- | --- |
| `search_products` | `GET /api/offers` | One plain product per offer; the rail (`merchant_checkout` / `x402`) is the category. |
| `get_product_details` | `GET /api/offers/{id}` | Specs carry the license link and the source the price is verified against. |
| cart methods | in memory, per session | Only `merchant_checkout` offers; an `x402` offer raises `Unavailable` and points at its task. |
| `checkout_handoff` | `POST /api/quotes` | One gated merchant checkout URL per line. **A 409 raises `HandoffWithheld`**: the merchant's live price no longer matches, so no checkout card is rendered. |
| `get_orders` / `get_order` | none | Witness never places an order; empty / None. |
| `search_policies` | catalog license links | Plus one fixed passage on how checkout works. |
| `get_fulfillment_options` | catalog | Digital delivery, no fee. |

## Install

The blueprint's packages are unpublished, so install them editable from a checkout first:

```bash
git clone https://github.com/anthropics/commerce-agents
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -e commerce-agents/commerce-common -e commerce-agents/shopping-agent/core
uv pip install --python .venv/bin/python -e '.[dev]'
.venv/bin/python -m pytest            # fakes only
WITNESS_LIVE=1 .venv/bin/python -m pytest   # plus one test against witness.outbid.sh
```

## Use

```python
from shopping_agent import ShoppingAgentConfig
from shopping_agent_runtime import ShoppingAgent
from witness_storefront import WitnessStorefront

agent = ShoppingAgent(
    backend=WitnessStorefront(),  # https://witness.outbid.sh
    skills_dir=Path("commerce-agents/shopping-agent/skills"),
    config=ShoppingAgentConfig(brand_name="Witness offers", enable_orders=False),
)
```

Set `enable_orders=False`: there is no order history to show. Witness never pays,
reserves, or creates order state; neither does this adapter.
