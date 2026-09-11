# Copyright 2026 TWZRD. SPDX-License-Identifier: Apache-2.0.
"""Witness-backed StorefrontBackend for the Claude Commerce Agents blueprint.

Maps the blueprint's ``StorefrontBackend`` ABC
(``shopping-agent/core/shopping_agent/backend.py`` in
anthropics/commerce-agents) onto the Witness offer routes:

- catalog   -> ``GET /api/offers/{id}``
- cart      -> session-local lines (spike: swap for a durable store)
- checkout  -> ``POST /api/quotes``; the URL is returned only on HTTP 200.
  A 409 gate refusal becomes :class:`Unavailable` naming ids only — the
  gate's observed merchant values never reach the model.
- x402-rail offers surface in search/details but raise :class:`NotOffered`
  on cart writes: a per-call payable resource is not a cart item.

Run the spike tests (needs the blueprint checkout for imports)::

    PYTHONPATH=/path/to/commerce-agents/shopping-agent/core:/path/to/commerce-agents/commerce-common \\
        python3 -m unittest discover -s adapters -p 'test_*.py'
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable

Fetcher = Callable[[str, str, dict | None], tuple[int, Any]]
"""``(method, url, json_body) -> (http_status, parsed_json_or_None)``."""

try:
    from shopping_agent.backend import StorefrontBackend
except ImportError:  # pragma: no cover - blueprint checkout not on PYTHONPATH
    StorefrontBackend = object


def urllib_fetcher(base_url: str, timeout_s: float = 10.0) -> Fetcher:
    """Default transport over plain urllib (stdlib only)."""

    def fetch(method: str, path: str, body: dict | None = None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            base_url.rstrip("/") + path,
            data=data,
            method=method,
            headers={"content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_s) as res:
                raw = res.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, None
        try:
            return res.status, json.loads(raw) if raw else None
        except ValueError:
            return res.status, None

    return fetch


class WitnessStorefrontBackend(StorefrontBackend):
    """StorefrontBackend over one Witness host. See module docstring."""

    MAX_QUANTITY = 99  # Witness quote bound; the executor clamps first.

    def __init__(
        self,
        base_url: str,
        offer_ids: list[str] | None = None,
        fetcher: Fetcher | None = None,
    ) -> None:
        self._fetch: Fetcher = fetcher or urllib_fetcher(base_url)
        # Deployer-configured catalog seed: Witness has no list endpoint, so the
        # ids served here are explicit, never scraped or guessed.
        self._offer_ids = list(
            offer_ids or ["pixel-surplus-vintage-polaroid", "outbid-reader-scrape"]
        )
        self._carts: dict[str, dict[str, int]] = {}
        self._details_cache: dict[str, dict] = {}

    # -- internal ---------------------------------------------------------

    def _get_offer(self, offer_id: str) -> dict | None:
        if offer_id in self._details_cache:
            return self._details_cache[offer_id]
        status, body = self._fetch("GET", f"/api/offers/{offer_id}", None)
        if status != 200 or not isinstance(body, dict):
            return None
        self._details_cache[offer_id] = body
        return body

    def _cart(self, session) -> "Cart":
        from shopping_agent.types import Cart, CartItem

        lines = self._carts.get(session.session_id, {})
        items = []
        for pid, qty in lines.items():
            offer = self._get_offer(pid)
            if offer is None or offer.get("rail") != "merchant_checkout":
                continue
            items.append(
                CartItem(
                    product_id=pid,
                    title=f"{offer['product']} — {offer.get('variant', '')}".rstrip(" —"),
                    price=offer["price_minor"] / 100,
                    quantity=qty,
                )
            )
        return Cart(items=items, currency="USD")

    # -- Catalog ------------------------------------------------------------

    @staticmethod
    def _to_product(offer):
        from shopping_agent.types import Product

        title = f"{offer['product']} — {offer.get('variant', '')}".rstrip(" —")
        if offer.get("rail") == "x402":
            price = offer.get("price", {})
            return Product(
                product_id=offer["id"],
                title=title,
                brand=offer.get("merchant"),
                price=float(price.get("usd", 0)),
                currency="USD",
                in_stock=True,
                short_description=offer.get("outcome"),
                attributes={"rail": "x402", "price_kind": "fixed_per_call"},
            )
        return Product(
            product_id=offer["id"],
            title=title,
            brand=offer.get("merchant"),
            price=offer["price_minor"] / 100,
            currency=offer.get("currency", "USD"),
            in_stock=True,
            short_description=offer.get("outcome"),
            attributes={
                "rail": "merchant_checkout",
                "price_kind": offer.get("price_kind", "observed_item_price"),
                "license_url": offer.get("license_url", ""),
            },
        )

    async def search_products(self, session, query, filters=None, limit=8):
        q = (query or "").strip().lower()
        out = []
        for oid in self._offer_ids:
            offer = self._get_offer(oid)
            if offer is None:
                continue
            hay = f"{offer.get('product', '')} {offer.get('merchant', '')} {offer.get('deliverable', '')}".lower()
            if q and q not in hay:
                continue
            out.append(self._to_product(offer))
            if len(out) >= limit:
                break
        return out

    async def get_product_details(self, session, product_id):
        from shopping_agent.types import ProductDetails

        offer = self._get_offer(product_id)
        if offer is None:
            return None
        return ProductDetails(**self._to_product(offer).model_dump())

    # -- Cart ---------------------------------------------------------------

    async def get_cart(self, session):
        return self._cart(session)

    async def add_to_cart(self, session, product_id, quantity):
        from shopping_agent.backend import Unavailable
        from shopping_agent.backend import NotOffered

        offer = self._get_offer(product_id)
        if offer is None:
            raise Unavailable(f"{product_id} unavailable: unknown offer")
        if offer.get("rail") != "merchant_checkout":
            raise NotOffered(f"{product_id} is a per-call x402 resource, not a cart item")
        qty = max(1, min(int(quantity), self.MAX_QUANTITY))
        lines = self._carts.setdefault(session.session_id, {})
        lines[product_id] = min(lines.get(product_id, 0) + qty, self.MAX_QUANTITY)
        return self._cart(session)

    async def update_cart_item(self, session, product_id, quantity):
        lines = self._carts.setdefault(session.session_id, {})
        if product_id not in lines:
            return self._cart(session)
        lines[product_id] = max(1, min(int(quantity), self.MAX_QUANTITY))
        return self._cart(session)

    async def remove_from_cart(self, session, product_id):
        lines = self._carts.setdefault(session.session_id, {})
        lines.pop(product_id, None)
        return self._cart(session)

    # -- Customer context -----------------------------------------------------

    async def get_preferences(self, session):
        from shopping_agent.types import UserPreferences

        return UserPreferences(user_id=session.user_id)

    async def checkout_handoff(self, session, cart):
        from shopping_agent.backend import Unavailable
        from shopping_agent.types import CheckoutHandoff

        handoffs = []
        for item in cart.items:
            status, body = self._fetch(
                "POST", "/api/quotes", {"offer_id": item.product_id, "quantity": item.quantity}
            )
            if status == 200 and isinstance(body, dict) and body.get("checkout_url"):
                handoffs.append(
                    CheckoutHandoff(
                        url=body["checkout_url"],
                        label=f"Buy at {body.get('merchant', 'merchant')}",
                        seller=body.get("merchant"),
                    )
                )
                continue
            # 409 (gate withheld), 404, 503, 429, or malformed: no URL, ever.
            # The message names ids only — gate.observed values stay server-side.
            raise Unavailable(f"{item.product_id} unavailable: merchant verification failed")
        return handoffs

    # -- Orders, policies, fulfillment ------------------------------------------

    async def get_orders(self, session, limit=5):
        return []

    async def get_order(self, session, order_id):
        return None

    async def search_policies(self, session, query):
        return []

    async def get_disclosure(self, session, product_id):
        from shopping_agent.types import Disclosure, DisclosureRow

        offer = self._get_offer(product_id)
        if offer is None or offer.get("rail") != "merchant_checkout":
            return None
        return Disclosure(
            title=f"{offer['product']} — facts",
            product_id=product_id,
            rows=[
                DisclosureRow(
                    label="Observed price",
                    value=f"{offer.get('currency', 'USD')} {offer['price_minor'] / 100:.2f}",
                    note="Observed, not a final quote — total shown at merchant checkout.",
                ),
                DisclosureRow(
                    label="License",
                    value=offer.get("variant", ""),
                    note=offer.get("license_url", ""),
                ),
            ],
            footnotes=["No partnership with the merchant. Price and fulfillment are the merchant's, not TWZRD's."],
        )

    async def get_fulfillment_options(self, session, product_ids):
        return []
