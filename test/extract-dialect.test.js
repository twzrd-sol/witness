import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers/tmpdir.js";
import { normalizeExtract } from "../src/extract.js";
import { generateProcessKey, signReceipt, sourceHash } from "../src/receipt.js";
import { methodFromRequest, specHash } from "../src/observatory.js";
import { createApp, handleQuote, handleWitness } from "../src/server.js";

const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const URL = "https://example.com/pricing";
const CANON = { starter_price: "number", currency: "string" };
const SCHEMA = { starter_price: { type: "number", description: "monthly" }, currency: { type: "string" } };
// specHash(methodFromRequest({ url: URL, extract: CANON })) measured at 05b08aa, before normalisation existed.
const PINNED = "f1123b280c37d47ed2e6049c95fab4c121b121d3b83b4e4083c8c859f8de5b76";
const BAD = { reason: "bad_extract", expected: { "<key>": "number|string" }, example: { url: "https://outbid.sh/top", extract: { rank: "number" } } };
const retrieve = async () => ({ text: FIXTURE });
const post = (base, body) => fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("normalizeExtract: canonical deep-equal, JSON Schema collapses, junk is null", () => {
  assert.deepEqual(normalizeExtract(CANON), CANON);
  assert.deepEqual(normalizeExtract(SCHEMA), CANON);
  assert.deepEqual(normalizeExtract({ rank: { type: "number" }, name: "string" }), { rank: "number", name: "string" }, "dialects may mix per key");
  for (const bad of [undefined, null, "rank", 7, [], ["rank", "price"], {}, { rank: 5 }, { rank: null }, { rank: { type: 7 } }, { rank: { description: "no type" } }, { rank: ["number"] }]) {
    assert.equal(normalizeExtract(bad), null, JSON.stringify(bad));
  }
});

test("canonical dialect: spec_hash byte-identical to the pre-normalisation pin", async () => {
  assert.equal(specHash(methodFromRequest({ url: URL, extract: CANON })), PINNED);
  const out = await handleWitness({ url: URL, extract: CANON }, { retrieve, paid: true, key: generateProcessKey() });
  assert.equal(out.status, 200);
  assert.equal(out.json.spec_hash, PINNED);
  assert.deepEqual(out.json.method.extract, CANON);
});

test("JSON Schema dialect: quote 200, signed method is canonical, same spec_hash", async () => {
  const q = await handleQuote({ url: URL, extract: SCHEMA }, { retrieve });
  assert.deepEqual(q.json, { price_usdc: "0.01", replicas: 1, can_deliver: true, retrieval: "scrape" });
  const out = await handleWitness({ url: URL, extract: SCHEMA }, { retrieve, paid: true, key: generateProcessKey() });
  assert.equal(out.status, 200);
  assert.equal(out.json.spec_hash, PINNED, "one method, one identity — the observatory groups dialects together");
  assert.deepEqual(out.json.method.extract, CANON, "the receipt binds the canonical form, not the wire dialect");
  assert.equal(out.json.value.starter_price, 49);
});

test("JSON Schema dialect agrees with a canonical prior_receipt (no prior_method_mismatch)", async () => {
  const key = generateProcessKey();
  const method = methodFromRequest({ url: URL, extract: CANON });
  const prior = signReceipt({ value: { starter_price: 49, currency: "USD" }, assertion: null, observed_at: "2026-08-30T00:00:00.000Z", source_hash: sourceHash(FIXTURE), evidence: "e", agreement: "1-of-1", method, spec_hash: specHash(method), valid_until: "2026-08-30T01:00:00.000Z", vantage: "box" }, key);
  const q = await handleQuote({ url: URL, extract: SCHEMA, prior_receipt: prior }, { retrieve, key });
  assert.equal(q.status, 200);
  assert.equal(q.json.changed, false);
});

test("malformed extract: 400 bad_extract with the teaching example, retrieve never called", async () => {
  let n = 0;
  const spy = async () => (n++, { text: FIXTURE });
  for (const extract of ["rank", ["rank", "price"], { rank: 5 }, { rank: { type: 7 } }, {}, undefined]) {
    const out = await handleQuote({ url: URL, extract }, { retrieve: spy });
    assert.equal(out.status, 400, JSON.stringify(extract));
    assert.deepEqual(out.json, BAD);
  }
  assert.equal(n, 0, "a shape error is answered before any retrieve");
});

test("real extract_missing is still 422 — in the JSON Schema dialect too", async () => {
  const out = await handleQuote({ url: URL, extract: { rank: { type: "number" } } }, { retrieve });
  assert.equal(out.status, 422);
  assert.deepEqual(out.json, { reason: "extract_missing", missing: ["rank"] }, "names the key, never an array index");
});

test("POST /quote: JSON Schema 200, array 400, both dialects share one funnel spec_hash", async () => {
  const dir = tempDir("dialect-");
  const app = createApp({ key: generateProcessKey(), retrieve, funnelDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await post(base, { url: URL, extract: SCHEMA })).status, 200);
    assert.equal((await post(base, { url: URL, extract: CANON })).status, 200);
    const arr = await post(base, { url: URL, extract: ["starter_price"] });
    assert.equal(arr.status, 400);
    assert.deepEqual(await arr.json(), BAD);
    await new Promise((r) => setTimeout(r, 20));
    const events = readFileSync(path.join(dir, "funnel.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(events.map((e) => e.spec_hash), [PINNED, PINNED, undefined], "funnel counts one method, and no hash for a shape error");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
