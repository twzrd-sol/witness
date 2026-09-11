# SPDX-License-Identifier: Apache-2.0
"""A ``StorefrontBackend`` for Claude Commerce Agents over the Witness offer surface.

Maps the blueprint's interface onto Witness's HTTP routes:

- ``search_products`` / ``get_product_details`` read ``GET /api/offers`` and
  ``GET /api/offers/{id}``. Each offer is one plain product (no families).
- The cart is held in memory per session, like the blueprint's own examples; only
  ``merchant_checkout`` offers can be carted. An ``x402`` offer is paid per call by the
  agent itself, so ``add_to_cart`` raises :class:`Unavailable` and points at its task.
- ``checkout_handoff`` is where Witness earns its place: it posts each cart line to
  ``POST /api/quotes``, which re-observes the merchant's live product record before
  returning a checkout URL. A 200 becomes one :class:`CheckoutHandoff` per merchant.
  A 409 (the merchant's live price no longer matches the catalog, or it could not be
  verified) raises :class:`HandoffWithheld`, so the host never renders a checkout
  card for a price the merchant no longer says. Fail-closed.
- Orders are not held here (Witness never places one), so ``get_orders`` is empty and
  ``get_order`` is None. Policies come from the offers' license links plus one fixed
  passage on how checkout works.

Witness never pays, reserves, or creates order state. This adapter does not either.
"""

from __future__ import annotations

import asyncio
import json
import re
import urllib.error
import urllib.request
from collections.abc import Awaitable, Callable
from typing import Any

from shopping_agent import (
    Cart,
    CartItem,
    CheckoutHandoff,
    FulfillmentOption,
    Order,
    Policy,
    Product,
    ProductDetails,
    SearchFilters,
    ShoppingSessionContext,
    StorefrontBackend,
    Unavailable,
    UserPreferences,
)

DEFAULT_BASE_URL = "https://witness.outbid.sh"

FetchJson = Callable[[str, str, dict[str, Any] | None], Awaitable[tuple[int, Any]]]


class HandoffWithheld(Exception):
    """``POST /api/quotes`` answered 409: the merchant's live record contradicts the
    catalog price, or Witness could not verify it. ``reason`` is the gate's enum
    (``verdict_contradicted``, ``verify_retrieve_failed``, ...); ``observed`` is what
    the merchant's record actually carried, when it was read. The executor relays any
    non-``NotOffered`` exception as the tool being temporarily unavailable, which is
    the honest state: there is no checkout to present for this price."""

    def __init__(self, offer_id: str, reason: str, observed: dict[str, Any] | None, source: str | None):
        self.offer_id = offer_id
        self.reason = reason
        self.observed = observed
        self.source = source
        detail = f" (merchant record now says {observed})" if observed else ""
        super().__init__(f"checkout withheld for {offer_id}: {reason}{detail}")


def _urllib_fetch_json(timeout: float) -> FetchJson:
    """Stdlib HTTP, run off the event loop. Returns (status, parsed body or None)."""

    def _sync(method: str, url: str, body: dict[str, Any] | None) -> tuple[int, Any]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"accept": "application/json"}
        if data is not None:
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.status, _parse(res.read())
        except urllib.error.HTTPError as e:  # non-2xx still carries a JSON body we want
            return e.code, _parse(e.read())

    async def fetch(method: str, url: str, body: dict[str, Any] | None) -> tuple[int, Any]:
        return await asyncio.to_thread(_sync, method, url, body)

    return fetch


def _parse(raw: bytes) -> Any:
    try:
        return json.loads(raw) if raw else None
    except json.JSONDecodeError:
        return None


_WORD = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


class WitnessStorefront(StorefrontBackend):
    """See the module docstring. ``fetch_json(method, url, body) -> (status, json)`` is
    injectable for tests; the default is stdlib urllib on a worker thread."""

    CHECKOUT_POLICY = Policy(
        policy_id="checkout",
        title="How checkout works",
        category="checkout",
        content=(
            "Each merchant offer is paid for at the merchant's own checkout, not here. Before "
            "the checkout link is shown, Witness re-reads the merchant's public product record "
            "and confirms the listed price is what the merchant still says; if it is not, no "
            "checkout link is offered. The price shown is the observed item price — tax and "
            "fees are added at the merchant checkout. Agent-payable (x402) offers are paid per "
            "call by the agent over x402 and are not added to the cart."
        ),
    )

    def __init__(self, base_url: str = DEFAULT_BASE_URL, *, fetch_json: FetchJson | None = None, timeout: float = 15.0):
        if (
            not base_url.startswith("https://")
            and not base_url.startswith("http://127.0.0.1")
            and not base_url.startswith("http://localhost")
        ):
            raise ValueError("base_url must be https (or loopback for tests)")
        self._base = base_url.rstrip("/")
        self._fetch = fetch_json or _urllib_fetch_json(timeout)
        self._carts: dict[str, dict[str, CartItem]] = {}
        self._offers: dict[str, dict[str, Any]] = {}

    # -- HTTP ---------------------------------------------------------------------

    async def _get(self, path: str) -> tuple[int, Any]:
        return await self._fetch("GET", f"{self._base}{path}", None)

    async def _post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        return await self._fetch("POST", f"{self._base}{path}", body)

    async def _catalog(self) -> list[dict[str, Any]]:
        status, body = await self._get("/api/offers")
        if status != 200 or not isinstance(body, dict) or not isinstance(body.get("offers"), list):
            raise RuntimeError(f"witness catalog unavailable ({status})")
        offers = [o for o in body["offers"] if isinstance(o, dict) and isinstance(o.get("id"), str)]
        self._offers.update({o["id"]: o for o in offers})
        return offers

    async def _offer(self, offer_id: str) -> dict[str, Any] | None:
        status, body = await self._get(f"/api/offers/{offer_id}")
        if status == 404:
            return None
        if status != 200 or not isinstance(body, dict):
            raise RuntimeError(f"witness offer unavailable ({status})")
        self._offers[offer_id] = body
        return body

    # -- Mapping ------------------------------------------------------------------

    @staticmethod
    def _price(offer: dict[str, Any]) -> tuple[float, str]:
        if offer.get("rail") == "x402":
            price = offer.get("price") or {}
            return float(price.get("usd", 0)), str(price.get("asset", "USDC"))
        return round(int(offer.get("price_minor", 0)) / 100, 2), str(offer.get("currency", "USD"))

    @classmethod
    def _product(cls, offer: dict[str, Any]) -> Product:
        price, currency = cls._price(offer)
        rail = str(offer.get("rail", "merchant_checkout"))
        attributes = {
            "rail": rail,
            "checkout": str(offer.get("checkout", "")),
            "merchant": str(offer.get("merchant", "")),
        }
        if rail == "x402":
            attributes["paid_by"] = "agent, per call, over x402"
            attributes["price_kind"] = "per_call"
        else:
            attributes["price_kind"] = str(offer.get("price_kind", "observed_item_price"))
            attributes["paid_at"] = "merchant checkout"
        return Product(
            product_id=offer["id"],
            title=f"{offer.get('product', offer['id'])} — {offer['variant']}"
            if offer.get("variant")
            else str(offer.get("product", offer["id"])),
            brand=offer.get("merchant"),
            price=price,
            currency=currency,
            category=rail,
            labels=[rail],
            attributes=attributes,
            in_stock=True,
            short_description=offer.get("outcome"),
        )

    @classmethod
    def _details(cls, offer: dict[str, Any]) -> ProductDetails:
        base = cls._product(offer)
        specs: dict[str, str] = {}
        if offer.get("variant_id"):
            specs["variant_id"] = str(offer["variant_id"])
        if offer.get("license_url"):
            specs["license"] = str(offer["license_url"])
        if offer.get("product_url"):
            specs["merchant_page"] = str(offer["product_url"])
        verified = offer.get("verified_by")
        if isinstance(verified, dict) and verified.get("source"):
            specs["price_verified_against"] = str(verified["source"])
            specs["price_assertion"] = str(verified.get("assertion", ""))
        resource = offer.get("resource")
        if isinstance(resource, dict):
            specs["resource"] = f"{resource.get('method', 'GET')} {resource.get('url_template', '')}"
        long_description = " ".join(part for part in [offer.get("outcome"), offer.get("deliverable")] if part)
        return ProductDetails(**base.model_dump(), long_description=long_description or None, specs=specs)

    # -- Catalog ------------------------------------------------------------------

    async def search_products(
        self,
        session: ShoppingSessionContext,
        query: str,
        filters: SearchFilters | None = None,
        limit: int = 8,
    ) -> list[Product]:
        del session
        offers = await self._catalog()
        words = _tokens(query)
        scored: list[tuple[float, Product]] = []
        for offer in offers:
            product = self._product(offer)
            if filters:
                if filters.category and filters.category != product.category:
                    continue
                if filters.min_price is not None and product.price < filters.min_price:
                    continue
                if filters.max_price is not None and product.price > filters.max_price:
                    continue
                if any(product.attributes.get(k) != v for k, v in filters.attributes.items()):
                    continue
            haystack = " ".join(
                str(offer.get(k, ""))
                for k in ("product", "variant", "outcome", "deliverable", "merchant", "id", "rail")
            )
            hits = len(words & _tokens(haystack)) if words else 1
            if hits:
                scored.append((hits, product))
        scored.sort(key=lambda pair: (-pair[0], pair[1].product_id))
        products = [product for _, product in scored]
        if filters and filters.sort == "price_asc":
            products.sort(key=lambda p: p.price)
        elif filters and filters.sort == "price_desc":
            products.sort(key=lambda p: -p.price)
        return products[: max(0, limit)]

    async def get_product_details(self, session: ShoppingSessionContext, product_id: str) -> ProductDetails | None:
        del session
        offer = await self._offer(product_id)
        return self._details(offer) if offer else None

    # -- Cart ---------------------------------------------------------------------

    def _lines(self, session_id: str) -> dict[str, CartItem]:
        return self._carts.setdefault(session_id, {})

    def _cart(self, session_id: str) -> Cart:
        lines = list(self._lines(session_id).values())
        currency = str(self._offers.get(lines[0].product_id, {}).get("currency", "USD")) if lines else "USD"
        return Cart(items=lines, currency=currency)

    async def get_cart(self, session: ShoppingSessionContext) -> Cart:
        return self._cart(session.session_id)

    async def add_to_cart(self, session: ShoppingSessionContext, product_id: str, quantity: int) -> Cart:
        offer = self._offers.get(product_id) or await self._offer(product_id)
        if offer is None:
            raise KeyError(product_id)
        if offer.get("rail") == "x402":
            raise Unavailable(
                f"{product_id} is paid per call by the agent over x402, not through the cart; "
                f"see /api/offers/{product_id}/task.json"
            )
        product = self._product(offer)
        lines = self._lines(session.session_id)
        existing = lines.get(product_id)
        total = quantity + (existing.quantity if existing else 0)
        lines[product_id] = CartItem(product_id=product_id, title=product.title, price=product.price, quantity=total)
        return self._cart(session.session_id)

    async def update_cart_item(self, session: ShoppingSessionContext, product_id: str, quantity: int) -> Cart:
        lines = self._lines(session.session_id)
        if product_id in lines:
            lines[product_id] = lines[product_id].model_copy(update={"quantity": quantity})
        return self._cart(session.session_id)

    async def remove_from_cart(self, session: ShoppingSessionContext, product_id: str) -> Cart:
        self._lines(session.session_id).pop(product_id, None)
        return self._cart(session.session_id)

    # -- Customer context ---------------------------------------------------------

    async def get_preferences(self, session: ShoppingSessionContext) -> UserPreferences:
        return UserPreferences(user_id=session.user_id)

    async def checkout_handoff(self, session: ShoppingSessionContext, cart: Cart) -> list[CheckoutHandoff]:
        """One gated merchant checkout URL per cart line. Raises :class:`HandoffWithheld`
        on the first line whose live price Witness could not confirm."""
        del session
        handoffs: list[CheckoutHandoff] = []
        for item in cart.items:
            status, body = await self._post("/api/quotes", {"offer_id": item.product_id, "quantity": item.quantity})
            body = body if isinstance(body, dict) else {}
            gate = body.get("gate") if isinstance(body.get("gate"), dict) else {}
            if (
                status == 200
                and isinstance(body.get("checkout_url"), str)
                and body["checkout_url"].startswith("https://")
            ):
                handoffs.append(
                    CheckoutHandoff(
                        url=body["checkout_url"],
                        label=f"Pay at {body.get('merchant', 'the merchant')}",
                        seller=body.get("merchant"),
                    )
                )
                continue
            if status == 409:
                raise HandoffWithheld(
                    item.product_id, str(gate.get("reason", "withheld")), gate.get("observed"), gate.get("source")
                )
            raise RuntimeError(
                f"witness quote failed for {item.product_id} ({status}: {body.get('reason', 'unknown')})"
            )
        return handoffs

    # -- Orders and policies ------------------------------------------------------

    async def get_orders(self, session: ShoppingSessionContext, limit: int = 5) -> list[Order]:
        del session, limit
        return []  # Witness never places an order; there is nothing to list.

    async def get_order(self, session: ShoppingSessionContext, order_id: str) -> Order | None:
        del session, order_id
        return None

    async def search_policies(self, session: ShoppingSessionContext, query: str) -> list[Policy]:
        del session
        policies = [self.CHECKOUT_POLICY]
        for offer in await self._catalog():
            if offer.get("license_url"):
                policies.append(
                    Policy(
                        policy_id=f"license:{offer['id']}",
                        title=f"License — {offer.get('product', offer['id'])}",
                        category="license",
                        content=(
                            f"{offer.get('merchant', 'The merchant')} licenses {offer.get('product', offer['id'])} "
                            f"({offer.get('variant', '')}) under the terms at {offer['license_url']}. "
                            "Choose the license that matches the use before buying."
                        ),
                    )
                )
        words = _tokens(query)
        if not words:
            return policies
        return [p for p in policies if words & _tokens(f"{p.title} {p.category or ''} {p.content}")]

    # -- Fulfillment --------------------------------------------------------------

    async def get_fulfillment_options(
        self, session: ShoppingSessionContext, product_ids: list[str]
    ) -> list[FulfillmentOption]:
        del session
        options: list[FulfillmentOption] = []
        seen: set[str] = set()
        for pid in product_ids[:20]:
            offer = self._offers.get(pid) or await self._offer(pid)
            if offer is None:
                continue
            eta = (
                "immediately, per call, after x402 settlement"
                if offer.get("rail") == "x402"
                else "digital download immediately after merchant checkout"
            )
            if eta not in seen:
                seen.add(eta)
                options.append(FulfillmentOption(method="delivery", eta=eta, fee=0.0))
        return options
