/**
 * Adversarial suite for the offers catalog + funnel — extends #40 without
 * repeating its /quote /witness /delivery/attest host matrix.
 *
 * #40 pinned those three paid/probe routes. This file covers the surfaces #40
 * left alone:
 *
 *   Offers (unpaid; OpenAPI security: []):
 *     GET  /offers/:id
 *     GET  /api/offers
 *     GET  /api/offers/:id
 *     GET  /api/offers/:id/task.json
 *     POST /api/quotes
 *
 *   Funnel (not an HTTP route — append-only NDJSON on POST /quote and
 *   POST /witness only). Offers must not write it: funnelOutcome has no
 *   catalog category, so a 200 handoff would be mislabeled
 *   witness_signed_receipt.
 *
 * Matrix — every item is a named `test()`; every assertion is concrete:
 *  1. Shape/400 never 402 — malformed /api/quotes bodies and catalog 404s
 *     are client errors. A live resource 402 must not leak as a host 402.
 *     Funnel shape rows are *_non_deliverable, never a 402.
 *  2. Forged payment headers — invented or stolen X-PAYMENT /
 *     PAYMENT-SIGNATURE do not 402 the catalog, unlock a withheld handoff,
 *     mint a receipt, or settle. Funnel rows never carry payment material.
 *  3. Settle-only-on-2xx — offers have no host paywall. Facilitator settle
 *     stays 0 on every offers status, including a payment header. Funnel
 *     records witness_signed_receipt only after a /witness 200.
 *
 * No live reader. No live facilitator. Injected retrieve + probeFetch +
 * facilitator stubs. Held #20 / #21 (twice-pay, payout-claim) untouched.
 *
 * Run this file: `node --test test/offers-funnel-adversarial.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
import { readObservations } from "../src/observatory.js";
import { OFFERS } from "../src/offers.js";
import { funnelOutcome, funnelReason } from "../src/funnel.js";

const PAYWALL = {
  evmAddress: "0xabc0000000000000000000000000000000000001",
  svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
};
const BASE_URL = "https://witness.example.net";
const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const WITNESS_BODY = {
  url: "https://example.com/pricing",
  extract: { starter_price: "number", currency: "string" },
};
const MERCHANT_ID = "pixel-surplus-vintage-polaroid";
const X402_ID = "outbid-reader-scrape";
const BODY_INPUT_ID = "stacktree-publish";
const VERIFY_URL = OFFERS[MERCHANT_ID].verify.url;
const CART = "https://pixel-surplus.myshopify.com/cart/46117070209071:1";

const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];

const refusingFacilitator = {
  async getSupported() { return { kinds: KINDS }; },
  async verify() { return { isValid: false, invalidReason: "fixture refuses every payment" }; },
  async settle() { throw new Error("settle must not be reached on a refused or forged payment"); },
};

function acceptingFacilitator() {
  const calls = { verify: 0, settle: 0 };
  return {
    calls,
    async getSupported() { return { kinds: KINDS }; },
    async verify() {
      calls.verify += 1;
      return { isValid: true, payer: "0x00000000000000000000000000000000000000aa" };
    },
    async settle(_payload, requirements) {
      calls.settle += 1;
      return {
        success: true,
        transaction: `0x${"ab".repeat(32)}`,
        network: requirements.network,
        payer: "0x00000000000000000000000000000000000000aa",
      };
    },
  };
}

const productDoc = (price) =>
  JSON.stringify({ id: 1, title: "Vintage Polaroid Photo Frames", handle: "vintage-polaroid-photo-frames", price, variants: [{ id: 46117070209071, price }] });

function countingRetrieve(price = 600) {
  const calls = { n: 0, urls: [] };
  return {
    calls,
    retrieve: async (url) => {
      calls.n += 1;
      calls.urls.push(url);
      if (url === VERIFY_URL) return { text: productDoc(price) };
      return { text: FIXTURE };
    },
  };
}

const liveAccepts = OFFERS[X402_ID].accepts.map((a) => ({ ...a, maxTimeoutSeconds: 300 }));
const challengeHeader = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", accepts })).toString("base64");

function countingProbe({ status = 402, accepts = liveAccepts } = {}) {
  const calls = { n: 0, urls: [], methods: [] };
  return {
    calls,
    fetch: async (url, init = {}) => {
      calls.n += 1;
      calls.urls.push(url);
      calls.methods.push(init.method);
      return {
        status,
        headers: { get: (h) => (h === "payment-required" && status === 402 ? challengeHeader(accepts) : null) },
        json: async () => ({}),
      };
    },
  };
}

async function serve(app, fn) {
  const server = await new Promise((resolve, reject) => {
    const s = listenExclusive(app, { port: 0 }, {
      onListening: () => resolve(s),
      onError: (e) => reject(new Error(`host listen failed (${e.code}): ${e.message}`, { cause: e })),
    });
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function host(extra = {}) {
  const observationsDir = extra.observationsDir ?? mkdtempSync(path.join(os.tmpdir(), "wit-off-adv-"));
  const reader = extra.retrieve ? { retrieve: extra.retrieve, calls: extra.retrieveCalls } : countingRetrieve(extra.merchantPrice ?? 600);
  return {
    app: createApp({
      key: extra.key ?? generateProcessKey(),
      retrieve: reader.retrieve,
      observationsDir,
      funnelDir: extra.funnelDir === undefined ? null : extra.funnelDir,
      facilitator: extra.facilitator ?? refusingFacilitator,
      paywall: extra.paywall === undefined ? PAYWALL : extra.paywall,
      publicBaseUrl: BASE_URL,
      quoteRateLimit: extra.quoteRateLimit,
      quoteGlobalRateLimit: extra.quoteGlobalRateLimit,
      probeFetch: extra.probeFetch ?? (async () => { throw new Error("probeFetch must be injected — no live x402"); }),
      gateTtlMs: extra.gateTtlMs ?? 0,
    }),
    observationsDir,
    retrieveCalls: reader.calls,
  };
}

const post = (base, route, body, headers = {}) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function challengeOf(res) {
  const raw = res.headers.get("payment-required");
  assert.ok(raw, "402 without a PAYMENT-REQUIRED header is not an x402 challenge");
  try { return JSON.parse(raw); } catch { /* base64url or base64 */ }
  try { return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); } catch { /* std base64 */ }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

async function paymentFor(base, route, body) {
  const res = await post(base, route, body);
  assert.equal(res.status, 402, `challenge fetch for ${route} must be 402, got ${res.status}`);
  const accepted = challengeOf(res).accepts[0];
  return {
    "payment-signature": Buffer.from(JSON.stringify({
      x402Version: 2,
      accepted,
      payload: { signature: "0x00", authorization: {} },
    })).toString("base64"),
  };
}

function assertNoChallenge(res, label) {
  assert.notEqual(res.status, 402, `${label}: must not be a payment challenge`);
  assert.equal(res.headers.get("payment-required"), null, `${label}: carried PAYMENT-REQUIRED`);
}

function readFunnel(dir) {
  const file = path.join(dir, "funnel.ndjson");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((l) => JSON.parse(l));
}

async function funnelSettled(dir) {
  await new Promise((r) => setTimeout(r, 20));
  return readFunnel(dir);
}

const CATALOG_OK = [
  `/offers/${MERCHANT_ID}`,
  `/offers/${X402_ID}`,
  "/api/offers",
  `/api/offers/${MERCHANT_ID}`,
  `/api/offers/${X402_ID}`,
  `/api/offers/${BODY_INPUT_ID}`,
  `/api/offers/${MERCHANT_ID}/task.json`,
  `/api/offers/${X402_ID}/task.json`,
];

const CATALOG_MISSING = [
  "/offers/nope",
  "/api/offers/nope",
  "/api/offers/nope/task.json",
];

const FORGED = [
  { "x-payment": "forged" },
  { "payment-signature": "forged" },
  { "X-PAYMENT": "forged" },
  { "PAYMENT-SIGNATURE": "forged" },
  { "payment-signature": "e30=" },
  { "x-payment": Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: {} })).toString("base64") },
];

const FUNNEL_FORBIDDEN = [
  "example.com", "starter_price", "x-payment", "payment-signature", "user-agent",
  "0x", "evidence", "http://", "https://", MERCHANT_ID, X402_ID, "myshopify",
  "forged", "PAYMENT-REQUIRED", "pixel-surplus",
];

// ---------------------------------------------------------------------------
// 1. Shape / 400 never 402
// ---------------------------------------------------------------------------

test("matrix 1 (shape/400 never 402): POST /api/quotes — malformed bodies, wrong content-type, and missing fields are client errors with no PAYMENT-REQUIRED", async () => {
  const probe = countingProbe();
  const { app, retrieveCalls } = host({ probeFetch: probe.fetch });
  await serve(app, async (base) => {
    const cases = [
      ["malformed JSON", 400, "bad_json", () => post(base, "/api/quotes", "{not json")],
      ["JSON null", 400, "bad_offer_quote", () => post(base, "/api/quotes", "null")],
      ["array body", 400, "bad_offer_quote", () => post(base, "/api/quotes", [1, 2])],
      ["empty object", 400, "bad_offer_quote", () => post(base, "/api/quotes", {})],
      ["missing offer_id", 400, "bad_offer_quote", () => post(base, "/api/quotes", { quantity: 1 })],
      ["numeric offer_id", 400, "bad_offer_quote", () => post(base, "/api/quotes", { offer_id: 1 })],
      ["empty offer_id", 400, "bad_offer_quote", () => post(base, "/api/quotes", { offer_id: "" })],
      ["bad quantity", 400, "bad_quantity", () => post(base, "/api/quotes", { offer_id: MERCHANT_ID, quantity: 0 })],
      ["bad input.url", 400, "bad_input_url", () => post(base, "/api/quotes", { offer_id: X402_ID, input: { url: "ftp://x" } })],
      ["unknown offer", 404, "offer_not_found", () => post(base, "/api/quotes", { offer_id: "nope" })],
      ["text/plain (json parser skipped)", 400, "bad_offer_quote", () => fetch(`${base}/api/quotes`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })],
      ["form-urlencoded", 400, "bad_offer_quote", () => fetch(`${base}/api/quotes`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `offer_id=${MERCHANT_ID}` })],
      ["no content-type", 400, "bad_offer_quote", () => fetch(`${base}/api/quotes`, { method: "POST", body: JSON.stringify({ offer_id: MERCHANT_ID }) })],
      ["payment header + malformed JSON still shape-first", 400, "bad_json", () => post(base, "/api/quotes", "{not json", { "x-payment": "forged" })],
      ["payment-signature + missing offer_id still shape-first", 400, "bad_offer_quote", () => post(base, "/api/quotes", {}, { "payment-signature": "forged" })],
    ];
    for (const [label, status, reason, send] of cases) {
      const res = await send();
      assert.equal(res.status, status, `${label}: status`);
      assertNoChallenge(res, label);
      const json = await res.json();
      assert.equal(json.reason, reason, `${label}: reason`);
      assert.equal(json.receipt, undefined, `${label}: must not mint a receipt`);
      assert.equal(json.checkout_url, undefined, `${label}: must not hand a checkout URL`);
    }
    const ok = await post(base, "/api/quotes", { offer_id: MERCHANT_ID });
    assert.equal(ok.status, 200, "a well-formed unpaid merchant quote still 200s — the paywall is not on this route");
    assertNoChallenge(ok, "deliverable merchant quote");
    assert.equal((await ok.json()).checkout_url, CART);
  });
  assert.equal(probe.calls.n, 0, "shape / 404 refusals must not probe an x402 resource");
  assert.equal(retrieveCalls.n, 1, "shape refusals must not retrieve; only the final well-formed merchant quote does");
});

test("matrix 1 (shape/400 never 402): GET offers catalog — 200 and 404 never carry a challenge, including when a payment header is attached", async () => {
  const facilitator = acceptingFacilitator();
  const { app } = host({ facilitator });
  await serve(app, async (base) => {
    for (const route of CATALOG_OK) {
      const unpaid = await fetch(`${base}${route}`);
      assert.equal(unpaid.status, 200, route);
      assertNoChallenge(unpaid, route);
      await unpaid.arrayBuffer();

      for (const h of [{ "x-payment": "forged" }, { "payment-signature": "forged" }]) {
        const paid = await fetch(`${base}${route}`, { headers: h });
        const label = `${route} ${JSON.stringify(h)}`;
        assert.equal(paid.status, 200, label);
        assertNoChallenge(paid, label);
        await paid.arrayBuffer();
      }
    }
    for (const route of CATALOG_MISSING) {
      const res = await fetch(`${base}${route}`, { headers: { "x-payment": "forged" } });
      assert.equal(res.status, 404, route);
      assertNoChallenge(res, route);
      await res.arrayBuffer();
    }
    const wrongMethod = await post(base, "/api/offers", { offer_id: MERCHANT_ID }, { "payment-signature": "forged" });
    assert.notEqual(wrongMethod.status, 402, "POST /api/offers is not a paid route");
    assertNoChallenge(wrongMethod, "POST /api/offers");
  });
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("matrix 1 (shape/400 never 402): POST /api/quotes — a live resource 402 or a withheld gate is a host 200/409, never a host 402", async () => {
  const match = countingProbe({ status: 402, accepts: liveAccepts });
  const { app: matchApp } = host({ probeFetch: match.fetch });
  await serve(matchApp, async (base) => {
    const res = await post(base, "/api/quotes", { offer_id: X402_ID, input: { url: "https://example.com/a" } });
    assert.equal(res.status, 200, "matching live 402 is a host 200 handoff, not a host challenge");
    assertNoChallenge(res, "matching x402 quote");
    const json = await res.json();
    assert.equal(json.gate.status, "passed");
    assert.ok(Array.isArray(json.accepts) && json.accepts.length);
    assert.equal(json.receipt, undefined);
  });

  const gone = countingProbe({ status: 200 });
  const { app: goneApp } = host({ probeFetch: gone.fetch });
  await serve(goneApp, async (base) => {
    const res = await post(base, "/api/quotes", { offer_id: X402_ID, input: { url: "https://example.com/a" } });
    assert.equal(res.status, 409, "a resource that no longer 402s withholds");
    assertNoChallenge(res, "resource_not_402");
    const json = await res.json();
    assert.equal(json.gate.reason, "resource_not_402");
    assert.equal(json.accepts, null);
  });

  const { app: withheldApp } = host({ merchantPrice: 700 });
  await serve(withheldApp, async (base) => {
    const res = await post(base, "/api/quotes", { offer_id: MERCHANT_ID });
    assert.equal(res.status, 409);
    assertNoChallenge(res, "contradicted merchant");
    const json = await res.json();
    assert.equal(json.checkout_url, null);
    assert.equal(json.gate.reason, "verdict_contradicted");
  });

  assert.equal(match.calls.n, 1);
  assert.equal(gone.calls.n, 1);
});

test("matrix 1 (shape/400 never 402): funnelOutcome has no offers category — a catalog 200 would be mislabeled, so POST /api/quotes must not write a row", async () => {
  assert.equal(funnelOutcome("/quote", 400), "quote_non_deliverable");
  assert.equal(funnelOutcome("/witness", 400), "witness_non_deliverable");
  assert.equal(funnelOutcome("/witness", 402), "witness_402_challenge");
  assert.equal(funnelOutcome("/api/quotes", 200), "witness_signed_receipt", "the five-label helper would lie about a catalog 200");
  assert.equal(funnelOutcome("/api/quotes", 409), "witness_non_deliverable");
  assert.equal(funnelOutcome("/api/quotes", 402), "witness_402_challenge");
  assert.equal(funnelReason({ reason: "bad_offer_quote" }), "bad_offer_quote");

  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-off-funnel-"));
  const probe = countingProbe();
  const { app } = host({ funnelDir: dir, probeFetch: probe.fetch });
  await serve(app, async (base) => {
    const shape = await post(base, "/quote", {});
    assert.equal(shape.status, 400);
    assertNoChallenge(shape, "/quote shape");

    assert.equal((await post(base, "/api/quotes", "{not json")).status, 400);
    assert.equal((await post(base, "/api/quotes", { offer_id: MERCHANT_ID })).status, 200);
    assert.equal((await post(base, "/api/quotes", { offer_id: X402_ID, input: { url: "https://example.com/a" } })).status, 200);
    assert.equal((await fetch(`${base}/api/offers`)).status, 200);
    assert.equal((await fetch(`${base}/offers/${MERCHANT_ID}`)).status, 200);
  });
  const events = await funnelSettled(dir);
  assert.deepEqual(events.map((e) => [e.route, e.status, e.outcome, e.reason]), [
    ["/quote", 400, "quote_non_deliverable", "bad_extract"],
  ], "offers traffic must not append; the lone row is the /quote shape error that proves the funnel is wired");
});

// ---------------------------------------------------------------------------
// 2. Forged payment headers
// ---------------------------------------------------------------------------

test("matrix 2 (forged payment headers): GET catalog + POST /api/quotes — invented X-PAYMENT / PAYMENT-SIGNATURE never 402, mint a receipt, or settle", async () => {
  const facilitator = acceptingFacilitator();
  const probe = countingProbe();
  const { app, observationsDir } = host({ facilitator, probeFetch: probe.fetch });
  await serve(app, async (base) => {
    for (const h of FORGED) {
      for (const route of [`/api/offers/${MERCHANT_ID}`, `/api/offers/${X402_ID}/task.json`]) {
        const res = await fetch(`${base}${route}`, { headers: h });
        const label = `GET ${route} ${JSON.stringify(h)}`;
        assert.equal(res.status, 200, label);
        assertNoChallenge(res, label);
        const json = await res.json();
        assert.equal(json.receipt, undefined, label);
      }
      const quote = await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, h);
      const label = `POST /api/quotes ${JSON.stringify(h)}`;
      assert.equal(quote.status, 200, `${label}: unpaid catalog quote still 200`);
      assertNoChallenge(quote, label);
      const json = await quote.json();
      assert.equal(json.receipt, undefined, label);
      assert.equal(json.checkout_url, CART, `${label}: must not rewrite the handoff`);
      assert.ok(!("payment_authorized" in json), `${label}: payment_authorized is not part of the checkout response`);
    }
    const unrelated = await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, { "payment-response": "forged" });
    assert.equal(unrelated.status, 200, "PAYMENT-RESPONSE is not a proof header and must not change the quote");
    assertNoChallenge(unrelated, "PAYMENT-RESPONSE");
  });
  assert.equal(facilitator.calls.verify, 0, "offers never reach the host facilitator");
  assert.equal(facilitator.calls.settle, 0);
  assert.equal(readObservations(observationsDir).length, 0, "nothing appended");
});

test("matrix 2 (forged payment headers): POST /api/quotes — a forged or stolen /witness payment never unlocks a withheld handoff or skips the gate", async () => {
  const facilitator = acceptingFacilitator();
  const reader = countingRetrieve(700);
  const probe = countingProbe({
    accepts: liveAccepts.map((a) => ({ ...a, amount: "6000" })),
  });
  const { app, observationsDir } = host({
    facilitator,
    retrieve: reader.retrieve,
    retrieveCalls: reader.calls,
    probeFetch: probe.fetch,
  });
  await serve(app, async (base) => {
    const stolen = await paymentFor(base, "/witness", WITNESS_BODY);
    const headers = [...FORGED, stolen];

    for (const h of headers) {
      const merchant = await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, h);
      const label = `merchant ${JSON.stringify(h)}`;
      assert.equal(merchant.status, 409, `${label}: withheld stays withheld`);
      assertNoChallenge(merchant, label);
      const json = await merchant.json();
      assert.equal(json.checkout_url, null, label);
      assert.equal(json.gate.reason, "verdict_contradicted", label);
      assert.equal(json.receipt, undefined, label);
      assert.doesNotMatch(JSON.stringify(json), /myshopify\.com\/cart/, `${label}: no cart URL in a withheld body`);
    }

    const x = await post(base, "/api/quotes", { offer_id: X402_ID, input: { url: "https://example.com/a" } }, stolen);
    assert.equal(x.status, 409, "stolen payment must not accept a changed amount");
    assertNoChallenge(x, "x402 stolen");
    assert.equal((await x.json()).gate.reason, "payee_or_price_changed");
  });
  assert.ok(reader.calls.n >= 1, "the merchant gate still ran");
  assert.ok(reader.calls.urls.includes(VERIFY_URL), "forged pay must not skip the live price check");
  assert.ok(probe.calls.n >= 1, "the x402 probe still ran");
  assert.equal(facilitator.calls.settle, 0, "a stolen /witness payment must never settle on /api/quotes");
  assert.equal(readObservations(observationsDir).length, 0);
});

test("matrix 2 (forged payment headers): funnel — forged pay on /witness is a 402 challenge row with no payment material; /api/quotes still writes nothing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-off-funnel-"));
  const facilitator = acceptingFacilitator();
  const { app } = host({ funnelDir: dir, facilitator });
  await serve(app, async (base) => {
    const forged = await post(base, "/witness", WITNESS_BODY, { "x-payment": "forged" });
    assert.equal(forged.status, 402);
    assert.equal((await forged.json()).receipt, undefined);

    const empty = await post(base, "/witness", WITNESS_BODY, { "x-payment": "", "payment-signature": "" });
    assert.equal(empty.status, 402);

    const quote = await post(base, "/quote", WITNESS_BODY, { "payment-signature": "forged" });
    assert.equal(quote.status, 200);
    assertNoChallenge(quote, "/quote + forged");

    assert.equal((await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, { "x-payment": "forged" })).status, 200);
  });
  const events = await funnelSettled(dir);
  assert.deepEqual(events.map((e) => [e.route, e.status, e.outcome]), [
    ["/witness", 402, "witness_402_challenge"],
    ["/witness", 402, "witness_402_challenge"],
    ["/quote", 200, "quote_deliverable"],
  ]);
  assert.ok(events.every((e) => e.outcome !== "witness_signed_receipt"), "forged pay must never log a signed receipt");
  const raw = readFileSync(path.join(dir, "funnel.ndjson"), "utf8");
  for (const forbidden of FUNNEL_FORBIDDEN) {
    assert.ok(!raw.includes(forbidden), `funnel must not carry ${forbidden}`);
  }
  assert.equal(facilitator.calls.settle, 0);
});

// ---------------------------------------------------------------------------
// 3. Settle only on 2xx
// ---------------------------------------------------------------------------

test("matrix 3 (settle-only-on-2xx): POST /api/quotes — host facilitator settle stays 0 on 200/400/409/429, including a payment header", async () => {
  const facilitator = acceptingFacilitator();
  const probe = countingProbe();
  const { app, observationsDir } = host({
    facilitator,
    probeFetch: probe.fetch,
    quoteRateLimit: 1,
    gateTtlMs: 0,
  });
  await serve(app, async (base) => {
    const pay = await paymentFor(base, "/witness", WITNESS_BODY);
    assert.equal(facilitator.calls.verify, 0, "minting a challenge must not verify");
    assert.equal(facilitator.calls.settle, 0, "an unpaid /witness challenge must not settle");

    const ok = await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, pay);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).checkout_url, CART);
    assert.equal(facilitator.calls.verify, 0, "a 200 catalog quote must not verify — there is no offers paywall");
    assert.equal(facilitator.calls.settle, 0, "a 200 catalog quote must not settle");

    const shape = await post(base, "/api/quotes", {}, pay);
    assert.equal(shape.status, 400);
    assert.equal((await shape.json()).reason, "bad_offer_quote");
    assert.equal(facilitator.calls.settle, 0, "400 must not settle");

    const limited = await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, pay);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).reason, "quote_rate_limited");
    assert.equal(facilitator.calls.settle, 0, "429 must not settle");
  });

  const withheldFacilitator = acceptingFacilitator();
  const { app: withheldApp } = host({ facilitator: withheldFacilitator, merchantPrice: 700, probeFetch: probe.fetch });
  await serve(withheldApp, async (base) => {
    const pay = await paymentFor(base, "/witness", WITNESS_BODY);
    const withheld = await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, pay);
    assert.equal(withheld.status, 409);
    assert.equal((await withheld.json()).checkout_url, null);
    assert.equal(withheldFacilitator.calls.settle, 0, "409 must not settle");

    const x = await post(base, "/api/quotes", { offer_id: X402_ID, input: { url: "https://example.com" } }, pay);
    assert.equal(x.status, 200, "matching x402 probe is a host 200");
    assert.equal(withheldFacilitator.calls.settle, 0, "an x402 handoff must not settle on the host");
  });

  assert.equal(readObservations(observationsDir).length, 0);
});

test("matrix 3 (settle-only-on-2xx): funnel — witness_signed_receipt only after a 200; 400/422/500 after verify never record a receipt or increment settle", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-off-funnel-"));
  const key = generateProcessKey();
  const facilitator = acceptingFacilitator();
  let retrieveMode = "ok";
  const { app } = host({
    key,
    facilitator,
    funnelDir: dir,
    retrieve: async (url) => {
      if (url === VERIFY_URL) return { text: productDoc(600) };
      if (retrieveMode === "fail") throw new Error("reader_503");
      if (retrieveMode === "boom") return { text: 42 };
      return { text: FIXTURE };
    },
  });
  await serve(app, async (base) => {
    const unpaid = await post(base, "/witness", WITNESS_BODY);
    assert.equal(unpaid.status, 402);
    assert.equal(facilitator.calls.settle, 0);

    const pay = await paymentFor(base, "/witness", WITNESS_BODY);
    const ok = await post(base, "/witness", WITNESS_BODY, pay);
    assert.equal(ok.status, 200);
    assert.ok(verifyReceipt(await ok.json(), key.publicKey), "the 200 is a real signed receipt");
    assert.equal(facilitator.calls.settle, 1, "settled once, after the 200");

    const missing = await post(base, "/witness", { url: WITNESS_BODY.url }, pay);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).reason, "bad_extract");
    assert.equal(facilitator.calls.settle, 1, "400 must not settle");

    retrieveMode = "fail";
    const failed = await post(base, "/witness", WITNESS_BODY, pay);
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).reason, "retrieve_failed");
    assert.equal(facilitator.calls.settle, 1, "422 must not settle");

    retrieveMode = "boom";
    const boom = await post(base, "/witness", WITNESS_BODY, pay);
    assert.equal(boom.status, 500);
    assert.equal((await boom.json()).reason, "internal_error");
    assert.equal(facilitator.calls.settle, 1, "500 must not settle");

    retrieveMode = "ok";
    assert.equal((await post(base, "/api/quotes", { offer_id: MERCHANT_ID }, pay)).status, 200);
  });

  const events = await funnelSettled(dir);
  assert.deepEqual(events.map((e) => [e.route, e.status, e.outcome, e.reason]), [
    ["/witness", 402, "witness_402_challenge", undefined],
    ["/witness", 200, "witness_signed_receipt", undefined],
    ["/witness", 400, "witness_non_deliverable", "bad_extract"],
    ["/witness", 422, "witness_non_deliverable", "retrieve_failed"],
    ["/witness", 500, "witness_non_deliverable", "internal_error"],
  ]);
  assert.equal(events.filter((e) => e.outcome === "witness_signed_receipt").length, 1);
  assert.ok(events.every((e) => e.route !== "/api/quotes"), "the catalog 200 must not be logged as a signed receipt");
  const raw = readFileSync(path.join(dir, "funnel.ndjson"), "utf8");
  for (const forbidden of ["x-payment", "payment-signature", "starter_price", MERCHANT_ID, "myshopify"]) {
    assert.ok(!raw.includes(forbidden), `funnel must not carry ${forbidden}`);
  }
});
