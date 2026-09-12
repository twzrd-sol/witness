/**
 * Wave9 FF — offline buyer checklist + fixture storefront stub.
 *
 * In-process catalog and loopback HTTP only. fetch is mocked on library
 * paths. No live store, no reader, no 402, no wallet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import http from "node:http";
import path from "node:path";
import Ajv from "ajv";

import { generateProcessKey } from "../src/receipt.js";
import { OFFERS } from "../src/offers.js";
import {
  signMandate,
  verifyMandate,
  bindMandateToQuote,
  evaluateDone,
} from "../src/shopping-mandate.js";
import {
  KIND,
  ORIGIN,
  READER_OFFER_ID,
  NOTE_OFFER_ID,
  FIXTURE_JSON_SCHEMA,
  inspectCatalog,
  loadCatalog,
  listProducts,
  getProduct,
  quoteProduct,
  renderFixtureHtml,
  listenFixture,
} from "../src/fixture-storefront.js";
import {
  CHECKLIST_STEPS,
  evaluateBuyerChecklist,
} from "../src/offline-buyer-checklist.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/examples/digital-product-mandate.json"), "utf8"),
);
const CATALOG_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "fixtures/storefront/catalog.json"), "utf8"),
);
const SCHEMA_FILE = JSON.parse(
  readFileSync(path.join(ROOT, "docs/consumer/schemas/fixture-storefront-v1.json"), "utf8"),
);
const FIXTURE_SRC = readFileSync(path.join(ROOT, "src/fixture-storefront.js"), "utf8");
const CHECKLIST_SRC = readFileSync(path.join(ROOT, "src/offline-buyer-checklist.js"), "utf8");
const MERCHANT_ID = "pixel-surplus-vintage-polaroid";

const ajv = new Ajv({ strict: false, validateFormats: false });
const ajvOk = ajv.compile(SCHEMA_FILE);

function mechanicalCheck() {
  return {
    approve: true,
    reason: "receipt_supported",
    verifier_pid: process.pid + 1000,
    receipt_hash: "ab".repeat(32),
    key_hash: "cd".repeat(32),
  };
}

function copyCatalog(overrides = {}) {
  return {
    ...CATALOG_FILE,
    products: CATALOG_FILE.products.map((p) => ({
      ...p,
      resource: { ...p.resource },
      accepts: p.accepts.map((a) => ({ ...a })),
    })),
    ...overrides,
  };
}

function happyBundle(t, mandateOverrides = {}, bundleOverrides = {}) {
  const key = generateProcessKey();
  const mandate = signMandate({ ...EXAMPLE, ...mandateOverrides }, key);
  const catalog = loadCatalog();
  t.mock.method(globalThis, "fetch", () => { throw new Error("offline checklist must not fetch"); });
  return {
    key,
    catalog,
    bundle: {
      storefront: { kind: KIND, live_store: false, origin: ORIGIN },
      catalog,
      mandate,
      quote: quoteProduct(READER_OFFER_ID, { catalog }),
      reserved_minor: 0,
      payment_status: "not_attempted",
      ...bundleOverrides,
    },
    opts: { issuerPublicKey: key.publicKey, now: Date.parse("2026-09-12T12:00:00Z") },
  };
}

async function withFixture(fn, catalog) {
  const server = listenFixture({ host: "127.0.0.1", port: 0, catalog });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function requestWithHost(base, pathname, hostHeader) {
  const u = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { host: hostHeader },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body = raw;
        try { body = JSON.parse(raw); } catch { /* text */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("JSON schema file is the runtime schema and Ajv accepts the committed catalog", () => {
  assert.deepEqual(FIXTURE_JSON_SCHEMA, SCHEMA_FILE);
  assert.equal(SCHEMA_FILE.additionalProperties, false);
  assert.equal(KIND, "witness.fixture_storefront.v1");
  assert.equal(ORIGIN, "local");
  assert.ok(ajvOk(CATALOG_FILE), ajv.errorsText(ajvOk.errors));
  assert.equal(inspectCatalog(CATALOG_FILE).ok, true);
  assert.equal(CATALOG_FILE.live_store, false);
  assert.equal(CATALOG_FILE.origin, "local");
});

test("schema and inspectCatalog reject a store URL and other human-checkout fields", () => {
  const extra = { store_url: "https://example.com/store" };
  assert.equal(ajvOk({ ...CATALOG_FILE, ...extra }), false);
  assert.equal(inspectCatalog({ ...CATALOG_FILE, ...extra }).ok, false);

  const poisoned = copyCatalog();
  poisoned.products[0] = {
    ...poisoned.products[0],
    variant_id: "46117070209071",
    cart_url: "https://example.com/cart/1:1",
    checkout_url: "https://example.com/checkout",
    rail: "merchant_checkout",
    checkout: "merchant_hosted",
  };
  assert.equal(ajvOk(poisoned), false);
  assert.equal(inspectCatalog(poisoned).ok, false);
  assert.equal(inspectCatalog(poisoned).reason, "forbidden_field");
});

test("committed catalog is digital-only and omits the merchant-rail offer", () => {
  const ids = CATALOG_FILE.products.map((p) => p.id);
  assert.deepEqual(ids, [READER_OFFER_ID, NOTE_OFFER_ID]);
  assert.ok(!ids.includes(MERCHANT_ID));
  assert.equal(OFFERS[MERCHANT_ID].rail, "merchant_checkout");
  for (const p of CATALOG_FILE.products) {
    assert.equal(p.rail, "x402");
    assert.equal(p.checkout, "x402");
    assert.equal(p.variant_id, undefined);
    assert.equal(p.cart_url, undefined);
    assert.equal(p.checkout_url, undefined);
    assert.equal(p.store_url, undefined);
  }
  const text = JSON.stringify(CATALOG_FILE);
  assert.doesNotMatch(text, /my\s*shopify|shopify\.com|pixelsurplus/i);
});

test("listProducts and getProduct read the fixture catalog", () => {
  const listed = listProducts();
  assert.equal(listed.length, 2);
  assert.equal(getProduct(READER_OFFER_ID).merchant, "outbid");
  assert.equal(getProduct(NOTE_OFFER_ID).merchant, "fixture");
  assert.equal(getProduct(MERCHANT_ID), null);
  assert.equal(getProduct(""), null);
});

test("quoteProduct builds a fixture quote that binds the signed mandate example", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("fixture quote must not fetch"); });
  const quote = quoteProduct(READER_OFFER_ID);
  assert.equal(quote.status, 200);
  assert.equal(quote.body.source, "fixture_catalog");
  assert.equal(quote.body.probed, false);
  assert.equal(quote.body.live_store, false);
  assert.equal(quote.body.gate.reason, "fixture_catalog");
  assert.equal(quote.body.rail, "x402");
  assert.equal(quote.body.checkout, "x402");
  assert.equal(quote.body.checkout_url, undefined);
  assert.match(quote.body.request.url, /example\.com/);

  const key = generateProcessKey();
  const mandate = signMandate(EXAMPLE, key);
  assert.equal(verifyMandate(mandate, key.publicKey).ok, true);
  assert.equal(bindMandateToQuote(mandate, quote.body).ok, true);
});

test("quoteProduct fail-closes unknown ids, bad quantity, and bad input", () => {
  assert.equal(quoteProduct(MERCHANT_ID).status, 404);
  assert.equal(quoteProduct(READER_OFFER_ID, { quantity: 2 }).status, 400);
  assert.equal(quoteProduct(READER_OFFER_ID, { input: { url: "http://example.com" } }).status, 400);
  assert.equal(quoteProduct("").status, 400);
  const note = quoteProduct(NOTE_OFFER_ID);
  assert.equal(note.status, 200);
  assert.equal(note.body.request.url, "https://fixture.witness.test/note");
});

test("inspectCatalog rejects a catalog that names a forbidden storefront host", () => {
  const poisoned = copyCatalog({ note: "see https://evil." + "myshopify.com/cart" });
  assert.equal(inspectCatalog(poisoned).ok, false);
  assert.equal(inspectCatalog(poisoned).reason, "forbidden_host");
});

test("evaluateBuyerChecklist grants ready only when every step holds — and still is not Done", (t) => {
  const { bundle, opts } = happyBundle(t);
  const report = evaluateBuyerChecklist(bundle, opts);
  assert.deepEqual(report.failed, []);
  assert.equal(report.ready, true);
  assert.equal(report.checklist, "passed");
  assert.equal(report.completion, "incomplete");
  assert.equal(report.checkout_approved, false);
  assert.equal(report.payment_attempted, false);
  assert.equal(report.check.approve, false);
  assert.equal(report.check.reason, "checklist_passed_not_done");
  assert.equal(CHECKLIST_STEPS.length, 12);

  const done = evaluateDone(bundle, opts);
  assert.equal(done.completion, "incomplete");
  assert.equal(done.checkout_approved, false);
  assert.ok(done.failed.includes("receipt_check"));
});

test("a fixture quote plus a child receipt_check can complete evaluateDone; the checklist still denies checkout", (t) => {
  const { bundle, opts } = happyBundle(t, {}, { check: mechanicalCheck() });
  const report = evaluateBuyerChecklist(bundle, opts);
  assert.equal(report.ready, true);
  assert.equal(report.checkout_approved, false);
  const done = evaluateDone(bundle, opts);
  assert.equal(done.completion, "complete");
  assert.equal(done.checkout_approved, true);
});

test("evaluateBuyerChecklist ignores narration, HTTP 200, and success flags", (t) => {
  const { opts } = happyBundle(t);
  const report = evaluateBuyerChecklist({
    success: true,
    http_status: 200,
    narration: "buyer is ready",
    check: { approve: true, reason: "I checked" },
  }, opts);
  assert.equal(report.ready, false);
  assert.equal(report.checkout_approved, false);
  assert.ok(report.failed.includes("storefront_is_fixture"));
  assert.ok(report.failed.includes("receipt_check") === false);
});

test("expired mandate is not ready even with a fixture quote", (t) => {
  const { bundle, opts } = happyBundle(t, { expires_at: "2026-01-01T00:00:00Z" });
  const report = evaluateBuyerChecklist(bundle, opts);
  assert.ok(report.failed.includes("mandate_fresh"));
  assert.equal(report.ready, false);
});

test("wrong issuer pin cannot approve the checklist", (t) => {
  const { bundle, opts } = happyBundle(t);
  const other = generateProcessKey();
  const report = evaluateBuyerChecklist(bundle, { ...opts, issuerPublicKey: other.publicKey });
  assert.ok(report.failed.includes("mandate_signature"));
  assert.equal(report.ready, false);
});

test("over-budget reserved spend fails amount_in_budget", (t) => {
  const { bundle, opts } = happyBundle(t, {}, { reserved_minor: 1 });
  assert.ok(evaluateBuyerChecklist(bundle, opts).failed.includes("amount_in_budget"));
});

test("a merchant-checkout quote cannot pass the checklist", (t) => {
  const { bundle, opts } = happyBundle(t, {}, {
    quote: {
      status: 200,
      body: {
        offer_id: MERCHANT_ID,
        rail: "merchant_checkout",
        merchant: "Pixel Surplus",
        checkout: "merchant_hosted",
        checkout_url: OFFERS[MERCHANT_ID].cart_url,
        cart: { items: [{ variant_id: OFFERS[MERCHANT_ID].variant_id, quantity: 1 }] },
        gate: { status: "passed", reason: "verdict_supported" },
        price: { amount_atomic: "600", asset: "USD" },
        source: "live_store",
        probed: true,
        live_store: true,
      },
    },
  });
  const report = evaluateBuyerChecklist(bundle, opts);
  assert.equal(report.ready, false);
  assert.ok(report.failed.includes("quote_from_fixture"));
  assert.ok(report.failed.includes("human_checkout_untouched"));
});

test("a live-looking x402 quote (probed) fails quote_from_fixture", (t) => {
  const { bundle, opts } = happyBundle(t);
  const live = {
    ...bundle.quote,
    body: { ...bundle.quote.body, source: "live_402", probed: true, gate: { status: "passed", reason: "challenge_matches_catalog" } },
  };
  const report = evaluateBuyerChecklist({ ...bundle, quote: live }, opts);
  assert.ok(report.failed.includes("quote_from_fixture"));
  assert.equal(report.ready, false);
});

test("payment_attempted or a wallet fails no_spend", (t) => {
  const { bundle, opts } = happyBundle(t);
  assert.ok(evaluateBuyerChecklist({ ...bundle, payment_attempted: true }, opts).failed.includes("no_spend"));
  assert.ok(evaluateBuyerChecklist({ ...bundle, wallet: { pubkey: "x" } }, opts).failed.includes("no_spend"));
  assert.ok(evaluateBuyerChecklist({ ...bundle, paid: true }, opts).failed.includes("no_spend"));
});

test("a storefront that claims to be live fails storefront_is_fixture", (t) => {
  const { bundle, opts } = happyBundle(t, {}, {
    storefront: { kind: KIND, live_store: true, origin: "public" },
  });
  assert.ok(evaluateBuyerChecklist(bundle, opts).failed.includes("storefront_is_fixture"));
});

test("empty bundle is not ready on every required step class", () => {
  const report = evaluateBuyerChecklist(null, {});
  assert.equal(report.ready, false);
  assert.equal(report.checkout_approved, false);
  for (const p of ["storefront_is_fixture", "catalog_digital_only", "no_store_fields", "mandate_schema", "mandate_signature", "quote_from_fixture", "no_spend"]) {
    assert.ok(report.failed.includes(p), p);
  }
});

test("renderFixtureHtml labels the page as a local fixture with no payment", () => {
  const html = renderFixtureHtml();
  assert.match(html, /FIXTURE/);
  assert.match(html, /no payment/);
  assert.match(html, /live_store=false/);
  assert.match(html, /outbid-reader-scrape/);
  assert.doesNotMatch(html, /Buy now/i);
});

test("listenFixture serves health, catalog, and fixture quotes on loopback", async () => {
  await withFixture(async (base) => {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.kind, KIND);
    assert.equal(health.live_store, false);

    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /FIXTURE/);

    const products = await (await fetch(`${base}/api/products`)).json();
    assert.equal(products.products.length, 2);

    const one = await fetch(`${base}/api/products/${READER_OFFER_ID}`);
    assert.equal(one.status, 200);
    assert.equal((await one.json()).id, READER_OFFER_ID);

    const quoted = await fetch(`${base}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer_id: READER_OFFER_ID }),
    });
    assert.equal(quoted.status, 200);
    const body = await quoted.json();
    assert.equal(body.source, "fixture_catalog");
    assert.equal(body.probed, false);
    assert.equal(quoted.headers.get("x-fixture-storefront"), KIND);

    const missing = await fetch(`${base}/api/products/${MERCHANT_ID}`);
    assert.equal(missing.status, 404);

    const pay = await fetch(`${base}/witness`, { method: "POST" });
    assert.equal(pay.status, 404);
  });
});

test("listenFixture refuses a non-loopback bind before listen", () => {
  assert.throws(() => listenFixture({ host: "0.0.0.0", port: 0 }), /fixture_bind_not_loopback/);
  assert.throws(() => listenFixture({ host: "localhost", port: 0 }), /fixture_bind_not_loopback/);
});

test("fixture HTTP rejects a non-local Host header", async () => {
  await withFixture(async (base) => {
    const remote = await requestWithHost(base, "/health", "evil." + "myshopify.com");
    assert.equal(remote.status, 400);
    assert.equal(remote.body.reason, "fixture_host_not_local");
    const ok = await requestWithHost(base, "/health", "127.0.0.1");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.live_store, false);
  });
});

test("fixture and checklist modules never name a live storefront host and do not import offers", () => {
  assert.doesNotMatch(FIXTURE_SRC, /myshopify|pixelsurplus|shopify/i);
  assert.doesNotMatch(CHECKLIST_SRC, /myshopify|pixelsurplus|shopify/i);
  assert.doesNotMatch(FIXTURE_SRC, /offers\.js|handleOfferQuote|probeX402|verifyMerchant/);
  assert.doesNotMatch(FIXTURE_SRC, /from ["'].*server\.js/);
});
