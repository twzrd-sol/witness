import { test } from "node:test";
import assert from "node:assert";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
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
});

test("POST /witness 422 when extract cannot fill — no 402", async () => {
  const out = await handleWitness(BODY, { retrieve: async () => ({ text: "<p>hi</p>" }) });
  assert.equal(out.status, 422);
  assert.equal(out.json.reason, "extract_missing");
});

test("POST /witness unpaid 402 after a deliverable quote", async () => {
  const out = await handleWitness(BODY, { retrieve: async () => ({ text: FIXTURE }) });
  assert.equal(out.status, 402);
  assert.equal(out.json.accepts[0].maxAmountRequired, "10000");
});

test("GET /pubkey", async () => {
  const key = generateProcessKey();
  const app = createApp({ key, retrieve: async () => ({ text: FIXTURE }) });
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
  const nets = challenge.accepts.map((a) => a.network).sort();
  assert.deepEqual(nets, ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(challenge.accepts.every((a) => (a.maxAmountRequired ?? a.amount) === "10000"));
  await new Promise((r) => server.close(r));
});

test("paywall wired: extract miss → 422, the paywall never bills", async () => {
  const app = createApp({
    key: generateProcessKey(),
    retrieve: async () => ({ text: "<p>hi</p>" }),
    facilitator: fakeFacilitator,
    paywall: { svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/witness`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY),
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, "extract_missing");
  await new Promise((r) => server.close(r));
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
