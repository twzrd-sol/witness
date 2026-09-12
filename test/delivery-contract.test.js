/**
 * The seam between what /delivery/attest DOCUMENTS and what it SERVES.
 *
 * This file exists because both existing suites passed while the two disagreed.
 * test/openapi.test.js asserted the document described a {success, data,
 * request_metadata} envelope; test/delivery-route.test.js asserted the route
 * returned a bare receipt. Neither was wrong about the thing it checked, and
 * nothing checked that they agreed - so the published contract described a
 * response shape the server had stopped returning, and a client coding against
 * the document would have destructured `data` off a receipt.
 *
 * A documented contract that disagrees with the served one is worse than an
 * undocumented route: the lie is machine-readable.
 */

import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createPublicKey, verify } from "node:crypto";

import { canonical, generateProcessKey, pubkeyB64 } from "../src/receipt.js";
import { openapiDoc } from "../src/openapi.js";
import { createDeliveryRouter } from "../src/routes/delivery.js";
import { SPEC_ORIGINS } from "../src/delivery.js";
import { SIGNING_DOMAIN } from "../src/delivery-signature.js";

const KEY = generateProcessKey();

async function withServer(fn) {
  const app = express();
  app.use(createDeliveryRouter({ key: KEY, verifier: "witness.test", log: () => {} }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const BODY = {
  offer: {
    resource_url: "https://api.example/search",
    deliverable_class: "data_json",
    price_usdc: 0.28,
    spec: { required_fields: { query: "string", results: "array" } },
  },
  request: { request_body: { q: "acme" }, settlement_ref: "5tGsKx", requested_at: "2026-09-11T04:00:00+00:00" },
  observation: { artifact: { query: "acme", results: [{ n: 1 }] }, observed_at: "2026-09-11T04:00:10+00:00", mode: "buyer_attested", http_status: 200 },
};

const post = (base, body) =>
  fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const schemaFor = (status) =>
  openapiDoc({ PUBLIC_BASE_URL: "https://witness.test" })
    .paths["/delivery/attest"].post.responses[status].content["application/json"].schema;

test("the documented 200 shape is the shape actually served", async () => {
  const doc = schemaFor("200");
  const served = await withServer(async (base) => (await post(base, structuredClone(BODY))).json());

  // Every field the document says is required must actually be there.
  for (const key of doc.required ?? []) {
    assert.ok(Object.hasOwn(served, key), `documented as required but not served: ${key}`);
  }
  // ...and the reverse, which is the direction that let six fields ship
  // undocumented: everything the route SERVES must be described. Drift detected
  // in one direction only is drift that ships.
  const documented = Object.keys(doc.properties ?? {});
  const undocumented = Object.keys(served).filter((k) => !documented.includes(k));
  assert.deepEqual(undocumented, [], `served but undocumented: ${undocumented.join(", ")}`);

  // And the document must not describe a wrapper the route does not send. This is
  // the exact drift that shipped: the schema kept `success`/`data` long after the
  // route returned the receipt bare.
  for (const wrapper of ["success", "data", "request_metadata", "error"]) {
    assert.equal(Object.hasOwn(doc.properties ?? {}, wrapper), false, `document still describes an envelope key: ${wrapper}`);
    assert.equal(Object.hasOwn(served, wrapper), false, `route serves an envelope key: ${wrapper}`);
  }
});

test("the documented failure shape is the shape actually served", async () => {
  const doc = schemaFor("400");
  const served = await withServer(async (base) => (await post(base, { offer: 1, request: 2, observation: 3 })).json());
  for (const key of doc.required ?? []) {
    assert.ok(Object.hasOwn(served, key), `documented as required on a 400 but not served: ${key}`);
  }
  assert.equal(Object.hasOwn(served, "success"), false);
  assert.ok(Array.isArray(served.details.problems));
});

test("a declared spec_origin survives the route and is signed into the receipt", async () => {
  // It did not. A four-field destructure dropped it, so every receipt this route
  // issued read buyer_authored regardless of what the caller declared - quietly
  // defeating the one field that lets a consumer discount a spec the accuser wrote.
  for (const origin of SPEC_ORIGINS) {
    const body = structuredClone(BODY);
    body.offer.spec_origin = origin;
    const served = await withServer(async (base) => (await post(base, body)).json());
    assert.equal(served.spec_origin, origin, `spec_origin ${origin} was dropped between the request and the receipt`);
  }
});

test("an undeclared spec_origin defaults to buyer_authored, and a bogus one is refused", async () => {
  const served = await withServer(async (base) => (await post(base, structuredClone(BODY))).json());
  assert.equal(served.spec_origin, "buyer_authored", "silence about provenance is not a claim of seller backing");

  const bogus = structuredClone(BODY);
  bogus.offer.spec_origin = "seller_published_probably";
  const res = await withServer(async (base) => post(base, bogus));
  assert.equal(res.status, 400, "an unknown provenance must be refused, not silently downgraded");
});

test("spec_origin is inside the signature, not decoration beside it", async () => {
  const body = structuredClone(BODY);
  body.offer.spec_origin = "seller_published";
  const served = await withServer(async (base) => (await post(base, body)).json());

  const pub = createPublicKey({ key: Buffer.from(pubkeyB64(KEY), "base64"), format: "der", type: "spki" });
  const check = (doc) => {
    const { receipt, ...rest } = doc;
    return verify(null, Buffer.from(canonical(rest)), pub, Buffer.from(receipt, "base64"));
  };
  assert.equal(check(served), true);
  assert.equal(check({ ...served, spec_origin: "buyer_authored" }), false, "provenance could be edited after signing");
});

// ---------------------------------------------------------------------------
// The REQUEST direction. Everything above this line binds the documented
// RESPONSE to the served one. That is the half #31 fixed, and it is not the
// half that broke next: the document typed observation.seller_signature as
// `string | null` while the route had always required
// {network, payTo, signature}, and offer.spec_origin was accepted, validated
// and signed while appearing on no request surface at all - not the schema, not
// the route's own 400 `expected`, not the reference integrations. A client
// coding against the document could not have produced a request the route
// accepts in the strong mode, and the two reference examples that were supposed
// to show the way had rotted into a signing scheme the route never accepted.
//
// Response-only drift detection is drift that ships in the other direction.

/** The route's own statement of what it accepts, read off the wire rather than imported. */
const expectedShapes = () =>
  withServer(async (base) => (await post(base, [])).json()).then((r) => {
    assert.equal(r.reason, "bad_body", "a non-object body should return the full expected shape");
    return r.details.expected;
  });

const requestSchema = () =>
  openapiDoc({ PUBLIC_BASE_URL: "https://witness.test" })
    .paths["/delivery/attest"].post.requestBody.content["application/json"].schema;

test("every member the route names in `expected` is documented, and every documented one is named", async () => {
  const shapes = await expectedShapes();
  const documented = requestSchema().properties;
  for (const member of ["offer", "request", "observation"]) {
    const served = Object.keys(shapes[member]).sort();
    const doc = Object.keys(documented[member].properties ?? {}).sort();
    assert.deepEqual(doc, served, `${member}: documented fields and the fields the route tells a caller to send disagree`);
  }
});

test("the documented request example is a request the route actually accepts", async () => {
  // The example is what most integrators copy. If it does not round-trip, the
  // document is teaching a shape the server refuses.
  const example = requestSchema().example ?? openapiDoc({ PUBLIC_BASE_URL: "https://witness.test" })
    .paths["/delivery/attest"].post.requestBody.content["application/json"].example;
  const res = await withServer(async (base) => post(base, structuredClone(example)));
  assert.equal(res.status, 200, "the documented example was refused by the route it documents");
});

test("seller_signature is documented as the object the route requires, not a string", async () => {
  const sig = requestSchema().properties.observation.properties.seller_signature;
  assert.deepEqual(sig.type, ["object", "null"], "documenting it as a string describes a request the route refuses");
  assert.deepEqual([...sig.required].sort(), ["network", "payTo", "signature"], "the binding fields are what make a signature verifiable");

  // Documented as an object because that is what is enforced. A bare string -
  // exactly what the old document described - must be refused.
  const body = structuredClone(BODY);
  body.observation.seller_signature = "ZmFrZSBzaWduYXR1cmU";
  const res = await withServer(async (base) => post(base, body));
  assert.equal(res.status, 400, "a string signature must be refused, not silently ignored");

  // ...and each documented-required key must actually be required, by name.
  for (const key of sig.required) {
    const partial = structuredClone(BODY);
    partial.observation.seller_signature = { network: "solana", payTo: "x", signature: "y" };
    delete partial.observation.seller_signature[key];
    const r = await withServer(async (base) => (await post(base, partial)).json());
    assert.equal(r.reason, "bad_observation", `omitting seller_signature.${key} was accepted`);
    assert.ok(
      r.details.problems.some((p) => p.includes(`seller_signature.${key}`)),
      `omitting seller_signature.${key} was refused without naming it: ${JSON.stringify(r.details.problems)}`,
    );
  }
});

test("the documented spec_origin values are exactly the ones the route accepts", async () => {
  const documented = requestSchema().properties.offer.properties.spec_origin;
  assert.deepEqual([...documented.enum].sort(), [...SPEC_ORIGINS].sort());
  assert.equal(documented.default, "buyer_authored", "the documented default must match the receipt's default");
  for (const origin of documented.enum) {
    const body = structuredClone(BODY);
    body.offer.spec_origin = origin;
    const res = await withServer(async (base) => post(base, body));
    assert.equal(res.status, 200, `documented spec_origin ${origin} was refused`);
  }
});

test("every field documented as required on a request member is required by the route", async () => {
  // Optional-in-practice but documented-required is the same class of lie as an
  // undocumented served field, just pointed the other way.
  const documented = requestSchema().properties;
  for (const member of ["offer", "request", "observation"]) {
    for (const key of documented[member].required ?? []) {
      const body = structuredClone(BODY);
      delete body[member][key];
      const res = await withServer(async (base) => post(base, body));
      assert.equal(res.status, 400, `${member}.${key} is documented as required but the route accepted its absence`);
    }
  }
});

test("the document names the real signing domain, spelled out, not a placeholder", async () => {
  // It named `${SIGNING_DOMAIN}` - inside a double-quoted string, so the
  // placeholder shipped verbatim and the published document instructed sellers
  // to sign over the characters of the variable name. Nothing imports the
  // constant here on purpose: src/routes/delivery.js loads the verifier (and
  // viem with it) lazily, and the document should not undo that at boot. This
  // test is what keeps the spelled-out copy honest instead.
  const sig = requestSchema().properties.observation.properties.seller_signature;
  assert.ok(sig.description.includes(SIGNING_DOMAIN), `the documented signing domain is not ${SIGNING_DOMAIN}: ${sig.description}`);
  assert.ok(!/\$\{/.test(sig.description), "an uninterpolated placeholder shipped in the published description");

  // And the same for every description on the route: a placeholder anywhere is
  // a published lie, just a quieter one.
  const post = openapiDoc({ PUBLIC_BASE_URL: "https://witness.test" }).paths["/delivery/attest"].post;
  const placeholders = [];
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && /\$\{/.test(v)) placeholders.push(`${at}.${k}`);
      else if (v && typeof v === "object") walk(v, `${at}.${k}`);
    }
  };
  walk(post, "post");
  assert.deepEqual(placeholders, [], `uninterpolated placeholders in the published document: ${placeholders.join(", ")}`);
});
