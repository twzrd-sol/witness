/**
 * Adversarial suite for the witness HTTP host after #34 (attest route bound + paywall).
 *
 * Matrix — every item is a named `test()` below; every assertion is concrete:
 *  1. Shape/400 never 402 — malformed bodies, wrong content-type, missing required
 *     fields are a documented client error (400, or 422 where the spec already
 *     names one). They never carry a PAYMENT-REQUIRED challenge.
 *  2. Forged payment headers — invented or malformed `X-PAYMENT` /
 *     `PAYMENT-SIGNATURE` must not unlock a paid route. Refuse or 402 as
 *     designed; never 200, never settle.
 *  3. Per-IP vs forwarded-IP buckets — limiter keys are Express `req.ip` after
 *     `trust proxy = "loopback"` (the only hop the host trusts). Documented:
 *       - The process binds loopback; only the tunnel reaches it.
 *       - `X-Forwarded-For`: the rightmost untrusted hop is the client (the
 *         tunnel appends the real address last). A client-supplied left hop
 *         cannot pick its own bucket.
 *       - `X-Real-IP` is not consulted.
 *       - RFC 7239 `Forwarded` is not consulted.
 *       - A process on this box can forge `X-Forwarded-For` over loopback —
 *         the same trust the socket already carries. Off-box callers never
 *         reach the bind, so they cannot.
 *  4. Settle-only-on-2xx — the x402 middleware verifies, then runs the handler,
 *     then settles only when the handler answered 2xx. 4xx/5xx cancel; the
 *     facilitator `settle` call must not run.
 *
 * No live reader. No live facilitator. Injected `retrieve` + facilitator stubs.
 * Run this file: `node --test test/host-adversarial.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
import { readObservations } from "../src/observatory.js";
import { EXAMPLE_BODY } from "../src/routes/delivery.js";

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

const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];

/** Answers the capability handshake; refuses every payment. Settle must never run. */
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

function countingAttest() {
  const calls = [];
  const attest = async (input) => {
    calls.push(input);
    return {
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
    };
  };
  return { attest, calls };
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
  const observationsDir = extra.observationsDir ?? mkdtempSync(path.join(os.tmpdir(), "wit-adv-"));
  return createApp({
    key: extra.key ?? generateProcessKey(),
    retrieve: extra.retrieve ?? (async () => ({ text: FIXTURE })),
    observationsDir,
    funnelDir: null,
    facilitator: extra.facilitator ?? refusingFacilitator,
    paywall: extra.paywall === undefined ? PAYWALL : extra.paywall,
    publicBaseUrl: BASE_URL,
    quoteRateLimit: extra.quoteRateLimit,
    quoteGlobalRateLimit: extra.quoteGlobalRateLimit,
    attestRateLimit: extra.attestRateLimit,
    attest: extra.attest,
  });
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

// ---------------------------------------------------------------------------
// 1. Shape / 400 never 402
// ---------------------------------------------------------------------------

test("matrix 1 (shape/400 never 402): POST /witness unpaid — malformed bodies, wrong content-type, and missing required fields are client errors with no PAYMENT-REQUIRED", async () => {
  let retrieves = 0;
  const app = host({ retrieve: async () => { retrieves += 1; return { text: FIXTURE }; } });
  await serve(app, async (base) => {
    const cases = [
      ["malformed JSON", 400, "bad_json", () => post(base, "/witness", "{not json")],
      ["text/plain", 400, "bad_json", () => fetch(`${base}/witness`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })],
      ["form-urlencoded", 400, "bad_json", () => fetch(`${base}/witness`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "url=https://example.com" })],
      ["no content-type", 400, "bad_json", () => fetch(`${base}/witness`, { method: "POST", body: JSON.stringify(WITNESS_BODY) })],
      ["JSON null", 400, "bad_json", () => post(base, "/witness", "null")],
      ["empty object", 400, "bad_extract", () => post(base, "/witness", {})],
      ["missing extract", 400, "bad_extract", () => post(base, "/witness", { url: WITNESS_BODY.url })],
      ["array body", 400, "bad_extract", () => post(base, "/witness", [1, 2])],
      ["bad assertion type", 400, "bad_assertion", () => post(base, "/witness", { ...WITNESS_BODY, assertion: 7 })],
      ["assertion over max length", 400, "bad_assertion", () => post(base, "/witness", { ...WITNESS_BODY, assertion: "x".repeat(513) })],
      ["missing url", 422, "invalid_url", () => post(base, "/witness", { extract: WITNESS_BODY.extract })],
      ["replicas unsupported", 422, "replicas_unsupported", () => post(base, "/witness", { ...WITNESS_BODY, replicas: 3 })],
      ["http url (SSRF)", 422, "https_only", () => post(base, "/witness", { ...WITNESS_BODY, url: "http://127.0.0.1/" })],
    ];
    for (const [label, status, reason, send] of cases) {
      const res = await send();
      assert.equal(res.status, status, `${label}: status`);
      assertNoChallenge(res, label);
      const json = await res.json();
      assert.equal(json.reason, reason, `${label}: reason`);
      assert.equal(json.receipt, undefined, `${label}: must not mint a receipt`);
    }
    // A well-formed unpaid body still 402s — the paywall is wired; the cases above must not have reached it.
    const ok = await post(base, "/witness", WITNESS_BODY);
    assert.equal(ok.status, 402);
    assert.equal(challengeOf(ok).resource?.url, `${BASE_URL}/witness`);
  });
  assert.equal(retrieves, 1, "shape/SSRF/replicas refusals must not retrieve; only the final deliverable unpaid POST does");
});

test("matrix 1 (shape/400 never 402): POST /quote never answers 402 — not for a shape error, not for a documented 422, not when a payment header is attached", async () => {
  const app = host();
  await serve(app, async (base) => {
    const cases = [
      ["malformed JSON", 400, "bad_json", { "content-type": "application/json" }, "{not json"],
      ["missing extract", 400, "bad_extract", { "content-type": "application/json" }, JSON.stringify({ url: WITNESS_BODY.url })],
      ["SSRF", 422, "https_only", { "content-type": "application/json" }, JSON.stringify({ ...WITNESS_BODY, url: "http://127.0.0.1/" })],
      ["forged x-payment on a shape error", 400, "bad_extract", { "content-type": "application/json", "x-payment": "forged" }, "{}"],
      ["forged payment-signature on a shape error", 400, "bad_extract", { "content-type": "application/json", "payment-signature": "forged" }, "{}"],
    ];
    for (const [label, status, reason, headers, body] of cases) {
      const res = await fetch(`${base}/quote`, { method: "POST", headers, body });
      assert.equal(res.status, status, label);
      assertNoChallenge(res, label);
      assert.equal((await res.json()).reason, reason, label);
    }
    const deliverable = await post(base, "/quote", WITNESS_BODY);
    assert.equal(deliverable.status, 200);
    assertNoChallenge(deliverable, "deliverable quote");
    assert.equal((await deliverable.json()).can_deliver, true);
  });
});

test("matrix 1 (shape/400 never 402): POST /delivery/attest — off-shape and unreadable bodies stay 400 with no challenge, even when a payment header is attached", async () => {
  const fake = countingAttest();
  const facilitator = acceptingFacilitator();
  await serve(host({ attest: fake.attest, facilitator }), async (base) => {
    const cases = [
      ["bad_json unparseable", "bad_json", () => post(base, "/delivery/attest", "{not json")],
      ["bad_json text/plain", "bad_json", () => fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })],
      ["bad_json xml", "bad_json", () => fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "application/xml" }, body: "<x/>" })],
      ["bad_json no content-type", "bad_json", () => fetch(`${base}/delivery/attest`, { method: "POST", body: JSON.stringify(EXAMPLE_BODY) })],
      ["bad_body array", "bad_body", () => post(base, "/delivery/attest", [1, 2])],
      ["bad_offer empty object", "bad_offer", () => post(base, "/delivery/attest", {})],
      ["bad_offer incomplete", "bad_offer", () => post(base, "/delivery/attest", { ...structuredClone(EXAMPLE_BODY), offer: { resource_url: "" } })],
      ["bad_paid_request", "bad_paid_request", () => post(base, "/delivery/attest", { ...structuredClone(EXAMPLE_BODY), request: {} })],
      ["bad_observation", "bad_observation", () => post(base, "/delivery/attest", { ...structuredClone(EXAMPLE_BODY), observation: { mode: "buyer_attested" } })],
      ["bad_mode", "bad_mode", () => post(base, "/delivery/attest", { ...structuredClone(EXAMPLE_BODY), observation: { ...EXAMPLE_BODY.observation, mode: "wishful" } })],
      ["payment header + bad_offer still shape-first", "bad_offer", () => post(base, "/delivery/attest", { ...structuredClone(EXAMPLE_BODY), offer: {} }, { "payment-signature": "forged" })],
      ["x-payment + missing request still shape-first", "bad_paid_request", () => post(base, "/delivery/attest", { offer: EXAMPLE_BODY.offer, observation: EXAMPLE_BODY.observation }, { "x-payment": "forged" })],
    ];
    for (const [label, reason, send] of cases) {
      const res = await send();
      assert.equal(res.status, 400, label);
      assertNoChallenge(res, label);
      const json = await res.json();
      assert.equal(json.reason, reason, label);
      assert.equal(json.receipt, undefined, label);
      assert.ok(Array.isArray(json.details.problems), `${label}: envelope details.problems`);
    }
    assert.equal(fake.calls.length, 0, "the model never ran for a shape refusal");
    assert.equal(facilitator.calls.verify, 0, "the facilitator never verified a shape refusal");
    assert.equal(facilitator.calls.settle, 0, "nothing settled for a shape refusal");
  });
});

// ---------------------------------------------------------------------------
// 2. Forged payment headers
// ---------------------------------------------------------------------------

test("matrix 2 (forged payment headers): POST /witness — invented and malformed X-PAYMENT / PAYMENT-SIGNATURE never mint a receipt or settle", async () => {
  const facilitator = acceptingFacilitator();
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-adv-"));
  await serve(host({ key, facilitator, observationsDir: dir }), async (base) => {
    const headers = [
      { "x-payment": "forged" },
      { "payment-signature": "forged" },
      { "X-PAYMENT": "forged" },
      { "PAYMENT-SIGNATURE": "forged" },
      { "x-payment": "null" },
      { "x-payment": "0" },
      { "payment-signature": "e30=" }, // {}
      { "payment-signature": Buffer.from("not-json").toString("base64") },
      { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: {} })).toString("base64") },
      { "x-payment": Buffer.from(JSON.stringify({ x402Version: 1, payload: {} })).toString("base64") },
    ];
    for (const h of headers) {
      const res = await post(base, "/witness", WITNESS_BODY, h);
      const label = JSON.stringify(h);
      assert.notEqual(res.status, 200, `${label} minted a receipt`);
      assert.ok(res.status < 500, `${label} was a server error (${res.status}); a bad payment is the client's problem`);
      assert.equal(res.status, 402, `${label}: refuse or 402 as designed, got ${res.status}`);
      const json = await res.json().catch(() => ({}));
      assert.equal(json.receipt, undefined, `${label}: receipt field`);
    }
    // An unrelated response header name is not a proof. The request is unpaid and 402s.
    const unrelated = await post(base, "/witness", WITNESS_BODY, { "payment-response": "forged" });
    assert.equal(unrelated.status, 402, "PAYMENT-RESPONSE is not a proof header and must not unlock");
    assert.equal((await unrelated.json()).receipt, undefined);

    // Empty proof headers are not payments: deliverable probe runs, then the unpaid challenge.
    const empty = await post(base, "/witness", WITNESS_BODY, { "x-payment": "", "payment-signature": "" });
    assert.equal(empty.status, 402);
    assert.equal((await empty.json()).receipt, undefined);

    assert.equal(facilitator.calls.settle, 0, "a forged header must never settle");
    assert.equal(readObservations(dir).length, 0, "nothing appended");
  });
});

test("matrix 2 (forged payment headers): GET /witness with a payment header is 405 discovery-only — no retrieve, no verify, no settle", async () => {
  let retrieves = 0;
  const facilitator = acceptingFacilitator();
  await serve(host({ facilitator, retrieve: async () => { retrieves += 1; return { text: FIXTURE }; } }), async (base) => {
    for (const headers of [{ "x-payment": "forged" }, { "payment-signature": "forged" }, await paymentFor(base, "/witness", WITNESS_BODY)]) {
      const res = await fetch(`${base}/witness`, { headers });
      assert.equal(res.status, 405, JSON.stringify(headers));
      assertNoChallenge(res, `GET ${JSON.stringify(headers)}`);
      assert.equal((await res.json()).reason, "get_discovery_only_use_post");
    }
    assert.equal(retrieves, 1, "only the unpaid POST used to mint a payment-shaped header retrieved; GET never does");
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0);
  });
});

test("matrix 2 (forged payment headers): POST /delivery/attest — a forged or well-shaped-but-refused payment never reaches the model or settle", async () => {
  const fake = countingAttest();
  await serve(host({ attest: fake.attest, facilitator: refusingFacilitator }), async (base) => {
    const headers = [
      { "payment-signature": "forged" },
      { "x-payment": "forged" },
      { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact", network: "eip155:8453", payload: {} })).toString("base64") },
    ];
    for (const h of headers) {
      const res = await post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), h);
      const label = JSON.stringify(h);
      assert.notEqual(res.status, 200, `${label} minted a receipt`);
      assert.ok(res.status < 500, `${label} was a server error (${res.status})`);
      assert.equal((await res.json().catch(() => ({}))).receipt, undefined, label);
    }
    assert.equal(fake.calls.length, 0, "the model never ran behind a forged payment");
  });
});

// ---------------------------------------------------------------------------
// 3. Per-IP vs forwarded-IP buckets
// ---------------------------------------------------------------------------

test("matrix 3 (per-IP vs forwarded-IP): trust proxy is loopback — X-Forwarded-For rightmost hop is the bucket; X-Real-IP and Forwarded do not mint a fresh one", async () => {
  const fake = countingAttest();
  // /quote spends a slot on a shape error (limiter runs before handleQuote).
  // /delivery/attest without a paywall spends a slot only after the shape check.
  await serve(host({
    paywall: {},
    quoteRateLimit: 1,
    attestRateLimit: 1,
    attest: fake.attest,
  }), async (base) => {
    const quote = (headers = {}) => post(base, "/quote", {}, headers);
    const attest = (headers = {}) => post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), headers);

    const qSocket = await quote();
    assert.equal(qSocket.status, 400, "no forwarded header: the socket address (127.0.0.1) is the bucket");
    assert.equal((await qSocket.json()).reason, "bad_extract");

    const qReal = await quote({ "x-real-ip": "198.51.100.1" });
    assert.equal(qReal.status, 429, "X-Real-IP is not a trusted identity header; it must not mint a fresh /quote bucket");
    assert.equal((await qReal.json()).reason, "quote_rate_limited");

    const qFwd = await quote({ forwarded: "for=198.51.100.2" });
    assert.equal(qFwd.status, 429, "RFC 7239 Forwarded is not consulted; it must not mint a fresh /quote bucket");
    assert.equal((await qFwd.json()).reason, "quote_rate_limited");

    const qXff = await quote({ "x-forwarded-for": "203.0.113.9" });
    assert.equal(qXff.status, 400, "X-Forwarded-For from loopback is the intended client identity (tunnel-appended hop)");
    assert.equal((await qXff.json()).reason, "bad_extract");

    const qBoth = await quote({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.11" });
    assert.equal(qBoth.status, 400, "when both are sent, X-Forwarded-For wins; X-Real-IP still does not");

    const aSocket = await attest();
    assert.equal(aSocket.status, 200, "attest socket bucket");
    const aReal = await attest({ "x-real-ip": "198.51.100.1" });
    assert.equal(aReal.status, 429, "X-Real-IP must not mint a fresh attest bucket");
    assert.equal((await aReal.json()).reason, "attest_rate_limited");
    const aXff = await attest({ "x-forwarded-for": "203.0.113.9" });
    assert.equal(aXff.status, 200, "a distinct X-Forwarded-For hop has its own attest budget");
    assert.equal(fake.calls.length, 2);
  });
});

test("matrix 3 (per-IP vs forwarded-IP): a spoofed leftmost X-Forwarded-For hop cannot spend or steal another client's /quote or /delivery/attest budget", async () => {
  const fake = countingAttest();
  await serve(host({
    paywall: {},
    quoteRateLimit: 1,
    attestRateLimit: 1,
    attest: fake.attest,
  }), async (base) => {
    const quote = (xff) => post(base, "/quote", {}, { "x-forwarded-for": xff });
    const attest = (xff) => post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), { "x-forwarded-for": xff });

    assert.equal((await quote("203.0.113.1")).status, 400, "victim spends their /quote slot");
    assert.equal((await quote("198.51.100.7, 203.0.113.1")).status, 429, "rightmost hop is the victim — a spoofed left hop cannot reset that bucket");
    assert.equal((await quote("203.0.113.1, 198.51.100.7")).status, 400, "rightmost hop is a different client — that is a new bucket, not a steal of the victim's remaining budget");

    assert.equal((await attest("203.0.113.1")).status, 200, "victim spends their attest slot");
    assert.equal((await attest("198.51.100.7, 203.0.113.1")).status, 429, "rightmost hop is the victim — leftmost spoof does not escape the attest limiter");
    assert.equal((await attest("203.0.113.1, 198.51.100.7")).status, 200, "rightmost hop is a different client");
    assert.equal((await attest("203.0.113.1:9, 203.0.113.1")).status, 429, "a port decoration on the leftmost hop still cannot pick the bucket — rightmost identity wins");
  });
});

test("matrix 3 (per-IP vs forwarded-IP): IPv6 X-Forwarded-For addresses are distinct buckets; a flood of fresh identities still hits the global /quote cap", async () => {
  await serve(host({
    paywall: {},
    quoteRateLimit: 1,
    quoteGlobalRateLimit: 2,
  }), async (base) => {
    const quote = (xff) => post(base, "/quote", {}, { "x-forwarded-for": xff });
    assert.equal((await quote("2001:db8::1")).status, 400, "first IPv6 client spends its per-client slot and one global slot");
    const same = await quote("2001:db8::1");
    assert.equal(same.status, 429, "the same IPv6 client is over its per-client budget");
    assert.equal((await same.json()).reason, "quote_rate_limited");

    assert.equal((await quote("2001:db8::2")).status, 400, "a different IPv6 address is a different per-client bucket (global slot 2)");
    const third = await quote("2001:db8::3");
    assert.equal(third.status, 429, "the global /quote cap (2) refuses a third distinct identity — minting X-Forwarded-For addresses cannot unbounded-spend the reader");
    assert.equal((await third.json()).reason, "quote_rate_limited");
  });
});

// ---------------------------------------------------------------------------
// 4. Settle only on 2xx
// ---------------------------------------------------------------------------

test("matrix 4 (settle-only-on-2xx): POST /witness — a verified payment settles once on 200 and never on 400/422/500", async () => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-adv-"));
  const facilitator = acceptingFacilitator();
  let retrieveMode = "ok";
  const app = host({
    key,
    facilitator,
    observationsDir: dir,
    retrieve: async () => {
      if (retrieveMode === "fail") throw new Error("reader_503");
      if (retrieveMode === "boom") return { text: 42 };
      return { text: FIXTURE };
    },
  });
  await serve(app, async (base) => {
    const unpaid = await post(base, "/witness", WITNESS_BODY);
    assert.equal(unpaid.status, 402);
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0, "an unpaid challenge must not settle");

    const pay = await paymentFor(base, "/witness", WITNESS_BODY);
    const ok = await post(base, "/witness", WITNESS_BODY, pay);
    assert.equal(ok.status, 200);
    const receipt = await ok.json();
    assert.equal(typeof receipt.receipt, "string");
    assert.ok(verifyReceipt(receipt, key.publicKey), "the 200 is a real signed receipt");
    assert.equal(facilitator.calls.verify, 1);
    assert.equal(facilitator.calls.settle, 1, "settled once, after the 200");
    assert.equal(readObservations(dir).length, 1);

    const missing = await post(base, "/witness", { url: WITNESS_BODY.url }, pay);
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).reason, "bad_extract");
    assert.equal(facilitator.calls.settle, 1, "400 bad_extract must not settle");

    const none = await post(base, "/witness", { url: WITNESS_BODY.url, extract: { nowhere: "number" }, assertion: "nowhere < 1" }, pay);
    assert.equal(none.status, 422);
    assert.equal((await none.json()).reason, "extract_none");
    assert.equal(facilitator.calls.settle, 1, "422 extract_none must not settle");

    retrieveMode = "fail";
    const failed = await post(base, "/witness", WITNESS_BODY, pay);
    assert.equal(failed.status, 422);
    assert.equal((await failed.json()).reason, "retrieve_failed");
    assert.equal(facilitator.calls.settle, 1, "422 retrieve_failed must not settle");

    retrieveMode = "boom";
    const boom = await post(base, "/witness", WITNESS_BODY, pay);
    assert.equal(boom.status, 500);
    assert.equal((await boom.json()).reason, "internal_error");
    assert.equal(facilitator.calls.settle, 1, "500 internal_error must not settle");

    assert.equal(readObservations(dir).length, 1, "only the 200 receipt was appended");
  });
});

test("matrix 4 (settle-only-on-2xx): POST /delivery/attest — settlement runs only after a signed 200; 400/413/429/500 paths never settle", async () => {
  const facilitator = acceptingFacilitator();
  let attestMode = "ok";
  const fake = countingAttest();
  const attest = async (input) => {
    if (attestMode === "invalid") return { schema: "x", delivery_verdict: "nope" };
    if (attestMode === "throw") throw new Error("model exploded");
    return fake.attest(input);
  };
  await serve(host({ facilitator, attest, attestRateLimit: 1 }), async (base) => {
    const unpaid = await post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY));
    assert.equal(unpaid.status, 402);
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0);

    const pay = await paymentFor(base, "/delivery/attest", EXAMPLE_BODY);
    const ok = await post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), pay);
    assert.equal(ok.status, 200);
    const signed = await ok.json();
    assert.equal(typeof signed.receipt, "string");
    assert.equal(signed.delivery_verdict, "delivered");
    assert.equal(fake.calls.length, 1);
    assert.equal(facilitator.calls.verify, 1);
    assert.equal(facilitator.calls.settle, 1, "settled once, after the 200");

    const over = await post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), pay);
    assert.equal(over.status, 429);
    assert.equal((await over.json()).reason, "attest_rate_limited");
    assert.equal(facilitator.calls.settle, 1, "429 must not settle");
    assert.equal(fake.calls.length, 1, "the limited request never reached the model");

    const shape = await post(base, "/delivery/attest", { ...structuredClone(EXAMPLE_BODY), offer: {} }, pay);
    assert.equal(shape.status, 400);
    assert.equal((await shape.json()).reason, "bad_offer");
    assert.equal(facilitator.calls.verify, 1, "shape runs before the paywall — no extra verify");
    assert.equal(facilitator.calls.settle, 1, "400 must not settle");

    const huge = { ...structuredClone(EXAMPLE_BODY), observation: { ...EXAMPLE_BODY.observation, notes: ["x".repeat(300_000)] } };
    const tooBig = await post(base, "/delivery/attest", huge, pay);
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).reason, "body_too_large");
    assert.equal(facilitator.calls.settle, 1, "413 must not settle");
  });

  // Fresh limiter so a 500 after verify can be shown independently of the 429 above.
  const facilitator2 = acceptingFacilitator();
  let mode2 = "invalid";
  const attest2 = async (input) => {
    if (mode2 === "invalid") return { schema: "x" };
    throw new Error("model exploded");
  };
  await serve(host({ facilitator: facilitator2, attest: attest2 }), async (base) => {
    const pay = await paymentFor(base, "/delivery/attest", EXAMPLE_BODY);
    const invalid = await post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), pay);
    assert.equal(invalid.status, 500);
    assert.equal((await invalid.json()).reason, "attest_invalid");
    assert.equal(facilitator2.calls.verify, 1);
    assert.equal(facilitator2.calls.settle, 0, "500 attest_invalid must not settle");

    mode2 = "throw";
    const boom = await post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), pay);
    assert.equal(boom.status, 500);
    assert.equal((await boom.json()).reason, "attest_failed");
    assert.equal(facilitator2.calls.verify, 2);
    assert.equal(facilitator2.calls.settle, 0, "500 attest_failed must not settle");
  });
});
