import { test } from "node:test";
import assert from "node:assert";
import { openapiDoc } from "../src/openapi.js";
import { createHostApp } from "../src/listen.js";

test("openapi contract: quote free, witness quote-first paid x402, canonical origin", async () => {
  const doc = openapiDoc({ EVM_ADDRESS: "0xabc0000000000000000000000000000000000001", SVM_ADDRESS: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" });
  assert.equal(doc.servers[0].url, "https://witness.outbid.sh");
  assert.equal(doc.openapi, "3.1.0");

  const q = doc.paths["/quote"].post;
  assert.deepEqual(Object.keys(q.responses).sort(), ["200", "400", "422"]);
  assert.match(q.description, /Never bills/);
  assert.deepEqual(q.security, [], "quote is explicitly public — free, no auth requirement");

  const w = doc.paths["/witness"].post;
  assert.equal(w["x-payment"].price_usdc, "0.01");
  assert.deepEqual(w["x-payment-info"].protocols, [{ x402: {} }]);
  assert.deepEqual(w["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.010000" });
  assert.deepEqual(w["x-payment"].accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(w["x-payment"].accepts.every((a) => a.payTo), "accepts carry payTo when env set");
  assert.match(doc.info["x-guidance"], /POST \/quote/);
  assert.match(doc.info["x-guidance"], /POST \/witness/);
  assert.match(doc.info["x-guidance"], /\$0\.01/);
  assert.deepEqual(Object.keys(w.responses).sort(), ["200", "400", "402", "422"]);
  const req = w.requestBody.content["application/json"].schema;
  assert.deepEqual(req.required, ["url", "extract"]);
  const receipt = w.responses["200"].content["application/json"].schema;
  for (const field of ["value", "method", "spec_hash", "valid_until", "vantage", "receipt"]) assert.ok(receipt.required.includes(field), `receipt exposes ${field}`);
  const r402 = w.responses["402"].content["application/json"].schema;
  assert.deepEqual(r402.properties.accepts.type, "array");
  assert.ok(doc.info.description.includes("/observatory") && doc.info.description.includes("/llms.txt"), "agent guidance present");
});

test("GET /openapi.json serves the doc on the host surface", async () => {
  const server = createHostApp({}).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/openapi.json`);
    assert.equal(res.status, 200);
    const served = await res.json();
    assert.equal(served.servers[0].url, "https://witness.outbid.sh", "canonical origin even without env");
    assert.deepEqual(Object.keys(served.paths), ["/quote", "/witness"]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
