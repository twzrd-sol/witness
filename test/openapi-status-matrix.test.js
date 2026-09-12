/**
 * Wave6 Q — OpenAPI ↔ runtime status/reason matrix.
 *
 * Cells are generated from `openapiDoc()` (test/openapi-matrix.js). Each
 * documented 400/402/404/405/409/413/422/429/500/502/503 on a published
 * route has a stimulus. Runtime drift — wrong status, a reason outside a
 * documented enum, a documented cell with no probe — fails.
 *
 * In-process host only. Mocked retrieve / intel / facilitator. No live
 * reader, no live settle, no twice-pay, no paid payout receipt.
 *
 * Run this file: `node --test test/openapi-status-matrix.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FacilitatorResponseError } from "@x402/core/server";

import { openapiDoc } from "../src/openapi.js";
import { createApp } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey } from "../src/receipt.js";
import { EXAMPLE_BODY } from "../src/routes/delivery.js";
import { IntelUnavailable } from "../src/intel-evidence.js";
import {
  CONTRACT_STATUSES,
  cellKey,
  documentedCells,
  documentedReasonRows,
} from "./openapi-matrix.js";

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
const productDoc = (price) =>
  JSON.stringify({ price, handle: "vintage-polaroid-photo-frames" });

const SOL = "46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe";
const BOARD = `{"economics":{"decidedCount":372,"payouts":{"sentCount":67,"sentUsd":56.14,"uniqueWallets":22}}}`;
const OVER = {
  claim_url: "https://deskcrew.io/api/arena/contests",
  claim: { payout_count: "decidedCount", unique_wallets: "uniqueWallets", paid_usd: "sentUsd" },
  wallet: SOL,
  network: "solana",
  direction: "inbound",
};
const intelOk = async () => ({
  score: {
    wallet: SOL, payments_received: 47, distinct_counterparties: 5, total_usdc_received: 0.189,
    paid_calls: 0, total_usdc: 0, data_available: true, corpus: "fixture",
  },
  card: { merchant: SOL, decision: "insufficient_evidence", card_version: "merchant_card_v1.6" },
  sources: [{ name: "score_wallet_for_intel", url: "https://intel.example/score", sha256: "a".repeat(64), fetched_at: "2026-09-10T00:00:00.000Z" }],
});

const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];

const refusingFacilitator = {
  async getSupported() { return { kinds: KINDS }; },
  async verify() { return { isValid: false, invalidReason: "fixture refuses every payment" }; },
  async settle() { throw new Error("settle must not be reached on an unpaid contract probe"); },
};

function settleThrowFacilitator() {
  return {
    async getSupported() { return { kinds: KINDS }; },
    async verify() { return { isValid: true, payer: "0x00000000000000000000000000000000000000aa" }; },
    async settle() {
      throw new FacilitatorResponseError("settle", 503, { error: "facilitator settle unavailable" });
    },
  };
}

function countingAttest() {
  return async (input) => ({
    schema: "delivery-attestation/v0",
    offer_hash: "o".repeat(64),
    request_hash: "r".repeat(64),
    artifact_hash: "a".repeat(64),
    delivery_verdict: "delivered",
    reasons: [],
    evidence_mode: input.observation.mode,
    declared_mode: input.observation.mode,
    this_receipt_proves: ["fixture"],
    this_receipt_does_not_prove: ["fixture"],
  });
}

const DOC = openapiDoc({
  EVM_ADDRESS: PAYWALL.evmAddress,
  SVM_ADDRESS: PAYWALL.svmAddress,
  PUBLIC_BASE_URL: BASE_URL,
});
const CELLS = documentedCells(DOC);
const ROWS = documentedReasonRows(CELLS);
const CELL_BY = new Map(CELLS.map((c) => [`${c.method} ${c.path} ${c.status}`, c]));

function defaultAttest(extra) {
  if (Object.hasOwn(extra, "attest") || Object.hasOwn(extra, "importModel")) return extra;
  return { attest: countingAttest(), ...extra };
}

function buildApp(kind, extra = {}) {
  const base = {
    key: generateProcessKey(),
    observationsDir: mkdtempSync(path.join(os.tmpdir(), "wit-oa-mtx-")),
    funnelDir: null,
    publicBaseUrl: BASE_URL,
    quoteRateLimit: 1000,
    quoteGlobalRateLimit: 1000,
    attestRateLimit: 1000,
    payoutQuoteRateLimit: 1000,
    // One fixture page fills both /quote (starter_price) and payout-claim (decidedCount).
    retrieve: async () => ({ text: `${FIXTURE}\n${BOARD}` }),
    fetchIntel: intelOk,
  };
  const wired = defaultAttest(extra);
  switch (kind) {
    case "paywalled":
      return createApp({ ...base, paywall: PAYWALL, facilitator: refusingFacilitator, ...wired });
    case "free":
      return createApp({ ...base, paywall: {}, ...wired });
    case "quote1":
      return createApp({ ...base, paywall: {}, quoteRateLimit: 1, ...wired });
    case "payout1":
      return createApp({ ...base, paywall: {}, payoutQuoteRateLimit: 1, ...wired });
    case "attest1":
      return createApp({ ...base, paywall: {}, attestRateLimit: 1, ...wired });
    case "attestUnwired":
      return createApp({
        ...base, paywall: {}, attest: undefined,
        importModel: async () => { throw Object.assign(new Error("missing"), { code: "ERR_MODULE_NOT_FOUND" }); },
        ...extra,
      });
    case "attestFailed":
      return createApp({ ...base, paywall: {}, attest: async () => { throw new Error("boom"); }, ...extra });
    case "attestInvalid":
      return createApp({ ...base, paywall: {}, attest: async () => ({}), ...extra });
    case "attestInternal":
      return createApp({
        ...base, paywall: {}, attest: undefined,
        importModel: async () => { throw new Error("disk on fire"); },
        ...extra,
      });
    case "paywallDown":
      return createApp({ ...base, paywall: PAYWALL, facilitator: settleThrowFacilitator(), ...wired });
    case "quotes409":
      return createApp({ ...base, paywall: {}, retrieve: async () => ({ text: productDoc(700) }), ...wired });
    case "quotes429":
      return createApp({
        ...base, paywall: {}, retrieve: async () => ({ text: productDoc(600) }),
        quoteRateLimit: 1, gateTtlMs: 0, ...wired,
      });
    case "quotes503":
      return createApp({ ...base, paywall: {}, retrieve: undefined, ...wired });
    default:
      throw new Error(`unknown host kind: ${kind}`);
  }
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

function jsonBody(body) {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function challengeOf(res) {
  const raw = res.headers.get("payment-required");
  assert.ok(raw, `${res.status} without a PAYMENT-REQUIRED header is not an x402 challenge`);
  try { return JSON.parse(raw); } catch { /* base64 */ }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

async function paymentFor(base, url, body) {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonBody(body),
  });
  const challenge = challengeOf(res);
  const accepted = challenge.accepts[0];
  return {
    "payment-signature": Buffer.from(JSON.stringify({
      x402Version: 2, accepted, payload: { signature: "0x00", authorization: {} },
    })).toString("base64"),
  };
}

/**
 * Stimulus table. `path` is the OpenAPI path template (coverage key).
 * `url` is the concrete request path when it differs. `reason` is required
 * when the generated cell names that reason.
 */
const STIMULI = [
  // --- catalog 404s ---
  { id: "offers.html.404", path: "/offers/{id}", url: "/offers/no-such-offer", method: "GET", status: 404, host: "free", textIncludes: "offer_not_found" },
  { id: "api.offers.404", path: "/api/offers/{id}", url: "/api/offers/no-such-offer", method: "GET", status: 404, reason: "offer_not_found", host: "free" },
  { id: "api.offers.task.404", path: "/api/offers/{id}/task.json", url: "/api/offers/no-such-offer/task.json", method: "GET", status: 404, reason: "offer_not_found", host: "free" },

  // --- discovery 402 / 405 ---
  { id: "witness.get.402", path: "/witness", method: "GET", status: 402, host: "paywalled", challenge: true },
  { id: "witness.get.405", path: "/witness", method: "GET", status: 405, reason: "get_discovery_only_use_post", host: "paywalled", headers: { "x-payment": "bogus" }, noChallenge: true },
  { id: "payout.get.402", path: "/verify/payout", method: "GET", status: 402, host: "paywalled", challenge: true },
  { id: "payout.get.405", path: "/verify/payout", method: "GET", status: 405, reason: "get_discovery_only_use_post", host: "paywalled", headers: { "x-payment": "bogus" }, noChallenge: true },

  // --- POST /quote ---
  { id: "quote.400.bad_json", path: "/quote", method: "POST", status: 400, reason: "bad_json", host: "free", headers: { "content-type": "application/json" }, body: "{not json" },
  { id: "quote.400.bad_extract", path: "/quote", method: "POST", status: 400, reason: "bad_extract", host: "free", body: { url: "https://example.com/pricing", extract: { rank: "bogus" } } },
  { id: "quote.400.bad_assertion", path: "/quote", method: "POST", status: 400, reason: "bad_assertion", host: "free", body: { ...WITNESS_BODY, assertion: 7 } },
  { id: "quote.422.https_only", path: "/quote", method: "POST", status: 422, reason: "https_only", host: "free", body: { url: "http://127.0.0.1/", extract: { a: "string" } } },
  { id: "quote.429.quote_rate_limited", path: "/quote", method: "POST", status: 429, reason: "quote_rate_limited", host: "quote1", body: WITNESS_BODY, prime: 1 },

  // --- POST /witness (unpaid; deliverable-first) ---
  { id: "witness.post.400.bad_json", path: "/witness", method: "POST", status: 400, reason: "bad_json", host: "paywalled", headers: { "content-type": "application/json" }, body: "{not json" },
  { id: "witness.post.400.bad_extract", path: "/witness", method: "POST", status: 400, reason: "bad_extract", host: "paywalled", body: { url: "https://example.com/pricing", extract: { rank: "bogus" } } },
  { id: "witness.post.400.bad_assertion", path: "/witness", method: "POST", status: 400, reason: "bad_assertion", host: "paywalled", body: { ...WITNESS_BODY, assertion: 7 } },
  { id: "witness.post.402", path: "/witness", method: "POST", status: 402, host: "paywalled", body: WITNESS_BODY, challenge: true },
  { id: "witness.post.422.https_only", path: "/witness", method: "POST", status: 422, reason: "https_only", host: "paywalled", body: { url: "http://127.0.0.1/", extract: { a: "string" } }, noChallenge: true },

  // --- POST /delivery/attest ---
  { id: "attest.400.bad_json", path: "/delivery/attest", method: "POST", status: 400, reason: "bad_json", host: "free", headers: { "content-type": "application/json" }, body: "{not json" },
  { id: "attest.400.bad_body", path: "/delivery/attest", method: "POST", status: 400, reason: "bad_body", host: "free", body: [1, 2] },
  { id: "attest.400.bad_offer", path: "/delivery/attest", method: "POST", status: 400, reason: "bad_offer", host: "free", body: { ...structuredClone(EXAMPLE_BODY), offer: {} } },
  { id: "attest.400.bad_paid_request", path: "/delivery/attest", method: "POST", status: 400, reason: "bad_paid_request", host: "free", body: { ...structuredClone(EXAMPLE_BODY), request: {} } },
  { id: "attest.400.bad_observation", path: "/delivery/attest", method: "POST", status: 400, reason: "bad_observation", host: "free", body: { ...structuredClone(EXAMPLE_BODY), observation: { mode: "buyer_attested" } } },
  { id: "attest.400.bad_mode", path: "/delivery/attest", method: "POST", status: 400, reason: "bad_mode", host: "free", body: { ...structuredClone(EXAMPLE_BODY), observation: { ...EXAMPLE_BODY.observation, mode: "wishful" } } },
  { id: "attest.402", path: "/delivery/attest", method: "POST", status: 402, host: "paywalled", body: structuredClone(EXAMPLE_BODY), challenge: true },
  { id: "attest.413.body_too_large", path: "/delivery/attest", method: "POST", status: 413, reason: "body_too_large", host: "free", body: { ...structuredClone(EXAMPLE_BODY), observation: { ...EXAMPLE_BODY.observation, artifact: { blob: "x".repeat(300 * 1024) } } } },
  { id: "attest.429.attest_rate_limited", path: "/delivery/attest", method: "POST", status: 429, reason: "attest_rate_limited", host: "attest1", body: structuredClone(EXAMPLE_BODY), prime: 1 },
  { id: "attest.500.attest_failed", path: "/delivery/attest", method: "POST", status: 500, reason: "attest_failed", host: "attestFailed", body: structuredClone(EXAMPLE_BODY) },
  { id: "attest.500.attest_invalid", path: "/delivery/attest", method: "POST", status: 500, reason: "attest_invalid", host: "attestInvalid", body: structuredClone(EXAMPLE_BODY) },
  { id: "attest.500.internal_error", path: "/delivery/attest", method: "POST", status: 500, reason: "internal_error", host: "attestInternal", body: structuredClone(EXAMPLE_BODY) },
  { id: "attest.502.paywall_unavailable", path: "/delivery/attest", method: "POST", status: 502, reason: "paywall_unavailable", host: "paywallDown", async run(base) {
    const headers = await paymentFor(base, "/delivery/attest", structuredClone(EXAMPLE_BODY));
    return fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: jsonBody(structuredClone(EXAMPLE_BODY)) });
  } },
  { id: "attest.503.attest_not_wired", path: "/delivery/attest", method: "POST", status: 503, reason: "attest_not_wired", host: "attestUnwired", body: structuredClone(EXAMPLE_BODY) },

  // --- POST /verify/payout/quote (free; mocked intel) ---
  { id: "payout.quote.400.bad_claim_url", path: "/verify/payout/quote", method: "POST", status: 400, reason: "bad_claim_url", host: "free", body: { ...OVER, claim_url: "" } },
  { id: "payout.quote.400.bad_claim", path: "/verify/payout/quote", method: "POST", status: 400, reason: "bad_claim", host: "free", body: { ...OVER, claim: { revenue: "x" } } },
  { id: "payout.quote.400.bad_wallet", path: "/verify/payout/quote", method: "POST", status: 400, reason: "bad_wallet", host: "free", body: { ...OVER, wallet: "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8" } },
  { id: "payout.quote.400.bad_network", path: "/verify/payout/quote", method: "POST", status: 400, reason: "bad_network", host: "free", body: { ...OVER, network: "algorand" } },
  { id: "payout.quote.400.bad_direction", path: "/verify/payout/quote", method: "POST", status: 400, reason: "bad_direction", host: "free", body: { ...OVER, direction: "sideways" } },
  { id: "payout.quote.422.https_only", path: "/verify/payout/quote", method: "POST", status: 422, reason: "https_only", host: "free", body: { ...OVER, claim_url: "http://127.0.0.1/stats" } },
  { id: "payout.quote.429.quote_rate_limited", path: "/verify/payout/quote", method: "POST", status: 429, reason: "quote_rate_limited", host: "payout1", body: OVER, prime: 1 },

  // --- POST /verify/payout (unpaid only) ---
  { id: "payout.post.400.bad_network", path: "/verify/payout", method: "POST", status: 400, reason: "bad_network", host: "paywalled", body: { ...OVER, network: "algorand" }, noChallenge: true },
  { id: "payout.post.402", path: "/verify/payout", method: "POST", status: 402, host: "paywalled", body: OVER, challenge: true },
  { id: "payout.post.422.https_only", path: "/verify/payout", method: "POST", status: 422, reason: "https_only", host: "paywalled", body: { ...OVER, claim_url: "http://127.0.0.1/stats" }, noChallenge: true },

  // --- POST /api/quotes ---
  { id: "api.quotes.400.bad_offer_quote", path: "/api/quotes", method: "POST", status: 400, reason: "bad_offer_quote", host: "free", body: {} },
  { id: "api.quotes.404.offer_not_found", path: "/api/quotes", method: "POST", status: 404, reason: "offer_not_found", host: "free", body: { offer_id: "no-such-offer" } },
  { id: "api.quotes.409.verdict_contradicted", path: "/api/quotes", method: "POST", status: 409, host: "quotes409", body: { offer_id: MERCHANT_ID } },
  { id: "api.quotes.429.quote_rate_limited", path: "/api/quotes", method: "POST", status: 429, reason: "quote_rate_limited", host: "quotes429", body: { offer_id: MERCHANT_ID }, prime: 1 },
  { id: "api.quotes.503.gate_not_wired", path: "/api/quotes", method: "POST", status: 503, reason: "gate_not_wired", host: "quotes503", body: { offer_id: MERCHANT_ID } },

  // extras: related runtime reasons on documented statuses (not required by OpenAPI names)
  { id: "api.quotes.400.bad_quantity", path: "/api/quotes", method: "POST", status: 400, reason: "bad_quantity", host: "free", body: { offer_id: MERCHANT_ID, quantity: 0 } },
  { id: "api.quotes.400.bad_input_url", path: "/api/quotes", method: "POST", status: 400, reason: "bad_input_url", host: "free", body: { offer_id: X402_ID, input: { url: "ftp://x" } } },
  { id: "payout.post.400.bad_json", path: "/verify/payout", method: "POST", status: 400, reason: "bad_json", host: "paywalled", headers: { "content-type": "application/json" }, body: "{not json", noChallenge: true },
  { id: "quote.422.extract_missing", path: "/quote", method: "POST", status: 422, reason: "extract_missing", host: "free", body: { url: "https://example.com/pricing", extract: { nowhere: "number" } } },
  { id: "payout.quote.422.intel_unavailable", path: "/verify/payout/quote", method: "POST", status: 422, reason: "intel_unavailable", host: "free", body: OVER, extra: { fetchIntel: async () => { throw new IntelUnavailable({ name: "score_wallet_for_intel", status: 503 }); } } },
];

function coversRow(row, s) {
  if (s.path !== row.path || s.method !== row.method || String(s.status) !== row.status) return false;
  if (row.reason == null) return true;
  return s.reason === row.reason;
}

test("generated matrix: every OpenAPI contract status/reason has a stimulus", () => {
  assert.ok(CELLS.length >= 20, `expected a real matrix, got ${CELLS.length} cells`);
  const missing = ROWS.filter((row) => !STIMULI.some((s) => coversRow(row, s)));
  assert.deepEqual(
    missing.map((r) => cellKey(r)),
    [],
    `OpenAPI cell has no runtime probe: ${missing.map((r) => cellKey(r)).join(", ")}`,
  );
});

test("generated matrix: every stimulus targets a documented contract status", () => {
  const undocumented = STIMULI.filter((s) => !CELL_BY.has(`${s.method} ${s.path} ${s.status}`));
  assert.deepEqual(
    undocumented.map((s) => s.id),
    [],
    `stimulus status is not in OpenAPI: ${undocumented.map((s) => `${s.id} ${s.method} ${s.path} ${s.status}`).join(", ")}`,
  );
  for (const s of STIMULI) {
    if (!s.reason) continue;
    const cell = CELL_BY.get(`${s.method} ${s.path} ${s.status}`);
    if (cell.reasonSource === "enum") {
      assert.ok(cell.reasons.includes(s.reason), `${s.id}: reason ${s.reason} is not in the OpenAPI enum [${cell.reasons}]`);
    }
  }
});

test("generated matrix names the documented quote/delivery reason enums", () => {
  const quote400 = CELL_BY.get("POST /quote 400");
  assert.deepEqual(quote400.reasons, ["bad_json", "bad_extract", "bad_assertion"]);
  const attest400 = CELL_BY.get("POST /delivery/attest 400");
  assert.deepEqual(attest400.reasons, ["bad_json", "bad_body", "bad_offer", "bad_paid_request", "bad_observation", "bad_mode"]);
  const payout400 = CELL_BY.get("POST /verify/payout/quote 400");
  assert.deepEqual(payout400.reasons, ["bad_claim_url", "bad_claim", "bad_wallet", "bad_network", "bad_direction"]);
  assert.ok(CONTRACT_STATUSES.includes("405") && CONTRACT_STATUSES.includes("402"));
});

async function fire(base, s) {
  if (typeof s.run === "function") return s.run(base);
  const url = `${base}${s.url ?? s.path}`;
  const headers = { ...(s.body !== undefined && typeof s.body !== "string" ? { "content-type": "application/json" } : {}), ...s.headers };
  const init = { method: s.method, headers };
  if (s.body !== undefined && s.method !== "GET") init.body = jsonBody(s.body);
  const send = () => fetch(url, init);
  for (let i = 0; i < (s.prime ?? 0); i++) await send();
  return send();
}

for (const s of STIMULI) {
  const label = s.reason
    ? `${s.method} ${s.path} → ${s.status} ${s.reason}`
    : `${s.method} ${s.path} → ${s.status}`;
  test(`runtime ${s.id}: ${label}`, async () => {
    const cell = CELL_BY.get(`${s.method} ${s.path} ${s.status}`);
    assert.ok(cell, `${s.id}: OpenAPI no longer documents ${s.method} ${s.path} ${s.status}`);
    await serve(buildApp(s.host, s.extra ?? {}), async (base) => {
      const res = await fire(base, s);
      assert.equal(res.status, s.status, `${s.id}: expected ${s.status}, got ${res.status}`);

      if (s.challenge || cell.hasPaymentRequiredHeader) {
        const challenge = challengeOf(res);
        assert.equal(typeof challenge, "object");
      } else if (s.noChallenge || res.status !== 402) {
        assert.equal(res.headers.get("payment-required"), null, `${s.id}: unexpected PAYMENT-REQUIRED`);
      }

      if (s.textIncludes) {
        const text = await res.text();
        assert.match(text, new RegExp(s.textIncludes));
        return;
      }

      const json = await res.json().catch(() => ({}));
      if (s.reason) assert.equal(json.reason, s.reason, `${s.id}: ${JSON.stringify(json)}`);
      if (cell.reasonSource === "enum" && json.reason) {
        assert.ok(cell.reasons.includes(json.reason), `${s.id}: runtime reason ${json.reason} not in OpenAPI enum [${cell.reasons}]`);
      }
      if (res.status >= 400 && res.status !== 402 && json.receipt !== undefined) {
        assert.equal(json.receipt, undefined, `${s.id}: error carried a receipt`);
      }
    });
  });
}
