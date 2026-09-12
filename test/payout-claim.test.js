import { test } from "node:test";
import assert from "node:assert";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
import { specHash } from "../src/observatory.js";
import {
  buildPayoutReceipt, claimExtract, classifyPayoutVerdict, comparePayoutClaim, isPayoutBillable, normalizePayoutRequest,
  observeIntel, payoutMethod, PAYOUT_NEVER_BILLED, PAYOUT_PRICE_USDC, PAYOUT_SCHEMA, PAYOUT_VERDICTS, projectClaim,
} from "../src/payout-claim.js";
import { fillExtract } from "../src/extract.js";

// Live shapes pinned 2026-09-10 from intel.twzrd.xyz (read-only probes). Field
// names come from the responses, not from any checkout of the intel source.
const SOL_WALLET = "46vMcwuC4sK11sB3gkLhyA7J7GEwfkhn5rFyDtihBwqe";
const BASE_WALLET = "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8";
const SCORE_MERCHANT = {
  wallet: SOL_WALLET, chain: null, network: null, window_days: null, role: "merchant",
  payments_received: 47, distinct_counterparties: 5, total_usdc_received: 0.189,
  paid_calls: 0, total_usdc: 0.0, first_seen: "2026-02-09T21:06:08Z", last_seen: "2026-08-23T18:11:55Z",
  wash_flag: "unknown", data_available: true, error: null, corpus: "cross-facilitator Solana x402 payer corpus",
};
const CARD_MERCHANT = {
  merchant: SOL_WALLET, wash_flagged: null, decision: "insufficient_evidence", recommendation: "quick",
  confidence: "partial_inbound_only", reason: "Real inbound demand observed, but the wash axis was not evaluated.", card_version: "merchant_card_v1.6",
};
const SCORE_EMPTY_BASE = {
  wallet: BASE_WALLET, chain: "base", network: "eip155:8453", window_days: 90, role: "unknown",
  payments_received: 0, distinct_counterparties: 0, total_usdc_received: 0.0, paid_calls: 0, total_usdc: 0.0,
  first_seen: null, last_seen: null, wash_flag: "clean", data_available: true, error: null, corpus: "attributed rollup",
};
const CARD_EMPTY_BASE = { merchant: BASE_WALLET, wash_flagged: null, decision: "insufficient_evidence", confidence: "full", card_version: "merchant_card_v1.6" };
const FOOTPRINT_EMPTY = { wallet: BASE_WALLET, found: false, unique_facilitators: 0, tx_count: 0, unique_merchants: null, first_seen: null, last_seen: null, data_available: true, error: null };

// Claim fields map to the page's own keys (DeskCrew's descriptor vocabulary here).
const CLAIM = { payout_count: "decidedCount", unique_wallets: "uniqueWallets", paid_usd: "sentUsd" };
const REQ = { claim_url: "https://example.com/board/stats", claim: CLAIM, wallet: SOL_WALLET, network: "solana", direction: "inbound" };
const PAGE = `{"economics":{"decidedCount":372,"payouts":{"sentCount":67,"sentUsd":56.14,"uniqueWallets":22}}}`;

test("constants: price, schema, billable verdict set, never-billed reasons", () => {
  assert.equal(PAYOUT_PRICE_USDC, "0.05");
  assert.equal(PAYOUT_SCHEMA, "witness.payout_claim.v1");
  assert.deepEqual(PAYOUT_VERDICTS, ["supported", "discrepant", "coverage_limited", "incomplete"]);
  for (const v of PAYOUT_VERDICTS) assert.ok(isPayoutBillable(v), `${v} bills`);
  for (const r of ["unable_to_verify", "intel_unavailable", "retrieve_failed", "ssrf_refused", "server_error", "extract_none"]) {
    assert.ok(PAYOUT_NEVER_BILLED.includes(r), `${r} is never billed`);
    assert.equal(isPayoutBillable(r), false);
  }
  assert.equal(isPayoutBillable(null), false, "no verdict is not a billable answer");
});

test("normalize accepts a well-formed inbound request", () => {
  const out = normalizePayoutRequest(REQ);
  assert.equal(out.ok, true);
  assert.deepEqual(out.request, REQ);
});

test("normalize rejects unsupported network, direction, and wallet/network mismatch with 400", () => {
  assert.deepEqual(normalizePayoutRequest({ ...REQ, network: "algorand" }), { ok: false, status: 400, reason: "bad_network" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, direction: "sideways" }), { ok: false, status: 400, reason: "bad_direction" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, wallet: BASE_WALLET }), { ok: false, status: 400, reason: "bad_wallet" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, network: "base", wallet: SOL_WALLET }), { ok: false, status: 400, reason: "bad_wallet" });
  assert.equal(normalizePayoutRequest({ ...REQ, network: "base", wallet: BASE_WALLET }).ok, true);
});

test("normalize rejects unknown claim fields, non-string or unsafe page keys, and an empty claim", () => {
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: { revenue: "sentUsd" } }), { ok: false, status: 400, reason: "bad_claim" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: { payout_count: "number" } }).ok, true, "a page literally keyed 'number' is still a page key");
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: { payout_count: 7 } }), { ok: false, status: 400, reason: "bad_claim" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: { payout_count: "a b" } }), { ok: false, status: 400, reason: "bad_claim" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: { payout_count: "x".repeat(65) } }), { ok: false, status: 400, reason: "bad_claim" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: {} }), { ok: false, status: 400, reason: "bad_claim" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim: undefined }), { ok: false, status: 400, reason: "bad_claim" });
  assert.deepEqual(normalizePayoutRequest(null), { ok: false, status: 400, reason: "bad_json" });
  assert.deepEqual(normalizePayoutRequest({ ...REQ, claim_url: 42 }), { ok: false, status: 400, reason: "bad_claim_url" });
});

test("claimExtract reads the page in its own keys; projectClaim folds the figures back onto claim fields", () => {
  assert.deepEqual(claimExtract(CLAIM), { decidedCount: "number", uniqueWallets: "number", sentUsd: "number" });
  const filled = fillExtract(PAGE, claimExtract(CLAIM));
  assert.deepEqual(projectClaim(CLAIM, filled), { values: { payout_count: 372, unique_wallets: 22, paid_usd: 56.14 }, missing: [] });
  const partial = fillExtract(PAGE, claimExtract({ payout_count: "decidedCount", paid_usd: "grossUsd" }));
  assert.deepEqual(projectClaim({ payout_count: "decidedCount", paid_usd: "grossUsd" }, partial), { values: { payout_count: 372 }, missing: ["paid_usd"] });
  const shared = projectClaim({ payout_count: "sentCount", unique_wallets: "sentCount" }, fillExtract(PAGE, { sentCount: "number" }));
  assert.deepEqual(shared.values, { payout_count: 67, unique_wallets: 67 });
});

test("observeIntel inbound: counts map to payments_received / distinct_counterparties / total_usdc_received", () => {
  const o = observeIntel({ score: SCORE_MERCHANT, card: CARD_MERCHANT }, "inbound");
  assert.equal(o.in_corpus, true);
  assert.deepEqual(o.counts, { payout_count: 47, unique_wallets: 5, paid_usd: 0.189 });
  assert.equal(o.mixed_directions, false);
  assert.equal(o.window, "all_time");
  assert.equal(o.wash_flagged, null);
  assert.equal(o.card_decision, "insufficient_evidence");
  assert.equal(o.first_seen, "2026-02-09T21:06:08Z");
});

test("observeIntel outbound: counts come from the x402 payer footprint; base window is 90d; empty wallet is not in corpus", () => {
  const o = observeIntel({ score: SCORE_EMPTY_BASE, card: CARD_EMPTY_BASE, footprint: FOOTPRINT_EMPTY }, "outbound");
  assert.equal(o.in_corpus, false);
  assert.equal(o.window, "90d");
  assert.deepEqual(o.counts, { payout_count: 0, unique_wallets: null, paid_usd: 0 });
  const rich = observeIntel({ score: { ...SCORE_MERCHANT, paid_calls: 12, total_usdc: 1.5 }, card: CARD_MERCHANT, footprint: { ...FOOTPRINT_EMPTY, found: true, tx_count: 12, unique_merchants: 3 } }, "outbound");
  assert.deepEqual(rich.counts, { payout_count: 12, unique_wallets: 3, paid_usd: 1.5 });
});

test("inbound: every claimed figure at or below the observed corpus is supported", () => {
  const observed = observeIntel({ score: SCORE_MERCHANT, card: CARD_MERCHANT }, "inbound");
  const findings = comparePayoutClaim({ payout_count: 40, unique_wallets: 5, paid_usd: 0.18 }, observed, "inbound");
  assert.deepEqual(findings.map((f) => [f.field, f.relation]), [["payout_count", "supported"], ["unique_wallets", "supported"], ["paid_usd", "supported"]]);
  assert.deepEqual(findings[0], { field: "payout_count", claimed: 40, observed: 47, relation: "supported", note: null });
});

test("inbound: a claim above the observed corpus is discrepant, with the corpus scope stated", () => {
  const observed = observeIntel({ score: SCORE_MERCHANT, card: CARD_MERCHANT }, "inbound");
  const [f] = comparePayoutClaim({ payout_count: 372 }, observed, "inbound");
  assert.equal(f.relation, "discrepant");
  assert.equal(f.claimed, 372);
  assert.equal(f.observed, 47);
  assert.match(f.note, /observed subset/i);
});

test("inbound paid_usd tolerates a cent of rounding, no more", () => {
  const observed = observeIntel({ score: SCORE_MERCHANT, card: CARD_MERCHANT }, "inbound");
  assert.equal(comparePayoutClaim({ paid_usd: 0.19 }, observed, "inbound")[0].relation, "supported");
  assert.equal(comparePayoutClaim({ paid_usd: 0.21 }, observed, "inbound")[0].relation, "discrepant");
});

test("inbound unique_wallets on a wallet that also pays is an upper bound only", () => {
  const observed = observeIntel({ score: { ...SCORE_MERCHANT, paid_calls: 3 }, card: CARD_MERCHANT }, "inbound");
  assert.equal(observed.mixed_directions, true);
  const [ok] = comparePayoutClaim({ unique_wallets: 5 }, observed, "inbound");
  assert.equal(ok.relation, "coverage_limited");
  assert.equal(ok.note, "upper_bound_only: distinct_counterparties mixes payer and payee edges");
  const [over] = comparePayoutClaim({ unique_wallets: 6 }, observed, "inbound");
  assert.equal(over.relation, "discrepant", "more distinct payers than distinct counterparties is impossible");
});

test("outbound: the x402 corpus can confirm a floor but never refute a transfer payout claim", () => {
  const observed = observeIntel({ score: { ...SCORE_MERCHANT, paid_calls: 12, total_usdc: 1.5 }, card: CARD_MERCHANT, footprint: { ...FOOTPRINT_EMPTY, found: true, tx_count: 12, unique_merchants: 3 } }, "outbound");
  const [ok] = comparePayoutClaim({ payout_count: 10 }, observed, "outbound");
  assert.equal(ok.relation, "supported");
  const [short] = comparePayoutClaim({ payout_count: 67 }, observed, "outbound");
  assert.equal(short.relation, "coverage_limited");
  assert.match(short.note, /x402 settlements only/);
});

test("a wallet never observed in the corpus yields coverage_limited for every field, never discrepant", () => {
  const observed = observeIntel({ score: SCORE_EMPTY_BASE, card: CARD_EMPTY_BASE }, "inbound");
  const findings = comparePayoutClaim({ payout_count: 372, unique_wallets: 22, paid_usd: 56.14 }, observed, "inbound");
  assert.ok(findings.every((f) => f.relation === "coverage_limited"));
  assert.ok(findings.every((f) => f.note === "wallet_not_observed"));
  assert.deepEqual(classifyPayoutVerdict(findings, { values: { payout_count: 372, unique_wallets: 22, paid_usd: 56.14 }, missing: [] }), { verdict: "coverage_limited", reason: "wallet_not_observed" });
});

test("classify: discrepant outranks coverage_limited; all supported is supported", () => {
  const findings = [
    { field: "payout_count", claimed: 1, observed: 5, relation: "supported", note: null },
    { field: "unique_wallets", claimed: 9, observed: 5, relation: "discrepant", note: "x" },
    { field: "paid_usd", claimed: 1, observed: null, relation: "coverage_limited", note: "field_unavailable" },
  ];
  assert.deepEqual(classifyPayoutVerdict(findings, { values: { payout_count: 1, unique_wallets: 9, paid_usd: 1 }, missing: [] }), { verdict: "discrepant", reason: "claim_exceeds_observed:unique_wallets" });
  assert.deepEqual(classifyPayoutVerdict([findings[0]], { values: { payout_count: 1 }, missing: [] }), { verdict: "supported", reason: null });
});

test("classify: a claim page missing a requested field is incomplete only when another field proves the extractor read it", () => {
  const some = classifyPayoutVerdict([{ field: "payout_count", claimed: 1, observed: 5, relation: "supported", note: null }], { values: { payout_count: 1 }, missing: ["paid_usd"] });
  assert.deepEqual(some, { verdict: "incomplete", reason: "extract_missing", missing: ["paid_usd"] });
  const none = classifyPayoutVerdict([], { values: {}, missing: ["payout_count"] });
  assert.deepEqual(none, { verdict: null, reason: "extract_none", missing: ["payout_count"] });
  assert.equal(isPayoutBillable(none.verdict), false);
});

test("receipt: signed over the full method and findings; tampering fails; spec_hash binds the method", () => {
  const key = generateProcessKey();
  const observed = observeIntel({ score: SCORE_MERCHANT, card: CARD_MERCHANT }, "inbound");
  const values = { payout_count: 40, unique_wallets: 5 };
  const findings = comparePayoutClaim(values, observed, "inbound");
  const text = "payout_count: 40\nunique_wallets: 5\n";
  const receipt = buildPayoutReceipt({
    request: REQ, text, values, missing: ["paid_usd"], findings, observed,
    intelSources: [{ url: "https://intel.twzrd.xyz/v1/intel/score_wallet_for_intel?wallet=" + SOL_WALLET, sha256: "abc", fetched_at: "2026-09-10T00:00:00.000Z" }],
    verdict: "incomplete", verdict_reason: "extract_missing", observed_at: "2026-09-10T00:00:00.000Z", key,
  });
  assert.equal(receipt.schema, PAYOUT_SCHEMA);
  assert.ok(verifyReceipt(receipt, key.publicKey));
  assert.equal(receipt.valid_until, "2026-09-10T01:00:00.000Z");
  assert.equal(receipt.vantage, "box");
  assert.equal(receipt.claim.url, REQ.claim_url);
  assert.equal(receipt.claim.source_hash.length, 64);
  assert.deepEqual(receipt.claim.keys, CLAIM);
  assert.deepEqual(receipt.claim.values, values);
  assert.deepEqual(receipt.claim.missing, ["paid_usd"]);
  assert.equal(receipt.wallet, SOL_WALLET);
  assert.equal(receipt.direction, "inbound");
  assert.deepEqual(receipt.findings, findings);
  assert.equal(receipt.evidence.observed.in_corpus, true);
  assert.equal(receipt.evidence.intel_sources.length, 1);
  assert.equal(receipt.coverage.window, "all_time");
  assert.match(receipt.coverage.note, /x402/);
  assert.equal(receipt.verdict, "incomplete");
  assert.deepEqual(receipt.method, payoutMethod(REQ));
  assert.equal(receipt.spec_hash, specHash(payoutMethod(REQ)));
  assert.ok(receipt.findings.every((f) => f.relation === "supported"));
  const tampered = { ...receipt, findings: receipt.findings.map((f) => ({ ...f, claimed: f.claimed * 10, relation: "discrepant" })) };
  assert.equal(verifyReceipt(tampered, key.publicKey), false);
  const observedTampered = { ...receipt, evidence: { ...receipt.evidence, observed: { ...receipt.evidence.observed, counts: { ...receipt.evidence.observed.counts, payout_count: 9999 } } } };
  assert.equal(verifyReceipt(observedTampered, key.publicKey), false, "nested observed counts are inside the signature");
  const swapped = { ...receipt, verdict: "supported" };
  assert.equal(verifyReceipt(swapped, key.publicKey), false);
});

test("payoutMethod is canonical over the request and names the retrieval and intel routes", () => {
  const m = payoutMethod(REQ);
  assert.deepEqual(m, { claim_url: REQ.claim_url, retrieval: "scrape", claim: CLAIM, wallet: SOL_WALLET, network: "solana", direction: "inbound", intel: ["score_wallet_for_intel", "merchant_card"] });
  assert.deepEqual(payoutMethod({ ...REQ, direction: "outbound" }).intel, ["score_wallet_for_intel", "merchant_card", "get_facilitator_footprint"]);
  assert.deepEqual(payoutMethod({ ...REQ, direction: "outbound", network: "base", wallet: BASE_WALLET }).intel, ["score_wallet_for_intel", "merchant_card"], "the payer footprint route is Solana-only; Base outbound reads the rollup alone");
  assert.equal(specHash(payoutMethod(REQ)), specHash(payoutMethod({ ...REQ, claim: { paid_usd: "sentUsd", unique_wallets: "uniqueWallets", payout_count: "decidedCount" } })), "key order does not change spec_hash");
  assert.notEqual(specHash(payoutMethod(REQ)), specHash(payoutMethod({ ...REQ, claim: { ...CLAIM, payout_count: "sentCount" } })), "a different page key is a different method");
});
