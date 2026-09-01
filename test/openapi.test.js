import { test } from "node:test";
import assert from "node:assert";
import { openapiDoc } from "../src/openapi.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHostApp } from "../src/listen.js";

test("openapi contract: quote free, witness quote-first paid x402, canonical origin", async () => {
  const doc = openapiDoc({ EVM_ADDRESS: "0xabc0000000000000000000000000000000000001", SVM_ADDRESS: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" });
  assert.equal(doc.servers[0].url, "https://witness.outbid.sh");
  assert.equal(doc.openapi, "3.1.0");

  const q = doc.paths["/quote"].post;
  assert.deepEqual(Object.keys(q.responses).sort(), ["200", "400", "422", "429"]);
  assert.match(q.description, /Never bills/);
  assert.deepEqual(q.security, [], "quote is explicitly public — free, no auth requirement");

  const w = doc.paths["/witness"].post;
  assert.equal(w["x-payment"].price_usdc, "0.01");
  const wreq = w.requestBody.content["application/json"];
  assert.deepEqual(wreq.schema.required, ["url", "extract"]);
  assert.equal(wreq.schema.properties.retrieval.type, "string");
  assert.deepEqual(wreq.schema.properties.retrieval.enum, ["scrape"], "retrieval is an enum (scrape only)");
  assert.equal(wreq.schema.properties.retrieval.example, "scrape");
  assert.equal(wreq.schema.properties.assertion.type, "string");
  assert.equal(wreq.schema.properties.assertion.example, "rank < 100");
  assert.deepEqual(wreq.example, { url: "https://outbid.sh/top", extract: { rank: "number" }, retrieval: "scrape", assertion: "rank < 100", replicas: 1 }, "witness example: outbid.sh/top rank method");
  assert.equal(wreq.schema.properties.url.example, "https://outbid.sh/top", "url property example — sampler composes a real probe, not placehold.co");
  assert.deepEqual(wreq.schema.properties.extract.example, { rank: "number" }, "extract property example");
  const qbody = doc.paths["/quote"].post.requestBody.content["application/json"];
  assert.deepEqual(qbody.example, wreq.example, "quote carries the same example");
  assert.equal(qbody.schema, wreq.schema, "quote and witness share the one canonical request schema");
  assert.deepEqual(w["x-payment-info"].protocols, [{ x402: {} }]);
  assert.deepEqual(w["x-payment-info"].price, { mode: "fixed", currency: "USD", amount: "0.010000" });
  assert.deepEqual(w["x-payment"].accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.ok(w["x-payment"].accepts.every((a) => a.payTo), "accepts carry payTo when env set");
  assert.match(doc.info["x-guidance"], /POST \/quote/);
  assert.match(doc.info["x-guidance"], /POST \/witness/);
  assert.match(doc.info["x-guidance"], /\$0\.02/);
  assert.deepEqual(Object.keys(w.responses).sort(), ["200", "400", "402", "422"]);
  const req = w.requestBody.content["application/json"].schema;
  assert.deepEqual(req.required, ["url", "extract"]);
  const receipt = w.responses["200"].content["application/json"].schema;
  for (const field of ["value", "method", "spec_hash", "valid_until", "vantage", "receipt"]) assert.ok(receipt.required.includes(field), `receipt exposes ${field}`);
  const r402 = w.responses["402"];  assert.deepEqual(r402.content["application/json"].schema.properties.accepts.type, "array");
  const acc = r402.content["application/json"].schema.properties.accepts.items.properties;
  assert.ok(acc.amount, "402 accepts schema carries amount (atomic), matching the real challenge");
  assert.equal(acc.price, undefined, "402 accepts schema no longer documents a nonexistent price field");
  assert.equal(acc.asset.type, "string");
  assert.ok(r402.headers["payment-required"], "402 documents the PAYMENT-REQUIRED header (challenge lives there)");
  assert.match(r402.description, /PAYMENT-REQUIRED/, "402 description points header-first");
  assert.deepEqual(receipt.properties.assertion.type, ["string", "null"], "receipt assertion is string|null (runtime emits null when omitted)");
  assert.ok(doc.tags?.length >= 7, "top-level tags declared");
  assert.deepEqual(doc.tags.map((t) => t.name).sort(), ["empiricism", "fact", "observation", "oracle", "rank", "receipt", "x402"]);
  assert.match(doc.info.description, /oracle/i, "description names the oracle role");
  assert.match(doc.info.description, /fact/i, "description names the fact");
  assert.deepEqual(w.tags, ["observation", "receipt", "x402"]);
  assert.deepEqual(doc.paths["/witness"].get.tags, ["observation", "receipt", "x402"]);
  assert.ok(doc.info.description.includes("/observatory") && doc.info.description.includes("/llms.txt"), "agent guidance present");
});

test("GET /openapi.json serves the doc on the host surface", async () => {
  const server = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-oa-")) }).listen(0, "127.0.0.1");
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
  const wg = doc.paths["/witness"].get;
  assert.ok(wg, "GET /witness documented as discovery");
  assert.deepEqual(wg.security, [], "GET /witness discovery is not an auth requirement");
  assert.ok(wg.responses["402"], "GET /witness documents the 402 challenge");
  assert.equal(wg.responses["200"], undefined, "GET /witness is not a paid deliverable");
});
