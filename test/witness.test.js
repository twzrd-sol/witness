import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
import { compareReceipts, methodFromRequest, readObservations, specHash } from "../src/observatory.js";
import { createApp, handleWitness } from "../src/server.js";

const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const EXTRACT = { starter_price: "number", currency: "string" };
const BODY = { url: "https://example.com/pricing", extract: EXTRACT, assertion: "starter_price < 100" };

test("receipt verify with process pubkey", async () => {
  const key = generateProcessKey();
  const out = await handleWitness(BODY, {
    retrieve: async () => ({ text: FIXTURE }),
    paid: true,
    key,
    now: () => "2026-08-30T00:00:00.000Z",
  });
  assert.equal(out.status, 200);
  assert.ok(verifyReceipt(out.json, key.publicKey));
  assert.equal(out.json.agreement, "1-of-1");
  assert.equal(out.json.value.starter_price, 49);
  assert.equal(out.json.assertion, "starter_price < 100");
  assert.equal(out.json.vantage, "box");
  assert.equal(out.json.valid_until, "2026-08-30T01:00:00.000Z");
  assert.equal(out.json.spec_hash, specHash(methodFromRequest(BODY)));
  assert.deepEqual(out.json.method, methodFromRequest(BODY));
  const methodTampered = { ...out.json, method: { ...out.json.method, url: "https://example.com/evil" } };
  assert.equal(verifyReceipt(methodTampered, key.publicKey), false, "method is inside the signature");
});

test("paid card appends; /observatory reads the log, not seeds", async () => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-"));
  const now = () => "2026-08-30T00:00:00.000Z";
  const out = await handleWitness(BODY, {
    retrieve: async () => ({ text: FIXTURE }),
    paid: true,
    key,
    now,
    observationsDir: dir,
  });
  assert.equal(out.status, 200);
  // Partial source: currency resolves, starter_price does not. That proves the
  // extractor read the page, so the miss is the source's and the answer bills.
  const miss = await handleWitness(BODY, {
    retrieve: async () => ({ text: "<p>currency: USD</p>" }),
    paid: true,
    key,
    now,
    observationsDir: dir,
  });
  // A claim whose field the source lacks is now an answer, not a refusal: it is
  // paid, it appends, and it carries its verdict so no reader can mistake it for
  // a confirmed fact.
  assert.equal(miss.status, 200);
  assert.equal(miss.json.verdict, "incomplete");
  const rows = readObservations(dir);
  assert.equal(rows.length, 2, "a paid incomplete is an observation and appends");
  assert.deepEqual(rows.map((r) => r.verdict), ["supported", "incomplete"]);
  const app = createApp({ key, retrieve: async () => ({ text: FIXTURE }), observationsDir: dir, now });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/observatory`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(out.json.spec_hash.slice(0, 16)));
    // Two observations of one method that do not agree: a supported reading and
    // an incomplete one. The sky must show that disagreement, not a steady star.
    assert.match(html, /class="card flare"/);
    assert.doesNotMatch(html, /What price is published/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("a card never renders a non-supported group as one settled answer", async () => {
  // Condition: the star map must carry the verdict end to end. A group whose
  // active receipts disagree reads "mixed", never the supported one of the pair.
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-v-"));
  const now = () => "2026-08-30T00:00:00.000Z";
  const deps = { paid: true, key, now, observationsDir: dir };
  await handleWitness(BODY, { ...deps, retrieve: async () => ({ text: FIXTURE }) });
  const cardsOne = compareReceipts(readObservations(dir), key.publicKey, new Date(now()));
  assert.equal(cardsOne[0].verdict, "supported");

  await handleWitness(BODY, { ...deps, retrieve: async () => ({ text: "<p>currency: USD</p>" }) });
  const cards = compareReceipts(readObservations(dir), key.publicKey, new Date(now()));
  assert.equal(cards.length, 1, "one method, one card");
  assert.equal(cards[0].verdict, "mixed", "a disagreeing group must not read as supported");
  assert.equal(cards[0].state, "flare");
});

test("a claim the source cannot answer is quoted, charged, and labelled incomplete", async () => {
  const partial = async () => ({ text: "<p>currency: USD</p>" });
  const out = await handleWitness(BODY, { retrieve: partial });
  assert.equal(out.status, 402, "incomplete is a billable answer, so it reaches the paywall");
  const paid = await handleWitness(BODY, { retrieve: partial, paid: true, key: generateProcessKey() });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.verdict, "incomplete");
  assert.deepEqual(paid.json.value, { currency: "USD" }, "the evidence we did find is still in the receipt");
});

test("a document where nothing resolved is not sold as incomplete", async () => {
  // We cannot tell "the page lacks every field" from "our matcher read none of
  // them", so this is free -- the guard against billing our own defects.
  const out = await handleWitness(BODY, { retrieve: async () => ({ text: "<p>hi</p>" }) });
  assert.deepEqual([out.status, out.json.reason], [422, "extract_none"]);
});

test("with no claim, an extract miss still never reaches the paywall", async () => {
  // Nothing was asked, so there is nothing incomplete and nothing to sell.
  const { assertion, ...noClaim } = BODY;
  const out = await handleWitness(noClaim, { retrieve: async () => ({ text: "<p>hi</p>" }) });
  assert.equal(out.status, 422);
  assert.equal(out.json.reason, "extract_missing");
});

test("POST /witness unpaid 402 after a deliverable quote", async () => {
  const out = await handleWitness(BODY, { retrieve: async () => ({ text: FIXTURE }) });
  assert.equal(out.status, 402);
  assert.equal(out.json.x402Version, 2);
  assert.equal(out.json.accepts[0].amount ?? out.json.accepts[0].maxAmountRequired, "10000");
});

test("browse quote-first: unpaid 402 is $0.06; paid receipt binds retrieval browse", async () => {
  const calls = [];
  const retrieve = async (url, opts = {}) => {
    calls.push(opts.retrieval ?? "scrape");
    return { text: FIXTURE };
  };
  const browse = { ...BODY, retrieval: "browse" };
  const unpaid = await handleWitness(browse, { retrieve });
  assert.equal(unpaid.status, 402);
  assert.equal(unpaid.json.accepts[0].amount ?? unpaid.json.accepts[0].maxAmountRequired, "60000");

  const key = generateProcessKey();
  const paid = await handleWitness(browse, { retrieve, paid: true, key });
  assert.equal(paid.status, 200);
  assert.equal(paid.json.method.retrieval, "browse");
  assert.deepEqual(calls, ["browse", "browse"]);
});

test("GET /pubkey", async () => {
  const key = generateProcessKey();
  const app = createApp({ key, retrieve: async () => ({ text: FIXTURE }), funnelDir: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/pubkey`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).pubkey);
  await new Promise((r) => server.close(r));
});

const fakeFacilitator = {
  async getSupported() {
    return { kinds: [
      { x402Version: 2, scheme: "exact", network: "eip155:8453" },
      { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
    ] };
  },
  async verify() { throw new Error("not implemented in fixture"); },
  async settle() { throw new Error("not implemented in fixture"); },
};

test("paywall wired: unpaid deliverable → real x402 402 challenge, both rails", async () => {
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: FIXTURE }),
    funnelDir: null,
    facilitator: fakeFacilitator,
    paywall: { evmAddress: "0xabc0000000000000000000000000000000000001", svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/witness`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY),
  });
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.resource.url, "https://witness.outbid.sh/witness", "402 resource is canonical https, not request-derived http://127.0.0.1");
  assert.equal(challenge.resource.serviceName, "witness");
  assert.deepEqual(challenge.resource.tags, ["observation", "receipt", "x402", "empiricism"]);
  assert.ok(challenge.extensions?.bazaar, "bazaar discovery extension declared on the challenge");
  const nets = challenge.accepts.map((a) => a.network).sort();
  assert.deepEqual(nets, ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(challenge.accepts.every((a) => (a.maxAmountRequired ?? a.amount) === "10000"));
  await new Promise((r) => server.close(r));
});

test("paywall resource URL follows publicBaseUrl (PUBLIC_BASE_URL), never the request host", async () => {
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: FIXTURE }),
    funnelDir: null,
    facilitator: fakeFacilitator,
    paywall: { svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
    publicBaseUrl: "https://witness.example.net",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/witness`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY),
  });
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(challenge.resource.url, "https://witness.example.net/witness");
  await new Promise((r) => server.close(r));
});

test("paywall wired: our own defects and unreadable claims never bill", async () => {
  // The line the billing constant draws. A claim we cannot read, and a retrieval
  // that failed on our side, are free 422s that never reach the challenge.
  const cases = [
    [{ ...BODY, assertion: "starter_price ~~ cheap" }, async () => ({ text: FIXTURE }), "assertion_malformed"],
    [BODY, async () => { throw new Error("reader_503"); }, "retrieve_failed"],
    [BODY, async () => ({ text: "" }), "retrieve_empty"],
  ];
  for (const [body, retrieve, reason] of cases) {
    const app = createApp({
      key: generateProcessKey(), retrieve, funnelDir: null, facilitator: fakeFacilitator,
      paywall: { svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/witness`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      assert.equal(res.status, 422, `${reason} must not be billed`);
      assert.equal((await res.json()).reason, reason);
    } finally {
      // Close in a finally: a failed assertion here once leaked the listener and
      // hung the whole file instead of reporting one red test.
      await new Promise((r) => server.close(r));
    }
  }
});

test("paid witness reuses the quote retrieve — one scrape per observation", async () => {
  let calls = 0;
  const key = generateProcessKey();
  const out = await handleWitness(BODY, {
    retrieve: async () => { calls++; return { text: FIXTURE }; },
    paid: true,
    key,
  });
  assert.equal(out.status, 200);
  assert.equal(calls, 1, "paid /witness must scrape once, not twice");
  assert.equal(out.json.method.url, BODY.url);
});

test("GET /witness is crawlable discovery: 402 challenge, zero retrieve", async () => {
  let calls = 0;
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => { calls++; return { text: FIXTURE }; },
    funnelDir: null,
    facilitator: fakeFacilitator,
    paywall: { evmAddress: "0xabc0000000000000000000000000000000000001", svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/witness`);
    assert.equal(res.status, 402);
    const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource.url, "https://witness.outbid.sh/witness");
    assert.deepEqual(challenge.accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    assert.equal(challenge.resource.serviceName, "witness");
    assert.equal(calls, 0, "GET must not retrieve");
    const paid = await fetch(`http://127.0.0.1:${server.address().port}/witness`, { headers: { "x-payment": "bogus" } });
    assert.equal(paid.status, 405, "paid GET refused before any facilitator call");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("malformed JSON body -> 400 bad_json, never 500", async () => {
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: FIXTURE }), funnelDir: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    for (const path of ["/witness", "/quote"]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
      });
      assert.equal(res.status, 400, `${path} parse failure is a 400`);
      assert.equal((await res.json()).reason, "bad_json");
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("nested-value tampering fails receipt verification", async () => {
  const key = generateProcessKey();
  const out = await handleWitness(BODY, {
    retrieve: async () => ({ text: FIXTURE }),
    paid: true,
    key,
    now: () => "2026-08-30T00:00:00.000Z",
  });
  assert.equal(out.status, 200);
  const tampered = { ...out.json, value: { ...out.json.value, starter_price: 9999, currency: "EUR" } };
  assert.equal(verifyReceipt(tampered, key.publicKey), false);
  assert.ok(verifyReceipt(out.json, key.publicKey));
  const reordered = { ...out.json, value: { currency: out.json.value.currency, starter_price: out.json.value.starter_price } };
  assert.ok(verifyReceipt(reordered, key.publicKey), "key order must not change validity");
});

async function postWitness(app, headers = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fetch(`http://127.0.0.1:${server.address().port}/witness`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(BODY),
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("no paywall: forged x-payment must not mint a receipt or append", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-"));
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: FIXTURE }),
    observationsDir: dir,
  });
  const res = await postWitness(app, { "x-payment": "forged" });
  assert.notEqual(res.status, 200);
  assert.ok(res.status === 503 || res.status === 402 || res.status === 422);
  assert.equal(readObservations(dir).length, 0);
});

test("no paywall: forged payment-signature must not mint a receipt or append", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-"));
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: FIXTURE }),
    observationsDir: dir,
  });
  const res = await postWitness(app, { "payment-signature": "forged" });
  assert.notEqual(res.status, 200);
  assert.ok(res.status === 503 || res.status === 402 || res.status === 422);
  assert.equal(readObservations(dir).length, 0);
});

test("paywall wired: payment headers do not skip deliverability — 422 never settles", async () => {
  let verify = 0, settle = 0;
  const facilitator = {
    async getSupported() { return fakeFacilitator.getSupported(); },
    async verify() { verify++; throw new Error("verify must not run on a non-deliverable body"); },
    async settle() { settle++; throw new Error("settle must not run on a non-deliverable body"); },
  };
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: "<p>hi</p>" }),
    funnelDir: null,
    facilitator,
    paywall: { evmAddress: "0xabc0000000000000000000000000000000000001", svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
  });
  for (const header of [{ "x-payment": "bogus" }, { "payment-signature": "bogus" }]) {
    verify = 0;
    settle = 0;
    const res = await postWitness(app, header);
    assert.equal(res.status, 422, `${Object.keys(header)[0]} must 422 before the facilitator`);
    assert.equal((await res.json()).reason, "extract_none");
    assert.equal(verify, 0, "facilitator.verify must not run");
    assert.equal(settle, 0, "facilitator.settle must not run");
  }
});

test("paywall wired: unpaid deliverable still returns the x402 402 challenge", async () => {
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: FIXTURE }),
    funnelDir: null,
    facilitator: fakeFacilitator,
    paywall: { evmAddress: "0xabc0000000000000000000000000000000000001", svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
  });
  const res = await postWitness(app);
  assert.equal(res.status, 402);
  const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
  assert.equal(challenge.x402Version, 2);
  assert.deepEqual(challenge.accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  const bodyJson = await res.json();
  assert.equal(bodyJson.error, "Payment required");
  assert.equal(bodyJson.accepts.length, 2);
});

test("explicit deps.paid (not an HTTP header) still signs a verifiable receipt", async () => {
  const key = generateProcessKey();
  const out = await handleWitness(BODY, {
    retrieve: async () => ({ text: FIXTURE }),
    paid: true,
    key,
  });
  assert.equal(out.status, 200);
  assert.ok(verifyReceipt(out.json, key.publicKey));
});
