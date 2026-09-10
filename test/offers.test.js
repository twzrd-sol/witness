import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHostApp } from "../src/listen.js";
import { OFFERS, buildCheckoutUrl, handleOfferQuote } from "../src/offers.js";

const ID = "pixel-surplus-vintage-polaroid";

async function withServer(fn) {
  const server = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-offers-")) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body) =>
  fetch(`${base}/api/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /offers/:id serves the offer page with a buy link and the agent task", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/offers/${ID}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.match(html, /vintage finish/i);
    assert.match(html, /Buy now/);
    assert.match(html, /pixel-surplus\.myshopify\.com\/cart\/46117070209071:1/);
    assert.match(html, /pixelsurplus\.com\/products\/vintage-polaroid-photo-frames/);
    assert.match(html, /pixelsurplus\.com\/pages\/licensing/);
    assert.match(html, /USD 6\.00/);
    assert.match(html, /not a final quote/);
    assert.match(html, /No partnership/i);
    assert.match(html, /task\.json/);
  });
});

test("GET /offers/:id is 404 for unknown offers", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/offers/nope`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/offers/:id returns the catalog record with merchant-hosted checkout", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/offers/${ID}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.id, ID);
    assert.equal(json.checkout, "merchant_hosted");
    assert.equal(json.price_minor, 600);
    assert.equal(json.currency, "USD");
    assert.equal(json.price_kind, "observed_item_price", "price is labeled observed, never a final quote");
    assert.equal(json.variant_id, "46117070209071");
    assert.equal(json.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    const missing = await fetch(`${base}/api/offers/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).reason, "offer_not_found");
  });
});

test("GET /api/offers/:id/task.json carries intent, requirements, merchant, and price", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/offers/${ID}/task.json`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.offer_id, ID);
    assert.equal(json.authorization, null, "recipient supplies fresh authority; the task carries none");
    assert.match(json.intent, /Polaroid/i);
    assert.ok(Array.isArray(json.requirements) && json.requirements.length > 0);
    assert.ok(json.requirements.some((r) => /confirms purchase details/i.test(r)), "task requires human confirmation before payment");
    assert.equal(json.merchant.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    assert.deepEqual(json.price, { amount_minor: 600, currency: "USD", kind: "observed_item_price" });
    const missing = await fetch(`${base}/api/offers/nope/task.json`);
    assert.equal(missing.status, 404);
  });
});

test("POST /api/quotes builds the cart and returns the merchant checkout URL", async () => {
  await withServer(async (base) => {
    const res = await post(base, { offer_id: ID });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.offer_id, ID);
    assert.equal(json.checkout, "merchant_hosted");
    assert.equal(json.checkout_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    assert.equal(json.cart.currency, "USD");
    assert.equal(json.cart.subtotal_minor, 600);
    assert.equal(json.cart.price_kind, "observed_item_price");
    assert.match(json.cart.price_note, /not a final quote/);
    assert.deepEqual(json.cart.items.map((i) => [i.variant_id, i.quantity, i.unit_price_minor]), [["46117070209071", 1, 600]]);
    for (const k of ["decision", "reason", "payment_authorized", "order_status", "enforcement_scope"]) {
      assert.ok(!(k in json), `${k} is not part of the checkout response`);
    }
  });
});

test("POST /api/quotes honours quantity in the cart and the checkout URL", async () => {
  await withServer(async (base) => {
    const res = await post(base, { offer_id: ID, quantity: 3 });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.cart.items[0].quantity, 3);
    assert.equal(json.cart.subtotal_minor, 1800);
    assert.equal(json.checkout_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:3");
  });
});

test("buildCheckoutUrl derives the origin from the offer record, per merchant", async () => {
  const second = { cart_base: "https://radpatches.myshopify.com/cart", variant_id: "39843061629114" };
  assert.equal(buildCheckoutUrl(second, 2), "https://radpatches.myshopify.com/cart/39843061629114:2");
  assert.equal(buildCheckoutUrl({ cart_base: "https://pixel-surplus.myshopify.com/cart", variant_id: "46117070209071" }, 1), "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
  assert.throws(() => buildCheckoutUrl({ variant_id: "1" }, 1), /offer_missing_cart_base/);
  assert.throws(() => buildCheckoutUrl({ cart_base: "http://insecure.example/cart", variant_id: "1" }, 1), /offer_missing_cart_base/);
  assert.throws(() => buildCheckoutUrl({ cart_base: "https://pixel-surplus.myshopify.com/cart", variant_id: "abc" }, 1), /offer_missing_variant/);
});

test("POST /api/quotes rejects unknown offers, missing ids, and bad quantities", async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, { offer_id: "nope" })).status, 404);
    assert.equal((await post(base, {})).status, 400);
    for (const quantity of [0, -1, 1.5, "2", 100]) {
      const res = await post(base, { offer_id: ID, quantity });
      assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)}`);
      assert.equal((await res.json()).reason, "bad_quantity");
    }
  });
});

test("every catalog offer's cart_url equals its own checkout URL at quantity 1", () => {
  for (const offer of Object.values(OFFERS)) {
    assert.equal(buildCheckoutUrl(offer, 1), offer.cart_url, offer.id);
  }
});

test("POST /api/quotes uses a second merchant's own cart_base, never the first merchant's", () => {
  const second = {
    id: "other-merchant-thing",
    merchant: "Other Merchant",
    product: "Thing",
    variant: "Default",
    variant_id: "99",
    price_minor: 1234,
    currency: "EUR",
    price_kind: "observed_item_price",
    product_url: "https://other.example/products/thing",
    cart_base: "https://other-merchant.myshopify.com/cart",
    cart_url: "https://other-merchant.myshopify.com/cart/99:1",
    license_url: "https://other.example/license",
  };
  const out = handleOfferQuote({ offer_id: second.id, quantity: 4 }, { [second.id]: second });
  assert.equal(out.status, 200);
  assert.equal(out.json.checkout_url, "https://other-merchant.myshopify.com/cart/99:4");
  assert.equal(out.json.merchant, "Other Merchant");
  assert.equal(out.json.cart.currency, "EUR");
  assert.equal(out.json.cart.subtotal_minor, 4936);
  assert.doesNotMatch(out.json.checkout_url, /pixel-surplus/);
});
