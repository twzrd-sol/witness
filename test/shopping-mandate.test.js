import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv from "ajv";

import { generateProcessKey, pubkeyB64 } from "../src/receipt.js";
import { OFFERS, handleOfferQuote, buildCheckoutUrl } from "../src/offers.js";
import {
  SCHEMA,
  AUDIENCE,
  RAIL,
  SIGNING_DOMAIN,
  MANDATE_JSON_SCHEMA,
  STORE_URL_ENV,
  STORE_URL_JSON_SCHEMA,
  DONE_PREDICATES,
  validateMandate,
  signMandate,
  verifyMandate,
  resourceScopeAllows,
  isHumanCheckoutQuote,
  bindMandateToQuote,
  resolveStoreUrl,
  evaluateDone,
} from "../src/shopping-mandate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/examples/digital-product-mandate.json"), "utf8"),
);
const SCHEMA_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/shopping-mandate-v1.json"), "utf8"),
);
const STORE_URL_SCHEMA_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/shopify-store-url-env-v1.json"), "utf8"),
);
const SRC = readFileSync(path.join(ROOT, "src/shopping-mandate.js"), "utf8");
const MERCHANT_ID = "pixel-surplus-vintage-polaroid";
const X402_ID = "outbid-reader-scrape";

const ajv = new Ajv({ strict: false, validateFormats: false });
const ajvOk = ajv.compile(SCHEMA_FILE);
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

function happyBundle(t, mandateOverrides = {}, bundleOverrides = {}) {
  const key = generateProcessKey();
  const mandate = signMandate({ ...EXAMPLE, ...mandateOverrides }, key);
  t.mock.method(globalThis, "fetch", () => { throw new Error("mandate Done-gate must not fetch"); });
  return {
    key,
    bundle: {
      mandate,
      quote: { status: 200, body: x402QuoteBody() },
      check: mechanicalCheck(),
      reserved_minor: 0,
      ...bundleOverrides,
    },
    opts: { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") },
  };
}

test("JSON schema file is the runtime schema and Ajv accepts the unsigned example", () => {
  assert.deepEqual(MANDATE_JSON_SCHEMA, SCHEMA_FILE);
  assert.equal(SCHEMA_FILE.additionalProperties, false);
  assert.equal(SCHEMA, "witness.shopping_mandate.v1");
  assert.equal(AUDIENCE, "witness.shopping.digital_product");
  assert.equal(SIGNING_DOMAIN, SCHEMA);
  assert.ok(ajvOk(EXAMPLE), ajv.errorsText(ajvOk.errors));
  assert.equal(validateMandate(EXAMPLE).ok, true);
  assert.equal(EXAMPLE.store_url, undefined);
  assert.equal(EXAMPLE.cart_url, undefined);
  assert.equal(EXAMPLE.checkout_url, undefined);
});

test("schema and validator reject a store URL and other human-checkout fields", () => {
  for (const extra of [
    { store_url: "https://pixelsurplus.com" },
    { cart_url: "https://pixel-surplus.myshopify.com/cart/1:1" },
    { checkout_url: "https://pixel-surplus.myshopify.com/checkout" },
    { product_url: "https://pixelsurplus.com/products/x" },
    { variant_id: "46117070209071" },
    { issuer_pubkey: "not-a-trust-anchor" },
  ]) {
    const doc = { ...EXAMPLE, ...extra };
    assert.equal(ajvOk(doc), false, Object.keys(extra)[0]);
    assert.equal(validateMandate(doc).ok, false, Object.keys(extra)[0]);
  }
});

test("schema and validator reject merchant_checkout rail, fiat currency, and recurring", () => {
  assert.equal(validateMandate({ ...EXAMPLE, rail: "merchant_checkout" }).ok, false);
  assert.equal(ajvOk({ ...EXAMPLE, rail: "merchant_checkout" }), false);
  assert.equal(validateMandate({ ...EXAMPLE, currency: "USD" }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, recurring: "monthly" }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, audience: "witness.shopping.shopify" }).ok, false);
});

for (const field of ["schema", "audience", "issuer_kid", "subject", "mandate_id", "offer_id", "payee", "max_total_minor", "expires_at"]) {
  test(`missing ${field} fails schema`, () => {
    const doc = { ...EXAMPLE };
    delete doc[field];
    assert.equal(ajvOk(doc), false);
    assert.equal(validateMandate(doc).ok, false);
  });
}

test("malformed expiry, quantity, and budget fail closed", () => {
  assert.equal(validateMandate({ ...EXAMPLE, expires_at: "tomorrow" }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, expires_at: "2027-01-01T00:00:00+00:00" }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, quantity: 0 }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, quantity: 1.5 }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, max_total_minor: 0 }).ok, false);
  assert.equal(validateMandate({ ...EXAMPLE, resource_url: "http://reader.outbid.sh/scrape" }).ok, false);
});

test("sign and verify against the pinned issuer key; wrong or caller key cannot approve", () => {
  const issuer = generateProcessKey();
  const other = generateProcessKey();
  const signed = signMandate(EXAMPLE, issuer);
  assert.equal(ajvOk(signed), true);
  assert.equal(verifyMandate(signed, issuer.publicKey).ok, true);
  assert.equal(verifyMandate(signed, pubkeyB64(issuer)).ok, true);
  assert.equal(verifyMandate(signed, other.publicKey).ok, false);
  assert.equal(verifyMandate(EXAMPLE, issuer.publicKey).reason, "signature_missing");
  assert.equal(verifyMandate(signed, undefined).reason, "trusted_key_invalid");
  const tampered = { ...signed, max_total_minor: 9_999_999 };
  assert.equal(verifyMandate(tampered, issuer.publicKey).ok, false);
});

test("resource scope matches wzrd-final allow rule: same origin, exact or child path", () => {
  const scope = "https://reader.outbid.sh/scrape";
  assert.equal(resourceScopeAllows(scope, "https://reader.outbid.sh/scrape?url=https%3A%2F%2Fexample.com"), true);
  assert.equal(resourceScopeAllows(scope, "https://reader.outbid.sh/scrape/extra"), true);
  assert.equal(resourceScopeAllows(scope, "https://evil.example/scrape"), false);
  assert.equal(resourceScopeAllows(scope, "https://reader.outbid.sh/browse"), false);
  assert.equal(resourceScopeAllows("https://user:pass@reader.outbid.sh/scrape", "https://reader.outbid.sh/scrape"), false);
});

test("evaluateDone grants complete only when every predicate holds", (t) => {
  const { bundle, opts } = happyBundle(t);
  const done = evaluateDone(bundle, opts);
  assert.deepEqual(done.failed, []);
  assert.equal(done.completion, "complete");
  assert.equal(done.checkout_approved, true);
  assert.equal(done.check.reason, "mandate_done");
  assert.deepEqual(DONE_PREDICATES.length, 9);
});

test("evaluateDone ignores narration, HTTP 200, and success flags", (t) => {
  const { bundle, opts } = happyBundle(t, {}, {
    check: { approve: true, success: true, reason: "I verified", narration: "looks good" },
    http_status: 200,
    success: true,
  });
  const done = evaluateDone(bundle, opts);
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  assert.ok(done.failed.includes("receipt_check"));
});

test("same-process verifier_pid cannot satisfy receipt_check", (t) => {
  const { bundle, opts } = happyBundle(t, {}, {
    check: { ...mechanicalCheck(), verifier_pid: process.pid },
  });
  assert.ok(evaluateDone(bundle, opts).failed.includes("receipt_check"));
});

test("expired mandate is incomplete even with a supported quote and child check", (t) => {
  const { bundle, opts } = happyBundle(t, { expires_at: "2026-01-01T00:00:00Z" });
  const done = evaluateDone(bundle, opts);
  assert.ok(done.failed.includes("mandate_fresh"));
  assert.equal(done.completion, "incomplete");
});

test("changed payee, offer, or resource cannot retain approval", (t) => {
  const { key, opts } = happyBundle(t);
  const mandate = signMandate(EXAMPLE, key);
  const cases = [
    x402QuoteBody({ offer_id: "stacktree-publish" }),
    x402QuoteBody({ merchant: "other" }),
    x402QuoteBody({ accepts: [{ ...OFFERS[X402_ID].accepts[1], payTo: "11111111111111111111111111111111" }] }),
    x402QuoteBody({ request: { method: "GET", url: "https://evil.example/scrape" } }),
    x402QuoteBody({ price: { amount_atomic: "5000", asset: "USD", usd: "0.005" } }),
  ];
  for (const body of cases) {
    const done = evaluateDone({ mandate, quote: { status: 200, body }, check: mechanicalCheck() }, opts);
    assert.ok(done.failed.includes("mandate_binds_quote"), JSON.stringify(body));
    assert.equal(done.checkout_approved, false);
  }
});

test("409 / withheld quote and over-budget quoted amount fail closed", (t) => {
  const { bundle, opts } = happyBundle(t);
  const withheld = evaluateDone({
    ...bundle,
    quote: { status: 409, body: x402QuoteBody({ gate: { status: "withheld", reason: "payee_or_price_changed" }, accepts: null }) },
  }, opts);
  assert.ok(withheld.failed.includes("quote_passed"));
  const over = evaluateDone({ ...bundle, reserved_minor: 1 }, opts);
  assert.ok(over.failed.includes("amount_in_budget"));
  const sameKey = generateProcessKey();
  const ceiling = evaluateDone({
    ...bundle,
    mandate: signMandate({ ...EXAMPLE, max_total_minor: 4999 }, sameKey),
  }, { ...opts, issuerPublicKey: sameKey.publicKey });
  assert.ok(ceiling.failed.includes("amount_in_budget"));
});

test("human-checkout quote cannot complete the digital-product Done-gate", (t) => {
  const { bundle, opts } = happyBundle(t);
  const merchantBody = {
    offer_id: MERCHANT_ID,
    rail: "merchant_checkout",
    merchant: "Pixel Surplus",
    checkout: "merchant_hosted",
    checkout_url: OFFERS[MERCHANT_ID].cart_url,
    cart: { items: [{ variant_id: OFFERS[MERCHANT_ID].variant_id, quantity: 1 }] },
    gate: { status: "passed", reason: "verdict_supported" },
    price: { amount_atomic: "600", asset: "USD" },
    accepts: [{ payTo: EXAMPLE.payee, network: EXAMPLE.network, asset: EXAMPLE.asset }],
    request: { url: EXAMPLE.resource_url },
  };
  assert.equal(isHumanCheckoutQuote(merchantBody), true);
  assert.equal(isHumanCheckoutQuote(x402QuoteBody()), false);
  const done = evaluateDone({ ...bundle, quote: { status: 200, body: merchantBody } }, opts);
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  assert.ok(done.failed.includes("human_checkout_untouched"));
  assert.ok(done.failed.includes("rail_x402"));
});

test("human-checkout catalog and handleOfferQuote stay mandate-free", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("merchant quote test must not fetch"); });
  const offer = OFFERS[MERCHANT_ID];
  assert.equal(offer.rail, "merchant_checkout");
  assert.equal(offer.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
  assert.equal(offer.cart_base, "https://pixel-surplus.myshopify.com/cart");
  assert.equal(offer.variant_id, "46117070209071");
  assert.equal(buildCheckoutUrl(offer, 1), offer.cart_url);

  const quote = await handleOfferQuote(
    { offer_id: offer.id, quantity: 1, mandate: { schema: SCHEMA, rail: RAIL } },
    { verifyMerchant: async () => ({ status: "passed", reason: "verdict_supported", verdict: "supported", source: offer.verify.url }) },
  );
  assert.equal(quote.status, 200);
  assert.equal(quote.json.checkout, "merchant_hosted");
  assert.equal(quote.json.checkout_url, offer.cart_url);
  assert.equal(quote.json.rail, "merchant_checkout");
  assert.equal(quote.json.mandate, undefined);
  assert.equal(quote.json.authorization, undefined);
});

test("mandate module wires SHOPIFY_STORE_URL and never names a storefront host", () => {
  assert.match(SRC, /SHOPIFY_STORE_URL/);
  assert.match(SRC, /shopify-mandate-stub/);
  assert.doesNotMatch(SRC, /myshopify|pixelsurplus/i);
  assert.equal(STORE_URL_ENV, "SHOPIFY_STORE_URL");
});

test("evaluateDone and bindMandateToQuote never fetch", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const key = generateProcessKey();
  const mandate = signMandate(EXAMPLE, key);
  assert.equal(bindMandateToQuote(mandate, x402QuoteBody()).ok, true);
  const done = evaluateDone({
    mandate,
    quote: { status: 200, body: x402QuoteBody() },
    check: mechanicalCheck(),
  }, { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z"), env: {} });
  assert.equal(done.completion, "complete");
});

test("empty bundle is incomplete on every required predicate class", () => {
  const done = evaluateDone(null, { env: {} });
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  for (const p of ["mandate_schema", "mandate_signature", "mandate_fresh", "receipt_check", "quote_passed", "amount_in_budget"]) {
    assert.ok(done.failed.includes(p), p);
  }
});

test("store-url env schema accepts unset, configured, and invalid resolver results", () => {
  assert.deepEqual(STORE_URL_JSON_SCHEMA, STORE_URL_SCHEMA_FILE);
  assert.equal(STORE_URL_SCHEMA_FILE.additionalProperties, false);
  assert.ok(ajvStore({ ok: true, enabled: false, store_url: null, reason: "store_url_unset" }));
  assert.ok(ajvStore({
    ok: true, enabled: true, store_url: "https://merchant.example", reason: "store_url_configured",
  }));
  assert.ok(ajvStore({ ok: false, enabled: false, store_url: null, reason: "store_url_invalid" }));
  assert.equal(ajvStore({ ok: true, enabled: true, store_url: "https://merchant.example", reason: "fetched" }), false);
  assert.equal(ajvStore({ ok: true, enabled: false, store_url: null, reason: "store_url_unset", cart_url: "x" }), false);
});

test("resolveStoreUrl no-ops when SHOPIFY_STORE_URL is unset, empty, or whitespace", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("store URL resolver must not fetch"); });
  for (const env of [{}, { SHOPIFY_STORE_URL: "" }, { SHOPIFY_STORE_URL: "   " }, { SHOPIFY_STORE_URL: "\n" }]) {
    const resolved = resolveStoreUrl(env);
    assert.equal(resolved.ok, true, JSON.stringify(env));
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.store_url, null);
    assert.equal(resolved.reason, "store_url_unset");
    assert.ok(ajvStore(resolved));
  }
});

test("resolveStoreUrl fail-closes on a set but invalid store URL and does not fetch", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("invalid store URL must not fetch"); });
  for (const raw of [
    "http://merchant.example",
    "https://user:pass@merchant.example",
    "not-a-url",
    "ftp://merchant.example",
    "https://",
  ]) {
    const resolved = resolveStoreUrl({ SHOPIFY_STORE_URL: raw });
    assert.equal(resolved.ok, false, raw);
    assert.equal(resolved.enabled, false);
    assert.equal(resolved.store_url, null);
    assert.equal(resolved.reason, "store_url_invalid");
    assert.ok(ajvStore(resolved));
  }
});

test("resolveStoreUrl records a valid https store URL without fetching", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("configured store URL must not fetch"); });
  const resolved = resolveStoreUrl({ SHOPIFY_STORE_URL: "  https://merchant.example/shop  " });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.store_url, "https://merchant.example/shop");
  assert.equal(resolved.reason, "store_url_configured");
  assert.ok(ajvStore(resolved));
});

test("evaluateDone no-ops when SHOPIFY_STORE_URL is unset in process.env", (t) => {
  isolateStoreEnv(t, undefined);
  t.mock.method(globalThis, "fetch", () => { throw new Error("unset store URL must not fetch"); });
  const { bundle, opts } = happyBundle(t);
  const done = evaluateDone(bundle, opts);
  assert.equal(done.completion, "complete");
  assert.equal(done.checkout_approved, true);
  assert.equal(done.store.enabled, false);
  assert.equal(done.store.reason, "store_url_unset");
  assert.equal(done.store.env, STORE_URL_ENV);
  assert.equal(done.failed.includes("store_url"), false);
});

test("evaluateDone stays complete when a valid SHOPIFY_STORE_URL is set and still does not fetch", (t) => {
  isolateStoreEnv(t, "https://merchant.example");
  t.mock.method(globalThis, "fetch", () => { throw new Error("set store URL must not fetch"); });
  const { bundle, opts } = happyBundle(t);
  const done = evaluateDone(bundle, { ...opts, env: { SHOPIFY_STORE_URL: "https://merchant.example" } });
  assert.equal(done.completion, "complete");
  assert.equal(done.store.enabled, true);
  assert.equal(done.store.reason, "store_url_configured");
  assert.equal(done.store.store_url, undefined);
});

test("invalid SHOPIFY_STORE_URL is reported and is not a Done predicate", (t) => {
  const { bundle, opts } = happyBundle(t);
  const done = evaluateDone(bundle, { ...opts, env: { SHOPIFY_STORE_URL: "http://merchant.example" } });
  assert.equal(done.completion, "complete");
  assert.equal(done.store.enabled, false);
  assert.equal(done.store.reason, "store_url_invalid");
  assert.equal(done.failed.includes("store_url"), false);
});

test("a configured store URL cannot complete a human-checkout quote", (t) => {
  const { bundle, opts } = happyBundle(t);
  const merchantBody = {
    offer_id: MERCHANT_ID,
    rail: "merchant_checkout",
    merchant: "Pixel Surplus",
    checkout: "merchant_hosted",
    checkout_url: OFFERS[MERCHANT_ID].cart_url,
    cart: { items: [{ variant_id: OFFERS[MERCHANT_ID].variant_id, quantity: 1 }] },
    gate: { status: "passed", reason: "verdict_supported" },
    price: { amount_atomic: "600", asset: "USD" },
    accepts: [{ payTo: EXAMPLE.payee, network: EXAMPLE.network, asset: EXAMPLE.asset }],
    request: { url: EXAMPLE.resource_url },
  };
  const done = evaluateDone(
    { ...bundle, quote: { status: 200, body: merchantBody } },
    { ...opts, env: { SHOPIFY_STORE_URL: "https://merchant.example" } },
  );
  assert.equal(done.completion, "incomplete");
  assert.ok(done.failed.includes("human_checkout_untouched"));
  assert.equal(done.store.enabled, true);
});
