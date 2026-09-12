/**
 * Wave9 EE — Human-checkout untouched invariants.
 *
 * After #45 the mandate / Done-gate lives in `src/shopping-mandate.js`.
 * That library is the x402 digital-product agent path. This file pins the
 * boundary `docs/consumer/shopping-mandate.md` already states:
 *
 *   Mandate/Done evaluation must not:
 *   - require a store URL to encode authority
 *   - rewrite `handleOfferQuote` for merchant offers
 *   - treat a merchant `checkout_url` as Done
 *   - call Shopify, Catalog, or UCP
 *
 * A merchant cart quote is `incomplete` (`human_checkout_untouched`).
 * The mandate path cannot hijack the human rail: a signed mandate in the
 * quote request, Done-shaped headers/fields, or an x402-looking quote that
 * still carries a cart permalink must not rewrite checkout or complete.
 *
 * #45 unit coverage: `test/shopping-mandate.test.js`. This suite is the
 * invariant lock (source isolation, bit-identical merchant quotes,
 * hijack-shaped bundles, HTTP catalog/quote surface).
 *
 * No live Shopify. No live reader. Storefront hosts are refused.
 *
 * Run this file: `node --test test/human-checkout-untouched.test.js`
 * CI-equivalent: `npm test`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tempDir } from "./helpers/tmpdir.js";

import { createHostApp } from "../src/listen.js";
import { openapiDoc } from "../src/openapi.js";
import { generateProcessKey } from "../src/receipt.js";
import {
  OFFERS,
  buildCheckoutUrl,
  buildOfferJson,
  buildOfferTask,
  handleOfferQuote,
  renderOfferHtml,
} from "../src/offers.js";
import {
  SCHEMA,
  RAIL,
  validateMandate,
  signMandate,
  verifyMandate,
  bindMandateToQuote,
  isHumanCheckoutQuote,
  evaluateDone,
} from "../src/shopping-mandate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/examples/digital-product-mandate.json"), "utf8"),
);
const MERCHANT_ID = "pixel-surplus-vintage-polaroid";
const X402_ID = "outbid-reader-scrape";
const CART = "https://pixel-surplus.myshopify.com/cart/46117070209071:1";
const VERIFY_URL = OFFERS[MERCHANT_ID].verify.url;

const MANDATE_SRC = readFileSync(path.join(ROOT, "src/shopping-mandate.js"), "utf8");
const OFFERS_SRC = readFileSync(path.join(ROOT, "src/offers.js"), "utf8");
const OFFERS_ROUTE_SRC = readFileSync(path.join(ROOT, "src/routes/offers.js"), "utf8");

function rel(file) {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function mechanicalCheck() {
  return {
    approve: true,
    reason: "receipt_supported",
    verifier_pid: process.pid + 1000,
    receipt_hash: "ab".repeat(32),
    key_hash: "cd".repeat(32),
  };
}

function x402QuoteBody(overrides = {}) {
  const offer = OFFERS[X402_ID];
  return {
    offer_id: offer.id,
    rail: "x402",
    merchant: offer.merchant,
    request: { method: "GET", url: "https://reader.outbid.sh/scrape?url=https%3A%2F%2Fexample.com" },
    price: { amount_atomic: offer.amount_atomic, asset: offer.asset, usd: offer.price_usdc },
    checkout: "x402",
    accepts: offer.accepts.map((a) => ({ ...a })),
    gate: { status: "passed", reason: "challenge_matches_catalog" },
    ...overrides,
  };
}

function merchantQuoteBody(overrides = {}) {
  const offer = OFFERS[MERCHANT_ID];
  return {
    offer_id: offer.id,
    rail: "merchant_checkout",
    merchant: offer.merchant,
    checkout: "merchant_hosted",
    checkout_url: offer.cart_url,
    cart: { items: [{ variant_id: offer.variant_id, quantity: 1 }], currency: "USD" },
    gate: { status: "passed", reason: "verdict_supported" },
    price: { amount_atomic: "600", asset: "USD" },
    ...overrides,
  };
}

function signedBundle(quote, wrap = "body") {
  const key = generateProcessKey();
  const mandate = signMandate(EXAMPLE, key);
  const quoteWrap = wrap === "bare" ? quote : wrap === "json" ? { status: 200, json: quote } : { status: 200, body: quote };
  return {
    bundle: { mandate, quote: quoteWrap, check: mechanicalCheck(), reserved_minor: 0 },
    opts: { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") },
  };
}

function passedMerchantGate(observedAt = "2026-09-12T12:00:00Z") {
  return {
    status: "passed",
    reason: "verdict_supported",
    verdict: "supported",
    observed: { price: 600 },
    observed_at: observedAt,
    source: VERIFY_URL,
  };
}

function productDoc(price) {
  return JSON.stringify({
    id: 1,
    title: "Vintage Polaroid Photo Frames",
    handle: "vintage-polaroid-photo-frames",
    price,
    variants: [{ id: 46117070209071, price }],
  });
}

function fakeReader(price, calls = { n: 0 }) {
  const fetch = async (readerUrl) => {
    calls.n += 1;
    const target = new URL(readerUrl).searchParams.get("url");
    assert.ok(target, "reader fetch must carry a target url query");
    let host = "";
    try { host = new URL(target).hostname; } catch { /* ignore */ }
    assert.ok(!/myshopify\.com$/i.test(host), `quote must not fetch a checkout host: ${target}`);
    if (target === VERIFY_URL) return { ok: true, status: 200, text: async () => productDoc(price) };
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetch, calls };
}

async function withServer(fn, { readerFetch, probeFetch, env = {} } = {}) {
  const server = createHostApp(
    { OBSERVATIONS_DIR: tempDir("wit-hcu-"), ...env },
    { readerFetch, probeFetch },
  ).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

function stableQuote(json) {
  const { gate, ...rest } = json;
  const { observed_at, cached, ...g } = gate ?? {};
  return { ...rest, gate: g };
}

function assertIncompleteHuman(done, extraFailed = []) {
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  assert.ok(done.failed.includes("human_checkout_untouched"), JSON.stringify(done.failed));
  for (const p of extraFailed) assert.ok(done.failed.includes(p), p);
}

// ---------------------------------------------------------------------------
// 1. Boundary map — source isolation
// ---------------------------------------------------------------------------

test("mandate library does not import the merchant rail or name a storefront", () => {
  assert.doesNotMatch(MANDATE_SRC, /from\s+["'][.\/].*offers/);
  assert.doesNotMatch(MANDATE_SRC, /buildCheckoutUrl|createOffersRouter|verifyMerchantOffer/);
  assert.doesNotMatch(MANDATE_SRC, /myshopify|pixelsurplus/i);
  assert.doesNotMatch(MANDATE_SRC, /authorize-purchase|catalog\.shopify/i);
  assert.doesNotMatch(MANDATE_SRC, /\bfetch\s*\(/);
  assert.match(MANDATE_SRC, /from ["']\.\/receipt\.js["']/);
  assert.match(MANDATE_SRC, /shopify-mandate-stub/);
});

test("merchant rail, HTTP host, and preapproval do not import the mandate library", () => {
  const files = [
    "src/offers.js",
    "src/routes/offers.js",
    "src/server.js",
    "src/listen.js",
    "src/openapi.js",
    "scripts/shopping-preapproval.mjs",
    "scripts/verify-shopping-receipt.mjs",
    "scripts/loop-run.mjs",
    "scripts/loop-check.mjs",
  ];
  for (const f of files) {
    const src = rel(f);
    assert.doesNotMatch(src, /shopping-mandate|shopify-mandate-stub/, f);
  }
  assert.doesNotMatch(OFFERS_SRC, /evaluateDone|validateMandate|signMandate|verifyMandate/);
  assert.doesNotMatch(OFFERS_ROUTE_SRC, /evaluateDone|shopping-mandate|checkout_approved/);
  assert.doesNotMatch(OFFERS_SRC, /checkout_approved|authorize-purchase/);
});

test("no production src module imports the mandate library", () => {
  const walk = (dir) => {
    const out = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(p));
      else if (ent.name.endsWith(".js")) out.push(p);
    }
    return out;
  };
  for (const file of walk(path.join(ROOT, "src"))) {
    if (file.endsWith(`${path.sep}shopping-mandate.js`)) continue;
    // Library checklist is the one src consumer; the HTTP host stays mandate-free.
    if (file.endsWith(`${path.sep}offline-buyer-checklist.js`)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /shopping-mandate/, path.relative(ROOT, file));
  }
});

// ---------------------------------------------------------------------------
// 2. Catalog / handleOfferQuote stay mandate-free
// ---------------------------------------------------------------------------

test("Pixel Surplus catalog row stays the human merchant_checkout rail", () => {
  const offer = OFFERS[MERCHANT_ID];
  assert.equal(offer.rail, "merchant_checkout");
  assert.equal(offer.currency, "USD");
  assert.equal(offer.price_minor, 600);
  assert.equal(offer.price_kind, "observed_item_price");
  assert.equal(offer.variant_id, "46117070209071");
  assert.equal(offer.cart_url, CART);
  assert.equal(offer.cart_base, "https://pixel-surplus.myshopify.com/cart");
  assert.equal(buildCheckoutUrl(offer, 1), CART);
  assert.equal(buildCheckoutUrl(offer, 3), "https://pixel-surplus.myshopify.com/cart/46117070209071:3");

  const json = buildOfferJson(offer);
  assert.equal(json.checkout, "merchant_hosted");
  assert.equal(json.cart_url, CART);
  assert.equal(json.authorization, undefined);
  assert.equal(json.mandate, undefined);

  const task = buildOfferTask(offer);
  assert.equal(task.authorization, null);
  assert.ok(task.requirements.some((r) => /Human confirms purchase details/i.test(r)));
  assert.doesNotMatch(JSON.stringify(task), /witness\.shopping_mandate/);

  const html = renderOfferHtml(offer);
  assert.match(html, /Buy now/);
  assert.match(html, /pixel-surplus\.myshopify\.com\/cart\/46117070209071:1/);
  assert.doesNotMatch(html, /mandate|checkout_approved|authorize-purchase/i);
});

test("handleOfferQuote merchant result is bit-identical with and without a mandate", async () => {
  const key = generateProcessKey();
  const mandate = signMandate(EXAMPLE, key);
  const deps = { verifyMerchant: async () => passedMerchantGate() };
  const plain = await handleOfferQuote({ offer_id: MERCHANT_ID, quantity: 1 }, deps);
  const withMandate = await handleOfferQuote({
    offer_id: MERCHANT_ID,
    quantity: 1,
    mandate,
    authorization: mandate,
    checkout_approved: true,
    completion: "complete",
  }, deps);
  assert.equal(plain.status, 200);
  assert.deepEqual(withMandate, plain);
  assert.equal(plain.json.checkout_url, CART);
  assert.equal(plain.json.rail, "merchant_checkout");
  assert.equal(plain.json.mandate, undefined);
  assert.equal(plain.json.authorization, undefined);
  assert.equal(plain.json.checkout_approved, undefined);
});

test("handleOfferQuote ignores client checkout_url, cart, rail, and variant overrides", async () => {
  const hijack = await handleOfferQuote({
    offer_id: MERCHANT_ID,
    quantity: 2,
    rail: "x402",
    checkout: "x402",
    checkout_url: "https://evil.example/checkout",
    cart_url: "https://evil.example/cart/1:1",
    cart_base: "https://evil.example/cart",
    variant_id: "999",
    cart: { items: [{ variant_id: "999", quantity: 99 }] },
    mandate: { schema: SCHEMA, rail: RAIL, max_total_minor: 1 },
  }, { verifyMerchant: async () => passedMerchantGate() });
  assert.equal(hijack.status, 200);
  assert.equal(hijack.json.rail, "merchant_checkout");
  assert.equal(hijack.json.checkout, "merchant_hosted");
  assert.equal(hijack.json.checkout_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:2");
  assert.equal(hijack.json.cart.items[0].variant_id, "46117070209071");
  assert.equal(hijack.json.cart.items[0].quantity, 2);
  assert.doesNotMatch(JSON.stringify(hijack.json), /evil\.example/);
});

test("evaluateDone does not rewrite a later merchant handleOfferQuote", async () => {
  const { bundle, opts } = signedBundle(merchantQuoteBody());
  const before = await handleOfferQuote(
    { offer_id: MERCHANT_ID, quantity: 1 },
    { verifyMerchant: async () => passedMerchantGate() },
  );
  const done = evaluateDone(bundle, opts);
  assertIncompleteHuman(done, ["rail_x402"]);
  const after = await handleOfferQuote(
    { offer_id: MERCHANT_ID, quantity: 1, mandate: bundle.mandate },
    { verifyMerchant: async () => passedMerchantGate() },
  );
  assert.deepEqual(after, before);
  assert.equal(after.json.checkout_url, CART);
  assert.equal(OFFERS[MERCHANT_ID].cart_url, CART);
});

// ---------------------------------------------------------------------------
// 3. Done-gate never completes a human quote
// ---------------------------------------------------------------------------

test("isHumanCheckoutQuote is true for every human marker and false for a clean x402 quote", () => {
  assert.equal(isHumanCheckoutQuote(x402QuoteBody()), false);
  assert.equal(isHumanCheckoutQuote(null), false);
  assert.equal(isHumanCheckoutQuote([]), false);
  const markers = [
    { rail: "merchant_checkout" },
    { checkout: "merchant_hosted" },
    { checkout_url: CART },
    { cart_url: CART },
    { cart: "https://pixel-surplus.myshopify.com/cart/46117070209071:1" },
    { cart: { items: [{ variant_id: "46117070209071", quantity: 1 }] } },
    merchantQuoteBody(),
    buildOfferJson(OFFERS[MERCHANT_ID]),
  ];
  for (const q of markers) {
    assert.equal(isHumanCheckoutQuote(q), true, JSON.stringify(q));
  }
});

test("evaluateDone is incomplete for every human-marker quote shape", () => {
  const shapes = [
    merchantQuoteBody(),
    { rail: "merchant_checkout", gate: { status: "passed" } },
    { checkout: "merchant_hosted", gate: { status: "passed" } },
    { checkout_url: CART, rail: "x402", checkout: "x402", gate: { status: "passed" } },
    { cart_url: CART, rail: "x402", checkout: "x402", gate: { status: "passed" } },
    { cart: { items: [] }, rail: "x402", checkout: "x402", gate: { status: "passed" } },
    { cart: CART, rail: "x402", checkout: "x402", gate: { status: "passed" } },
  ];
  for (const body of shapes) {
    const { bundle, opts } = signedBundle(body);
    assertIncompleteHuman(evaluateDone(bundle, opts));
  }
});

test("evaluateDone unwraps handleOfferQuote {status,json} and a bare merchant quote", async () => {
  const merchant = await handleOfferQuote(
    { offer_id: MERCHANT_ID, quantity: 1 },
    { verifyMerchant: async () => passedMerchantGate() },
  );
  assert.equal(merchant.status, 200);
  const asJson = signedBundle(merchant.json, "json");
  assertIncompleteHuman(evaluateDone(asJson.bundle, asJson.opts), ["rail_x402"]);
  const asBare = signedBundle(merchant.json, "bare");
  assertIncompleteHuman(evaluateDone(asBare.bundle, asBare.opts), ["rail_x402"]);
  const asBody = signedBundle(merchant.json, "body");
  assertIncompleteHuman(evaluateDone(asBody.bundle, asBody.opts), ["rail_x402"]);
});

test("an otherwise-valid x402 quote that still carries a cart permalink cannot complete", () => {
  const hijacks = [
    x402QuoteBody({ checkout_url: CART }),
    x402QuoteBody({ cart_url: CART }),
    x402QuoteBody({ cart: { items: [{ variant_id: "46117070209071", quantity: 1 }] } }),
    x402QuoteBody({ checkout: "merchant_hosted" }),
    x402QuoteBody({ rail: "merchant_checkout" }),
  ];
  for (const body of hijacks) {
    const { bundle, opts } = signedBundle(body);
    const done = evaluateDone(bundle, opts);
    assertIncompleteHuman(done);
    assert.equal(done.check.approve, false);
  }
});

test("narration, X-Checkout-Approved, and success flags cannot complete a merchant cart", () => {
  const { bundle, opts } = signedBundle(merchantQuoteBody());
  const done = evaluateDone({
    ...bundle,
    checkout_approved: true,
    completion: "complete",
    success: true,
    http_status: 200,
    headers: { "X-Checkout-Approved": "true" },
    check: { ...mechanicalCheck(), approve: true, success: true, narration: "human checkout is Done" },
  }, opts);
  assertIncompleteHuman(done, ["rail_x402"]);
});

test("a withheld merchant 409 is incomplete and is not treated as Done", () => {
  const withheld = merchantQuoteBody({ checkout_url: null, gate: { status: "withheld", reason: "verdict_contradicted" } });
  const { bundle, opts } = signedBundle(withheld);
  bundle.quote = { status: 409, json: withheld };
  const done = evaluateDone(bundle, opts);
  assertIncompleteHuman(done);
  assert.ok(done.failed.includes("quote_passed"));
  assert.equal(done.checkout_approved, false);
});

// ---------------------------------------------------------------------------
// 4. No mutation, no store URL, no Shopify
// ---------------------------------------------------------------------------

test("evaluateDone does not mutate the merchant quote, mandate, or catalog", () => {
  const quote = merchantQuoteBody();
  const quoteFrozen = structuredClone(quote);
  const offerFrozen = structuredClone(OFFERS[MERCHANT_ID]);
  const { bundle, opts } = signedBundle(quote);
  const mandateFrozen = structuredClone(bundle.mandate);
  evaluateDone(bundle, opts);
  evaluateDone({ ...bundle, quote: { status: 200, json: quote } }, opts);
  evaluateDone({ ...bundle, quote }, opts);
  assert.deepEqual(quote, quoteFrozen);
  assert.deepEqual(bundle.mandate, mandateFrozen);
  assert.deepEqual(OFFERS[MERCHANT_ID], offerFrozen);
  assert.equal(OFFERS[MERCHANT_ID].cart_url, CART);
});

test("schema still rejects store URL and other human-checkout fields; Done needs no store", () => {
  for (const extra of [
    { store_url: "https://pixelsurplus.com" },
    { cart_url: CART },
    { checkout_url: "https://pixel-surplus.myshopify.com/checkout" },
    { product_url: "https://pixelsurplus.com/products/x" },
    { variant_id: "46117070209071" },
  ]) {
    assert.equal(validateMandate({ ...EXAMPLE, ...extra }).ok, false, Object.keys(extra)[0]);
  }
  const { bundle, opts } = signedBundle(x402QuoteBody());
  assert.equal(bundle.mandate.store_url, undefined);
  assert.equal(evaluateDone(bundle, opts).completion, "complete");
});

test("validateMandate, bindMandateToQuote, and evaluateDone never fetch a storefront", () => {
  const key = generateProcessKey();
  const mandate = signMandate(EXAMPLE, key);
  assert.equal(validateMandate(mandate).ok, true);
  assert.equal(verifyMandate(mandate, key.publicKey).ok, true);
  assert.equal(bindMandateToQuote(mandate, x402QuoteBody()).ok, true);
  const done = evaluateDone({
    mandate,
    quote: { status: 200, body: x402QuoteBody() },
    check: mechanicalCheck(),
  }, { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") });
  assert.equal(done.completion, "complete");
  assertIncompleteHuman(evaluateDone({
    mandate,
    quote: { status: 200, json: merchantQuoteBody() },
    check: mechanicalCheck(),
  }, { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") }));
});

test("evaluateDone report is not an authorization token for the human rail", () => {
  const { bundle, opts } = signedBundle(x402QuoteBody());
  const done = evaluateDone(bundle, opts);
  assert.equal(done.completion, "complete");
  assert.equal(done.signature, undefined);
  assert.equal(done.payment_authorized, undefined);
  assert.equal(done.order_status, undefined);
  assert.equal(done.checkout_url, undefined);
  assert.equal(done.authorization, undefined);
});

// ---------------------------------------------------------------------------
// 5. HTTP catalog / quote surface — mandate cannot hijack
// ---------------------------------------------------------------------------

test("POST /api/quotes with a signed mandate still returns the catalog cart permalink", async () => {
  const reader = fakeReader(600);
  const key = generateProcessKey();
  const mandate = signMandate(EXAMPLE, key);
  await withServer(async (base) => {
    const plain = await (await post(base, { offer_id: MERCHANT_ID, quantity: 1 })).json();
    const hijack = await post(base, {
      offer_id: MERCHANT_ID,
      quantity: 1,
      mandate,
      checkout_url: "https://evil.example/checkout",
      rail: "x402",
      checkout_approved: true,
      completion: "complete",
      authorization: mandate,
    }, { "X-Checkout-Approved": "true", "X-Mandate-Id": mandate.mandate_id });
    assert.equal(hijack.status, 200);
    const json = await hijack.json();
    assert.deepEqual(stableQuote(json), stableQuote(plain));
    assert.equal(json.checkout_url, CART);
    assert.equal(json.rail, "merchant_checkout");
    assert.equal(json.checkout, "merchant_hosted");
    assert.equal(json.mandate, undefined);
    assert.equal(json.authorization, undefined);
    assert.equal(json.checkout_approved, undefined);
    assert.equal(json.completion, undefined);
    for (const k of ["decision", "payment_authorized", "order_status", "enforcement_scope"]) {
      assert.ok(!(k in json), k);
    }
  }, { readerFetch: reader.fetch });
  assert.equal(reader.calls.n, 1);
});

test("GET offer page, catalog, and task.json stay mandate-free when a mandate exists in-process", async () => {
  const { bundle, opts } = signedBundle(merchantQuoteBody());
  evaluateDone(bundle, opts);
  const reader = fakeReader(600);
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/offers/${MERCHANT_ID}`)).text();
    assert.match(html, /Buy now/);
    assert.match(html, /merchant_checkout/);
    assert.match(html, /pixel-surplus\.myshopify\.com\/cart\/46117070209071:1/);
    assert.doesNotMatch(html, /witness\.shopping_mandate|checkout_approved|authorize-purchase/);

    const catalog = await (await fetch(`${base}/api/offers/${MERCHANT_ID}`)).json();
    assert.equal(catalog.rail, "merchant_checkout");
    assert.equal(catalog.cart_url, CART);
    assert.equal(catalog.mandate, undefined);
    assert.equal(catalog.authorization, undefined);

    const task = await (await fetch(`${base}/api/offers/${MERCHANT_ID}/task.json`)).json();
    assert.equal(task.authorization, null);
    assert.doesNotMatch(JSON.stringify(task), /witness\.shopping_mandate/);
  }, { readerFetch: reader.fetch });
});

test("HTTP host has no authorize-purchase route and OpenAPI does not advertise one", async () => {
  const spec = openapiDoc({});
  assert.equal(spec.paths["/authorize-purchase"], undefined);
  assert.equal(spec.paths["/api/authorize-purchase"], undefined);
  const doc = JSON.stringify(spec);
  assert.doesNotMatch(doc, /authorize-purchase/);
  assert.doesNotMatch(doc, /shopping-mandate/);

  await withServer(async (base) => {
    for (const url of ["/authorize-purchase", "/api/authorize-purchase"]) {
      assert.equal((await fetch(`${base}${url}`)).status, 404);
      assert.equal((await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404);
    }
    const spec = await (await fetch(`${base}/openapi.json`)).json();
    assert.equal(spec.paths["/authorize-purchase"], undefined);
    assert.equal(spec.paths["/api/quotes"] !== undefined, true);
  });
});
