import { test } from "node:test";
import assert from "node:assert";
import { generateProcessKey, signReceipt, sourceHash, verifyReceipt } from "../src/receipt.js";
import { methodFromRequest, specHash } from "../src/observatory.js";
import { handleQuote, handleWitness } from "../src/server.js";

const BODY = { url: "https://example.com/p", extract: { stock: "number" }, assertion: "stock < 100", replicas: 1 };
const textA = "stock: 42";
const textB = "stock: 99";

function makePrior(kp, method, text, extra = {}) {
  const observed_at = "2026-08-30T00:00:00.000Z";
  const rest = {
    value: { stock: 42 }, assertion: method.assertion, observed_at,
    source_hash: sourceHash(text), evidence: "e", agreement: "1-of-1",
    method, spec_hash: specHash(method),
    valid_until: new Date(Date.parse(observed_at) + 3_600_000).toISOString(), vantage: "box", ...extra,
  };
  return signReceipt(rest, kp);
}

test("no prior_receipt: quote and receipt shapes unchanged (no changed key)", async () => {
  const kp = generateProcessKey();
  const q = await handleQuote(BODY, { retrieve: async () => ({ text: textA }), key: kp });
  assert.equal(q.status, 200);
  assert.equal("changed" in q.json, false);
  const w = await handleWitness(BODY, { retrieve: async () => ({ text: textA }), paid: true, key: kp });
  assert.equal(w.status, 200);
  assert.equal("changed" in w.json, false);
  assert.equal(verifyReceipt(w.json, kp.publicKey), true);
});

test("forged prior -> 422 prior_invalid, retrieve not called", async () => {
  const kp = generateProcessKey(), other = generateProcessKey();
  let n = 0;
  const prior = makePrior(other, methodFromRequest(BODY), textA);
  const q = await handleQuote({ ...BODY, prior_receipt: prior }, { retrieve: async () => (n++, { text: textA }), key: kp });
  assert.equal(q.status, 422);
  assert.equal(q.json.reason, "prior_invalid");
  assert.equal(n, 0);
});

test("non-string receipt field -> 422 prior_invalid, never 500, retrieve not called", async () => {
  const kp = generateProcessKey();
  let n = 0;
  const prior = makePrior(kp, methodFromRequest(BODY), textA, { receipt: 123 });
  const q = await handleQuote({ ...BODY, prior_receipt: prior }, { retrieve: async () => (n++, { text: textA }), key: kp });
  assert.equal(q.status, 422);
  assert.equal(q.json.reason, "prior_invalid");
  assert.equal(n, 0);
});

test("valid prior, different method -> 422 prior_method_mismatch, retrieve not called", async () => {
  const kp = generateProcessKey();
  let n = 0;
  const prior = makePrior(kp, methodFromRequest(BODY), textA);
  const q = await handleQuote({ ...BODY, url: "https://example.com/other", prior_receipt: prior }, { retrieve: async () => (n++, { text: textA }), key: kp });
  assert.equal(q.status, 422);
  assert.equal(q.json.reason, "prior_method_mismatch");
  assert.equal(n, 0);
});

test("expired prior, same source -> changed:false, paid receipt verifies", async () => {
  const kp = generateProcessKey();
  const prior = makePrior(kp, methodFromRequest(BODY), textA);
  const q = await handleQuote({ ...BODY, prior_receipt: prior }, { retrieve: async () => ({ text: textA }), key: kp });
  assert.equal(q.status, 200);
  assert.equal(q.json.changed, false);
  assert.equal(q.json.previous_source_hash, prior.source_hash);
  const w = await handleWitness({ ...BODY, prior_receipt: prior }, { retrieve: async () => ({ text: textA }), paid: true, key: kp });
  assert.equal(w.status, 200);
  assert.equal(w.json.changed, false);
  assert.equal(w.json.previous_source_hash, prior.source_hash);
  assert.equal(verifyReceipt(w.json, kp.publicKey), true);
});

test("expired prior, changed source -> changed:true, receipt binds delta and verifies", async () => {
  const kp = generateProcessKey();
  const prior = makePrior(kp, methodFromRequest(BODY), textA);
  const w = await handleWitness({ ...BODY, prior_receipt: prior }, { retrieve: async () => ({ text: textB }), paid: true, key: kp });
  assert.equal(w.status, 200);
  assert.equal(w.json.changed, true);
  assert.equal(w.json.previous_source_hash, prior.source_hash);
  assert.notEqual(w.json.source_hash, prior.source_hash);
  assert.equal(verifyReceipt(w.json, kp.publicKey), true);
});

test("unpaid deliverable with valid prior -> 402, not 422", async () => {
  const kp = generateProcessKey();
  const prior = makePrior(kp, methodFromRequest(BODY), textA);
  const w = await handleWitness({ ...BODY, prior_receipt: prior }, { retrieve: async () => ({ text: textA }), paid: false, key: kp });
  assert.equal(w.status, 402);
});
