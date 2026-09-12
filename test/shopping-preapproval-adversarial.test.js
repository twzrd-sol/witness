/**
 * Adversarial suite for shopping-preapproval / Done-before-checkout after #37.
 *
 * #40 pinned POST /quote, POST /witness, POST /delivery/attest (generic bodies).
 * #42 pinned the offers catalog and funnel.
 * This file covers the surfaces those suites do not bind to checkout:
 *
 *   Host (GATE_METHOD card only — not a repeat of the #40 bodies):
 *     POST /quote
 *     POST /witness
 *
 *   Client (scripts/shopping-preapproval.mjs runOnce):
 *     dry / live `checkout_approved` / `completion`
 *
 *   Child (scripts/verify-shopping-receipt.mjs):
 *     separate-process Done; not skipped by forged headers or success flags
 *
 * Existing tests: shopping-preapproval.test.js (card + decideGate + dry quote),
 * shopping-completion.test.js (pin, tamper, crash, dry incomplete, CLI exit).
 * Those use handleWitness + a fixture transport and never stand the paywall
 * up in front of runOnce. This suite does.
 *
 * Matrix — every item is a named `test()`; every assertion is concrete:
 *  1. Shape/400 never 402 — GATE_METHOD-shaped client errors never carry
 *     PAYMENT-REQUIRED. A 400/422 quote cannot be read as a challenge or
 *     as checkout approval, even when the body claims Done.
 *  2. Forged payment headers — invented X-PAYMENT / PAYMENT-SIGNATURE on
 *     the card never mint a receipt, never settle, and never set
 *     checkout_approved.
 *  3. Settle-only-on-2xx — facilitator settle runs once after a verified
 *     GATE_METHOD 200 and never on 400/422/500. A client 422 after verify
 *     leaves checkout incomplete.
 *  4. Done-required-before-checkout cannot be skipped by forged headers —
 *     X-Checkout-Approved, PAYMENT-RESPONSE, quote/witness bodies that
 *     claim complete, or a well-shaped payment that unlocks a host 200
 *     with a tampered receipt. Only the child accepting a pinned receipt
 *     sets checkout_approved.
 *
 * No live reader. No live facilitator. No wallet. Injected retrieve +
 * facilitator stubs. Held #20 / #21 (twice-pay, payout-claim) untouched.
 * No AutoGate / Monid / Path A.
 *
 * Run this file: `node --test test/shopping-preapproval-adversarial.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey, pubkeyB64, verifyReceipt } from "../src/receipt.js";
import { readObservations } from "../src/observatory.js";
import { GATE_METHOD, runOnce, logRun } from "../scripts/shopping-preapproval.mjs";

const PAYWALL = {
  evmAddress: "0xabc0000000000000000000000000000000000001",
  svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
};
const BASE_URL = "https://witness.example.net";
const CARD_HTML = "<p>price: $5.99</p>";

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

function countingRetrieve() {
  const calls = { n: 0, urls: [] };
  return {
    calls,
    retrieve: async (url) => {
      calls.n += 1;
      calls.urls.push(url);
      return { text: CARD_HTML };
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
  const observationsDir = extra.observationsDir ?? mkdtempSync(path.join(os.tmpdir(), "wit-shop-adv-"));
  const reader = extra.retrieve ? { retrieve: extra.retrieve, calls: extra.retrieveCalls ?? { n: 0, urls: [] } } : countingRetrieve();
  const key = extra.key ?? generateProcessKey();
  return {
    key,
    app: createApp({
      key,
      retrieve: reader.retrieve,
      observationsDir,
      funnelDir: extra.funnelDir === undefined ? null : extra.funnelDir,
      facilitator: extra.facilitator ?? refusingFacilitator,
      paywall: extra.paywall === undefined ? PAYWALL : extra.paywall,
      publicBaseUrl: BASE_URL,
      quoteRateLimit: extra.quoteRateLimit ?? 100,
      quoteGlobalRateLimit: extra.quoteGlobalRateLimit ?? 100,
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

function assertCheckoutBlocked(run, label) {
  assert.equal(run.checkout_approved, false, `${label}: checkout_approved`);
  assert.equal(run.completion, "incomplete", `${label}: completion`);
  assert.equal(run.paid, false, `${label}: paid is not settlement and must stay false`);
}

const FORGED_PAY = [
  { "x-payment": "forged" },
  { "payment-signature": "forged" },
  { "X-PAYMENT": "forged" },
  { "PAYMENT-SIGNATURE": "forged" },
  { "x-payment": "null" },
  { "payment-signature": "e30=" },
  { "payment-signature": Buffer.from("not-json").toString("base64") },
  { "x-payment": Buffer.from(JSON.stringify({ x402Version: 1, payload: {} })).toString("base64") },
  { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: {} })).toString("base64") },
];

const DONE_HEADERS = {
  "x-checkout-approved": "true",
  "x-completion": "complete",
  "x-done": "1",
  "x-witness-verified": "true",
  "x-trusted-pubkey": "forged",
  "payment-response": "forged",
};

const HOSTILE_COMPLETE = {
  can_deliver: true,
  verdict: "supported",
  checkout_approved: true,
  completion: "complete",
  approve: true,
  paid: true,
  success: true,
  receipt: "forged",
};

function liveBlocked(base, extra = {}) {
  return runOnce({
    mode: "live",
    base,
    trustedPubkeyB64: extra.trustedPubkeyB64 ?? pubkeyB64(generateProcessKey()),
    paymentTransport: extra.paymentTransport ?? (async () => {
      throw new Error("paymentTransport must not run");
    }),
  });
}

/** Programmed quote hop. Avoids mocking global fetch — this file's tests
 *  may run concurrently with each other under `node --test`. */
async function serveQuote(status, body, headers, fn) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
// 1. Shape / 400 never 402
// ---------------------------------------------------------------------------

test("matrix 1 (shape/400 never 402): POST /quote GATE_METHOD — malformed card bodies are client errors; a well-formed card is unpaid 200, never 402", async () => {
  const reader = countingRetrieve();
  const { app } = host({ retrieve: reader.retrieve, retrieveCalls: reader.calls });
  await serve(app, async (base) => {
    const cases = [
      ["malformed JSON", 400, "bad_json", () => post(base, "/quote", "{not json")],
      ["text/plain", 400, "bad_json", () => fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })],
      ["form-urlencoded", 400, "bad_json", () => fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=https://dummyjson.com/products/1" })],
      ["no content-type", 400, "bad_json", () => fetch(`${base}/quote`, { method: "POST", body: JSON.stringify(GATE_METHOD) })],
      ["JSON null", 400, "bad_json", () => post(base, "/quote", "null")],
      ["empty object", 400, "bad_extract", () => post(base, "/quote", {})],
      ["missing extract", 400, "bad_extract", () => post(base, "/quote", { url: GATE_METHOD.url, assertion: GATE_METHOD.assertion })],
      ["array body", 400, "bad_extract", () => post(base, "/quote", [GATE_METHOD])],
      ["bad assertion type", 400, "bad_assertion", () => post(base, "/quote", { ...GATE_METHOD, assertion: 7 })],
      ["assertion over max length", 400, "bad_assertion", () => post(base, "/quote", { ...GATE_METHOD, assertion: "x".repeat(513) })],
      ["missing url", 422, "invalid_url", () => post(base, "/quote", { extract: GATE_METHOD.extract, assertion: GATE_METHOD.assertion })],
      ["replicas unsupported", 422, "replicas_unsupported", () => post(base, "/quote", { ...GATE_METHOD, replicas: 3 })],
      ["http url (SSRF)", 422, "https_only", () => post(base, "/quote", { ...GATE_METHOD, url: "http://127.0.0.1/" })],
      ["forged x-payment on a shape error", 400, "bad_extract", () => post(base, "/quote", {}, { "x-payment": "forged" })],
      ["forged payment-signature on a shape error", 400, "bad_extract", () => post(base, "/quote", {}, { "payment-signature": "forged" })],
    ];
    for (const [label, status, reason, send] of cases) {
      const res = await send();
      assert.equal(res.status, status, `${label}: status`);
      assertNoChallenge(res, label);
      const json = await res.json();
      assert.equal(json.reason, reason, `${label}: reason`);
      assert.equal(json.receipt, undefined, `${label}: must not mint a receipt`);
      assert.equal(json.checkout_approved, undefined, `${label}: quote is not a Done token`);
    }

    const ok = await post(base, "/quote", GATE_METHOD);
    assert.equal(ok.status, 200, "well-formed unpaid GATE_METHOD quote is 200");
    assertNoChallenge(ok, "deliverable GATE_METHOD quote");
    const quoted = await ok.json();
    assert.equal(quoted.can_deliver, true);
    assert.equal(quoted.verdict, "supported");
    assert.equal(quoted.receipt, undefined);
    assert.equal(quoted.checkout_approved, undefined);

    for (const h of [{ "x-payment": "forged" }, { "payment-signature": "forged" }, DONE_HEADERS]) {
      const res = await post(base, "/quote", GATE_METHOD, h);
      const label = `GATE_METHOD + ${JSON.stringify(h)}`;
      assert.equal(res.status, 200, label);
      assertNoChallenge(res, label);
      assert.equal((await res.json()).checkout_approved, undefined, label);
    }
  });
  assert.equal(reader.calls.n, 4, "shape/SSRF/replicas refusals must not retrieve; only the four deliverable GATE_METHOD quotes do");
  assert.ok(reader.calls.urls.every((u) => u === GATE_METHOD.url));
});

test("matrix 1 (shape/400 never 402): POST /witness unpaid GATE_METHOD — card-shaped client errors never challenge; a well-formed unpaid card still 402s", async () => {
  const reader = countingRetrieve();
  const { app } = host({ retrieve: reader.retrieve, retrieveCalls: reader.calls });
  await serve(app, async (base) => {
    const cases = [
      ["malformed JSON", 400, "bad_json", () => post(base, "/witness", "{not json")],
      ["missing extract", 400, "bad_extract", () => post(base, "/witness", { url: GATE_METHOD.url })],
      ["http url (SSRF)", 422, "https_only", () => post(base, "/witness", { ...GATE_METHOD, url: "http://127.0.0.1/" })],
      ["replicas unsupported", 422, "replicas_unsupported", () => post(base, "/witness", { ...GATE_METHOD, replicas: 3 })],
    ];
    for (const [label, status, reason, send] of cases) {
      const res = await send();
      assert.equal(res.status, status, `${label}: status`);
      assertNoChallenge(res, label);
      const json = await res.json();
      assert.equal(json.reason, reason, `${label}: reason`);
      assert.equal(json.receipt, undefined, `${label}: must not mint a receipt`);
    }
    const ok = await post(base, "/witness", GATE_METHOD);
    assert.equal(ok.status, 402, "unpaid deliverable GATE_METHOD still hits the paywall");
    assert.equal(challengeOf(ok).resource?.url, `${BASE_URL}/witness`);
    assert.equal((await ok.json()).receipt, undefined);
  });
  assert.equal(reader.calls.n, 1, "shape/SSRF/replicas refusals must not retrieve; only the unpaid deliverable probe does");
});

test("matrix 1 (shape/400 never 402): runOnce live — a 400/422/402 quote that claims checkout_approved never pays and never completes", async () => {
  const quotes = [
    ["400 bad_extract", 400, { reason: "bad_extract", ...HOSTILE_COMPLETE }],
    ["422 extract_none", 422, { reason: "extract_none", ...HOSTILE_COMPLETE }],
    ["402 quote (must not be read as a challenge-or-Done)", 402, { ...HOSTILE_COMPLETE, reason: "payment_required" }],
  ];
  for (const [label, status, body] of quotes) {
    let pays = 0;
    await serveQuote(status, body, { "payment-required": "forged", ...DONE_HEADERS }, async (base) => {
      const run = await liveBlocked(base, {
        paymentTransport: async () => {
          pays += 1;
          return { payer: "must-not-load", pay: async () => { throw new Error("must not pay"); } };
        },
      });
      assertCheckoutBlocked(run, label);
      assert.equal(run.step, "quote", `${label}: must stop on the quote`);
      assert.equal(run.status, status, `${label}: status`);
      assert.equal(run.decision.reason, "quote_not_deliverable", `${label}: reason`);
      assert.equal(run.payment_attempted, false, `${label}: must not attempt payment`);
      assert.equal(run.check.reason, "not_run", `${label}: child must not run on a refused quote`);
      assert.equal(pays, 0, `${label}: paymentTransport must not load`);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Forged payment headers
// ---------------------------------------------------------------------------

test("matrix 2 (forged payment headers): POST /witness GATE_METHOD — invented X-PAYMENT / PAYMENT-SIGNATURE never mint a receipt or settle", async () => {
  const facilitator = acceptingFacilitator();
  const { app, observationsDir } = host({ facilitator });
  await serve(app, async (base) => {
    for (const h of FORGED_PAY) {
      const res = await post(base, "/witness", GATE_METHOD, h);
      const label = JSON.stringify(h);
      assert.notEqual(res.status, 200, `${label} minted a receipt`);
      assert.ok(res.status < 500, `${label} was a server error (${res.status})`);
      assert.equal(res.status, 402, `${label}: refuse or 402 as designed, got ${res.status}`);
      assert.equal((await res.json()).receipt, undefined, `${label}: receipt field`);
    }
    const unrelated = await post(base, "/witness", GATE_METHOD, { "payment-response": "forged", ...DONE_HEADERS });
    assert.equal(unrelated.status, 402, "PAYMENT-RESPONSE / Done headers are not proof and must not unlock");
    assert.equal((await unrelated.json()).receipt, undefined);

    const empty = await post(base, "/witness", GATE_METHOD, { "x-payment": "", "payment-signature": "" });
    assert.equal(empty.status, 402);
    assert.equal((await empty.json()).receipt, undefined);

    assert.equal(facilitator.calls.settle, 0, "a forged header must never settle");
    assert.equal(readObservations(observationsDir).length, 0, "nothing appended");
  });
});

test("matrix 2 (forged payment headers): runOnce live against the paywall — forged X-PAYMENT / PAYMENT-SIGNATURE cannot approve checkout", async () => {
  const facilitator = acceptingFacilitator();
  const key = generateProcessKey();
  const { app } = host({ key, facilitator });
  await serve(app, async (base) => {
    for (const h of [{ "x-payment": "forged" }, { "payment-signature": "forged" }, { "X-PAYMENT": "forged", ...DONE_HEADERS }]) {
      const run = await runOnce({
        mode: "live",
        base,
        trustedPubkeyB64: pubkeyB64(key),
        paymentTransport: async () => ({
          payer: "forged-not-a-wallet",
          pay: async (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...h } }),
        }),
      });
      const label = JSON.stringify(h);
      assertCheckoutBlocked(run, label);
      assert.equal(run.step, "witness", `${label}: quote was deliverable; the paid hop ran`);
      assert.equal(run.status, 402, `${label}: host must 402 a forged payment`);
      assert.equal(run.decision.reason, "witness_http_402", label);
      assert.equal(run.payment_attempted, true, `${label}: attempt is recorded`);
      assert.equal(run.payment_status, "unknown", `${label}: a 402 is not settlement`);
      assert.equal(run.check.reason, "not_run", `${label}: child must not run without a 200 receipt`);
    }
  });
  assert.equal(facilitator.calls.settle, 0);
  assert.equal(facilitator.calls.verify, 0, "unparseable forged headers must not reach facilitator verify");
});

// ---------------------------------------------------------------------------
// 3. Settle only on 2xx
// ---------------------------------------------------------------------------

test("matrix 3 (settle-only-on-2xx): POST /witness GATE_METHOD — verified payment settles once on 200 and never on 400/422/500", async () => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-shop-adv-"));
  const facilitator = acceptingFacilitator();
  let retrieveMode = "ok";
  const { app } = host({
    key,
    facilitator,
    observationsDir: dir,
    retrieve: async () => {
      if (retrieveMode === "fail") throw new Error("reader_503");
      if (retrieveMode === "boom") return { text: 42 };
      return { text: CARD_HTML };
    },
  });
  await serve(app, async (base) => {
    const unpaid = await post(base, "/witness", GATE_METHOD);
    assert.equal(unpaid.status, 402);
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0, "an unpaid GATE_METHOD challenge must not settle");

    const pay = await paymentFor(base, "/witness", GATE_METHOD);
    const ok = await post(base, "/witness", GATE_METHOD, pay);
    assert.equal(ok.status, 200);
    const receipt = await ok.json();
    assert.equal(typeof receipt.receipt, "string");
    assert.ok(verifyReceipt(receipt, key.publicKey), "the 200 is a real signed receipt");
    assert.equal(receipt.verdict, "supported");
    assert.equal(facilitator.calls.verify, 1);
    assert.equal(facilitator.calls.settle, 1, "settled once, after the 200");
    assert.equal(readObservations(dir).length, 1);

    const missing = await post(base, "/witness", { url: GATE_METHOD.url }, pay);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).reason, "bad_extract");
    assert.equal(facilitator.calls.settle, 1, "400 bad_extract must not settle");

    const none = await post(base, "/witness", { url: GATE_METHOD.url, extract: { nowhere: "number" }, assertion: "nowhere < 1" }, pay);
    assert.equal(none.status, 422);
    assert.equal((await none.json()).reason, "extract_none");
    assert.equal(facilitator.calls.settle, 1, "422 extract_none must not settle");

    retrieveMode = "fail";
    const failed = await post(base, "/witness", GATE_METHOD, pay);
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).reason, "retrieve_failed");
    assert.equal(facilitator.calls.settle, 1, "422 retrieve_failed must not settle");

    retrieveMode = "boom";
    const boom = await post(base, "/witness", GATE_METHOD, pay);
    assert.equal(boom.status, 500);
    assert.equal((await boom.json()).reason, "internal_error");
    assert.equal(facilitator.calls.settle, 1, "500 internal_error must not settle");

    assert.equal(readObservations(dir).length, 1, "only the 200 receipt was appended");
  });
});

test("matrix 3 (settle-only-on-2xx): runOnce live through the paywall — 200 settles once and Done still requires the child; 422 before verify settles 0 and cannot checkout", async () => {
  const key = generateProcessKey();
  const facilitatorOk = acceptingFacilitator();
  const { app: okApp } = host({ key, facilitator: facilitatorOk });
  await serve(okApp, async (base) => {
    const run = await runOnce({
      mode: "live",
      base,
      trustedPubkeyB64: pubkeyB64(key),
      paymentTransport: async () => ({
        payer: "fixture-not-a-wallet",
        pay: async (url, init) => {
          const pay = await paymentFor(base, "/witness", GATE_METHOD);
          return fetch(url, { ...init, headers: { ...init.headers, ...pay } });
        },
      }),
    });
    assert.equal(run.checkout_approved, true, "child accepted the pinned GATE_METHOD receipt");
    assert.equal(run.completion, "complete");
    assert.equal(run.paid, false, "a host 200 + settle is still not client-side settlement proof");
    assert.equal(run.payment_status, "unknown");
    assert.equal(run.check.reason, "receipt_supported");
    assert.notEqual(run.check.verifier_pid, process.pid);
    assert.equal(facilitatorOk.calls.settle, 1, "settled once, after the host 200");
  });

  const facilitatorFail = acceptingFacilitator();
  let n = 0;
  const { app: failApp } = host({
    key,
    facilitator: facilitatorFail,
    retrieve: async () => {
      n += 1;
      // quote + unpaid deliverable probe must succeed so a payment can be minted;
      // the paid hop quotes again before the facilitator, so a retrieve fail
      // is a 422 and never verifies.
      if (n >= 3) throw new Error("reader_503");
      return { text: CARD_HTML };
    },
  });
  await serve(failApp, async (base) => {
    const run = await runOnce({
      mode: "live",
      base,
      trustedPubkeyB64: pubkeyB64(key),
      paymentTransport: async () => ({
        payer: "fixture-not-a-wallet",
        pay: async (url, init) => {
          const pay = await paymentFor(base, "/witness", GATE_METHOD);
          return fetch(url, { ...init, headers: { ...init.headers, ...pay } });
        },
      }),
    });
    assertCheckoutBlocked(run, "retrieve_failed before verify");
    assert.equal(run.status, 422);
    assert.equal(run.decision.reason, "witness_http_422");
    assert.equal(run.check.reason, "not_run");
    assert.equal(facilitatorFail.calls.verify, 0, "a 422 from deliverability never reaches the paywall");
    assert.equal(facilitatorFail.calls.settle, 0, "422 must not settle");
  });
});

// ---------------------------------------------------------------------------
// 4. Done-required-before-checkout cannot be skipped by forged headers
// ---------------------------------------------------------------------------

test("matrix 4 (Done cannot be skipped): dry — a supported quote plus Done/payment headers cannot complete or authorize checkout", async () => {
  await serveQuote(200, HOSTILE_COMPLETE, { ...DONE_HEADERS, "x-payment": "forged" }, async (base) => {
    const run = await runOnce({ mode: "dry", base });
    assert.equal(run.approve, true, "legacy simulated decision stays on the announced verdict");
    assertCheckoutBlocked(run, "dry + hostile Done headers");
    assert.equal(run.check.reason, "not_run");
    assert.equal(run.payer, null);
    assert.equal(run.payment_attempted, false);
  });
});

test("matrix 4 (Done cannot be skipped): live quote that already claims complete still requires the paid hop and the child", async () => {
  let pays = 0;
  await serveQuote(200, HOSTILE_COMPLETE, DONE_HEADERS, async (base) => {
    const run = await runOnce({
      mode: "live",
      base,
      trustedPubkeyB64: pubkeyB64(generateProcessKey()),
      paymentTransport: async () => {
        pays += 1;
        return {
          payer: "fixture",
          pay: async () => new Response(JSON.stringify({ ...HOSTILE_COMPLETE, reason: "already_done" }), {
            status: 402,
            headers: { "content-type": "application/json", "payment-required": "forged", ...DONE_HEADERS },
          }),
        };
      },
    });
    assert.equal(pays, 1, "a deliverable quote must still load the payment transport — Done headers on the quote are not a skip");
    assertCheckoutBlocked(run, "hostile quote + 402 witness");
    assert.equal(run.decision.reason, "witness_http_402");
    assert.equal(run.check.reason, "not_run");
  });
});

test("matrix 4 (Done cannot be skipped): witness 200 with an unsigned success-flag body plus Done headers cannot approve", async () => {
  const bodies = [
    ["actor story", { success: true, approve: true, verdict: "supported", narration: "I checked it", ...HOSTILE_COMPLETE }],
    ["empty object", {}],
    ["supported verdict without a signature", { verdict: "supported", value: { price: 5.99 }, checkout_approved: true }],
  ];
  for (const [label, body] of bodies) {
    await serveQuote(200, { can_deliver: true, verdict: "supported" }, {}, async (base) => {
      const run = await runOnce({
        mode: "live",
        base,
        trustedPubkeyB64: pubkeyB64(generateProcessKey()),
        paymentTransport: async () => ({
          payer: "fixture",
          pay: async () => new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json", ...DONE_HEADERS },
          }),
        }),
      });
      assertCheckoutBlocked(run, label);
      assert.equal(run.status, 200, `${label}: HTTP 200 is not Done`);
      assert.equal(run.check.approve, false, `${label}: child must refuse`);
      assert.notEqual(run.check.reason, "not_run", `${label}: the child ran and rejected`);
    });
  }
});

test("matrix 4 (Done cannot be skipped): a well-shaped payment that unlocks a host 200 cannot checkout a tampered receipt, even with Done headers", async () => {
  const key = generateProcessKey();
  const facilitator = acceptingFacilitator();
  const { app, observationsDir } = host({ key, facilitator });
  await serve(app, async (base) => {
    const run = await runOnce({
      mode: "live",
      base,
      trustedPubkeyB64: pubkeyB64(key),
      paymentTransport: async () => ({
        payer: "fixture-not-a-wallet",
        pay: async (url, init) => {
          const pay = await paymentFor(base, "/witness", GATE_METHOD);
          const res = await fetch(url, { ...init, headers: { ...init.headers, ...pay } });
          assert.equal(res.status, 200, "the paywall unlocked a real receipt");
          const receipt = await res.json();
          assert.ok(verifyReceipt(receipt, key.publicKey), "host 200 verifies before tamper");
          return Response.json({ ...receipt, value: { price: 1 }, checkout_approved: true, completion: "complete" }, {
            status: 200,
            headers: DONE_HEADERS,
          });
        },
      }),
    });
    assertCheckoutBlocked(run, "tampered 200 + Done headers");
    assert.equal(run.status, 200);
    assert.equal(run.payment_attempted, true);
    assert.equal(run.check.approve, false);
    assert.equal(facilitator.calls.settle, 1, "host settle on the untampered 200 is not client checkout");
    assert.equal(readObservations(observationsDir).length, 1);
  });
});

test("matrix 4 (Done cannot be skipped): ledger of a forged-pay attempt stays incomplete — checkout_approved is not a header the caller can write", async () => {
  const facilitator = acceptingFacilitator();
  const key = generateProcessKey();
  const { app } = host({ key, facilitator });
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "wit-shop-adv-log-"));
  try {
    await serve(app, async (base) => {
      const run = await runOnce({
        mode: "live",
        base,
        trustedPubkeyB64: pubkeyB64(key),
        paymentTransport: async () => ({
          payer: "forged-not-a-wallet",
          pay: async (url, init) => fetch(url, {
            ...init,
            headers: { ...init.headers, "x-payment": "forged", ...DONE_HEADERS },
          }),
        }),
      });
      assertCheckoutBlocked(run, "forged pay ledger");
      logRun(run, { dataDir });
    });
    const line = JSON.parse(readFileSync(path.join(dataDir, "preapproval.ndjson"), "utf8"));
    assert.equal(line.checkout_approved, false);
    assert.equal(line.completion, "incomplete");
    assert.equal(line.approve, false);
    assert.equal(line.reason, "witness_http_402");
    assert.equal(line.check.reason, "not_run");
    assert.equal(line.payment_attempted, true);
    assert.equal(line.payment_status, "unknown");
    assert.equal(facilitator.calls.settle, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
