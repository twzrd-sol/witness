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
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  const res = await fetch(`http://127.0.0.1:${app.address().port}/pubkey`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).pubkey);
  await new Promise((r) => app.close(r));
});
