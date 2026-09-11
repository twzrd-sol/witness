# Copyright 2026 TWZRD. SPDX-License-Identifier: Apache-2.0.
"""Spike tests for the Witness StorefrontBackend.

Hermetic: all Witness HTTP is a canned in-memory fetcher — no network, no
wallet, no checkout. Run::

    PYTHONPATH=/path/to/commerce-agents/shopping-agent/core:/path/to/commerce-agents/commerce-common \\
        python3 -m unittest discover -s adapters -p 'test_*.py'
"""

import unittest

from shopping_agent.backend import NotOffered, StorefrontBackend, Unavailable
from shopping_agent.types import ShoppingSessionContext

from witness_storefront import WitnessStorefrontBackend

PIXEL = {
    "id": "pixel-surplus-vintage-polaroid",
    "rail": "merchant_checkout",
    "merchant": "Pixel Surplus",
    "product": "Vintage Polaroid Photo Frames",
    "variant": "Desktop Commercial Use License",
    "variant_id": "46117070209071",
    "outcome": "Give your photos a vintage finish.",
    "deliverable": "22 PNG frames for rasterized web artwork.",
    "price_minor": 600,
    "currency": "USD",
    "price_kind": "observed_item_price",
    "product_url": "https://pixelsurplus.com/products/vintage-polaroid-photo-frames",
    "cart_url": "https://pixel-surplus.myshopify.com/cart/46117070209071:1",
    "license_url": "https://pixelsurplus.com/pages/licensing",
}

READER = {
    "id": "outbid-reader-scrape",
    "rail": "x402",
    "merchant": "outbid",
    "product": "Reader",
    "variant": "scrape — HTML to markdown",
    "outcome": "Read any public page as clean markdown.",
    "price": {"amount_atomic": "5000", "asset": "USDC", "usd": "0.005"},
}

QUOTE_OK = {
    "offer_id": PIXEL["id"],
    "merchant": "Pixel Surplus",
    "checkout_url": "https://pixel-surplus.myshopify.com/cart/46117070209071:1",
}

QUOTE_409 = {
    "offer_id": PIXEL["id"],
    "checkout_url": None,
    "gate": {
        "status": "withheld",
        "reason": "verdict_contradicted",
        "observed": {"price": 700, "handle": "vintage-polaroid-photo-frames"},
    },
}


def canned(status_map):
    def fetch(method, path, body):
        return status_map.get((method, path), (404, {"reason": "offer_not_found"}))

    return fetch


def offers_fetch():
    return canned(
        {
            ("GET", "/api/offers/pixel-surplus-vintage-polaroid"): (200, PIXEL),
            ("GET", "/api/offers/outbid-reader-scrape"): (200, READER),
        }
    )


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.backend = WitnessStorefrontBackend(
            "http://witness.test", fetcher=offers_fetch()
        )
        self.session = ShoppingSessionContext(session_id="s1", user_id="u1")

    def test_subclasses_the_real_abc(self):
        self.assertTrue(issubclass(WitnessStorefrontBackend, StorefrontBackend))

    async def test_search_hit_and_miss(self):
        hits = await self.backend.search_products(self.session, "polaroid")
        self.assertEqual([p.product_id for p in hits], [PIXEL["id"]])
        self.assertEqual(hits[0].price, 6.0)
        self.assertEqual(hits[0].attributes["price_kind"], "observed_item_price")
        self.assertEqual(await self.backend.search_products(self.session, "tent"), [])

    async def test_details_and_unknown_is_none(self):
        details = await self.backend.get_product_details(self.session, PIXEL["id"])
        self.assertEqual(details.brand, "Pixel Surplus")
        self.assertIsNone(await self.backend.get_product_details(self.session, "nope"))

    async def test_cart_add_update_remove(self):
        cart = await self.backend.add_to_cart(self.session, PIXEL["id"], 2)
        self.assertEqual(cart.subtotal, 12.0)
        cart = await self.backend.update_cart_item(self.session, PIXEL["id"], 1)
        self.assertEqual(cart.item_count, 1)
        cart = await self.backend.remove_from_cart(self.session, PIXEL["id"])
        self.assertEqual(cart.items, [])

    async def test_add_unknown_is_unavailable(self):
        with self.assertRaises(Unavailable):
            await self.backend.add_to_cart(self.session, "nope", 1)

    async def test_x402_rail_is_notoffered_for_cart(self):
        with self.assertRaises(NotOffered):
            await self.backend.add_to_cart(self.session, READER["id"], 1)

    async def test_checkout_handoff_returns_url_on_200(self):
        backend = WitnessStorefrontBackend(
            "http://witness.test",
            fetcher=canned(
                {
                    ("GET", "/api/offers/pixel-surplus-vintage-polaroid"): (200, PIXEL),
                    ("POST", "/api/quotes"): (200, QUOTE_OK),
                }
            ),
        )
        await backend.add_to_cart(self.session, PIXEL["id"], 1)
        handoffs = await backend.checkout_handoff(self.session, await backend.get_cart(self.session))
        self.assertEqual(len(handoffs), 1)
        self.assertEqual(handoffs[0].url, QUOTE_OK["checkout_url"])
        self.assertEqual(handoffs[0].seller, "Pixel Surplus")

    async def test_checkout_handoff_withholds_on_409_without_leaking_observed(self):
        backend = WitnessStorefrontBackend(
            "http://witness.test",
            fetcher=canned(
                {
                    ("GET", "/api/offers/pixel-surplus-vintage-polaroid"): (200, PIXEL),
                    ("POST", "/api/quotes"): (409, QUOTE_409),
                }
            ),
        )
        await backend.add_to_cart(self.session, PIXEL["id"], 1)
        with self.assertRaises(Unavailable) as ctx:
            await backend.checkout_handoff(self.session, await backend.get_cart(self.session))
        message = str(ctx.exception)
        self.assertIn(PIXEL["id"], message)
        self.assertNotIn("700", message, "gate.observed values must not reach the model")

    async def test_empty_cart_hands_off_nothing(self):
        self.assertEqual(
            await self.backend.checkout_handoff(self.session, await self.backend.get_cart(self.session)),
            [],
        )

    async def test_orders_policies_fulfillment_are_empty_not_errors(self):
        self.assertEqual(await self.backend.get_orders(self.session), [])
        self.assertIsNone(await self.backend.get_order(self.session, "x"))
        self.assertEqual(await self.backend.search_policies(self.session, "returns"), [])
        self.assertEqual(await self.backend.get_fulfillment_options(self.session, [PIXEL["id"]]), [])

    async def test_disclosure_states_observed_price(self):
        disclosure = await self.backend.get_disclosure(self.session, PIXEL["id"])
        self.assertIn("Observed price", [r.label for r in disclosure.rows])
        self.assertTrue(any("No partnership" in f for f in disclosure.footnotes))


if __name__ == "__main__":
    unittest.main()
