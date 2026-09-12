import test from "node:test";
import assert from "node:assert/strict";
import { createStorefrontBackend } from "../src/storefront-backend.js";

const ID = "pixel-surplus-vintage-polaroid";
const MERCHANT_CART = "https://pixel-surplus.myshopify.com/cart/46117070209071:1";

const supported = async () => ({ verdict: "supported", value: { price: 6 } });

test("search_products lists the catalog and filters by query", () => {
  const backend = createStorefrontBackend({ observe: supported });
  const all = backend.search_products("");
  assert.equal(all.length, 1);
  assert.equal(all[0].id, ID);
  assert.equal(all[0].checkout, "merchant_hosted");
  assert.equal(backend.search_products("polaroid").length, 1);
  assert.equal(backend.search_products("airline tickets").length, 0);
});

test("get_product_detail returns the catalog record; unknown id is null", () => {
  const backend = createStorefrontBackend({ observe: supported });
  const detail = backend.get_product_detail(ID);
  assert.equal(detail.price_minor, 600);
  assert.equal(detail.price_kind, "observed_item_price");
  assert.equal(detail.checkout, "merchant_hosted");
  assert.equal(backend.get_product_detail("nope"), null);
});

test("get_order_status never invents a merchant order", () => {
  const backend = createStorefrontBackend({ observe: supported });
  const status = backend.get_order_status("any");
  assert.equal(status.available, false);
  assert.equal(status.reason, "merchant_hosted");
});

test("get_policy returns the offer license URL", () => {
  const backend = createStorefrontBackend({ observe: supported });
  assert.equal(backend.get_policy(ID).license_url, "https://pixelsurplus.com/pages/licensing");
  assert.equal(backend.get_policy("nope"), null);
});

test("prepare_checkout returns the merchant URL only after a supported Witness verdict", async () => {
  const backend = createStorefrontBackend({ observe: supported });
  const out = await backend.prepare_checkout({ offer_id: ID });
  assert.equal(out.ok, true);
  assert.equal(out.checkout_url, MERCHANT_CART);
  assert.equal(out.checkout.checkout, "merchant_hosted");
  assert.equal(out.checkout.receipt.verdict, "supported");
  assert.equal(out.checkout.gate, "verdict_supported");
  for (const k of ["decision", "payment_authorized", "order_status", "enforcement_scope"]) {
    assert.ok(!(k in out.checkout), `${k} must not appear on a gated checkout`);
  }
});

test("prepare_checkout withholds the URL on contradicted and stale pages", async () => {
  for (const verdict of ["contradicted", "stale", "incomplete", "unable_to_verify"]) {
    const backend = createStorefrontBackend({ observe: async () => ({ verdict }) });
    const out = await backend.prepare_checkout({ offer_id: ID });
    assert.equal(out.ok, false, verdict);
    assert.equal(out.checkout_url, undefined, verdict);
    assert.equal(out.error.reason, "page_not_supported", verdict);
    assert.equal(out.error.gate, `verdict_${verdict}`, verdict);
  }
});

test("prepare_checkout is fail-closed without an observer and when observe throws", async () => {
  const missing = createStorefrontBackend();
  const noObserve = await missing.prepare_checkout({ offer_id: ID });
  assert.equal(noObserve.ok, false);
  assert.equal(noObserve.error.reason, "observe_required");
  assert.equal(noObserve.checkout_url, undefined);

  const exploding = createStorefrontBackend({
    observe: async () => {
      throw new Error("reader_down");
    },
  });
  const failed = await exploding.prepare_checkout({ offer_id: ID });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.reason, "observe_failed");
  assert.equal(failed.checkout_url, undefined);
});

test("prepare_checkout does not observe an unknown offer", async () => {
  let called = 0;
  const backend = createStorefrontBackend({
    observe: async () => {
      called += 1;
      return { verdict: "supported" };
    },
  });
  const out = await backend.prepare_checkout({ offer_id: "nope" });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.checkout_url, undefined);
  assert.equal(called, 0);
});

test("prepare_checkout never pays: observe is the only side effect, and it is not a wallet", async () => {
  const calls = [];
  const backend = createStorefrontBackend({
    observe: async (offer) => {
      calls.push(offer.product_url);
      return { verdict: "supported" };
    },
  });
  await backend.prepare_checkout({ offer_id: ID, quantity: 2 });
  assert.deepEqual(calls, ["https://pixelsurplus.com/products/vintage-polaroid-photo-frames"]);
});
