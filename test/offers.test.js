import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHostApp } from "../src/listen.js";
import { OFFERS, buildCheckoutUrl, handleOfferQuote, parseX402Challenge, resolveResourceUrl } from "../src/offers.js";

const ID = "pixel-surplus-vintage-polaroid";
const X402_ID = "outbid-reader-scrape";
const VERIFY_URL = OFFERS[ID].verify.url;

/** Shopify products/<handle>.js shape: price in cents at product level and per variant. */
const productDoc = (price) =>
  JSON.stringify({ id: 1, title: "Vintage Polaroid Photo Frames", handle: "vintage-polaroid-photo-frames", price, variants: [{ id: 46117070209071, price }] });

/** Fake reader: answers the verify URL with a product doc; anything else 404. */
function fakeReader(price, calls = { n: 0 }) {
  const fetch = async (readerUrl) => {
    calls.n += 1;
    const target = new URL(readerUrl).searchParams.get("url");
    if (target === VERIFY_URL) return { ok: true, status: 200, text: async () => productDoc(price) };
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetch, calls };
}

const liveAccepts = OFFERS[X402_ID].accepts.map((a) => ({ ...a, maxTimeoutSeconds: 300 }));
const challengeHeader = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", accepts })).toString("base64");

/** Fake x402 resource: 402 with a v2 payment-required header. */
function fakeProbe({ status = 402, accepts = liveAccepts, calls = { n: 0 } } = {}) {
  const fetch = async (url) => {
    calls.n += 1;
    calls.last = url;
    return { status, headers: { get: (h) => (h === "payment-required" && status === 402 ? challengeHeader(accepts) : null) }, json: async () => ({}) };
  };
  return { fetch, calls };
}

async function withServer(fn, { readerFetch, probeFetch, gateTtlMs, env = {} } = {}) {
  const server = createHostApp(
    { OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-offers-")), ...env },
    { readerFetch, probeFetch, gateTtlMs },
  ).listen(0, "127.0.0.1");
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
    assert.match(html, /merchant_checkout/);
    assert.match(html, /pixel-surplus\.myshopify\.com\/cart\/46117070209071:1/);
    assert.match(html, /pixelsurplus\.com\/pages\/licensing/);
    assert.match(html, /USD 6\.00/);
    assert.match(html, /not a final quote/);
    assert.match(html, /No partnership/i);
    assert.match(html, /task\.json/);
  });
});

test("GET /offers/:id for the x402 offer shows the rail and price per call, no Buy now link", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/offers/${X402_ID}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /x402/);
    assert.match(html, /USDC 0\.005 per call/);
    assert.doesNotMatch(html, /Buy now/);
    assert.match(html, /task\.json/);
  });
});

test("GET /offers/:id is 404 for unknown offers", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/offers/nope`)).status, 404);
  });
});

test("GET /api/offers lists every catalog record in order, same shape as the single-offer route", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/offers`);
    assert.equal(res.status, 200);
    const { offers } = await res.json();
    assert.deepEqual(offers.map((o) => o.id), Object.keys(OFFERS));
    for (const o of offers) {
      const single = await (await fetch(`${base}/api/offers/${o.id}`)).json();
      assert.deepEqual(o, single, o.id);
    }
  });
});

test("GET /api/offers/:id returns the merchant catalog record with its Witness method", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/offers/${ID}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.id, ID);
    assert.equal(json.rail, "merchant_checkout");
    assert.equal(json.checkout, "merchant_hosted");
    assert.equal(json.price_minor, 600);
    assert.equal(json.currency, "USD");
    assert.equal(json.price_kind, "observed_item_price", "price is labeled observed, never a final quote");
    assert.equal(json.variant_id, "46117070209071");
    assert.equal(json.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    assert.deepEqual(json.verified_by, { source: VERIFY_URL, assertion: "price == 600" });
    const missing = await fetch(`${base}/api/offers/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).reason, "offer_not_found");
  });
});

test("GET /api/offers/:id returns the x402 catalog record with vouched payees", async () => {
  await withServer(async (base) => {
    const json = await (await fetch(`${base}/api/offers/${X402_ID}`)).json();
    assert.equal(json.rail, "x402");
    assert.equal(json.checkout, "x402");
    assert.deepEqual(json.price, { amount_atomic: "5000", asset: "USDC", usd: "0.005" });
    assert.equal(json.resource.url_template, "https://reader.outbid.sh/scrape?url={url}");
    assert.equal(json.accepts.length, 2);
    assert.ok(json.accepts.every((a) => a.amount === "5000" && a.payTo));
    assert.equal(json.cart_url, undefined);
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
    assert.ok(json.requirements.some((r) => /POST \/api\/quotes/.test(r) && /409/.test(r)), "task routes the agent through the gated quote");
    assert.ok(json.requirements.some((r) => /confirms purchase details/i.test(r)), "task requires human confirmation before payment");
    assert.equal(json.merchant.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    assert.deepEqual(json.price, { amount_minor: 600, currency: "USD", kind: "observed_item_price" });
    const x = await (await fetch(`${base}/api/offers/${X402_ID}/task.json`)).json();
    assert.equal(x.authorization, null);
    assert.ok(x.requirements.some((r) => /different payee or amount is a stop/.test(r)));
    assert.equal(x.price.amount_atomic, "5000");
    assert.equal((await fetch(`${base}/api/offers/nope/task.json`)).status, 404);
  });
});

test("POST /api/quotes: supported live price returns the cart and the merchant checkout URL", async () => {
  const reader = fakeReader(600);
  await withServer(async (base) => {
    const res = await post(base, { offer_id: ID });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.offer_id, ID);
    assert.equal(json.rail, "merchant_checkout");
    assert.equal(json.checkout, "merchant_hosted");
    assert.equal(json.checkout_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    assert.equal(json.cart.currency, "USD");
    assert.equal(json.cart.subtotal_minor, 600);
    assert.equal(json.cart.price_kind, "observed_item_price");
    assert.deepEqual(json.cart.items.map((i) => [i.variant_id, i.quantity, i.unit_price_minor]), [["46117070209071", 1, 600]]);
    assert.equal(json.gate.status, "passed");
    assert.equal(json.gate.verdict, "supported");
    assert.equal(json.gate.observed.price, 600);
    assert.equal(json.gate.observed.handle, "vintage-polaroid-photo-frames");
    assert.equal(json.gate.source, VERIFY_URL);
    assert.equal(json.gate.cached, false);
    assert.match(json.gate.observed_at, /^\d{4}-\d{2}-\d{2}T/);
    for (const k of ["decision", "payment_authorized", "order_status", "enforcement_scope"]) {
      assert.ok(!(k in json), `${k} is not part of the checkout response`);
    }
    assert.equal(reader.calls.n, 1, "one reader call");
  }, { readerFetch: reader.fetch });
});

test("POST /api/quotes: contradicted live price withholds the checkout URL (409)", async () => {
  const reader = fakeReader(700);
  await withServer(async (base) => {
    const res = await post(base, { offer_id: ID, quantity: 2 });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.checkout_url, null);
    assert.equal(json.gate.status, "withheld");
    assert.equal(json.gate.reason, "verdict_contradicted");
    assert.equal(json.gate.verdict, "contradicted");
    assert.equal(json.gate.observed.price, 700, "the agent sees what the merchant actually says");
    assert.equal(json.cart.subtotal_minor, 1200, "cart is still described so the agent can reason");
    assert.equal(json.product_url, OFFERS[ID].product_url);
    assert.doesNotMatch(JSON.stringify(json), /myshopify\.com\/cart/, "no cart URL anywhere in a withheld response");
  }, { readerFetch: reader.fetch });
});

test("POST /api/quotes: reader failure withholds, never passes by default", async () => {
  const reader = { fetch: async () => ({ ok: false, status: 503, text: async () => "" }) };
  await withServer(async (base) => {
    const res = await post(base, { offer_id: ID });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.checkout_url, null);
    assert.equal(json.gate.reason, "verify_retrieve_failed");
    assert.equal(json.gate.verdict, null);
  }, { readerFetch: reader.fetch });
});

test("POST /api/quotes: gate result is cached per offer, and the cache respects the TTL", async () => {
  const cached = fakeReader(600);
  await withServer(async (base) => {
    const a = await (await post(base, { offer_id: ID })).json();
    const b = await (await post(base, { offer_id: ID, quantity: 3 })).json();
    assert.equal(a.gate.cached, false);
    assert.equal(b.gate.cached, true);
    assert.equal(b.checkout_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:3", "quantity is applied on top of a cached gate");
    assert.equal(cached.calls.n, 1, "second quote did not hit the reader");
  }, { readerFetch: cached.fetch });

  const uncached = fakeReader(600);
  await withServer(async (base) => {
    await post(base, { offer_id: ID });
    await post(base, { offer_id: ID });
    assert.equal(uncached.calls.n, 2, "ttl 0 re-observes every time");
  }, { readerFetch: uncached.fetch, gateTtlMs: 0 });
});

test("POST /api/quotes: a cache miss shares the POST /quote per-IP limiter", async () => {
  const reader = fakeReader(600);
  await withServer(async (base) => {
    assert.equal((await post(base, { offer_id: ID })).status, 200);
    const res = await post(base, { offer_id: ID });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).reason, "quote_rate_limited");
    assert.equal(reader.calls.n, 1);
  }, { readerFetch: reader.fetch, gateTtlMs: 0, env: { QUOTE_RATE_LIMIT_PER_MINUTE: "1" } });
});

test("POST /api/quotes: bad quantity is rejected before any gate call", async () => {
  const reader = fakeReader(600);
  await withServer(async (base) => {
    assert.equal((await post(base, { offer_id: "nope" })).status, 404);
    assert.equal((await post(base, {})).status, 400);
    for (const quantity of [0, -1, 1.5, "2", 100]) {
      const res = await post(base, { offer_id: ID, quantity });
      assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)}`);
      assert.equal((await res.json()).reason, "bad_quantity");
    }
    assert.equal(reader.calls.n, 0, "no reader call for a rejected request");
  }, { readerFetch: reader.fetch });
});

test("POST /api/quotes (x402): live 402 matching the catalog returns the request and the vouched accepts", async () => {
  const probe = fakeProbe();
  await withServer(async (base) => {
    const res = await post(base, { offer_id: X402_ID, input: { url: "https://example.com/a?b=1" } });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.rail, "x402");
    assert.equal(json.checkout, "x402");
    assert.equal(json.request.method, "GET");
    assert.equal(json.request.url, "https://reader.outbid.sh/scrape?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1");
    assert.equal(probe.calls.last, json.request.url, "the probe hit exactly the resolved resource");
    assert.equal(json.accepts.length, 2);
    assert.deepEqual(json.accepts.map((a) => a.payTo), OFFERS[X402_ID].accepts.map((a) => a.payTo));
    assert.ok(json.accepts.every((a) => a.maxTimeoutSeconds === undefined), "accepts are summarized to the settlement fields");
    assert.equal(json.gate.status, "passed");
    assert.equal(json.gate.x402Version, 2);
    assert.equal(json.price.amount_atomic, "5000");
  }, { probeFetch: probe.fetch });
});

test("POST /api/quotes (x402): a changed payee withholds and shows what the resource now asks for", async () => {
  const rogue = liveAccepts.map((a) => ({ ...a, payTo: a.network.startsWith("eip155") ? "0x000000000000000000000000000000000000dEaD" : "11111111111111111111111111111111" }));
  const probe = fakeProbe({ accepts: rogue });
  await withServer(async (base) => {
    const res = await post(base, { offer_id: X402_ID, input: { url: "https://example.com" } });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.accepts, null);
    assert.equal(json.gate.reason, "payee_or_price_changed");
    assert.equal(json.gate.live.length, 2);
    assert.match(json.gate.live[0].payTo, /dEaD$/);
  }, { probeFetch: probe.fetch });
});

test("POST /api/quotes (x402): a changed amount withholds even with the right payee", async () => {
  const probe = fakeProbe({ accepts: liveAccepts.map((a) => ({ ...a, amount: "6000" })) });
  await withServer(async (base) => {
    const res = await post(base, { offer_id: X402_ID, input: { url: "https://example.com" } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).gate.reason, "payee_or_price_changed");
  }, { probeFetch: probe.fetch });
});

test("POST /api/quotes (x402): a resource that no longer answers 402 withholds", async () => {
  const probe = fakeProbe({ status: 200 });
  await withServer(async (base) => {
    const res = await post(base, { offer_id: X402_ID, input: { url: "https://example.com" } });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.gate.reason, "resource_not_402");
    assert.equal(json.gate.live.status, 200);
  }, { probeFetch: probe.fetch });
});

test("POST /api/quotes (x402): bad or missing input.url is 400 before any probe", async () => {
  const probe = fakeProbe();
  await withServer(async (base) => {
    for (const body of [{ offer_id: X402_ID }, { offer_id: X402_ID, input: {} }, { offer_id: X402_ID, input: { url: "ftp://x" } }, { offer_id: X402_ID, input: { url: "not a url" } }, { offer_id: X402_ID, input: "https://example.com" }]) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).reason, "bad_input_url");
    }
    assert.equal(probe.calls.n, 0);
  }, { probeFetch: probe.fetch });
});

test("handleOfferQuote without a wired gate never issues a handoff (503)", async () => {
  const merchant = await handleOfferQuote({ offer_id: ID });
  assert.equal(merchant.status, 503);
  assert.equal(merchant.json.reason, "gate_not_wired");
  const x = await handleOfferQuote({ offer_id: X402_ID, input: { url: "https://example.com" } });
  assert.equal(x.status, 503);
});

test("parseX402Challenge reads the v2 header and falls back to a v1 body", () => {
  const v2 = parseX402Challenge(challengeHeader(liveAccepts), null);
  assert.equal(v2.x402Version, 2);
  assert.equal(v2.accepts[0].payTo, liveAccepts[0].payTo);
  const v1 = parseX402Challenge(null, { x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "5000", asset: liveAccepts[0].asset, payTo: liveAccepts[0].payTo }] });
  assert.equal(v1.x402Version, 1);
  assert.deepEqual(v1.accepts[0], { scheme: "exact", network: "eip155:8453", amount: "5000", asset: liveAccepts[0].asset, payTo: liveAccepts[0].payTo });
  assert.equal(parseX402Challenge("not-base64-json", { nope: true }), null);
  assert.equal(parseX402Challenge(undefined, null), null);
});

test("resolveResourceUrl encodes the agent's URL into the catalog template", () => {
  assert.equal(resolveResourceUrl(OFFERS[X402_ID], { url: "https://a.example/p?q=1&r=2" }), "https://reader.outbid.sh/scrape?url=https%3A%2F%2Fa.example%2Fp%3Fq%3D1%26r%3D2");
  assert.throws(() => resolveResourceUrl(OFFERS[X402_ID], { url: "x".repeat(3000) }), /bad_input_url/);
});

test("every merchant catalog offer's cart_url equals its own checkout URL at quantity 1", () => {
  for (const offer of Object.values(OFFERS).filter((o) => o.rail === "merchant_checkout")) {
    assert.equal(buildCheckoutUrl(offer, 1), offer.cart_url, offer.id);
  }
});

test("POST /api/quotes uses a second merchant's own cart_base and verify method, never the first merchant's", async () => {
  const second = {
    id: "other-merchant-thing",
    rail: "merchant_checkout",
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
    verify: { url: "https://other.example/products/thing.js", extract: { price: "number" }, assertion: "price == 1234" },
  };
  let verified = null;
  const out = await handleOfferQuote(
    { offer_id: second.id, quantity: 4 },
    { catalog: { [second.id]: second }, verifyMerchant: async (offer) => { verified = offer.verify.url; return { status: "passed", reason: "verdict_supported", verdict: "supported", observed: { price: 1234 }, source: offer.verify.url }; } },
  );
  assert.equal(out.status, 200);
  assert.equal(verified, "https://other.example/products/thing.js");
  assert.equal(out.json.checkout_url, "https://other-merchant.myshopify.com/cart/99:4");
  assert.equal(out.json.merchant, "Other Merchant");
  assert.equal(out.json.cart.currency, "EUR");
  assert.equal(out.json.cart.subtotal_minor, 4936);
  assert.doesNotMatch(out.json.checkout_url, /pixel-surplus/);
});

test("buildCheckoutUrl derives the origin from the offer record, per merchant", async () => {
  const second = { cart_base: "https://radpatches.myshopify.com/cart", variant_id: "39843061629114" };
  assert.equal(buildCheckoutUrl(second, 2), "https://radpatches.myshopify.com/cart/39843061629114:2");
  assert.equal(buildCheckoutUrl({ cart_base: "https://pixel-surplus.myshopify.com/cart", variant_id: "46117070209071" }, 1), "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
  assert.throws(() => buildCheckoutUrl({ variant_id: "1" }, 1), /offer_missing_cart_base/);
  assert.throws(() => buildCheckoutUrl({ cart_base: "http://insecure.example/cart", variant_id: "1" }, 1), /offer_missing_cart_base/);
  assert.throws(() => buildCheckoutUrl({ cart_base: "https://pixel-surplus.myshopify.com/cart", variant_id: "abc" }, 1), /offer_missing_variant/);
});
