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
  const wreq = w.requestBody.content["application/json"];
  assert.deepEqual(wreq.schema.required, ["url", "extract"]);
  assert.equal(wreq.schema.properties.retrieval.type, "string");
  assert.equal(wreq.schema.properties.assertion.type, "string");
  assert.deepEqual(wreq.example, { url: "https://outbid.sh/top", extract: { rank: "number" }, retrieval: "scrape", assertion: "rank < 100", replicas: 1 }, "witness example: outbid.sh/top rank method");
  assert.deepEqual(doc.paths["/quote"].post.requestBody.content["application/json"].example, wreq.example, "quote carries the same example");
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
    assert.deepEqual(Object.keys(served.paths).sort(), ["/.well-known/agent.json", "/.well-known/x402", "/llms.txt", "/observatory", "/openapi.json", "/pubkey", "/quote", "/skill.md", "/witness"]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("GET discovery paths documented public (security: []) — no GET /quote or /witness", () => {
  const doc = openapiDoc({});
  for (const p of ["/openapi.json", "/pubkey", "/.well-known/x402", "/observatory", "/llms.txt", "/skill.md", "/.well-known/agent.json"]) {
    const g = doc.paths[p].get;
    assert.ok(g, `${p} has a GET entry`);
    assert.deepEqual(g.security, [], `${p} is explicitly public`);
    assert.ok(g.responses["200"], `${p} documents 200`);
  }
  assert.equal(doc.paths["/pubkey"].get.responses["200"].content["application/json"].schema.required.join(), "pubkey");
  const x402 = doc.paths["/.well-known/x402"].get.responses["200"].content["application/json"].schema;
  assert.equal(x402.properties.resource.const, "https://witness.outbid.sh/witness");
  assert.deepEqual(x402.properties.accepts.items.properties.network.enum, ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(doc.paths["/observatory"].get.responses["200"].content["text/html"], "observatory is text/html");
  assert.ok(doc.paths["/llms.txt"].get.responses["200"].content["text/markdown"], "llms.txt is text/markdown");
  assert.ok(doc.paths["/skill.md"].get.responses["200"].content["text/markdown"], "skill.md is text/markdown");
  assert.deepEqual(doc.paths["/.well-known/agent.json"].get.responses["200"].content["application/json"].schema.required, ["name", "url", "skills"]);
  assert.equal(doc.paths["/quote"].get, undefined, "no GET /quote");
  assert.equal(doc.paths["/witness"].get, undefined, "no GET /witness");
});
