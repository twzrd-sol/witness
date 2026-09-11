#!/usr/bin/env node
/**
 * Reference BUYER integration for delivery attestation.
 *
 * You paid an x402 seller and got something back. This is how you turn that
 * into a signed delivery receipt, and how you check the receipt yourself.
 *
 *   1. Keep what you paid for: the offer you accepted, the exact request you
 *      sent, the settlement ref, and the response AS RECEIVED (status, headers,
 *      body). Do not "clean up" the body: the artifact is hashed.
 *   2. POST /delivery/attest with {offer, request, observation}. If the seller
 *      sent an x-delivery-signature header, declare mode seller_integrated and
 *      pass the header through; otherwise buyer_attested.
 *   3. Verify data.receipt offline against GET /pubkey (one fetch, then never
 *      again for that key).
 *   4. Read this_receipt_proves / this_receipt_does_not_prove BEFORE acting on
 *      delivery_verdict. A buyer_attested "contradicted" is your complaint on
 *      the record, not proof of the seller's fault.
 *
 * Runs against WITNESS_BASE when set. Otherwise it boots the host in-process on
 * loopback (no network). In-process it uses src/delivery.js when that module is
 * present; until it lands, a STAND-IN grader is injected that grades NOTHING
 * (every verdict unable_to_verify, and the limits say so) so the mechanics can
 * be exercised now without pretending a verdict was reached.
 *
 *   node examples/delivery-buyer.mjs
 *   WITNESS_BASE=https://witness.outbid.sh node examples/delivery-buyer.mjs
 */
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SIGNATURE_HEADER, SUBJECT, canonical, emitResponse, newSellerIdentity, requestHash, sha256 } from "./delivery-seller.mjs";

const say = (...a) => console.log(...a);
const block = (v) => JSON.stringify(v, null, 2).replace(/^/gm, "  ");

/** Stand-in for src/delivery.js: binds the hashes, grades nothing, and says so in the receipt. */
const STAND_IN = async (offer, request, observation, { verifier }) => ({
  schema: "delivery-attestation/v0",
  offer_hash: sha256(offer),
  request_hash: requestHash(request),
  artifact_hash: observation.artifact === null ? null : sha256(observation.artifact),
  delivery_verdict: "unable_to_verify",
  reasons: ["stand-in grader: src/delivery.js is not in this process, so the artifact was not graded"],
  evidence_mode: observation.mode === "seller_integrated" && !observation.seller_signature ? "buyer_attested" : observation.mode,
  declared_mode: observation.mode,
  observed_at: observation.observed_at,
  requested_at: request.requested_at,
  settlement_ref: request.settlement_ref,
  http_status: observation.http_status,
  seller_signature_present: Boolean(observation.seller_signature),
  verifier,
  resource_url: offer.resource_url,
  deliverable_class: offer.deliverable_class,
  price_usdc: offer.price_usdc,
  this_receipt_proves: ["nothing: produced by the example's stand-in grader, not the evidence model"],
  this_receipt_does_not_prove: ["anything about delivery"],
});

async function boot() {
  if (process.env.WITNESS_BASE) return { base: process.env.WITNESS_BASE.replace(/\/$/, ""), model: "remote", close: async () => {} };
  const { createApp } = await import("../src/server.js");
  const { generateProcessKey } = await import("../src/receipt.js");
  let attest = STAND_IN;
  let model = "stand-in (src/delivery.js not present)";
  try {
    ({ attest } = await import("../src/delivery.js"));
    model = "src/delivery.js";
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
  }
  const app = createApp({ key: generateProcessKey(), observationsDir: mkdtempSync(path.join(os.tmpdir(), "wit-buyer-")), attest, publicBaseUrl: "http://127.0.0.1" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${server.address().port}`, model, close: () => new Promise((r) => server.close(r)) };
}

/** Step 3: offline verification. Drop `receipt`, deep-canonical JSON, ed25519 against GET /pubkey. */
export function verifyReceiptOffline(data, pubkeyB64) {
  const { receipt, ...rest } = data;
  const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(canonical(rest)), key, Buffer.from(receipt, "base64"));
}

/** Step 2: build the observation from the response exactly as received. */
export function observationFrom(response, observed_at) {
  const signature = response.headers[SIGNATURE_HEADER] ?? null;
  return {
    artifact: response.body == null ? null : JSON.parse(response.body),
    observed_at,
    mode: signature ? "seller_integrated" : "buyer_attested",
    http_status: response.status,
    seller_signature: signature,
  };
}

async function attest(base, body) {
  const res = await fetch(`${base}/delivery/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

async function main() {
  const host = await boot();
  const failures = [];
  const expect = (cond, label) => { say(`  ${cond ? "ok " : "BAD"} ${label}`); if (!cond) failures.push(label); };
  try {
    say("verifier      :", host.base);
    say("evidence model:", host.model);

    // Step 1: what the buyer holds after paying. The seller side is simulated locally by the
    // seller reference (in real life `response` is the HTTP response you received).
    const offer = { resource_url: SUBJECT.resource_url, deliverable_class: SUBJECT.deliverable_class, price_usdc: SUBJECT.price_usdc, spec: SUBJECT.spec };
    const request = { request_body: { query: "acme corp" }, settlement_ref: "5tGsKx8n3v2Q1w9E7r6T5y4U3i2O1p0A9s8D7f6G5h4J3k2L1z0X9c8V7b6N5m4", requested_at: "2026-09-11T04:00:00Z" };
    const artifact = { query: "acme corp", results: [{ name: "Acme Corp", domain: "acme.example" }], result_count: 1 };
    const seller = newSellerIdentity(SUBJECT.pay_to);
    const signedResponse = emitResponse(seller, request, artifact, "2026-09-11T04:00:03Z");
    const unsignedResponse = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(artifact) };

    const { pubkey } = await (await fetch(`${host.base}/pubkey`)).json();
    say("verifier pubkey:", pubkey);

    // A: the seller signed at emit time -> seller_integrated.
    say("\nA. seller signed its response (x-delivery-signature present)");
    const a = await attest(host.base, { offer, request, observation: observationFrom(signedResponse, "2026-09-11T04:00:04Z") });
    say(`  HTTP ${a.status}  success=${a.json.success}`);
    expect(a.status === 200 && a.json.success === true, "receipt issued");
    const ra = a.json.data;
    say(`  delivery_verdict=${ra.delivery_verdict}  evidence_mode=${ra.evidence_mode}  declared_mode=${ra.declared_mode}`);
    say("  reasons:", JSON.stringify(ra.reasons));
    say("  binds  : offer_hash", ra.offer_hash.slice(0, 16) + "...", "request_hash", ra.request_hash.slice(0, 16) + "...", "artifact_hash", String(ra.artifact_hash).slice(0, 16) + "...");
    expect(ra.request_hash === requestHash(request), "request_hash matches what the buyer can recompute");
    expect(ra.artifact_hash === sha256(artifact), "artifact_hash matches the artifact as received");
    expect(verifyReceiptOffline(ra, pubkey), "signature verifies offline against GET /pubkey");
    expect(!verifyReceiptOffline({ ...ra, delivery_verdict: "delivered" }, pubkey), "a flipped verdict fails verification");
    expect(!verifyReceiptOffline({ ...ra, this_receipt_does_not_prove: [] }, pubkey), "stripped limits fail verification");
    say("  this_receipt_proves:");
    say(block(ra.this_receipt_proves));
    say("  this_receipt_does_not_prove:");
    say(block(ra.this_receipt_does_not_prove));
    say("  request_metadata:", JSON.stringify(a.json.request_metadata));

    // B: no seller signature -> buyer_attested. Same artifact, weaker evidence, and the receipt says so.
    say("\nB. seller did not sign (no header) -> buyer_attested");
    const b = await attest(host.base, { offer, request, observation: observationFrom(unsignedResponse, "2026-09-11T04:00:04Z") });
    expect(b.status === 200 && b.json.data.evidence_mode === "buyer_attested", "buyer_attested receipt issued");
    say(`  delivery_verdict=${b.json.data.delivery_verdict}  evidence_mode=${b.json.data.evidence_mode}`);
    expect(verifyReceiptOffline(b.json.data, pubkey), "signature verifies offline");

    // C: nothing came back (timeout / 5xx). artifact:null is graded, not refused.
    say("\nC. nothing came back (artifact: null, http_status 503) -> a receipt, not an HTTP error");
    const c = await attest(host.base, { offer, request, observation: { artifact: null, observed_at: "2026-09-11T04:00:30Z", mode: "buyer_attested", http_status: 503, seller_signature: null } });
    expect(c.status === 200 && c.json.success === true, "HTTP 200 with a signed receipt");
    expect(c.json.data.delivery_verdict === "unable_to_verify", "delivery_verdict is unable_to_verify");
    expect(c.json.data.artifact_hash === null, "artifact_hash is null");
    say("  reasons:", JSON.stringify(c.json.data.reasons));

    // D: a request the route cannot READ is refused (400, same envelope, specific reason). Contrast with C.
    say("\nD. a malformed submission (artifact key omitted) -> 400 in the envelope, nothing signed");
    const d = await attest(host.base, { offer, request, observation: { observed_at: "2026-09-11T04:00:30Z", mode: "buyer_attested" } });
    expect(d.status === 400 && d.json.success === false && d.json.error.reason === "bad_observation", "400 bad_observation");
    say("  problems:", JSON.stringify(d.json.error.details.problems));
    expect(d.json.data === null, "data is null on refusal");

    say("\nhow to act on a receipt");
    say("  - delivered / contradicted / incomplete are answers about the artifact vs the offer spec; read evidence_mode first");
    say("  - buyer_attested proves what YOU presented satisfied or did not satisfy the spec; it is a complaint on the record");
    say("  - seller_integrated proves the seller emitted it for this request; it does not prove you received it");
    say("  - unable_to_verify is not a fault finding either way; do not treat it as delivered or as not delivered");
    say("  - the verifier does not check the seller's signature for you here; verifySellerSignature() in the seller reference does");
    say(`\n${failures.length ? "FAILED" : "ok"}: ${failures.length ? failures.join("; ") : "attestation, offline verification, and refusal behave as expected"}`);
    return failures.length ? 1 : 0;
  } finally {
    await host.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
