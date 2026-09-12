import { test } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { INTEL_BASE, IntelUnavailable, intelUrls, makeFetchIntel } from "../src/intel-evidence.js";

const W = "46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe";
const SCORE = { wallet: W, payments_received: 47, distinct_counterparties: 5, total_usdc_received: 0.189, paid_calls: 0, first_seen: "2026-02-09T21:06:08Z", data_available: true, error: null };
const CARD = { merchant: W, wash_flagged: null, decision: "insufficient_evidence", card_version: "merchant_card_v1.6" };
const FOOT = { wallet: W, found: false, tx_count: 0, unique_merchants: null, data_available: true, error: null };
const sha = (s) => createHash("sha256").update(s).digest("hex");

function fakeFetch(routes, calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    const v = hit[1];
    if (v instanceof Error) throw v;
    if (typeof v === "string") return new Response(v, { status: 200, headers: { "content-type": "text/plain" } });
    return new Response(JSON.stringify(v.body ?? v), { status: v.status ?? 200, headers: { "content-type": "application/json" } });
  };
}

test("intelUrls: inbound reads score then merchant card; Solana outbound adds the payer footprint; Base outbound does not; wallet is URL-encoded", () => {
  const inbound = intelUrls(INTEL_BASE, W, "inbound", "solana");
  assert.deepEqual(inbound.map((r) => r.name), ["score_wallet_for_intel", "merchant_card"]);
  assert.equal(inbound[0].url, `https://intel.twzrd.xyz/v1/intel/score_wallet_for_intel?wallet=${W}`);
  assert.equal(inbound[1].url, `https://intel.twzrd.xyz/v1/intel/merchant_card/${W}`);
  const outbound = intelUrls(INTEL_BASE, W, "outbound", "solana");
  assert.deepEqual(outbound.map((r) => r.name), ["score_wallet_for_intel", "merchant_card", "get_facilitator_footprint"]);
  assert.equal(outbound[2].url, `https://intel.twzrd.xyz/v1/intel/get_facilitator_footprint?wallet=${W}`);
  const BASE = "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8";
  assert.deepEqual(intelUrls(INTEL_BASE, BASE, "outbound", "base").map((r) => r.name), ["score_wallet_for_intel", "merchant_card"], "footprint route rejects non-Solana addresses");
  assert.equal(intelUrls(INTEL_BASE, "a b", "inbound", "solana")[0].url, "https://intel.twzrd.xyz/v1/intel/score_wallet_for_intel?wallet=a%20b");
});

test("host pin: only https://intel.twzrd.xyz is an acceptable evidence origin", () => {
  assert.throws(() => makeFetchIntel({ intelBase: "https://evil.example" }), TypeError);
  assert.throws(() => makeFetchIntel({ intelBase: "http://intel.twzrd.xyz" }), TypeError);
  assert.throws(() => makeFetchIntel({ intelBase: "https://intel.twzrd.xyz.evil.example" }), TypeError);
  assert.ok(makeFetchIntel({ intelBase: "https://intel.twzrd.xyz/" }));
});

test("fetches every route for the direction and binds each raw body by sha256 with a fetch time", async () => {
  const calls = [];
  const now = () => 1_800_000_000_000;
  const fetchIntel = makeFetchIntel({ fetch: fakeFetch({ score_wallet_for_intel: SCORE, merchant_card: CARD, get_facilitator_footprint: FOOT }, calls), now });
  const out = await fetchIntel(W, "inbound", "solana");
  assert.deepEqual(out.score, SCORE);
  assert.deepEqual(out.card, CARD);
  assert.equal(out.footprint, undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.accept, "application/json");
  assert.deepEqual(out.sources.map((s) => s.name), ["score_wallet_for_intel", "merchant_card"]);
  assert.equal(out.sources[0].sha256, sha(JSON.stringify(SCORE)));
  assert.equal(out.sources[0].fetched_at, new Date(now()).toISOString());
  assert.match(out.sources[0].url, /^https:\/\/intel\.twzrd\.xyz\//);
  const outbound = await fetchIntel(W, "outbound", "solana");
  assert.deepEqual(outbound.footprint, FOOT);
  assert.equal(outbound.sources.length, 3);
});

test("caches a successful bundle per wallet+direction for the ttl, then refetches", async () => {
  const calls = [];
  let t = 1_800_000_000_000;
  const fetchIntel = makeFetchIntel({ fetch: fakeFetch({ score_wallet_for_intel: SCORE, merchant_card: CARD, get_facilitator_footprint: FOOT }, calls), now: () => t, cacheTtlMs: 60_000 });
  const a = await fetchIntel(W, "inbound", "solana");
  const b = await fetchIntel(W, "inbound", "solana");
  assert.equal(calls.length, 2, "second call within ttl is served from cache");
  assert.equal(a, b);
  await fetchIntel(W, "outbound", "solana");
  assert.equal(calls.length, 5, "direction is part of the cache key");
  await fetchIntel(W, "inbound", "base");
  assert.equal(calls.length, 7, "network is part of the cache key");
  t += 60_001;
  await fetchIntel(W, "inbound", "solana");
  assert.equal(calls.length, 9, "expired entry refetches");
});

test("fails closed: non-2xx, non-JSON, data_available:false, error set, or a rejected fetch all raise intel_unavailable and cache nothing", async () => {
  const cases = [
    { score_wallet_for_intel: { status: 500, body: {} }, merchant_card: CARD },
    { score_wallet_for_intel: "<html>edge error</html>", merchant_card: CARD },
    { score_wallet_for_intel: { ...SCORE, data_available: false }, merchant_card: CARD },
    { score_wallet_for_intel: { ...SCORE, error: "upstream" }, merchant_card: CARD },
    { score_wallet_for_intel: SCORE, merchant_card: { status: 429, body: {} } },
    { score_wallet_for_intel: new Error("timeout"), merchant_card: CARD },
  ];
  for (const routes of cases) {
    const calls = [];
    const fetchIntel = makeFetchIntel({ fetch: fakeFetch(routes, calls) });
    await assert.rejects(() => fetchIntel(W, "inbound", "solana"), (e) => e instanceof IntelUnavailable && e.reason === "intel_unavailable");
    const before = calls.length;
    await assert.rejects(() => fetchIntel(W, "inbound", "solana"));
    assert.ok(calls.length > before, "a failure is never cached");
  }
});

test("a wallet with no history is a valid answer, not an outage", async () => {
  const empty = { wallet: W, payments_received: 0, distinct_counterparties: 0, total_usdc_received: 0, paid_calls: 0, first_seen: null, data_available: true, error: null };
  const fetchIntel = makeFetchIntel({ fetch: fakeFetch({ score_wallet_for_intel: empty, merchant_card: CARD }) });
  const out = await fetchIntel(W, "inbound", "solana");
  assert.equal(out.score.first_seen, null);
});
