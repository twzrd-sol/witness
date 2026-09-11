# SPDX-License-Identifier: Apache-2.0
"""WitnessStorefront against a fake Witness: the catalog shape the live host serves
(captured 2026-09-11) and the two quote outcomes that matter."""

from __future__ import annotations

import copy
import os
from typing import Any

import pytest
from shopping_agent import Cart, CartItem, SearchFilters, ShoppingSessionContext, Unavailable
from witness_storefront import HandoffWithheld, WitnessStorefront

MERCHANT = {
    "id": "pixel-surplus-vintage-polaroid",
    "rail": "merchant_checkout",
    "merchant": "Pixel Surplus",
    "product": "Vintage Polaroid Photo Frames",
    "variant": "Desktop Commercial Use License",
    "outcome": "Give your photos a vintage finish.",
    "deliverable": "22 PNG frames for rasterized web artwork.",
    "product_url": "https://pixelsurplus.com/products/vintage-polaroid-photo-frames",
    "variant_id": "46117070209071",
    "price_minor": 600,
    "currency": "USD",
    "price_kind": "observed_item_price",
    "checkout": "merchant_hosted",
    "verified_by": {
        "source": "https://pixelsurplus.com/products/vintage-polaroid-photo-frames.js",
        "assertion": "price == 600",
    },
    "cart_url": "https://pixel-surplus.myshopify.com/cart/46117070209071:1",
    "license_url": "https://pixelsurplus.com/pages/licensing",
}
X402 = {
    "id": "outbid-reader-scrape",
    "rail": "x402",
    "merchant": "outbid",
    "product": "Reader",
    "variant": "scrape — HTML to markdown",
    "outcome": "Read any public page as clean markdown.",
    "deliverable": "JSON {title, content, markdown, word_count} for one public URL.",
    "product_url": "https://outbid.sh",
    "checkout": "x402",
    "price": {"amount_atomic": "5000", "asset": "USDC", "usd": "0.005"},
    "resource": {
        "method": "GET",
        "url_template": "https://reader.outbid.sh/scrape?url={url}",
        "input": {"url": "public http(s) URL to read"},
    },
    "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "5000", "asset": "0x8335", "payTo": "0x14df"}],
}

PASSED = {
    "offer_id": MERCHANT["id"],
    "rail": "merchant_checkout",
    "merchant": "Pixel Surplus",
    "cart": {"items": [], "subtotal_minor": 600, "currency": "USD"},
    "checkout": "merchant_hosted",
    "product_url": MERCHANT["product_url"],
    "checkout_url": "https://pixel-surplus.myshopify.com/cart/46117070209071:{q}",
    "gate": {
        "status": "passed",
        "reason": "verdict_supported",
        "verdict": "supported",
        "observed": {"price": 600},
        "source": MERCHANT["verified_by"]["source"],
        "cached": False,
    },
}
WITHHELD = {
    "offer_id": MERCHANT["id"],
    "rail": "merchant_checkout",
    "merchant": "Pixel Surplus",
    "checkout": "merchant_hosted",
    "checkout_url": None,
    "gate": {
        "status": "withheld",
        "reason": "verdict_contradicted",
        "verdict": "contradicted",
        "observed": {"price": 700},
        "source": MERCHANT["verified_by"]["source"],
        "cached": False,
    },
}


class FakeWitness:
    """Serves the offer routes from fixtures and answers quotes with a scripted gate."""

    def __init__(self, quote_status: int = 200, quote_body: dict[str, Any] | None = None):
        self.quote_status = quote_status
        self.quote_body = quote_body or PASSED
        self.calls: list[tuple[str, str, dict[str, Any] | None]] = []

    async def __call__(self, method: str, url: str, body: dict[str, Any] | None) -> tuple[int, Any]:
        self.calls.append((method, url, body))
        path = url.split("witness.test", 1)[1]
        if method == "GET" and path == "/api/offers":
            return 200, {"offers": [copy.deepcopy(MERCHANT), copy.deepcopy(X402)]}
        if method == "GET" and path.startswith("/api/offers/"):
            oid = path.rsplit("/", 1)[1]
            for o in (MERCHANT, X402):
                if o["id"] == oid:
                    return 200, copy.deepcopy(o)
            return 404, {"reason": "offer_not_found", "offer_id": oid}
        if method == "POST" and path == "/api/quotes":
            out = copy.deepcopy(self.quote_body)
            if isinstance(out.get("checkout_url"), str):
                out["checkout_url"] = out["checkout_url"].format(q=body["quantity"])
            return self.quote_status, out
        return 404, None


def session(sid: str = "s1") -> ShoppingSessionContext:
    return ShoppingSessionContext(session_id=sid, user_id="guest-1")


def backend(fake: FakeWitness | None = None) -> tuple[WitnessStorefront, FakeWitness]:
    fake = fake or FakeWitness()
    return WitnessStorefront("https://witness.test", fetch_json=fake), fake


def test_base_url_must_be_https():
    with pytest.raises(ValueError):
        WitnessStorefront("http://witness.example")


async def test_search_maps_offers_to_plain_products_with_the_rail_as_category():
    b, _ = backend()
    products = await b.search_products(session(), "vintage photo frames")
    assert products[0].product_id == MERCHANT["id"]
    p = products[0]
    assert p.price == 6.0 and p.currency == "USD"
    assert p.brand == "Pixel Surplus"
    assert p.category == "merchant_checkout"
    assert p.attributes["price_kind"] == "observed_item_price"
    assert not p.has_options, "an offer is a plain product, never a family"
    x = next(q for q in await b.search_products(session(), "markdown") if q.product_id == X402["id"])
    assert x.price == 0.005 and x.currency == "USDC"
    assert x.attributes["paid_by"].startswith("agent")


async def test_search_filters_by_category_price_and_attributes():
    b, _ = backend()
    only_x402 = await b.search_products(session(), "", SearchFilters(category="x402"))
    assert [p.product_id for p in only_x402] == [X402["id"]]
    cheap = await b.search_products(session(), "", SearchFilters(max_price=1.0))
    assert [p.product_id for p in cheap] == [X402["id"]]
    merchant_only = await b.search_products(session(), "", SearchFilters(attributes={"merchant": "Pixel Surplus"}))
    assert [p.product_id for p in merchant_only] == [MERCHANT["id"]]
    assert await b.search_products(session(), "zzz-nothing-matches") == []
    assert len(await b.search_products(session(), "", limit=1)) == 1


async def test_details_carry_license_verification_source_and_none_for_unknown():
    b, _ = backend()
    d = await b.get_product_details(session(), MERCHANT["id"])
    assert d is not None
    assert d.specs["license"] == MERCHANT["license_url"]
    assert d.specs["price_verified_against"] == MERCHANT["verified_by"]["source"]
    assert d.specs["price_assertion"] == "price == 600"
    assert "22 PNG frames" in (d.long_description or "")
    assert d.variants == []
    assert await b.get_product_details(session(), "nope") is None


async def test_cart_is_per_session_and_accumulates():
    b, _ = backend()
    await b.get_product_details(session("a"), MERCHANT["id"])
    cart = await b.add_to_cart(session("a"), MERCHANT["id"], 1)
    cart = await b.add_to_cart(session("a"), MERCHANT["id"], 2)
    assert cart.item_count == 3 and cart.subtotal == 18.0 and cart.currency == "USD"
    assert (await b.get_cart(session("b"))).items == []
    cart = await b.update_cart_item(session("a"), MERCHANT["id"], 1)
    assert cart.item_count == 1
    cart = await b.remove_from_cart(session("a"), MERCHANT["id"])
    assert cart.items == []
    assert (await b.update_cart_item(session("a"), "absent", 2)).items == []


async def test_x402_offers_cannot_be_carted():
    b, _ = backend()
    with pytest.raises(Unavailable, match="over x402"):
        await b.add_to_cart(session(), X402["id"], 1)
    with pytest.raises(KeyError):
        await b.add_to_cart(session(), "nope", 1)


async def test_checkout_handoff_returns_the_gated_merchant_url_per_line():
    b, fake = backend()
    cart = Cart(items=[CartItem(product_id=MERCHANT["id"], title="x", price=6.0, quantity=2)])
    handoffs = await b.checkout_handoff(session(), cart)
    assert len(handoffs) == 1
    assert handoffs[0].url == "https://pixel-surplus.myshopify.com/cart/46117070209071:2"
    assert handoffs[0].seller == "Pixel Surplus"
    assert handoffs[0].label == "Pay at Pixel Surplus"
    posted = [c for c in fake.calls if c[0] == "POST"]
    assert posted == [("POST", "https://witness.test/api/quotes", {"offer_id": MERCHANT["id"], "quantity": 2})]


async def test_checkout_handoff_withholds_when_the_live_price_contradicts():
    b, _ = backend(FakeWitness(409, WITHHELD))
    cart = Cart(items=[CartItem(product_id=MERCHANT["id"], title="x", price=6.0, quantity=1)])
    with pytest.raises(HandoffWithheld) as info:
        await b.checkout_handoff(session(), cart)
    assert info.value.reason == "verdict_contradicted"
    assert info.value.observed == {"price": 700}
    assert "700" in str(info.value)


async def test_checkout_handoff_never_returns_a_non_https_or_missing_url():
    b, _ = backend(FakeWitness(200, {**PASSED, "checkout_url": "http://insecure.example/cart"}))
    cart = Cart(items=[CartItem(product_id=MERCHANT["id"], title="x", price=6.0, quantity=1)])
    with pytest.raises(RuntimeError):
        await b.checkout_handoff(session(), cart)
    b2, _ = backend(FakeWitness(503, {"reason": "gate_not_wired"}))
    with pytest.raises(RuntimeError, match="gate_not_wired"):
        await b2.checkout_handoff(session(), cart)
    assert await b.checkout_handoff(session(), Cart()) == []


async def test_orders_are_never_invented():
    b, _ = backend()
    assert await b.get_orders(session()) == []
    assert await b.get_order(session(), "any") is None


async def test_policies_cover_checkout_and_each_license():
    b, _ = backend()
    all_policies = await b.search_policies(session(), "")
    assert [p.policy_id for p in all_policies] == ["checkout", f"license:{MERCHANT['id']}"]
    assert [p.policy_id for p in await b.search_policies(session(), "license")] == [f"license:{MERCHANT['id']}"]
    assert "Witness re-reads" in (await b.search_policies(session(), "checkout"))[0].content


async def test_fulfillment_is_digital_and_distinct_per_rail():
    b, _ = backend()
    options = await b.get_fulfillment_options(session(), [MERCHANT["id"], X402["id"], "nope"])
    assert [o.method for o in options] == ["delivery", "delivery"]
    assert all(o.fee == 0.0 for o in options)
    assert await b.get_fulfillment_options(session(), ["nope"]) == []


async def test_preferences_are_a_guest_profile_bound_to_the_session_user():
    b, _ = backend()
    prefs = await b.get_preferences(session())
    assert prefs.user_id == "guest-1"


@pytest.mark.skipif(os.environ.get("WITNESS_LIVE") != "1", reason="set WITNESS_LIVE=1 to hit the public host")
async def test_live_catalog_and_gated_handoff():
    b = WitnessStorefront()
    products = await b.search_products(session(), "vintage")
    assert any(p.product_id == "pixel-surplus-vintage-polaroid" for p in products)
    cart = await b.add_to_cart(session(), "pixel-surplus-vintage-polaroid", 1)
    handoffs = await b.checkout_handoff(session(), cart)
    assert handoffs and handoffs[0].url.startswith("https://pixel-surplus.myshopify.com/cart/46117070209071:1")
