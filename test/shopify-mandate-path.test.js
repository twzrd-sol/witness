/**
 * Wave19 RRR — Shopify env-gated mandate path (no-op until SHOPIFY_STORE_URL).
 *
 * Builds on #46 (env gate), #49 (offline checklist / fixture), #53 (stub).
 * Unset is a no-op: the path does not inspect the bundle. A set value is
 * validated and never fetched. Armed evaluation is offline only and cannot
 * approve checkout. Human checkout stays on src/offers.js.
 *
 * Run this file: `node --test test/shopify-mandate-path.test.js`
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
import { evaluateShopifyMandateStub } from "../src/shopify-mandate-stub.js";
import {
  KIND,
  PATH_PREDICATES,
  PATH_JSON_SCHEMA,
  evaluateShopifyMandatePath,
} from "../src/shopify-mandate-path.js";
import {
  KIND as FIXTURE_KIND,
  ORIGIN,
  READER_OFFER_ID,
  loadCatalog,
  quoteProduct,
} from "../src/fixture-storefront.js";
import { evaluateBuyerChecklist } from "../src/offline-buyer-checklist.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/examples/digital-product-mandate.json"), "utf8"),
);
const PATH_SCHEMA_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/shopify-mandate-path-v1.json"), "utf8"),
);
const PATH_SRC = readFileSync(path.join(ROOT, "src/shopify-mandate-path.js"), "utf8");
const MANDATE_SRC = readFileSync(path.join(ROOT, "src/shopping-mandate.js"), "utf8");
const CHECKLIST_SRC = readFileSync(path.join(ROOT, "src/offline-buyer-checklist.js"), "utf8");
const MERCHANT_ID = "pixel-surplus-vintage-polaroid";
const X402_ID = "outbid-reader-scrape";
const FIXTURE_URL = "https://merchant.example";

const ajv = new Ajv({ strict: false, validateFormats: false });
const ajvPath = ajv.compile(PATH_SCHEMA_FILE);

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
  t.mock.method(globalThis, "fetch", () => { throw new Error("path tests must not fetch"); });
  return {
    key,
    bundle: {
      mandate,
      quote: { status: 200, body: x402QuoteBody() },
      check: mechanicalCheck(),
      reserved_minor: 0,
    },
    opts: { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") },
  };
}

function assertIdleNoop(report, reason) {
  assert.equal(report.path, "idle");
  assert.equal(report.armed, false);
  assert.equal(report.ready, false);
  assert.equal(report.live_store, false);
  assert.equal(report.fetched, false);
  assert.equal(report.invented, false);
  assert.equal(report.completion, "incomplete");
  assert.equal(report.checkout_approved, false);
  assert.equal(report.check.approve, false);
  assert.equal(report.check.reason, reason);
  assert.deepEqual(report.failed, []);
  assert.equal(report.store.store_url, undefined);
  assert.ok(ajvPath(report), ajv.errorsText(ajvPath.errors));
}

test("path schema file is the runtime schema and rejects extra fields", () => {
  assert.deepEqual(PATH_JSON_SCHEMA, PATH_SCHEMA_FILE);
  assert.equal(PATH_SCHEMA_FILE.additionalProperties, false);
  assert.equal(KIND, "witness.shopify_mandate_path.v1");
  assert.deepEqual(PATH_PREDICATES, [
    "mandate_rejects_store_fields",
    "resource_not_store_origin",
    "quote_not_store_origin",
    "human_checkout_untouched",
  ]);
  const unset = evaluateShopifyMandatePath(null, { env: {} });
  assert.ok(ajvPath(unset), ajv.errorsText(ajvPath.errors));
  assert.equal(ajvPath({ ...unset, store_url: FIXTURE_URL }), false);
  assert.equal(ajvPath({ ...unset, checkout_url: FIXTURE_URL }), false);
  assert.equal(ajvPath({ ...unset, action: "fetched" }), false);
  assert.equal(ajvPath({ ...unset, path: "live" }), false);
});

test("unset, empty, or whitespace SHOPIFY_STORE_URL is a no-op and does not inspect the bundle", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("unset path must not fetch"); });
  const leaky = {
    mandate: { store_url: FIXTURE_URL, checkout_url: `${FIXTURE_URL}/checkout`, variant_id: "1" },
    quote: { status: 200, body: merchantQuoteBody() },
  };
  for (const env of [{}, { SHOPIFY_STORE_URL: "" }, { SHOPIFY_STORE_URL: "   " }, { SHOPIFY_STORE_URL: "\n" }]) {
    const report = evaluateShopifyMandatePath(leaky, { env });
    assert.equal(report.action, "unset_noop", JSON.stringify(env));
    assertIdleNoop(report, "store_url_unset");
    assert.equal(report.store.enabled, false);
    assert.equal(report.store.ok, true);
    assert.equal(report.store.env, STORE_URL_ENV);
  }
});

test("a set but invalid SHOPIFY_STORE_URL is idle and does not inspect the bundle", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("invalid path must not fetch"); });
  const leaky = {
    mandate: { store_url: FIXTURE_URL, variant_id: "1" },
    quote: { checkout_url: FIXTURE_URL },
  };
  for (const raw of [
    "http://merchant.example",
    "https://user:pass@merchant.example",
    "not-a-url",
    "ftp://merchant.example",
    "https://",
    12,
  ]) {
    const report = evaluateShopifyMandatePath(leaky, { env: { SHOPIFY_STORE_URL: raw } });
    assert.equal(report.action, "invalid_noop", String(raw));
    assertIdleNoop(report, "store_url_invalid");
    assert.equal(report.store.ok, false);
  }
});

test("a valid SHOPIFY_STORE_URL arms configured_eval without fetching or echoing the URL", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("configured path must not fetch"); });
  const { bundle } = happyBundle(t);
  const report = evaluateShopifyMandatePath(bundle, { env: { SHOPIFY_STORE_URL: `  ${FIXTURE_URL}/shop  ` } });
  assert.equal(report.action, "configured_eval");
  assert.equal(report.path, "env_ready");
  assert.equal(report.armed, true);
  assert.equal(report.ready, true);
  assert.equal(report.live_store, false);
  assert.equal(report.fetched, false);
  assert.equal(report.invented, false);
  assert.equal(report.completion, "incomplete");
  assert.equal(report.checkout_approved, false);
  assert.equal(report.check.approve, false);
  assert.equal(report.check.reason, "path_ready_not_live");
  assert.deepEqual(report.failed, []);
  assert.equal(report.store.store_url, undefined);
  assert.equal(report.store.enabled, true);
  assert.ok(ajvPath(report));
});

test("caller-supplied store_url cannot invent or arm the path", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("invented URL must not fetch"); });
  const report = evaluateShopifyMandatePath(
    { mandate: { store_url: FIXTURE_URL } },
    {
      env: {},
      store_url: FIXTURE_URL,
      checkout_url: `${FIXTURE_URL}/checkout`,
      armed: true,
      ready: true,
      completion: "complete",
      checkout_approved: true,
      success: true,
    },
  );
  assert.equal(report.action, "unset_noop");
  assertIdleNoop(report, "store_url_unset");
});

test("evaluateShopifyMandatePath reads process.env when opts.env is omitted", (t) => {
  isolateStoreEnv(t, undefined);
  t.mock.method(globalThis, "fetch", () => { throw new Error("process.env unset must not fetch"); });
  const unset = evaluateShopifyMandatePath();
  assert.equal(unset.action, "unset_noop");
  isolateStoreEnv(t, FIXTURE_URL);
  const armed = evaluateShopifyMandatePath();
  assert.equal(armed.action, "configured_eval");
  assert.equal(armed.armed, true);
  assert.equal(armed.ready, true);
  assert.equal(armed.fetched, false);
});

test("armed path fails mandate_rejects_store_fields when the document carries store fields", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("store-field path must not fetch"); });
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  for (const extra of [
    { store_url: FIXTURE_URL },
    { cart_url: `${FIXTURE_URL}/cart/1:1` },
    { checkout_url: `${FIXTURE_URL}/checkout` },
    { product_url: `${FIXTURE_URL}/products/x` },
    { variant_id: "46117070209071" },
  ]) {
    const report = evaluateShopifyMandatePath(
      { mandate: { ...EXAMPLE, ...extra } },
      { env },
    );
    assert.equal(report.action, "configured_eval", Object.keys(extra)[0]);
    assert.equal(report.path, "env_ready");
    assert.equal(report.ready, false);
    assert.equal(report.checkout_approved, false);
    assert.ok(report.failed.includes("mandate_rejects_store_fields"), Object.keys(extra)[0]);
    assert.equal(report.check.reason, "mandate_rejects_store_fields");
    assert.ok(ajvPath(report));
  }
});

test("armed path fails resource_not_store_origin when mandate.resource_url is the store", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("resource-origin path must not fetch"); });
  const report = evaluateShopifyMandatePath(
    { mandate: { ...EXAMPLE, resource_url: `${FIXTURE_URL}/scrape` } },
    { env: { SHOPIFY_STORE_URL: FIXTURE_URL } },
  );
  assert.equal(report.ready, false);
  assert.ok(report.failed.includes("resource_not_store_origin"));
  assert.equal(report.checkout_approved, false);
  assert.equal(report.fetched, false);
});

test("armed path fails quote_not_store_origin and human_checkout_untouched for a merchant cart", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("merchant quote path must not fetch"); });
  const { bundle } = happyBundle(t);
  const report = evaluateShopifyMandatePath(
    { ...bundle, quote: { status: 200, body: merchantQuoteBody() } },
    { env: { SHOPIFY_STORE_URL: FIXTURE_URL } },
  );
  assert.equal(report.ready, false);
  assert.ok(report.failed.includes("human_checkout_untouched"));
  assert.equal(report.completion, "incomplete");
  assert.equal(report.checkout_approved, false);
});

test("armed path fails quote_not_store_origin when an x402 quote still points at the store origin", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("store-origin quote must not fetch"); });
  const { bundle } = happyBundle(t);
  const report = evaluateShopifyMandatePath(
    {
      ...bundle,
      quote: {
        status: 200,
        body: x402QuoteBody({ request: { method: "GET", url: `${FIXTURE_URL}/products/x` } }),
      },
    },
    { env: { SHOPIFY_STORE_URL: FIXTURE_URL } },
  );
  assert.equal(report.ready, false);
  assert.ok(report.failed.includes("quote_not_store_origin"));
  assert.equal(report.checkout_approved, false);
});

test("path.store matches the stub store report for the same env", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("store-report path must not fetch"); });
  for (const env of [{}, { SHOPIFY_STORE_URL: FIXTURE_URL }, { SHOPIFY_STORE_URL: "http://bad.example" }]) {
    const stub = evaluateShopifyMandateStub({ env });
    const report = evaluateShopifyMandatePath(null, { env });
    assert.deepEqual(report.store, stub.store, JSON.stringify(env));
  }
});

test("evaluateDone.store stays the stub report and evaluateDone.path is the path summary", (t) => {
  isolateStoreEnv(t, undefined);
  const { bundle, opts } = happyBundle(t);
  const env = {};
  const report = evaluateShopifyMandatePath(bundle, { env });
  const done = evaluateDone(bundle, { ...opts, env });
  assert.equal(done.completion, "complete");
  assert.deepEqual(done.store, report.store);
  assert.deepEqual(done.path, {
    kind: KIND,
    armed: false,
    ready: false,
    action: "unset_noop",
    reason: "store_url_unset",
  });
});

test("evaluateDone stays complete when the path is armed and still does not fetch", (t) => {
  const { bundle, opts } = happyBundle(t);
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  const report = evaluateShopifyMandatePath(bundle, { env });
  const done = evaluateDone(bundle, { ...opts, env });
  assert.equal(done.completion, "complete");
  assert.equal(report.ready, true);
  assert.deepEqual(done.store, report.store);
  assert.equal(done.path.armed, true);
  assert.equal(done.path.ready, true);
  assert.equal(done.path.action, "configured_eval");
  assert.equal(done.path.reason, "path_ready_not_live");
  assert.equal(done.store.enabled, true);
});

test("an armed path cannot complete a human-checkout quote", (t) => {
  const { bundle, opts } = happyBundle(t);
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  const report = evaluateShopifyMandatePath(
    { ...bundle, quote: { status: 200, body: merchantQuoteBody() } },
    { env },
  );
  assert.equal(report.ready, false);
  assert.equal(report.checkout_approved, false);
  const done = evaluateDone(
    { ...bundle, quote: { status: 200, body: merchantQuoteBody() } },
    { ...opts, env },
  );
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  assert.ok(done.failed.includes("human_checkout_untouched"));
  assert.deepEqual(done.store, report.store);
  assert.equal(done.path.ready, false);
});

test("handleOfferQuote merchant result is bit-identical while the path is armed", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("merchant quote must not fetch"); });
  const env = { SHOPIFY_STORE_URL: FIXTURE_URL };
  const before = evaluateShopifyMandatePath(null, { env });
  const deps = { verifyMerchant: async () => ({ status: "passed", reason: "verdict_supported", verdict: "supported" }) };
  const plain = await handleOfferQuote({ offer_id: MERCHANT_ID, quantity: 1 }, deps);
  evaluateShopifyMandatePath({ mandate: { schema: SCHEMA, rail: RAIL } }, { env });
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
  assert.equal(before.action, "configured_eval");
  assert.equal(before.checkout_approved, false);
});

test("armed path stays ready against the #49 fixture catalog and still is not Done", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("fixture path must not fetch"); });
  const key = generateProcessKey();
  const catalog = loadCatalog();
  const mandate = signMandate(EXAMPLE, key);
  const bundle = {
    storefront: { kind: FIXTURE_KIND, live_store: false, origin: ORIGIN },
    catalog,
    mandate,
    quote: quoteProduct(READER_OFFER_ID, { catalog }),
    reserved_minor: 0,
    payment_status: "not_attempted",
  };
  const opts = { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z"), env: { SHOPIFY_STORE_URL: FIXTURE_URL } };
  const report = evaluateShopifyMandatePath(bundle, opts);
  assert.equal(report.ready, true);
  assert.equal(report.checkout_approved, false);
  const checklist = evaluateBuyerChecklist(bundle, opts);
  assert.equal(checklist.ready, true);
  assert.equal(checklist.checkout_approved, false);
  assert.deepEqual(checklist.store, report.store);
  assert.equal(checklist.path.armed, true);
  assert.equal(checklist.path.ready, true);
  assert.equal(checklist.path.action, "configured_eval");
});

test("checklist reports an idle path when SHOPIFY_STORE_URL is unset and stays ready", (t) => {
  isolateStoreEnv(t, undefined);
  t.mock.method(globalThis, "fetch", () => { throw new Error("unset checklist path must not fetch"); });
  const key = generateProcessKey();
  const catalog = loadCatalog();
  const mandate = signMandate(EXAMPLE, key);
  const bundle = {
    storefront: { kind: FIXTURE_KIND, live_store: false, origin: ORIGIN },
    catalog,
    mandate,
    quote: quoteProduct(READER_OFFER_ID, { catalog }),
    reserved_minor: 0,
    payment_status: "not_attempted",
  };
  const opts = { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z"), env: {} };
  const checklist = evaluateBuyerChecklist(bundle, opts);
  assert.equal(checklist.ready, true);
  assert.equal(checklist.store.reason, "store_url_unset");
  assert.equal(checklist.path.action, "unset_noop");
  assert.equal(checklist.path.ready, false);
  assert.equal(checklist.checkout_approved, false);
});

test("path and Done-gate never name a storefront host or invent a URL", () => {
  assert.match(PATH_SRC, /SHOPIFY_STORE_URL/);
  assert.match(MANDATE_SRC, /shopify-mandate-path/);
  assert.doesNotMatch(PATH_SRC, /myshopify|pixelsurplus/i);
  assert.doesNotMatch(PATH_SRC, /https:\/\/[A-Za-z0-9]/);
  assert.doesNotMatch(PATH_SRC, /\bfetch\s*\(/);
  assert.doesNotMatch(PATH_SRC, /from\s+["'][.\/].*offers/);
  assert.doesNotMatch(PATH_SRC, /handleOfferQuote|buildCheckoutUrl|authorize-purchase/);
  assert.doesNotMatch(PATH_SRC, /from\s+["']\.\/shopping-mandate/);
  assert.doesNotMatch(CHECKLIST_SRC, /myshopify|pixelsurplus|shopify/i);
});

test("merchant rail and HTTP host do not import the path", () => {
  const files = [
    "src/offers.js",
    "src/routes/offers.js",
    "src/server.js",
    "src/listen.js",
    "src/openapi.js",
    "src/fixture-storefront.js",
    "scripts/shopping-preapproval.mjs",
    "scripts/verify-shopping-receipt.mjs",
  ];
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /shopify-mandate-path|shopify-mandate-stub/, f);
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
    if (file.endsWith(`${path.sep}shopify-mandate-path.js`)) continue;
    if (file.endsWith(`${path.sep}shopify-mandate-stub.js`)) continue;
    if (file.endsWith(`${path.sep}shopping-mandate.js`)) continue;
    if (file.endsWith(`${path.sep}offline-buyer-checklist.js`)) continue;
    assert.doesNotMatch(readFileSync(file, "utf8"), /shopify-mandate-path/, path.relative(ROOT, file));
  }
});
