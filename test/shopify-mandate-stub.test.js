/**
 * Wave14 YY — Shopify mandate stub gated on SHOPIFY_STORE_URL.
 *
 * Builds on #46 resolveStoreUrl / evaluateDone.store. Unset is a no-op.
 * A set value is validated and never fetched. No store URL is invented.
 * Human checkout stays on src/offers.js. No live store, Catalog, or UCP.
 *
 * Run this file: `node --test test/shopify-mandate-stub.test.js`
 * CI-equivalent: `npm test`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv from "ajv";

import { generateProcessKey } from "../src/receipt.js";
import { OFFERS, handleOfferQuote } from "../src/offers.js";
import {
  SCHEMA,
  RAIL,
  STORE_URL_ENV,
  signMandate,
  evaluateDone,
} from "../src/shopping-mandate.js";
import {
  KIND,
  STORE_URL_JSON_SCHEMA,
  STUB_JSON_SCHEMA,
  resolveStoreUrl,
  evaluateShopifyMandateStub,
} from "../src/shopify-mandate-stub.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/examples/digital-product-mandate.json"), "utf8"),
);
const STUB_SCHEMA_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/shopify-mandate-stub-v1.json"), "utf8"),
);
const STORE_URL_SCHEMA_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/shopify-store-url-env-v1.json"), "utf8"),
);
const STUB_SRC = readFileSync(path.join(ROOT, "src/shopify-mandate-stub.js"), "utf8");
const MANDATE_SRC = readFileSync(path.join(ROOT, "src/shopping-mandate.js"), "utf8");
const MERCHANT_ID = "pixel-surplus-vintage-polaroid";
const X402_ID = "outbid-reader-scrape";
const FIXTURE_URL = "https://merchant.example";

const ajv = new Ajv({ strict: false, validateFormats: false });
const ajvStub = ajv.compile(STUB_SCHEMA_FILE);
const ajvStore = ajv.compile(STORE_URL_SCHEMA_FILE);

function isolateStoreEnv(t, value) {
  const prev = process.env.SHOPIFY_STORE_URL;
  if (value === undefined) delete process.env.SHOPIFY_STORE_URL;
  else process.env.SHOPIFY_STORE_URL = value;
  t.after(() => {
    if (prev === undefined) delete process.env.SHOPIFY_STORE_URL;
    else process.env.SHOPIFY_STORE_URL = prev;
  });
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

function merchantQuoteBody() {
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
  };
}

function happyBundle(t) {
  const key = generateProcessKey();
  const mandate = signMandate({ ...EXAMPLE }, key);
  t.mock.method(globalThis, "fetch", () => { throw new Error("stub tests must not fetch"); });
  return {
    bundle: {
      mandate,
      quote: { status: 200, body: x402QuoteBody() },
      check: mechanicalCheck(),
      reserved_minor: 0,
    },
    opts: { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") },
  };
}

test("stub schema file is the runtime schema and rejects extra fields", () => {
  assert.deepEqual(STUB_JSON_SCHEMA, STUB_SCHEMA_FILE);
  assert.deepEqual(STORE_URL_JSON_SCHEMA, STORE_URL_SCHEMA_FILE);
  assert.equal(STUB_SCHEMA_FILE.additionalProperties, false);
  assert.equal(KIND, "witness.shopify_mandate_stub.v1");
  assert.equal(STORE_URL_ENV, "SHOPIFY_STORE_URL");
  const unset = evaluateShopifyMandateStub({ env: {} });
  assert.ok(ajvStub(unset), ajv.errorsText(ajvStub.errors));
  assert.equal(ajvStub({ ...unset, store_url: FIXTURE_URL }), false);
  assert.equal(ajvStub({ ...unset, checkout_url: FIXTURE_URL }), false);
  assert.equal(ajvStub({ ...unset, action: "fetched" }), false);
});

test("unset, empty, or whitespace SHOPIFY_STORE_URL is a no-op", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unset stub must not fetch"); });
  for (const env of [{}, { SHOPIFY_STORE_URL: "" }, { SHOPIFY_STORE_URL: "   " }, { SHOPIFY_STORE_URL: "\n" }]) {
    const stub = evaluateShopifyMandateStub({ env });
    assert.equal(stub.action, "unset_noop", JSON.stringify(env));
    assert.equal(stub.armed, false);
    assert.equal(stub.live_store, false);
    assert.equal(stub.fetched, false);
    assert.equal(stub.invented, false);
    assert.equal(stub.completion, "incomplete");
    assert.equal(stub.checkout_approved, false);
    assert.equal(stub.check.approve, false);
    assert.equal(stub.check.reason, "store_url_unset");
    assert.equal(stub.store.enabled, false);
    assert.equal(stub.store.ok, true);
    assert.equal(stub.store.reason, "store_url_unset");
    assert.equal(stub.store.env, STORE_URL_ENV);
    assert.equal(stub.store.store_url, undefined);
    assert.ok(ajvStub(stub));
    const resolved = resolveStoreUrl(env);
    assert.equal(resolved.store_url, null);
    assert.ok(ajvStore(resolved));
  }
});

test("a set but invalid SHOPIFY_STORE_URL fail-closes and does not fetch", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("invalid stub must not fetch"); });
  for (const raw of [
    "http://merchant.example",
    "https://user:pass@merchant.example",
    "not-a-url",
    "ftp://merchant.example",
    "https://",
    12,
  ]) {
    const stub = evaluateShopifyMandateStub({ env: { SHOPIFY_STORE_URL: raw } });
    assert.equal(stub.action, "invalid_noop", String(raw));
    assert.equal(stub.armed, false);
    assert.equal(stub.fetched, false);
    assert.equal(stub.invented, false);
    assert.equal(stub.completion, "incomplete");
    assert.equal(stub.checkout_approved, false);
    assert.equal(stub.check.reason, "store_url_invalid");
    assert.equal(stub.store.ok, false);
    assert.equal(stub.store.reason, "store_url_invalid");
    assert.equal(stub.store.store_url, undefined);
    assert.ok(ajvStub(stub));
  }
});

test("a valid SHOPIFY_STORE_URL arms the stub as configured_noop without fetching", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("configured stub must not fetch"); });
  const stub = evaluateShopifyMandateStub({ env: { SHOPIFY_STORE_URL: `  ${FIXTURE_URL}/shop  ` } });
  assert.equal(stub.action, "configured_noop");
  assert.equal(stub.armed, true);
  assert.equal(stub.live_store, false);
  assert.equal(stub.fetched, false);
  assert.equal(stub.invented, false);
  assert.equal(stub.completion, "incomplete");
  assert.equal(stub.checkout_approved, false);
  assert.equal(stub.check.approve, false);
  assert.equal(stub.check.reason, "store_url_configured_not_live");
  assert.equal(stub.store.ok, true);
  assert.equal(stub.store.enabled, true);
  assert.equal(stub.store.reason, "store_url_configured");
  assert.equal(stub.store.store_url, undefined);
  assert.ok(ajvStub(stub));
  const resolved = resolveStoreUrl({ SHOPIFY_STORE_URL: `  ${FIXTURE_URL}/shop  ` });
  assert.equal(resolved.store_url, `${FIXTURE_URL}/shop`);
});

test("caller-supplied store_url cannot invent or arm the stub", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("invented URL must not fetch"); });
  const stub = evaluateShopifyMandateStub({
    env: {},
    store_url: FIXTURE_URL,
    checkout_url: `${FIXTURE_URL}/checkout`,
    armed: true,
    completion: "complete",
    checkout_approved: true,
    success: true,
  });
  assert.equal(stub.action, "unset_noop");
  assert.equal(stub.armed, false);
  assert.equal(stub.invented, false);
  assert.equal(stub.completion, "incomplete");
  assert.equal(stub.checkout_approved, false);
});

test("evaluateShopifyMandateStub reads process.env when opts.env is omitted", (t) => {
  isolateStoreEnv(t, undefined);
  t.mock.method(globalThis, "fetch", () => { throw new Error("process.env unset must not fetch"); });
  const unset = evaluateShopifyMandateStub();
  assert.equal(unset.action, "unset_noop");
  isolateStoreEnv(t, FIXTURE_URL);
  const armed = evaluateShopifyMandateStub();
  assert.equal(armed.action, "configured_noop");
  assert.equal(armed.armed, true);
  assert.equal(armed.fetched, false);
});

test("evaluateDone.store is the stub store report and stays complete when unset", (t) => {
  isolateStoreEnv(t, undefined);
  const { bundle, opts } = happyBundle(t);
  const stub = evaluateShopifyMandateStub({ env: {} });
  const done = evaluateDone(bundle, { ...opts, env: {} });
  assert.equal(done.completion, "complete");
  assert.deepEqual(done.store, stub.store);
  assert.equal(done.store.env, STORE_URL_ENV);
  assert.equal(done.store.reason, "store_url_unset");
  assert.equal(done.store.ok, true);
  assert.equal(done.store.store_url, undefined);
});

test("evaluateDone stays complete when the stub is armed and still does not fetch", (t) => {
  const { bundle, opts } = happyBundle(t);
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  const stub = evaluateShopifyMandateStub({ env });
  const done = evaluateDone(bundle, { ...opts, env });
  assert.equal(done.completion, "complete");
  assert.deepEqual(done.store, stub.store);
  assert.equal(stub.action, "configured_noop");
  assert.equal(done.store.enabled, true);
});

test("an armed stub cannot complete a human-checkout quote", (t) => {
  const { bundle, opts } = happyBundle(t);
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  const stub = evaluateShopifyMandateStub({ env });
  assert.equal(stub.armed, true);
  assert.equal(stub.checkout_approved, false);
  const done = evaluateDone(
    { ...bundle, quote: { status: 200, body: merchantQuoteBody() } },
    { ...opts, env },
  );
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  assert.ok(done.failed.includes("human_checkout_untouched"));
  assert.deepEqual(done.store, stub.store);
});

test("handleOfferQuote merchant result is bit-identical while the stub is armed", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("merchant quote must not fetch"); });
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  const before = evaluateShopifyMandateStub({ env });
  const deps = { verifyMerchant: async () => ({ status: "passed", reason: "verdict_supported", verdict: "supported" }) };
  const plain = await handleOfferQuote({ offer_id: MERCHANT_ID, quantity: 1 }, deps);
  evaluateShopifyMandateStub({ env });
  const after = await handleOfferQuote({
    offer_id: MERCHANT_ID,
    quantity: 1,
    mandate: { schema: SCHEMA, rail: RAIL },
    checkout_approved: true,
  }, deps);
  assert.deepEqual(after, plain);
  assert.equal(plain.json.rail, "merchant_checkout");
  assert.equal(plain.json.checkout, "merchant_hosted");
  assert.equal(plain.json.mandate, undefined);
  assert.equal(before.action, "configured_noop");
});

test("stub and Done-gate never name a storefront host or invent a URL", () => {
  assert.match(STUB_SRC, /SHOPIFY_STORE_URL/);
  assert.match(MANDATE_SRC, /shopify-mandate-stub/);
  assert.doesNotMatch(STUB_SRC, /myshopify|pixelsurplus/i);
  assert.doesNotMatch(STUB_SRC, /https:\/\/[A-Za-z0-9]/);
  assert.doesNotMatch(STUB_SRC, /\bfetch\s*\(/);
  assert.doesNotMatch(STUB_SRC, /from\s+["'][.\/].*offers/);
  assert.doesNotMatch(STUB_SRC, /handleOfferQuote|buildCheckoutUrl|authorize-purchase/);
  assert.doesNotMatch(MANDATE_SRC, /myshopify|pixelsurplus/i);
});

test("merchant rail and HTTP host do not import the stub", () => {
  const files = [
    "src/offers.js",
    "src/routes/offers.js",
    "src/server.js",
    "src/listen.js",
    "src/openapi.js",
    "src/fixture-storefront.js",
    "src/offline-buyer-checklist.js",
    "scripts/shopping-preapproval.mjs",
    "scripts/verify-shopping-receipt.mjs",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /shopify-mandate-stub/, f);
  }
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
    if (file.endsWith(`${path.sep}shopify-mandate-stub.js`)) continue;
    if (file.endsWith(`${path.sep}shopping-mandate.js`)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /shopify-mandate-stub/, path.relative(ROOT, file));
  }
});
