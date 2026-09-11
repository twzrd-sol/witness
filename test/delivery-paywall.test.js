/**
 * The bound in front of the key on POST /delivery/attest.
 *
 * Before this, the route was a free, unlimited signing oracle the moment it was
 * deployed on a public host. Now: parse -> shape -> per-IP limiter -> paywall ->
 * model. These tests pin the ORDER as much as the pieces, because the order is
 * what makes each refusal mean one thing: a 400 is "we could not read it" and
 * costs nothing, a 429 is "you reached the key too often", a 402 is "pay the
 * /witness price", and only after all three is anything graded or signed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/server.js";
import { createHostApp } from "../src/listen.js";
import { openapiDoc } from "../src/openapi.js";
import { generateProcessKey } from "../src/receipt.js";
import { EXAMPLE_BODY } from "../src/routes/delivery.js";

const PAYWALL = { evmAddress: "0xabc0000000000000000000000000000000000001", svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" };
const BASE_URL = "https://witness.example.net";

/** Answers the capability handshake; refuses every payment. A forged header must never verify. */
const refusingFacilitator = {
  async getSupported() {
    return { kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
    ] };
  },
  async verify() { return { isValid: false, invalidReason: "fixture refuses every payment" }; },
  async settle() { throw new Error("settle must not be reached in these tests"); },
};

/** The model, counting calls: the assertion in every refusal test is that it stays at zero. */
function countingAttest() {
  const calls = [];
  const attest = async (input) => {
    calls.push(input);
    return {
      schema: "delivery-attestation/v0", offer_hash: "o".repeat(64), request_hash: "r".repeat(64), artifact_hash: "a".repeat(64),
      delivery_verdict: "delivered", reasons: [], evidence_mode: input.observation.mode, declared_mode: input.observation.mode,
      this_receipt_proves: ["fixture"], this_receipt_does_not_prove: ["fixture"],
    };
  };
  return { attest, calls };
}

async function serve(app, fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const paywalled = (attest) =>
  createApp({ key: generateProcessKey(), observationsDir: mkdtempSync(path.join(os.tmpdir(), "wit-attest-pay-")), funnelDir: null, facilitator: refusingFacilitator, paywall: PAYWALL, publicBaseUrl: BASE_URL, attest });

const post = (base, body, headers = {}) =>
  fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** The challenge travels in the header (base64 or plain JSON); the body may be {} or the decoded copy. */
function challengeOf(res) {
  const raw = res.headers.get("payment-required");
  assert.ok(raw, "402 without a PAYMENT-REQUIRED header is not an x402 challenge");
  try { return JSON.parse(raw); } catch { /* base64 */ }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

test("paywall wired: a well-formed unpaid request gets the x402 challenge for THIS route, both rails, and the model is never called", async () => {
  const fake = countingAttest();
  await serve(paywalled(fake.attest), async (base) => {
    const res = await post(base, structuredClone(EXAMPLE_BODY));
    assert.equal(res.status, 402);
    const challenge = challengeOf(res);
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource?.url, `${BASE_URL}/delivery/attest`, "the challenge names the attest resource, not /witness");
    assert.deepEqual(challenge.accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    for (const a of challenge.accepts) {
      assert.equal(a.amount, "10000", "the /witness price: 0.01 USDC in atomic units");
      assert.ok(a.payTo, "every rail names its payee");
    }
    const body = await res.json();
    assert.equal(body.receipt, undefined, "nothing was signed");
    assert.equal(fake.calls.length, 0, "the model never ran for an unpaid request");
  });
});

test("paywall wired: a 400 never sees a 402 — unreadable and off-shape requests are refused before the paywall, unbilled", async () => {
  const fake = countingAttest();
  await serve(paywalled(fake.attest), async (base) => {
    const cases = [
      ["bad_json", () => post(base, "{not json")],
      ["bad_json", () => fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })],
      ["bad_body", () => post(base, [1, 2])],
      ["bad_offer", () => post(base, { ...structuredClone(EXAMPLE_BODY), offer: { resource_url: "" } })],
      ["bad_paid_request", () => post(base, { ...structuredClone(EXAMPLE_BODY), request: {} })],
      ["bad_observation", () => post(base, { ...structuredClone(EXAMPLE_BODY), observation: { mode: "buyer_attested" } })],
      ["bad_mode", () => post(base, { ...structuredClone(EXAMPLE_BODY), observation: { ...EXAMPLE_BODY.observation, mode: "wishful" } })],
    ];
    for (const [reason, send] of cases) {
      const res = await send();
      assert.equal(res.status, 400, reason);
      assert.equal(res.headers.get("payment-required"), null, `${reason}: a shape refusal carried a payment challenge`);
      const json = await res.json();
      assert.equal(json.reason, reason);
      assert.ok(Array.isArray(json.details.problems));
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("paywall wired: a forged payment header is refused before the key — not 200, not 500, model never called", async () => {
  const fake = countingAttest();
  await serve(paywalled(fake.attest), async (base) => {
    for (const headers of [{ "payment-signature": "forged" }, { "x-payment": "forged" }, { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: {} })).toString("base64") }]) {
      const res = await post(base, structuredClone(EXAMPLE_BODY), headers);
      assert.notEqual(res.status, 200, `${JSON.stringify(headers)} minted a receipt`);
      assert.ok(res.status < 500, `${JSON.stringify(headers)} was a server error (${res.status}); a bad payment is the client's problem, not ours`);
      const json = await res.json().catch(() => ({}));
      assert.equal(json.receipt, undefined, "nothing was signed");
    }
    assert.equal(fake.calls.length, 0, "the model never ran behind a forged payment");
  });
});

test("no paywall: attestation is per-IP limited after the shape check — 429 in the envelope, shape errors never spend a slot, the model is not called when limited", async () => {
  const fake = countingAttest();
  const app = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-attest-limit-")), ATTEST_RATE_LIMIT_PER_MINUTE: "1" }, { attest: fake.attest });
  await serve(app, async (base) => {
    const first = await post(base, structuredClone(EXAMPLE_BODY));
    assert.equal(first.status, 200);
    assert.equal(typeof (await first.json()).receipt, "string");

    const second = await post(base, structuredClone(EXAMPLE_BODY));
    assert.equal(second.status, 429);
    const json = await second.json();
    assert.equal(json.reason, "attest_rate_limited");
    assert.ok(Array.isArray(json.details.problems) && json.details.problems.length, "the refusal explains itself");
    assert.equal(typeof json.verifier, "string");
    assert.match(json.served_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(json.receipt, undefined, "nothing was signed");
    assert.equal(fake.calls.length, 1, "the limited request never reached the model");

    // Still limited, but a request we cannot read is answered as such: the shape
    // check runs first, so debugging a body never burns the budget.
    const bad = await post(base, { ...structuredClone(EXAMPLE_BODY), offer: {} });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).reason, "bad_offer");
  });
});

test("the attest limiter and the /quote limiter are separate budgets, and the default is 30 per minute", async () => {
  const fake = countingAttest();
  const app = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-attest-budget-")), QUOTE_RATE_LIMIT_PER_MINUTE: "1" }, { attest: fake.attest });
  await serve(app, async (base) => {
    const quote = (body) => fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await quote({})).status, 400, "first quote: shape error, slot consumed");
    assert.equal((await quote({})).status, 429, "second quote: the quote budget is spent");
    // The attest budget is untouched by the quote burst, and it is 30 wide by default.
    for (let i = 0; i < 30; i++) assert.equal((await post(base, structuredClone(EXAMPLE_BODY))).status, 200, `attest #${i + 1}`);
    const over = await post(base, structuredClone(EXAMPLE_BODY));
    assert.equal(over.status, 429);
    assert.equal((await over.json()).reason, "attest_rate_limited");
    assert.equal(fake.calls.length, 30);
  });
});

test("an invalid ATTEST_RATE_LIMIT_PER_MINUTE falls back to the default rather than disabling the bound", async () => {
  const fake = countingAttest();
  for (const bad of ["0", "-5", "lots", ""]) {
    const app = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-attest-env-")), ATTEST_RATE_LIMIT_PER_MINUTE: bad }, { attest: fake.attest });
    await serve(app, async (base) => {
      for (let i = 0; i < 30; i++) assert.equal((await post(base, structuredClone(EXAMPLE_BODY))).status, 200, `${JSON.stringify(bad)} attest #${i + 1}`);
      assert.equal((await post(base, structuredClone(EXAMPLE_BODY))).status, 429, `${JSON.stringify(bad)} left the route unbounded`);
    });
  }
});

test("behind the tunnel every socket is loopback: forwarded client addresses get their own budgets, and no header keeps the socket's", async () => {
  const fake = countingAttest();
  const app = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-attest-xff-")), ATTEST_RATE_LIMIT_PER_MINUTE: "1" }, { attest: fake.attest });
  await serve(app, async (base) => {
    const from = (ip) => post(base, structuredClone(EXAMPLE_BODY), { "x-forwarded-for": ip });
    assert.equal((await from("203.0.113.1")).status, 200);
    assert.equal((await from("203.0.113.1")).status, 429, "the same client is over its budget");
    assert.equal((await from("203.0.113.2")).status, 200, "a different client has its own budget");
    // A client-supplied chain: the tunnel appends the real address last, so that is the one counted.
    assert.equal((await from("203.0.113.1, 203.0.113.3")).status, 200, "the rightmost (tunnel-appended) address is the client, not the spoofable leftmost");
    assert.equal((await post(base, structuredClone(EXAMPLE_BODY))).status, 200, "no forwarded header: the socket address is its own bucket");
    assert.equal((await post(base, structuredClone(EXAMPLE_BODY))).status, 429);
    assert.equal(fake.calls.length, 4);
  });
});

test("openapi: /delivery/attest is documented paid at the /witness price with both rails when the env names them, and the 402 names the attest resource", () => {
  const doc = openapiDoc({ EVM_ADDRESS: PAYWALL.evmAddress, SVM_ADDRESS: PAYWALL.svmAddress, PUBLIC_BASE_URL: BASE_URL });
  const op = doc.paths["/delivery/attest"].post;
  assert.deepEqual(op.security, [{ x402: [] }]);
  assert.equal(op["x-payment"].price_usdc, "0.01");
  assert.deepEqual(op["x-payment"].accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(op["x-payment"].accepts.every((a) => a.payTo));
  assert.deepEqual(op["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.010000" });
  const challenge = op.responses["402"].content["application/json"].schema.properties;
  assert.equal(challenge.resource.properties.url.const, `${BASE_URL}/delivery/attest`);
  assert.equal(doc.paths["/witness"].post.responses["402"].content["application/json"].schema.properties.resource.properties.url.const, `${BASE_URL}/witness`, "/witness still names its own resource");
  assert.match(op.description, /refused 400 before it sees a 402/i);
  assert.match(op.description, /ATTEST_RATE_LIMIT_PER_MINUTE/);
  assert.doesNotMatch(op.description, /free and unauthenticated/i, "the old claim is gone");
});
