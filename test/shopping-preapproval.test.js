import { test } from "node:test";
import assert from "node:assert";
import { tempDir } from "./helpers/tmpdir.js";
import { generateProcessKey, pubkeyB64, verifyReceipt } from "../src/receipt.js";
import { createApp, handleWitness } from "../src/server.js";
import { decideGate, GATE_METHOD } from "../scripts/shopping-preapproval.mjs";

const CARD_METHOD = {
  url: "https://dummyjson.com/products/1",
  retrieval: "scrape",
  extract: { price: "number" },
  assertion: "price < 100",
  replicas: 1,
};

test("gate method is the design-partner shopping-preapproval card, byte-stable", () => {
  assert.deepEqual(GATE_METHOD, CARD_METHOD);
});

test("gate: supported verdict approves the simulated checkout", () => {
  const d = decideGate({
    verdict: "supported",
    value: { price: 5.99 },
    observed_at: "2026-09-08T23:00:00.000Z",
    valid_until: "2026-09-08T23:59:00.000Z",
  });
  assert.equal(d.approve, true);
  assert.equal(d.reason, "verdict_supported");
});

test("gate: contradicted is an answer and blocks the checkout, never a fraud label", () => {
  const d = decideGate({ verdict: "contradicted", value: { price: 149 } });
  assert.equal(d.approve, false);
  assert.equal(d.reason, "verdict_contradicted");
});

test("gate: incomplete and stale block; verdict is carried, not swallowed", () => {
  for (const verdict of ["incomplete", "stale", "unable_to_verify"]) {
    const d = decideGate({ verdict });
    assert.equal(d.approve, false);
    assert.equal(d.reason, `verdict_${verdict}`);
  }
});

test("gate: a receipt-shaped object without a verdict field cannot approve", () => {
  assert.equal(decideGate({}).approve, false);
  assert.equal(decideGate(null).approve, false);
});

test("dry run: quote is free, verdict announced, and no payment header is ever built", async () => {
  const key = generateProcessKey();
  const dir = tempDir("wit-shop-");
  const app = createApp({ key, retrieve: async () => ({ text: "<p>price: $5.99</p>" }), observationsDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const run = await runOnce({ base, mode: "dry", log: () => {} });
    assert.equal(run.step, "quote");
    assert.equal(run.status, 200);
    assert.equal(run.body.can_deliver, true);
    assert.equal(run.body.verdict, "supported");
    assert.equal(run.decision.approve, true, "dry run gates on the announced verdict");
    assert.equal(run.paid, false, "dry mode must not reach the paid endpoint");
    assert.equal(run.payer, null, "dry mode must not load a signer");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("paid run: settles only on a deliverable quote and gates on a signature-verifiable receipt", async () => {
  const key = generateProcessKey();
  const dir = tempDir("wit-shop-");
  // The x402 middleware is bypassed in tests via deps.paid; the harness's own
  // payment leg is the same shape: one POST /witness that returns a receipt.
  const out = await handleWitness(GATE_METHOD, {
    retrieve: async () => ({ text: "<p>price: $5.99</p>" }),
    paid: true,
    key,
    now: () => "2026-09-08T23:00:00.000Z",
    observationsDir: dir,
  });
  assert.equal(out.status, 200);
  assert.equal(out.json.verdict, "supported");
  assert.equal(verifyReceipt(out.json, key.publicKey), true, "harness only gates on verifiable receipts");
  assert.equal(decideGate(out.json).approve, true);
});

// Local imports are declared last so the RED phase fails here, not above.
import { runOnce, verifyAgainstPubkeyB64 } from "../scripts/shopping-preapproval.mjs";

test("live verification path: signature-verifiable receipt from /pubkey-shaped b64 gates; tamper blocks", async () => {
  const key = generateProcessKey();
  const now = () => "2026-09-08T23:00:00.000Z";
  const out = await handleWitness(GATE_METHOD, {
    retrieve: async () => ({ text: "<p>price: $5.99</p>" }),
    paid: true,
    key,
    now,
  });
  assert.equal(out.status, 200);
  const b64 = pubkeyB64(key);
  assert.equal(verifyAgainstPubkeyB64(out.json, b64), true, "the exact live-path helper verifies the real receipt");
  assert.equal(verifyAgainstPubkeyB64({ ...out.json, value: { price: 1 } }, b64), false, "tampered value fails");
  assert.equal(verifyAgainstPubkeyB64({}, b64), false, "empty doc fails");
  assert.equal(verifyAgainstPubkeyB64(out.json, "not-base64!"), false, "malformed pubkey fails closed");
});
