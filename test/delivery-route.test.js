import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";

import { createHostApp } from "../src/listen.js";
import { openapiDoc } from "../src/openapi.js";
import { canonical, generateProcessKey } from "../src/receipt.js";
import { DELIVERY_VERDICTS, EXAMPLE_BODY, MODES, handleDeliveryAttest } from "../src/routes/delivery.js";

/** The evidence model lives in another lane (src/delivery.js). This fake answers the router's
 *  contract — attest({offer, request, observation, seller_verification, verifier, max_staleness_seconds}) -> unsigned receipt
 *  the model emits, so the tests pin what the ROUTE does with a receipt, not how one is graded. */
const LIMITS = Object.freeze({
  proves: ["fake: the artifact was presented by the buyer, not observed from the seller."],
  never: ["fake: funds are recoverable", "fake: the seller is honest in general"],
});
function fakeAttest({ verdict = "delivered", reasons = [], downgrade = false, receipt } = {}) {
  const calls = [];
  const attest = async ({ offer, request, observation, seller_verification, verifier, max_staleness_seconds }) => {
    const opts = { verifier, maxStalenessSeconds: max_staleness_seconds };
    calls.push({ offer, request, observation, seller_verification, verifier, max_staleness_seconds });
    if (receipt !== undefined) return typeof receipt === "function" ? receipt() : receipt;
    return {
      schema: "delivery-attestation/v0",
      offer_hash: "o".repeat(64),
      request_hash: "r".repeat(64),
      artifact_hash: observation.artifact === null ? null : "a".repeat(64),
      delivery_verdict: verdict,
      reasons,
      evidence_mode: downgrade ? "buyer_attested" : observation.mode,
      declared_mode: observation.mode,
      observed_at: observation.observed_at,
      requested_at: request.requested_at,
      settlement_ref: request.settlement_ref,
      http_status: observation.http_status,
      seller_signature_present: Boolean(observation.seller_signature),
      verifier: opts.verifier,
      spec_origin: offer.spec_origin ?? "buyer_authored",
      resource_url: offer.resource_url,
      deliverable_class: offer.deliverable_class,
      price_usdc: offer.price_usdc,
      this_receipt_proves: [...LIMITS.proves],
      this_receipt_does_not_prove: [...LIMITS.never],
    };
  };
  return { attest, calls };
}

async function withServer(fn, { attest, importModel } = {}) {
  const server = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-delivery-")) }, { attest, importModel }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (base, body, headers = { "content-type": "application/json" }) =>
  fetch(`${base}/delivery/attest`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const example = () => structuredClone(EXAMPLE_BODY);

const verifyOffline = (data, pubkeyB64) => {
  const { receipt, ...rest } = data;
  const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(canonical(rest)), key, Buffer.from(receipt, "base64"));
};

test("POST /delivery/attest: signed receipt bare (no envelope), model fields verbatim, verifiable against GET /pubkey", async () => {
  const fake = fakeAttest();
  await withServer(async (base) => {
    const body = example();
    body.observation.mode = "seller_integrated";
    body.observation.seller_signature = { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og", signature: "z".repeat(88) };
    const res = await post(base, body);
    assert.equal(res.status, 200);
    const json = await res.json();
        const data = json;

    // Nothing the model emitted is dropped, renamed, or summarised: the limits ride verbatim.
    assert.equal(fake.calls.length, 1);
    const emitted = await fake.attest({ ...fake.calls[0] });
    for (const [k, v] of Object.entries(emitted)) assert.deepEqual(data[k], v, `receipt field ${k} passes through untouched`);
    assert.deepEqual(data.this_receipt_proves, LIMITS.proves);
    assert.deepEqual(data.this_receipt_does_not_prove, LIMITS.never);
    assert.equal(data.delivery_verdict, "delivered");
    assert.equal(data.evidence_mode, "seller_integrated");
    assert.equal(data.evidence_mode, "seller_integrated");
    assert.deepEqual(Object.keys(data).filter((k) => !(k in emitted)).sort(), ["attested_at", "receipt"], "the route adds exactly attested_at and the signature");
    assert.match(data.attested_at, /^\d{4}-\d{2}-\d{2}T/);

    // The signature covers every field, and GET /pubkey is enough to check it offline.
    const { pubkey } = await (await fetch(`${base}/pubkey`)).json();
    assert.equal(verifyOffline(data, pubkey), true);
    assert.equal(verifyOffline({ ...data, delivery_verdict: "contradicted" }, pubkey), false, "a flipped verdict does not verify");
    assert.equal(verifyOffline({ ...data, this_receipt_does_not_prove: [] }, pubkey), false, "stripped limits do not verify");

    // The model received the normalised inputs and the host identity.
    const call = fake.calls[0];
    assert.deepEqual(call.offer, body.offer);
    assert.deepEqual(call.request, body.request);
    assert.deepEqual(call.observation, { ...body.observation, notes: [] });
    assert.equal(call.verifier, "witness.outbid.sh");
    assert.equal(call.max_staleness_seconds, 300);

    // The envelope is gone; the receipt names its own verifier, which is the field
    // that actually matters to a holder checking it against that host's /pubkey.
    assert.equal(data.verifier, "witness.outbid.sh");
    assert.ok(data.attested_at);
  }, { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) });
});

test("unable_to_verify is a receipt (200), never an HTTP error; every verdict signs", async () => {
  const fake = fakeAttest({ verdict: "unable_to_verify", reasons: ["no artifact was presented or observed"] });
  await withServer(async (base) => {
    const body = example();
    body.observation.artifact = null;
    body.observation.http_status = 503;
    body.observation.mode = "verifier_observed";
    const res = await post(base, body);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.delivery_verdict, "unable_to_verify");
    assert.deepEqual(data.reasons, ["no artifact was presented or observed"]);
    assert.equal(data.artifact_hash, null);
    assert.ok(data.receipt, "inability to verify is signed like any other result");
  }, { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) });
  for (const verdict of DELIVERY_VERDICTS) {
    const f = fakeAttest({ verdict });
    await withServer(async (base) => {
      const res = await post(base, example());
      assert.equal(res.status, 200, verdict);
      assert.equal((await res.json()).delivery_verdict, verdict);
    }, { attest: f.attest });
  }
});

test("a seller_integrated claim the model downgrades keeps both modes visible", async () => {
  const fake = fakeAttest({ downgrade: true });
  await withServer(async (base) => {
    const body = example();
    body.observation.mode = "seller_integrated";
    const data = await (await post(base, body)).json();
    assert.equal(data.declared_mode, "seller_integrated");
    assert.equal(data.evidence_mode, "buyer_attested");
  }, { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) });
});

test("unreadable bodies are 400 bad_json (bare error body); a JSON array is bad_body; the model is never called", async () => {
  const fake = fakeAttest();
  await withServer(async (base) => {
    for (const [body, headers] of [
      ["{not json", undefined],
      ['"42"', undefined],
      [JSON.stringify(example()), { "content-type": "text/plain" }],
    ]) {
      const res = await post(base, body, headers);
      assert.equal(res.status, 400);
      const json = await res.json();
      assert.equal(json.reason, "bad_json");
      assert.ok(Array.isArray(json.details.problems));
      assert.equal(json.verifier !== undefined, true);
    }
    const arr = await post(base, "[]");
    assert.equal(arr.status, 400);
    const json = await arr.json();
    assert.equal(json.reason, "bad_body");
    assert.deepEqual(Object.keys(json.details.expected).sort(), ["observation", "offer", "request"]);
    assert.deepEqual(json.details.example, EXAMPLE_BODY);
  }, { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) });
  assert.equal(fake.calls.length, 0);
});

test("shape errors are specific, name the field, teach the fix, and never reach the model", async () => {
  const fake = fakeAttest();
  const cases = [
    ["bad_offer", /offer: object required/, (b) => { delete b.offer; }],
    ["bad_offer", /offer\.price_usdc/, (b) => { b.offer.price_usdc = "0.28"; }],
    ["bad_offer", /required_fields\.query: type must be one of/, (b) => { b.offer.spec.required_fields.query = "text"; }],
    ["bad_offer", /offer\.spec: object required/, (b) => { b.offer.spec = null; }],
    ["bad_paid_request", /request: object required/, (b) => { b.request = "paid"; }],
    ["bad_paid_request", /request\.request_body: object required/, (b) => { b.request.request_body = ["q"]; }],
    ["bad_paid_request", /request\.requested_at/, (b) => { delete b.request.requested_at; }],
    ["bad_paid_request", /request\.settlement_ref/, (b) => { b.request.settlement_ref = 5; }],
    ["bad_observation", /observation\.artifact: key required; send null/, (b) => { delete b.observation.artifact; }],
    ["bad_observation", /observation\.http_status/, (b) => { b.observation.http_status = "200"; }],
    ["bad_observation", /observation\.observed_at/, (b) => { b.observation.observed_at = 1757563200; }],
    ["bad_observation", /observation\.notes/, (b) => { b.observation.notes = "late"; }],
    ["bad_mode", /"verifier_paid" is not an evidence mode/, (b) => { b.observation.mode = "verifier_paid"; }],
  ];
  await withServer(async (base) => {
    for (const [reason, problem, mutate] of cases) {
      const body = example();
      mutate(body);
      const res = await post(base, body);
      assert.equal(res.status, 400, reason);
      const json = await res.json();
      assert.equal(json.reason, reason);
      assert.ok(json.details.problems.some((p) => problem.test(p)), `${reason}: ${JSON.stringify(json.details.problems)}`);
      assert.ok(json.details.expected !== undefined, `${reason} carries the expected shape`);
      assert.ok(json.details.example !== undefined, `${reason} carries an example`);
    }
    const bad = example();
    bad.observation.mode = "verifier_paid";
    assert.deepEqual((await (await post(base, bad)).json()).details.expected, [...MODES]);
  }, { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) });
  assert.equal(fake.calls.length, 0, "no shape error reaches the model");
});

test("a receipt without its limits, without a verdict, or pre-signed is refused (500 attest_invalid), not patched", async () => {
  const key = generateProcessKey();
  const deps = { key, verifier: "test", log: () => {} };
  const good = await fakeAttest().attest({ offer: EXAMPLE_BODY.offer, request: EXAMPLE_BODY.request, observation: { ...EXAMPLE_BODY.observation, notes: [] }, seller_verification: null, verifier: "test", max_staleness_seconds: 300 });
  for (const [label, receipt] of [
    ["no limits", (() => { const r = { ...good }; delete r.this_receipt_proves; return r; })()],
    ["empty never-proves", { ...good, this_receipt_does_not_prove: [] }],
    ["unknown verdict", { ...good, delivery_verdict: "ok" }],
    ["pre-signed", { ...good, receipt: "abc" }],
    ["not an object", "delivered"],
  ]) {
    const out = await handleDeliveryAttest(example(), { ...deps, attest: async () => receipt });
    assert.equal(out.status, 500, label);
    assert.equal(out.json.reason, "attest_invalid", label);
    assert.equal(out.json.receipt, undefined, `${label}: nothing was signed`);
  }
  const ok = await handleDeliveryAttest(example(), { ...deps, attest: async () => good });
  assert.equal(ok.status, 200);
  assert.equal(verifyOffline(ok.json, key.publicKey.export({ type: "spki", format: "der" }).toString("base64")), true);
});

test("a throwing model is 500 attest_failed; nothing is signed", async () => {
  const out = await handleDeliveryAttest(example(), { key: generateProcessKey(), verifier: "test", log: () => {}, attest: async () => { throw new Error("boom"); } });
  assert.equal(out.status, 500);
  assert.equal(out.json.reason, "attest_failed");
  assert.equal(out.json.receipt, undefined, "nothing was signed");
  assert.doesNotMatch(JSON.stringify(out.json), /boom/, "internal error text stays in the log");
});

test("no model in the process is 503 attest_not_wired; a lazily imported model is used and memoised", async () => {
  await withServer(async (base) => {
    const res = await post(base, example());
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.reason, "attest_not_wired");
  }, { importModel: async () => { throw Object.assign(new Error("Cannot find module"), { code: "ERR_MODULE_NOT_FOUND" }); } });

  const fake = fakeAttest();
  let imports = 0;
  await withServer(async (base) => {
    for (let i = 0; i < 2; i++) assert.equal((await post(base, example())).status, 200);
  }, { importModel: async () => { imports += 1; return { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) }; } });
  assert.equal(imports, 1, "the model module is imported once");
  assert.equal(fake.calls.length, 2);
});

test("a body over the limit is 413 body_too_large (bare error body)", async () => {
  const fake = fakeAttest();
  await withServer(async (base) => {
    const body = example();
    body.observation.artifact = { blob: "x".repeat(300 * 1024) };
    const res = await post(base, body);
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.reason, "body_too_large");
  }, { attest: fake.attest, verifySellerSignature: async () => ({ verified: true, reason: "seller_signature_verified", rail: "solana", checked: ["signer_matches_payto"], signer: "7VCU12sqMGTpiiwHPsrY2tfNDFqCj53htba1RX1fT5og" }) });
  assert.equal(fake.calls.length, 0);
});

test("openapi documents /delivery/attest as the wire: bare 200 receipt, bare 4xx/5xx, no envelope", () => {
  const doc = openapiDoc({});
  const op = doc.paths["/delivery/attest"].post;
  assert.deepEqual(op.security, [], "no auth in this lane, and the doc says so");
  assert.deepEqual(Object.keys(op.responses).sort(), ["200", "400", "413", "500", "503"]);
  assert.match(op.description, /unable_to_verify, not an error/);
  assert.match(op.description, /this_receipt_proves/);
  assert.doesNotMatch(op.description, /in the same envelope|Verify data\.receipt|request_metadata/);
  const req = op.requestBody.content["application/json"];
  assert.deepEqual(req.example, EXAMPLE_BODY);
  assert.deepEqual(req.schema.required, ["offer", "request", "observation"]);
  assert.deepEqual(req.schema.properties.observation.properties.mode.enum, [...MODES]);
  assert.deepEqual(req.schema.properties.offer.properties.spec_origin.enum, ["buyer_authored", "seller_published", "catalog_observed"]);
  const ok = op.responses["200"].content["application/json"].schema;
  assert.equal(ok.properties?.success, undefined, "200 is the receipt, not {success, data, request_metadata}");
  assert.equal(ok.properties?.data, undefined);
  assert.equal(ok.properties?.request_metadata, undefined);
  for (const f of ["delivery_verdict", "evidence_mode", "declared_mode", "spec_origin", "this_receipt_proves", "this_receipt_does_not_prove", "attested_at", "receipt"]) {
    assert.ok(ok.required.includes(f), `receipt schema requires ${f}`);
  }
  assert.deepEqual(ok.properties.delivery_verdict.enum, [...DELIVERY_VERDICTS]);
  const reasons = (code) => op.responses[code].content["application/json"].schema.properties.reason.enum;
  const failRequired = (code) => op.responses[code].content["application/json"].schema.required;
  for (const code of ["400", "413", "500", "503"]) {
    assert.deepEqual(failRequired(code).sort(), ["details", "reason", "served_at", "verifier"]);
  }
  assert.deepEqual(reasons("400"), ["bad_json", "bad_body", "bad_offer", "bad_paid_request", "bad_observation", "bad_mode"]);
  assert.deepEqual(reasons("413"), ["body_too_large"]);
  assert.deepEqual(reasons("500"), ["attest_failed", "attest_invalid", "internal_error"]);
  assert.deepEqual(reasons("503"), ["attest_not_wired"]);
  const all = ["400", "413", "500", "503"].flatMap(reasons);
  assert.equal(new Set(all).size, all.length, "reasons are distinct across statuses");
});

test("HTTP path forwards offer.spec_origin so the signed field is not always buyer_authored", async () => {
  const fake = fakeAttest();
  const body = example();
  body.offer = { ...body.offer, spec_origin: "seller_published" };
  const out = await handleDeliveryAttest(body, {
    attest: fake.attest,
    key: generateProcessKey(),
    verifier: "witness.outbid.sh",
    now: () => "2026-09-11T04:00:21.000Z",
    verifySellerSignature: async () => ({ verified: false, reason: "signature_absent", rail: null, checked: [] }),
  });
  assert.equal(out.status, 200);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].offer.spec_origin, "seller_published");
  assert.equal(out.json.spec_origin, "seller_published");
});
