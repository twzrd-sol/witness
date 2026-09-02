import { test } from "node:test";
import assert from "node:assert";
import Ajv from "ajv";
import { EXTRACT_SCHEMA, EXTRACT_TYPES, normalizeExtract } from "../src/extract.js";
import { generateProcessKey } from "../src/receipt.js";
import { methodFromRequest, specHash } from "../src/observatory.js";
import { openapiDoc } from "../src/openapi.js";
import { ASSERTION_SCHEMA, createApp, handleQuote, handleWitness } from "../src/server.js";

const URL = "https://example.com/pricing";
const FIXTURE = `<p>starter_price: $49/mo</p><p>rank: 7</p>`;
const PINNED = "f1123b280c37d47ed2e6049c95fab4c121b121d3b83b4e4083c8c859f8de5b76";
const BAD_EXTRACT = { reason: "bad_extract", expected: { "<key>": "number|string" }, example: { url: "https://outbid.sh/top", extract: { rank: "number" } } };
const retrieve = async () => ({ text: FIXTURE });
// Typenames an agent plausibly writes that fillExtract does not implement. Unchecked, each fell
// through to the string matcher and read rank 7 as "7". "Number" and "integer" stay refused in the
// flat dialect on purpose: accepting them would either change the canonical spec_hash or re-open the bug.
const BOGUS = ["bogus", "boolean", "Number", "integer"];
const fakeFacilitator = {
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }] }; },
  async verify() { throw new Error("fixture"); },
  async settle() { throw new Error("fixture"); },
};
async function withServer(deps, fn) {
  const server = createApp({ key: generateProcessKey(), retrieve, funnelDir: null, ...deps }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("flat dialect: only number|string, no alias — 400 bad_extract for anything else, pin unchanged", async () => {
  assert.deepEqual(EXTRACT_TYPES, ["number", "string"]);
  let n = 0;
  const spy = async () => (n++, { text: FIXTURE });
  for (const type of BOGUS) {
    assert.equal(normalizeExtract({ rank: type }), null, type);
    const q = await handleQuote({ url: URL, extract: { rank: type } }, { retrieve: spy });
    assert.deepEqual([q.status, q.json], [400, BAD_EXTRACT], type);
  }
  assert.equal(n, 0, "a shape error is answered before any retrieve");
  const canon = { starter_price: "number", currency: "string" };
  assert.equal(specHash(methodFromRequest({ url: URL, extract: canon })), PINNED);
  assert.equal(specHash(methodFromRequest({ url: URL, extract: normalizeExtract(canon) })), PINNED);
});

test('nested dialect: {"type":"integer"} reads as number — rank 7 with "rank < 100" is 200, not 422 assertion_failed', async () => {
  assert.deepEqual(normalizeExtract({ rank: { type: "integer" } }), { rank: "number" });
  const body = { url: URL, extract: { rank: { type: "integer" } }, assertion: "rank < 100" };
  const q = await handleQuote(body, { retrieve });
  assert.deepEqual([q.status, q.json], [200, { price_usdc: "0.01", replicas: 1, can_deliver: true }]);
  const w = await handleWitness(body, { retrieve, paid: true, key: generateProcessKey() });
  assert.equal(w.status, 200);
  assert.strictEqual(w.json.value.rank, 7, 'the number 7, never the string "7"');
  assert.deepEqual(w.json.method.extract, { rank: "number" }, "the receipt binds the canonical typename, never the alias");
  assert.equal(w.json.spec_hash, specHash(methodFromRequest({ ...body, extract: { rank: "number" } })), "one method, one identity across spellings");
  await withServer({}, async (base) => assert.equal((await post(base, "/quote", body)).status, 200));
});

test("nested dialect: an unknown type is 400 bad_extract too — the alias table is not a loophole, and the paid path mints nothing", async () => {
  let n = 0;
  const spy = async () => (n++, { text: FIXTURE });
  for (const spec of [{ type: "bogus" }, { type: "boolean" }, { type: "Number" }, { type: ["number"] }, { type: { type: "number" } }]) {
    assert.equal(normalizeExtract({ rank: spec }), null, JSON.stringify(spec));
    const q = await handleQuote({ url: URL, extract: { rank: spec } }, { retrieve: spy });
    assert.deepEqual([q.status, q.json], [400, BAD_EXTRACT], JSON.stringify(spec));
    const w = await handleWitness({ url: URL, extract: { rank: spec } }, { retrieve: spy, paid: true, key: generateProcessKey() });
    assert.deepEqual([w.status, w.json.receipt], [400, undefined], "no receipt over a type the method never ran");
  }
  assert.equal(n, 0, "retrieve never called");
});

test("openapi.json and the served bazaar inputSchema publish one extract schema, admitting exactly what the server admits", async () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const openapi = openapiDoc({}).paths["/quote"].post.requestBody.content["application/json"].schema;
  const { description, example, ...openapiExtract } = openapi.properties.extract;
  assert.deepEqual(openapiExtract, EXTRACT_SCHEMA, "openapi.json carries the shared extract schema");
  assert.match(description, /integer/, "the alias is advertised where it is accepted");
  const bazaar = await withServer({ facilitator: fakeFacilitator, paywall: { evmAddress: "0xabc0000000000000000000000000000000000001" } }, async (base) => {
    const res = await post(base, "/witness", { url: URL, extract: { rank: { type: "integer" } } });
    assert.equal(res.status, 402, "the paid door accepts the JSON-Schema dialect and challenges for payment");
    const challenge = JSON.parse(Buffer.from(res.headers.get("payment-required"), "base64").toString("utf8"));
    return challenge.extensions.bazaar.schema.properties.input.properties.body;
  });
  assert.deepEqual(bazaar.properties.extract, EXTRACT_SCHEMA, "the bazaar inputSchema on the wire carries the same extract schema");
  const { description: _d, example: _e, ...openapiAssertion } = openapi.properties.assertion;
  assert.deepEqual([openapiAssertion, bazaar.properties.assertion], [ASSERTION_SCHEMA, ASSERTION_SCHEMA], "and one assertion schema: string|null within one bound");
  const validators = { openapi: ajv.compile(openapi), bazaar: ajv.compile(bazaar) };
  const extracts = [
    { rank: "number" }, { rank: { type: "number" } }, { rank: { type: "integer" } }, { starter_price: "number", currency: { type: "string", description: "iso" } },
    { rank: "bogus" }, { rank: "integer" }, { rank: { type: "bogus" } }, { rank: 5 }, { rank: null }, {}, { "": "number" },
    { ["k".repeat(129)]: "number" }, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, "number"])),
  ];
  for (const extract of extracts) {
    const server = normalizeExtract(extract) !== null;
    for (const [name, validate] of Object.entries(validators)) {
      assert.equal(validate({ url: URL, extract }), server, `${name} contract vs server on ${JSON.stringify(extract).slice(0, 60)}`);
    }
  }
  // Round trip: the receipt's own method (assertion: null on a bare extract) is the documented next request body.
  const minted = await handleWitness({ url: URL, extract: { rank: "number" } }, { retrieve, paid: true, key: generateProcessKey() });
  assert.equal(minted.json.method.assertion, null, "a bare extract's receipt echoes assertion: null");
  for (const [name, validate] of Object.entries(validators)) {
    assert.equal(validate(minted.json.method) || validate.errors, true, `${name}: the receipt's own method is a valid next request body`);
    assert.equal(validate({ url: URL, extract: { rank: "number" }, assertion: 7 }), false, `${name}: a non-string assertion is still refused`);
  }
  assert.equal((await handleQuote(minted.json.method, { retrieve })).status, 200, "and the server re-quotes the receipt's method");
});

test("openapi documents the 400 body: reason enum with expected/example, one contract for /quote and /witness, matching the wire", async () => {
  const doc = openapiDoc({});
  const r400 = doc.paths["/quote"].post.responses["400"];
  assert.equal(r400, doc.paths["/witness"].post.responses["400"]);
  assert.match(r400.description, /never billed/i);
  const schema = r400.content["application/json"].schema;
  assert.deepEqual(schema.properties.reason.enum, ["bad_json", "bad_extract", "bad_assertion"]);
  assert.ok(schema.properties.expected && schema.properties.example, "the teaching fields are documented");
  const validate = new Ajv({ strict: false }).compile(schema);
  await withServer({}, async (base) => {
    for (const body of [{ url: URL, extract: { rank: "bogus" } }, { url: URL, extract: { rank: "number" }, assertion: 7 }]) {
      const res = await post(base, "/quote", body);
      assert.equal(res.status, 400);
      assert.ok(validate(await res.json()), `wire 400 for ${JSON.stringify(body)} fits the documented schema`);
    }
  });
});
