import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers/tmpdir.js";

import { createHostApp } from "../src/listen.js";
import { attest } from "../src/delivery.js";
import { pubkeyB64 } from "../src/receipt.js";
import { OFFERS } from "../src/offers.js";
import { checkRun, record, score } from "../scripts/loop-check.mjs";

/**
 * The verifier is under test, not the actor. A run directory is assembled the
 * way loop-run.mjs would write it, against an in-process Witness (real key,
 * real quote gate, real attest), with the paid call and the chain faked. Then
 * each predicate is broken one at a time and the verdict must fall to INCOMPLETE.
 */

const OFFER = OFFERS["outbid-reader-scrape"];
const PAYER = "33W8HJrqCPyJsaBnVPd24AVK2wYUf3VLLutXppyAyWMo";
const SIG = "5VfyDqk2m4kK3kFq1Ls9DbqB4o1GmZ1tZ1zjJcE7yq9Gb9kGmv2nZ3rYQwq3eYp8vN1sLxM2cK4hR7tT6uW9aB1c";
const ATTEST_SIG = "4AttestSettlementSignature11111111111111111111111111111111111111111111111111111111111";
const HOST_PAYTO = "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM";
const HOST_ACCEPTS = [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "10000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: HOST_PAYTO }];
const ARTIFACT = { ok: true, title: "Example Domain", content: "# Example Domain", markdown: "# Example Domain", word_count: 2 };

const liveAccepts = OFFER.accepts.map((a) => ({ ...a, maxTimeoutSeconds: 300 }));
const challengeHeader = (accepts) => Buffer.from(JSON.stringify({ x402Version: 2, error: "Payment required", accepts })).toString("base64");
const probeFetch = async () => ({ status: 402, headers: { get: (h) => (h === "payment-required" ? challengeHeader(liveAccepts) : null) }, json: async () => ({}) });

/** A confirmed Solana tx in which `payTo` received `amount` atomic USDC and PAYER signed. */
function fakeTx({ payTo, amount, payer = PAYER, err = null, mint = OFFER.accepts[1].asset }) {
  return {
    meta: {
      err,
      preTokenBalances: [{ owner: payTo, mint, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ owner: payTo, mint, uiTokenAmount: { amount: String(1000000 + Number(amount)) } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: payer, signer: true }, { pubkey: payTo, signer: false }] } },
  };
}

/** fetch used by the verifier: /pubkey and /api/offers go to the in-process host; RPC is
 *  faked per signature; the well-known descriptor can be overridden to simulate a paywalled host. */
function verifierFetch(base, tx, { attestTx = undefined, hostAccepts = null } = {}) {
  return async (url, init) => {
    if (typeof url === "string" && url.endsWith("/.well-known/x402") && hostAccepts !== null) return { json: async () => ({ accepts: hostAccepts }) };
    if (typeof url === "string" && url.startsWith(base)) return fetch(url, init);
    if (url === "rpc://fake") {
      const body = JSON.parse(init.body);
      assert.equal(body.method, "getTransaction");
      const [signature] = body.params;
      const result = signature === ATTEST_SIG ? (attestTx === undefined ? null : attestTx) : tx;
      return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

async function withHost(fn) {
  const server = createHostApp({ OBSERVATIONS_DIR: tempDir("wit-loop-") }, { probeFetch, attest }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Assemble a run dir exactly as the actor writes it, with the paid call faked. */
async function buildRun(base, { artifact = ARTIFACT, settlementSig = SIG, attestSig = null, mutate = () => {} } = {}) {
  const dir = tempDir("wit-run-");
  const write = (name, v) => writeFileSync(path.join(dir, name), JSON.stringify(v, null, 2));
  const quoteRes = await fetch(`${base}/api/quotes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offer_id: OFFER.id, input: { url: "https://example.com" } }) });
  const quote = await quoteRes.json();
  write("quote.json", { status: quoteRes.status, body: quote, at: new Date().toISOString() });
  const catalog = await (await fetch(`${base}/api/offers/${OFFER.id}`)).json();
  write("catalog.json", { status: 200, body: catalog });
  const request = { method: quote.request.method, url: quote.request.url, body: null, requested_at: "2026-09-11T07:00:00.000Z" };
  write("request.json", request);
  const bodyText = JSON.stringify(artifact);
  write("response.json", { status: 200, headers: { "content-type": "application/json", "payment-response": "ignored-in-tests" }, body_text: bodyText, received_at: "2026-09-11T07:00:05.000Z" });
  write("settlement.json", { header_present: true, decoded: settlementSig ? { success: true, transaction: settlementSig, network: OFFER.accepts[1].network, payer: PAYER } : null, payer: PAYER });
  const offer = { resource_url: request.url, deliverable_class: catalog.delivery.deliverable_class, price_usdc: Number(catalog.price.usd), spec: catalog.delivery.spec, spec_origin: catalog.delivery.spec_origin };
  write("offer.json", offer);
  const attestBody = {
    offer,
    request: { request_body: { url: "https://example.com" }, settlement_ref: settlementSig, requested_at: request.requested_at },
    observation: { artifact, observed_at: "2026-09-11T07:00:06.000Z", mode: "buyer_attested", http_status: 200, seller_signature: null, notes: [] },
  };
  write("attest-request.json", attestBody);
  const attestRes = await fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(attestBody) });
  write("receipt.json", { status: attestRes.status, body: await attestRes.json(), at: new Date().toISOString() });
  if (attestSig) write("attest-settlement.json", { header_present: true, decoded: { success: true, transaction: attestSig, network: HOST_ACCEPTS[0].network, payer: PAYER }, payer: PAYER });
  mutate(dir, write);
  return dir;
}

const goodTx = () => fakeTx({ payTo: OFFER.accepts[1].payTo, amount: OFFER.accepts[1].amount });

test("a complete, honest run is DONE: every predicate passes from recomputed evidence", async () => {
  await withHost(async (base) => {
    const dir = await buildRun(base);
    const result = await checkRun(dir, { fetch: verifierFetch(base, goodTx()), rpc: "rpc://fake", base });
    assert.deepEqual(result.failed, [], JSON.stringify(result.predicates, null, 1));
    assert.equal(result.done, true);
    assert.equal(result.predicates.length, 11);
    assert.equal(result.predicates.find((p) => p.name === "attest_settled").detail, "host advertises no paywall; attest served unpaid");
  });
});

test("on a paywalled host the attestation's own settlement must be on chain to the host's payee", async () => {
  await withHost(async (base) => {
    const attestTx = fakeTx({ payTo: HOST_PAYTO, amount: "10000" });
    const paid = await buildRun(base, { attestSig: ATTEST_SIG });
    const ok = await checkRun(paid, { fetch: verifierFetch(base, goodTx(), { attestTx, hostAccepts: HOST_ACCEPTS }), rpc: "rpc://fake", base });
    assert.deepEqual(ok.failed, [], JSON.stringify(ok.predicates.filter((p) => !p.pass)));
    const unpaid = await buildRun(base);
    const missing = await checkRun(unpaid, { fetch: verifierFetch(base, goodTx(), { hostAccepts: HOST_ACCEPTS }), rpc: "rpc://fake", base });
    assert.ok(missing.failed.includes("attest_settled"));
    assert.equal(missing.done, false);
    const ghost = await checkRun(paid, { fetch: verifierFetch(base, goodTx(), { attestTx: null, hostAccepts: HOST_ACCEPTS }), rpc: "rpc://fake", base });
    assert.ok(ghost.failed.includes("attest_settled"));
    const wrong = await checkRun(paid, { fetch: verifierFetch(base, goodTx(), { attestTx: fakeTx({ payTo: "11111111111111111111111111111111", amount: "10000" }), hostAccepts: HOST_ACCEPTS }), rpc: "rpc://fake", base });
    assert.ok(wrong.failed.includes("attest_settled"));
    const reused = await buildRun(base, { attestSig: SIG });
    const dup = await checkRun(reused, { fetch: verifierFetch(base, goodTx(), { hostAccepts: HOST_ACCEPTS }), rpc: "rpc://fake", base });
    assert.ok(dup.failed.includes("attest_settled"));
  });
});

test("INCOMPLETE is the default: an empty run dir fails every predicate and is not done", async () => {
  const dir = tempDir("wit-empty-");
  const result = await checkRun(dir, { fetch: async () => { throw new Error("no network"); }, rpc: "rpc://fake", base: "http://127.0.0.1:1" });
  assert.equal(result.done, false);
  assert.equal(result.failed.length, 11);
});

test("a tampered artifact after attestation is caught: receipt_binds_run and the verdict fall", async () => {
  await withHost(async (base) => {
    const dir = await buildRun(base, {
      mutate: (d, write) => {
        const r = JSON.parse(readFileSync(path.join(d, "response.json"), "utf8"));
        write("response.json", { ...r, body_text: JSON.stringify({ ...ARTIFACT, word_count: 9999 }) });
      },
    });
    const result = await checkRun(dir, { fetch: verifierFetch(base, goodTx()), rpc: "rpc://fake", base });
    assert.equal(result.done, false);
    assert.ok(result.failed.includes("receipt_binds_run"), result.failed.join(","));
  });
});

test("a paid call whose body misses the spec is INCOMPLETE even though everything is signed and settled", async () => {
  await withHost(async (base) => {
    const dir = await buildRun(base, { artifact: { ok: true, title: "Example Domain" } });
    const result = await checkRun(dir, { fetch: verifierFetch(base, goodTx()), rpc: "rpc://fake", base });
    assert.equal(result.done, false);
    assert.ok(result.failed.includes("spec_holds"));
    assert.ok(result.failed.includes("verdict_delivered"), "the receipt itself says incomplete, and the verifier agrees independently");
    assert.ok(!result.failed.includes("receipt_verifies"), "the receipt is still a valid signed receipt; it just does not say delivered");
  });
});

test("no settlement on chain is INCOMPLETE: a story about paying is not a payment", async () => {
  await withHost(async (base) => {
    const dir = await buildRun(base);
    const notFound = await checkRun(dir, { fetch: verifierFetch(base, null), rpc: "rpc://fake", base });
    assert.ok(notFound.failed.includes("settlement_on_chain"));
    assert.equal(notFound.done, false);
    const wrongPayee = await checkRun(dir, { fetch: verifierFetch(base, fakeTx({ payTo: "11111111111111111111111111111111", amount: OFFER.accepts[1].amount })), rpc: "rpc://fake", base });
    assert.ok(wrongPayee.failed.includes("settlement_on_chain"));
    const wrongAmount = await checkRun(dir, { fetch: verifierFetch(base, fakeTx({ payTo: OFFER.accepts[1].payTo, amount: "4999" })), rpc: "rpc://fake", base });
    assert.ok(wrongAmount.failed.includes("settlement_on_chain"));
    const errored = await checkRun(dir, { fetch: verifierFetch(base, fakeTx({ payTo: OFFER.accepts[1].payTo, amount: OFFER.accepts[1].amount, err: { InstructionError: [0, "Custom"] } })), rpc: "rpc://fake", base });
    assert.ok(errored.failed.includes("settlement_on_chain"));
    const otherSigner = await checkRun(dir, { fetch: verifierFetch(base, fakeTx({ payTo: OFFER.accepts[1].payTo, amount: OFFER.accepts[1].amount, payer: "SomeoneElse1111111111111111111111111111111" })), rpc: "rpc://fake", base });
    assert.ok(otherSigner.failed.includes("settlement_on_chain"));
  });
});

test("a receipt signed by a different key does not verify, whatever it says", async () => {
  await withHost(async (base) => {
    const dir = await buildRun(base);
    const { generateProcessKey } = await import("../src/receipt.js");
    const other = pubkeyB64(generateProcessKey());
    const result = await checkRun(dir, { fetch: verifierFetch(base, goodTx()), rpc: "rpc://fake", pubkeyB64: other, base });
    assert.ok(result.failed.includes("receipt_verifies"));
    assert.equal(result.done, false);
  });
});

test("a receipt bound to a different settlement than the chain shows is INCOMPLETE", async () => {
  await withHost(async (base) => {
    const dir = await buildRun(base, { settlementSig: "3AnotherSignatureThatWasAttestedButNotTheOneOnChain111111111111111111111111111111111" });
    // The chain answers for the attested signature (so settlement_on_chain passes),
    // then the settlement file is swapped to a different signature: the bound ref must disagree.
    const r = JSON.parse(readFileSync(path.join(dir, "settlement.json"), "utf8"));
    writeFileSync(path.join(dir, "settlement.json"), JSON.stringify({ ...r, decoded: { ...r.decoded, transaction: SIG } }));
    const result = await checkRun(dir, { fetch: verifierFetch(base, goodTx()), rpc: "rpc://fake", base });
    assert.ok(result.failed.includes("settlement_bound"));
    assert.ok(result.failed.includes("receipt_binds_run"), "request_hash covers settlement_ref, so it moves too");
    assert.equal(result.done, false);
  });
});

test("the ledger scores predicate pass rate, not recap quality", async () => {
  const ledger = path.join(tempDir("wit-ledger-"), "ledger.ndjson");
  record("run-a", { done: true, failed: [] }, ledger);
  record("run-b", { done: false, failed: ["settlement_on_chain"] }, ledger);
  record("run-c", { done: false, failed: ["spec_holds", "verdict_delivered"] }, ledger);
  assert.deepEqual(score(ledger), { runs: 3, done: 1, pass_rate: 1 / 3 });
  assert.deepEqual(score(path.join(path.dirname(ledger), "absent.ndjson")), { runs: 0, done: 0, pass_rate: null });
});
