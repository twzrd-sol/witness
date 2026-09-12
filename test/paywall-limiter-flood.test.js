/**
 * Wave17 JJJ — paywall limiter under flood (global + per-IP).
 *
 * After #51, POST /witness shares `limitQuoteProbes` with POST /quote: per-client
 * (QUOTE_RATE_LIMIT_PER_MINUTE) AND across all clients
 * (QUOTE_RATE_LIMIT_GLOBAL_PER_MINUTE). Every probe can cost a paid reader call,
 * so a concurrent flood must not overshoot either budget, must not retrieve or
 * talk to the facilitator once the budget is spent, and a 429 must never carry
 * a PAYMENT-REQUIRED challenge.
 *
 * Fixture retrieve + in-process facilitator. Loopback only. No live reader,
 * no live 402, no prod host.
 *
 * Run this file: `node --test test/paywall-limiter-flood.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createApp, perMinuteLimiter } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey } from "../src/receipt.js";
import { EXAMPLE_BODY } from "../src/routes/delivery.js";
import { tempDir } from "./helpers/tmpdir.js";

const PAYWALL = {
  evmAddress: "0xabc0000000000000000000000000000000000001",
  svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
};
const BASE_URL = "https://witness.example.net";
const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const BODY = {
  url: "https://example.com/pricing",
  extract: { starter_price: "number", currency: "string" },
};
const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];

function countingRetrieve({ delayMs = 20 } = {}) {
  let n = 0;
  const retrieve = async () => {
    n += 1;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { text: FIXTURE };
  };
  return { retrieve, count: () => n };
}

function countingFacilitator() {
  const calls = { supported: 0, verify: 0, settle: 0 };
  return {
    calls,
    async getSupported() {
      calls.supported += 1;
      return { kinds: KINDS };
    },
    async verify() {
      calls.verify += 1;
      return { isValid: false, invalidReason: "fixture refuses every payment" };
    },
    async settle() {
      calls.settle += 1;
      throw new Error("settle must not run on a flood-suite fixture");
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

function host({ retrieve, facilitator, attest, ...extra } = {}) {
  return createApp({
    key: generateProcessKey(),
    retrieve: retrieve ?? (async () => ({ text: FIXTURE })),
    observationsDir: extra.observationsDir ?? tempDir("wit-flood-"),
    funnelDir: null,
    facilitator: facilitator ?? countingFacilitator(),
    paywall: extra.paywall === undefined ? PAYWALL : extra.paywall,
    publicBaseUrl: BASE_URL,
    quoteRateLimit: extra.quoteRateLimit,
    quoteGlobalRateLimit: extra.quoteGlobalRateLimit,
    attestRateLimit: extra.attestRateLimit,
    attest,
  });
}

const post = (base, route, body, headers = {}) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function read(res) {
  const response = await res;
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* challenge body may be empty or non-JSON */ }
  return {
    status: response.status,
    json,
    paymentRequired: response.headers.get("payment-required"),
  };
}

async function flood(n, send) {
  return Promise.all(Array.from({ length: n }, async (_, i) => read(await send(i))));
}

function countStatus(rows, status) {
  return rows.filter((r) => r.status === status).length;
}

function assertLimited(row, label) {
  assert.equal(row.status, 429, label);
  assert.equal(row.json?.reason, "quote_rate_limited", `${label}: reason`);
  assert.equal(row.paymentRequired, null, `${label}: a 429 must not carry PAYMENT-REQUIRED`);
  assert.equal(row.json?.receipt, undefined, `${label}: nothing signed`);
}

function assertUnpaidChallenge(row, label) {
  assert.equal(row.status, 402, label);
  assert.ok(row.paymentRequired, `${label}: 402 without PAYMENT-REQUIRED is not the paywall`);
  assert.equal(row.json?.receipt, undefined, `${label}: unpaid challenge must not sign`);
}

function assertExactBudget(rows, budget, { allowedStatus = 402 } = {}) {
  assert.equal(countStatus(rows, allowedStatus), budget, `allowed ${allowedStatus}s must equal the budget (${budget})`);
  assert.equal(countStatus(rows, 429), rows.length - budget, "the rest of the flood is 429");
  for (const row of rows) {
    if (row.status === 429) assertLimited(row, "flood 429");
    else if (row.status === allowedStatus && allowedStatus === 402) assertUnpaidChallenge(row, "flood 402");
    else assert.equal(row.status, allowedStatus, `unexpected status ${row.status}`);
  }
}

// ---------------------------------------------------------------------------
// Primitive: the sync increment must stay exact under a burst.
// ---------------------------------------------------------------------------

test("flood primitive: perMinuteLimiter never overshoots a per-key or global-style burst", async () => {
  const perIp = perMinuteLimiter(5, 30, { now: () => 0 });
  const perHits = Array.from({ length: 80 }, () => perIp("203.0.113.1"));
  assert.equal(perHits.filter(Boolean).length, 5);

  const global = perMinuteLimiter(4, 60, { now: () => 0 });
  const globalHits = Array.from({ length: 80 }, () => global("*"));
  assert.equal(globalHits.filter(Boolean).length, 4);

  const overlapping = perMinuteLimiter(3, 30, { now: () => 0 });
  const got = await Promise.all(Array.from({ length: 40 }, async () => {
    await Promise.resolve();
    return overlapping("k");
  }));
  assert.equal(got.filter(Boolean).length, 3, "microtask-overlapped callers still exact");
});

// ---------------------------------------------------------------------------
// Per-IP flood on the paywall.
// ---------------------------------------------------------------------------

test("flood (per-IP): concurrent unpaid POST /witness from one client hits the per-client cap exactly; retrieve and facilitator stop", async () => {
  const reader = countingRetrieve();
  const facilitator = countingFacilitator();
  await serve(host({
    retrieve: reader.retrieve,
    facilitator,
    quoteRateLimit: 3,
    quoteGlobalRateLimit: 80,
  }), async (base) => {
    const rows = await flood(24, () => post(base, "/witness", BODY, { "x-forwarded-for": "203.0.113.10" }));
    assertExactBudget(rows, 3);
    assert.equal(reader.count(), 3, "limited requests must not retrieve");
    assert.equal(facilitator.calls.verify, 0, "unpaid flood must not verify");
    assert.equal(facilitator.calls.settle, 0, "unpaid flood must not settle");
  });
});

// ---------------------------------------------------------------------------
// Global flood on the paywall.
// ---------------------------------------------------------------------------

test("flood (global): concurrent unpaid POST /witness from distinct IPs hits the global cap; minting X-Forwarded-For cannot unbounded-spend the reader", async () => {
  const reader = countingRetrieve();
  const facilitator = countingFacilitator();
  await serve(host({
    retrieve: reader.retrieve,
    facilitator,
    quoteRateLimit: 10,
    quoteGlobalRateLimit: 4,
  }), async (base) => {
    const rows = await flood(16, (i) => post(base, "/witness", BODY, { "x-forwarded-for": `203.0.113.${20 + i}` }));
    assertExactBudget(rows, 4);
    assert.equal(reader.count(), 4, "a fresh identity past the global cap must not retrieve");
    assert.equal(facilitator.calls.verify, 0);
    assert.equal(facilitator.calls.settle, 0);
  });
});

test("flood (global): IPv6 X-Forwarded-For identities are distinct per-client buckets and still hit the global /witness cap", async () => {
  const reader = countingRetrieve();
  await serve(host({
    retrieve: reader.retrieve,
    quoteRateLimit: 5,
    quoteGlobalRateLimit: 3,
  }), async (base) => {
    const rows = await flood(12, (i) => post(base, "/witness", BODY, { "x-forwarded-for": `2001:db8::${(i + 1).toString(16)}` }));
    assertExactBudget(rows, 3);
    assert.equal(reader.count(), 3);
  });
});

// ---------------------------------------------------------------------------
// Shared /quote + /witness budgets under flood.
// ---------------------------------------------------------------------------

test("flood (per-IP): POST /quote and POST /witness share one per-client budget under a mixed concurrent burst", async () => {
  const reader = countingRetrieve();
  await serve(host({
    retrieve: reader.retrieve,
    quoteRateLimit: 3,
    quoteGlobalRateLimit: 80,
  }), async (base) => {
    const ip = { "x-forwarded-for": "198.51.100.7" };
    const rows = await Promise.all([
      ...Array.from({ length: 5 }, () => read(post(base, "/quote", BODY, ip))),
      ...Array.from({ length: 5 }, () => read(post(base, "/witness", BODY, ip))),
    ]);
    const limited = rows.filter((r) => r.status === 429);
    const allowed = rows.filter((r) => r.status !== 429);
    assert.equal(allowed.length, 3);
    assert.equal(limited.length, 7);
    for (const row of limited) assertLimited(row, "shared per-IP 429");
    for (const row of allowed) {
      assert.ok(row.status === 200 || row.status === 402, `allowed row was ${row.status}`);
      if (row.status === 402) assertUnpaidChallenge(row, "shared per-IP 402");
    }
    assert.equal(reader.count(), 3);
  });
});

test("flood (global): mixed /quote + /witness from distinct IPs share the global cap", async () => {
  const reader = countingRetrieve();
  await serve(host({
    retrieve: reader.retrieve,
    quoteRateLimit: 10,
    quoteGlobalRateLimit: 5,
  }), async (base) => {
    const rows = await Promise.all(Array.from({ length: 14 }, (_, i) => {
      const headers = { "x-forwarded-for": `198.51.100.${i + 1}` };
      const route = i % 2 === 0 ? "/quote" : "/witness";
      return read(post(base, route, BODY, headers));
    }));
    const limited = rows.filter((r) => r.status === 429);
    const allowed = rows.filter((r) => r.status !== 429);
    assert.equal(allowed.length, 5);
    assert.equal(limited.length, 9);
    for (const row of limited) assertLimited(row, "shared global 429");
    assert.equal(reader.count(), 5);
  });
});

// ---------------------------------------------------------------------------
// Interaction: one flooding client cannot starve a neighbour, or steal a bucket.
// ---------------------------------------------------------------------------

test("flood (per-IP + global): one client's per-IP 429s do not spend the global budget; a neighbour still gets through", async () => {
  const reader = countingRetrieve();
  await serve(host({
    retrieve: reader.retrieve,
    quoteRateLimit: 2,
    quoteGlobalRateLimit: 6,
  }), async (base) => {
    const [flooded, neighbour] = await Promise.all([
      flood(12, () => post(base, "/witness", BODY, { "x-forwarded-for": "203.0.113.50" })),
      read(post(base, "/witness", BODY, { "x-forwarded-for": "203.0.113.51" })),
    ]);
    assertExactBudget(flooded, 2);
    assertUnpaidChallenge(neighbour, "neighbour under its own per-IP budget");
    assert.equal(reader.count(), 3, "flooder 2 + neighbour 1; 429s must not retrieve");
  });
});

test("flood (per-IP): X-Real-IP cannot mint a fresh /witness bucket — a burst of spoofed identities still shares the socket", async () => {
  const reader = countingRetrieve();
  await serve(host({
    retrieve: reader.retrieve,
    quoteRateLimit: 2,
    quoteGlobalRateLimit: 80,
  }), async (base) => {
    const rows = await flood(10, (i) => post(base, "/witness", BODY, { "x-real-ip": `198.51.100.${i + 1}` }));
    assertExactBudget(rows, 2);
    assert.equal(reader.count(), 2, "X-Real-IP must not open a reader slot per spoofed address");
  });
});

// ---------------------------------------------------------------------------
// Paywall order under flood: limiter -> retrieve -> facilitator.
// ---------------------------------------------------------------------------

test("flood (per-IP): payment-carrying POST /witness is limited before the facilitator; 429s never verify or settle", async () => {
  const reader = countingRetrieve();
  const facilitator = countingFacilitator();
  await serve(host({
    retrieve: reader.retrieve,
    facilitator,
    quoteRateLimit: 2,
    quoteGlobalRateLimit: 80,
  }), async (base) => {
    const pay = {
      "payment-signature": Buffer.from(JSON.stringify({
        x402Version: 2,
        accepted: { scheme: "exact", network: "eip155:8453" },
        payload: { signature: "0x00", authorization: {} },
      })).toString("base64"),
      "x-forwarded-for": "203.0.113.80",
    };
    const rows = await flood(12, () => post(base, "/witness", BODY, pay));
    assert.equal(countStatus(rows, 429), 10);
    for (const row of rows.filter((r) => r.status === 429)) assertLimited(row, "paid-path 429");
    assert.equal(reader.count(), 2, "only the two limiter-allowed payments may retrieve");
    assert.ok(facilitator.calls.verify <= 2, `facilitator verify overshot (${facilitator.calls.verify})`);
    assert.equal(facilitator.calls.settle, 0);
    for (const row of rows) assert.notEqual(row.status, 200, "a forged payment must not mint a receipt under flood");
  });
});

test("flood: GET /witness discovery is not a quote probe — a GET burst does not spend the POST /witness budget", async () => {
  const reader = countingRetrieve();
  await serve(host({
    retrieve: reader.retrieve,
    quoteRateLimit: 2,
    quoteGlobalRateLimit: 80,
  }), async (base) => {
    const gets = await flood(16, () => fetch(`${base}/witness`));
    assert.equal(countStatus(gets, 402), 16, "discovery stays 402 under flood");
    for (const row of gets) {
      assert.equal(row.status, 402);
      assert.ok(row.paymentRequired, "GET /witness flood must still be the discovery challenge");
    }
    assert.equal(reader.count(), 0, "GET discovery must not retrieve");

    const posts = await flood(3, () => post(base, "/witness", BODY, { "x-forwarded-for": "203.0.113.90" }));
    assertExactBudget(posts, 2);
    assert.equal(reader.count(), 2, "POST budget is intact after the GET flood");
  });
});

test("flood: a /witness burst does not spend the attest budget", async () => {
  const reader = countingRetrieve();
  const fake = countingAttest();
  await serve(host({
    retrieve: reader.retrieve,
    attest: fake.attest,
    quoteRateLimit: 1,
    quoteGlobalRateLimit: 80,
    attestRateLimit: 2,
  }), async (base) => {
    const probe = await flood(6, () => post(base, "/witness", BODY, { "x-forwarded-for": "203.0.113.99" }));
    assertExactBudget(probe, 1);
    assert.equal(reader.count(), 1);

    const first = await read(post(base, "/delivery/attest", structuredClone(EXAMPLE_BODY), { "x-forwarded-for": "203.0.113.99" }));
    assert.equal(first.status, 402, "attest is a separate budget; unpaid well-formed is the paywall, not quote_rate_limited");
    assert.ok(first.paymentRequired);
    assert.notEqual(first.json?.reason, "quote_rate_limited");
    assert.notEqual(first.json?.reason, "attest_rate_limited");
    assert.equal(fake.calls.length, 0, "unpaid attest must not reach the model");
  });
});
