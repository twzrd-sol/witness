import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
import { createApp } from "../src/server.js";
import { openapiDoc } from "../src/openapi.js";
import { IntelUnavailable } from "../src/intel-evidence.js";
import { handlePayoutQuote, handlePayoutVerify, PAYOUT_QUOTE_ROUTE, PAYOUT_ROUTE, readPayoutClaims } from "../src/routes/payout-claim.js";

const SOL = "46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe";
const SCORE = { wallet: SOL, chain: null, window_days: null, role: "merchant", payments_received: 47, distinct_counterparties: 5, total_usdc_received: 0.189, paid_calls: 0, total_usdc: 0, first_seen: "2026-02-09T21:06:08Z", last_seen: "2026-08-23T18:11:55Z", wash_flag: "unknown", data_available: true, error: null, corpus: "cross-facilitator Solana x402 payer corpus" };
const CARD = { merchant: SOL, wash_flagged: null, decision: "insufficient_evidence", confidence: "partial_inbound_only", card_version: "merchant_card_v1.6" };
const SOURCES = [{ name: "score_wallet_for_intel", url: `https://intel.twzrd.xyz/v1/intel/score_wallet_for_intel?wallet=${SOL}`, sha256: "a".repeat(64), fetched_at: "2026-09-10T00:00:00.000Z" }, { name: "merchant_card", url: `https://intel.twzrd.xyz/v1/intel/merchant_card/${SOL}`, sha256: "b".repeat(64), fetched_at: "2026-09-10T00:00:00.000Z" }];
const intelOk = async () => ({ score: SCORE, card: CARD, sources: SOURCES });
const BOARD = `{"economics":{"decidedCount":372,"payouts":{"sentCount":67,"sentUsd":56.14,"uniqueWallets":22}}}`;
const SELLER = `{"stats":{"paidCalls":40,"payers":5,"grossUsd":0.18}}`;
const OVER = { claim_url: "https://deskcrew.io/api/arena/contests", claim: { payout_count: "decidedCount", unique_wallets: "uniqueWallets", paid_usd: "sentUsd" }, wallet: SOL, network: "solana", direction: "inbound" };
const UNDER = { claim_url: "https://example.com/seller/stats", claim: { payout_count: "paidCalls", unique_wallets: "payers", paid_usd: "grossUsd" }, wallet: SOL, network: "solana", direction: "inbound" };
const PAYWALL = { evmAddress: "0xabc0000000000000000000000000000000000001", svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" };
const fakeFacilitator = {
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }] }; },
  async verify() { throw new Error("not implemented in fixture"); },
  async settle() { throw new Error("not implemented in fixture"); },
};

async function withServer(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, route, body, headers = {}) => fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("routes are the documented paths", () => {
  assert.equal(PAYOUT_ROUTE, "/verify/payout");
  assert.equal(PAYOUT_QUOTE_ROUTE, "/verify/payout/quote");
});

test("quote: a malformed request is a 400 before any retrieve or intel call", async () => {
  let retrieves = 0, intels = 0;
  const deps = { retrieve: async () => (retrieves++, { text: BOARD }), fetchIntel: async () => (intels++, intelOk()) };
  assert.deepEqual(await handlePayoutQuote({ ...OVER, network: "algorand" }, deps), { status: 400, json: { reason: "bad_network" } });
  assert.deepEqual(await handlePayoutQuote({ ...OVER, claim: { revenue: "x" } }, deps), { status: 400, json: { reason: "bad_claim" } });
  assert.equal(retrieves + intels, 0);
});

test("quote: SSRF refusal is a 422 with nothing fetched", async () => {
  let n = 0;
  const deps = { retrieve: async () => (n++, { text: BOARD }), fetchIntel: async () => (n++, intelOk()) };
  const out = await handlePayoutQuote({ ...OVER, claim_url: "http://127.0.0.1/stats" }, deps);
  assert.deepEqual(out, { status: 422, json: { reason: "https_only" } });
  assert.equal(n, 0);
});

test("quote: unwired retrieve or intel is a 503, never billed", async () => {
  assert.deepEqual(await handlePayoutQuote(OVER, { fetchIntel: intelOk }), { status: 503, json: { reason: "retrieve_not_wired" } });
  assert.deepEqual(await handlePayoutQuote(OVER, { retrieve: async () => ({ text: BOARD }) }), { status: 503, json: { reason: "intel_not_wired" } });
});

test("quote: intel is consulted before the reader, so an intel outage costs no scrape", async () => {
  let retrieves = 0;
  const out = await handlePayoutQuote(OVER, { retrieve: async () => (retrieves++, { text: BOARD }), fetchIntel: async () => { throw new IntelUnavailable({ name: "score_wallet_for_intel", status: 503 }); } });
  assert.deepEqual(out, { status: 422, json: { reason: "intel_unavailable" } });
  assert.equal(retrieves, 0);
});

test("quote: reader failure or empty page is a 422", async () => {
  assert.deepEqual(await handlePayoutQuote(OVER, { retrieve: async () => { throw new Error("reader_502"); }, fetchIntel: intelOk }), { status: 422, json: { reason: "retrieve_failed" } });
  assert.deepEqual(await handlePayoutQuote(OVER, { retrieve: async () => ({ text: "" }), fetchIntel: intelOk }), { status: 422, json: { reason: "retrieve_empty" } });
});

test("quote 200: a board claim far above the observed corpus is announced discrepant at $0.05", async () => {
  const out = await handlePayoutQuote(OVER, { retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk });
  assert.equal(out.status, 200);
  assert.equal(out.json.price_usdc, "0.05");
  assert.equal(out.json.can_deliver, true);
  assert.equal(out.json.verdict, "discrepant");
  assert.equal(out.json.verdict_reason, "claim_exceeds_observed:payout_count,unique_wallets,paid_usd");
  assert.deepEqual(out.json.findings.map((f) => [f.field, f.claimed, f.observed, f.relation]), [["payout_count", 372, 47, "discrepant"], ["unique_wallets", 22, 5, "discrepant"], ["paid_usd", 56.14, 0.189, "discrepant"]]);
  assert.deepEqual(out.json.coverage, { in_corpus: true, window: "all_time", direction: "inbound" });
});

test("quote 200: a seller claim within the observed corpus is supported", async () => {
  const out = await handlePayoutQuote(UNDER, { retrieve: async () => ({ text: SELLER }), fetchIntel: intelOk });
  assert.equal(out.status, 200);
  assert.equal(out.json.verdict, "supported");
  assert.equal(out.json.verdict_reason, null);
});

test("quote: a page missing every mapped key is a free 422; missing one of several is a billable incomplete", async () => {
  const none = await handlePayoutQuote(OVER, { retrieve: async () => ({ text: "<p>nothing here</p>" }), fetchIntel: intelOk });
  assert.deepEqual(none, { status: 422, json: { reason: "extract_none", missing: ["payout_count", "unique_wallets", "paid_usd"] } });
  const some = await handlePayoutQuote({ ...OVER, claim: { payout_count: "decidedCount", paid_usd: "grossUsd" } }, { retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk });
  assert.equal(some.status, 200);
  assert.equal(some.json.verdict, "incomplete");
  assert.deepEqual(some.json.missing, ["paid_usd"]);
});

test("verify unpaid: a deliverable request gets a 402 carrying the $0.05 atomic amount", async () => {
  const out = await handlePayoutVerify(OVER, { retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk });
  assert.equal(out.status, 402);
  assert.equal(out.json.accepts[0].maxAmountRequired, "50000");
});

test("verify paid: one scrape, one intel bundle, a receipt that verifies and matches the quote, appended to its own log", async () => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-payout-"));
  let retrieves = 0, intels = 0;
  const deps = { retrieve: async () => (retrieves++, { text: BOARD }), fetchIntel: async () => (intels++, intelOk()), paid: true, key, now: () => "2026-09-10T00:00:00.000Z", observationsDir: dir };
  const out = await handlePayoutVerify(OVER, deps);
  assert.equal(out.status, 200);
  assert.equal(retrieves, 1, "paid verify must not scrape twice");
  assert.equal(intels, 1);
  assert.ok(verifyReceipt(out.json, key.publicKey));
  assert.equal(out.json.schema, "witness.payout_claim.v1");
  assert.equal(out.json.verdict, "discrepant");
  assert.equal(out.json.valid_until, "2026-09-10T01:00:00.000Z");
  assert.deepEqual(out.json.evidence.intel_sources, SOURCES);
  assert.equal(out.json.claim.values.payout_count, 372);
  assert.deepEqual(readPayoutClaims(dir), [out.json]);
  assert.equal(existsSync(path.join(dir, "observations.ndjson")), false, "payout receipts do not enter the observation star map");
  const miss = await handlePayoutVerify(OVER, { ...deps, retrieve: async () => ({ text: "<p>hi</p>" }) });
  assert.equal(miss.status, 422);
  assert.equal(readPayoutClaims(dir).length, 1, "422 must not append");
});

test("paywall wired: unpaid deliverable POST answers a real x402 challenge for /verify/payout at 50000 atomic on both rails", async () => {
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk, facilitator: fakeFacilitator, paywall: PAYWALL, funnelDir: null });
  await withServer(app, async (base) => {
    const res = await post(base, PAYOUT_ROUTE, OVER);
    assert.equal(res.status, 402);
    const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource.url, "https://witness.outbid.sh/verify/payout");
    assert.equal(challenge.resource.serviceName, "witness");
    assert.deepEqual(challenge.accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    assert.ok(challenge.accepts.every((a) => (a.maxAmountRequired ?? a.amount) === "50000"));
    const body = await res.json();
    assert.equal(body.accepts.length, 2);
    const witness = await post(base, "/witness", { url: "https://example.com/p", extract: { decidedCount: "number" } });
    const wc = JSON.parse(Buffer.from(witness.headers.get("payment-required"), "base64").toString("utf8"));
    assert.ok(wc.accepts.every((a) => (a.maxAmountRequired ?? a.amount) === "10000"), "the $0.01 witness price is untouched");
  });
});

test("paywall wired: a 400 or 422 never reaches the paywall", async () => {
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: BOARD }), fetchIntel: async () => { throw new IntelUnavailable({ name: "merchant_card", status: 500 }); }, facilitator: fakeFacilitator, paywall: PAYWALL, funnelDir: null });
  await withServer(app, async (base) => {
    const bad = await post(base, PAYOUT_ROUTE, { ...OVER, wallet: "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).reason, "bad_wallet");
    const outage = await post(base, PAYOUT_ROUTE, OVER);
    assert.equal(outage.status, 422);
    assert.equal((await outage.json()).reason, "intel_unavailable");
    assert.equal(outage.headers.get("payment-required"), null);
  });
});

test("GET /verify/payout is crawlable discovery: 402 challenge, zero retrieve or intel; paid GET is 405", async () => {
  let calls = 0;
  const app = createApp({ key: generateProcessKey(), retrieve: async () => (calls++, { text: BOARD }), fetchIntel: async () => (calls++, intelOk()), facilitator: fakeFacilitator, paywall: PAYWALL, funnelDir: null });
  await withServer(app, async (base) => {
    const res = await fetch(base + PAYOUT_ROUTE);
    assert.equal(res.status, 402);
    const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(challenge.resource.url, "https://witness.outbid.sh/verify/payout");
    assert.equal(calls, 0);
    const paid = await fetch(base + PAYOUT_ROUTE, { headers: { "x-payment": "bogus" } });
    assert.equal(paid.status, 405);
  });
});

test("no paywall: forged payment headers never mint a receipt or append", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-payout-"));
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk, observationsDir: dir, funnelDir: null });
  await withServer(app, async (base) => {
    for (const headers of [{ "x-payment": "forged" }, { "payment-signature": "forged" }]) {
      const res = await post(base, PAYOUT_ROUTE, OVER, headers);
      assert.notEqual(res.status, 200);
      assert.ok([402, 422, 503].includes(res.status));
    }
    assert.equal(readPayoutClaims(dir).length, 0);
  });
});

test("POST /verify/payout/quote over HTTP: 200 announces the verdict; the per-IP limiter answers 429 quote_rate_limited", async () => {
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk, payoutQuoteRateLimit: 2, funnelDir: null });
  await withServer(app, async (base) => {
    const a = await post(base, PAYOUT_QUOTE_ROUTE, OVER);
    assert.equal(a.status, 200);
    assert.equal((await a.json()).verdict, "discrepant");
    await post(base, PAYOUT_QUOTE_ROUTE, OVER);
    const c = await post(base, PAYOUT_QUOTE_ROUTE, OVER);
    assert.equal(c.status, 429);
    assert.equal((await c.json()).reason, "quote_rate_limited");
  });
});

test("malformed JSON on the payout routes is a 400 bad_json, never 500", async () => {
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk, funnelDir: null });
  await withServer(app, async (base) => {
    for (const route of [PAYOUT_ROUTE, PAYOUT_QUOTE_ROUTE]) {
      const res = await post(base, route, "{not json");
      assert.equal(res.status, 400);
      assert.equal((await res.json()).reason, "bad_json");
    }
  });
});

test("funnel: payout routes record outcome and spec_hash only, never the wallet, url, or figures", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-funnel-"));
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: BOARD }), fetchIntel: intelOk, funnelDir: dir, observationsDir: dir });
  await withServer(app, async (base) => {
    await post(base, PAYOUT_QUOTE_ROUTE, OVER);
    await post(base, PAYOUT_ROUTE, OVER);
    await post(base, PAYOUT_QUOTE_ROUTE, { ...OVER, network: "algorand" });
  });
  const lines = readFileSync(path.join(dir, "funnel.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.route, l.status, l.outcome]), [
    [PAYOUT_QUOTE_ROUTE, 200, "quote_deliverable"],
    [PAYOUT_ROUTE, 402, "witness_402_challenge"],
    [PAYOUT_QUOTE_ROUTE, 400, "quote_non_deliverable"],
  ]);
  assert.equal(typeof lines[0].spec_hash, "string");
  assert.equal(lines[0].spec_hash, lines[1].spec_hash, "same method, same spec_hash");
  assert.equal(lines[2].spec_hash, undefined, "an unnormalizable body has no method to hash");
  const raw = readFileSync(path.join(dir, "funnel.ndjson"), "utf8");
  for (const secret of [SOL, "deskcrew.io", "372", "decidedCount"]) assert.ok(!raw.includes(secret), `funnel must not carry ${secret}`);
});

test("openapi: both payout paths are documented; quote is free, verify is x402 at $0.05 on both rails", () => {
  const doc = openapiDoc({ EVM_ADDRESS: PAYWALL.evmAddress, SVM_ADDRESS: PAYWALL.svmAddress });
  const q = doc.paths[PAYOUT_QUOTE_ROUTE].post;
  assert.deepEqual(q.security, []);
  assert.deepEqual(Object.keys(q.responses).sort(), ["200", "400", "422", "429"]);
  const v = doc.paths[PAYOUT_ROUTE].post;
  assert.equal(v["x-payment"].price_usdc, "0.05");
  assert.deepEqual(v["x-payment"].accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(v["x-payment"].accepts.every((a) => a.price === "$0.05"));
  assert.deepEqual(v["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.050000" });
  assert.deepEqual(Object.keys(v.responses).sort(), ["200", "400", "402", "422"]);
  const req = v.requestBody.content["application/json"].schema;
  assert.deepEqual(req.required, ["claim_url", "claim", "wallet", "network", "direction"]);
  assert.deepEqual(req.properties.network.enum, ["solana", "base"]);
  assert.deepEqual(req.properties.direction.enum, ["inbound", "outbound"]);
  assert.equal(q.requestBody.content["application/json"].schema, req, "quote and verify share one request schema");
  const receipt = v.responses["200"].content["application/json"].schema;
  for (const f of ["schema", "claim", "wallet", "network", "direction", "evidence", "findings", "coverage", "verdict", "method", "spec_hash", "valid_until", "receipt"]) assert.ok(receipt.required.includes(f), `receipt documents ${f}`);
  assert.deepEqual(receipt.properties.verdict.enum, ["supported", "discrepant", "coverage_limited", "incomplete"]);
  const g = doc.paths[PAYOUT_ROUTE].get;
  assert.deepEqual(g.security, []);
  assert.ok(g.responses["402"]);
  assert.equal(g.responses["200"], undefined);
});
