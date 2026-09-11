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
