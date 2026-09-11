#!/usr/bin/env node
/**
 * Reference SELLER integration for delivery attestation.
 *
 * Settlement proves money moved. A seller that signs its response AT EMIT TIME
 * lets any buyer later obtain a seller_integrated receipt from
 * POST /delivery/attest: a verdict whose evidence mode proves "this seller
 * emitted THIS artifact for THIS paid request", instead of only "the buyer says
 * so". Without it the strongest receipt a buyer can get is buyer_attested,
 * which is a complaint, not proof of fault.
 *
 * What the seller signs (ed25519, key bound to its payTo):
 *   { schema, pay_to, request_hash, artifact_hash, emitted_at }
 * request_hash and artifact_hash use the same deep-canonical sha256 the
 * evidence model uses, so a verifier can recompute both from what the buyer
 * submits and check them against the seller's signature without contacting the
 * seller.
 *
 * How it travels: one response header; the JSON body is untouched so its bytes
 * hash the same on both ends.
 *   x-delivery-signature: <base64url JSON envelope, see signAtEmit>
 * The buyer copies that header into observation.seller_signature.
 *
 * What this does and does not prove is printed at the end. Runnable, no
 * network, no repo imports:  node examples/delivery-seller.mjs
 */
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { pathToFileURL } from "node:url";

export const SELLER_SIGNATURE_SCHEMA = "delivery-seller-signature/v0";
export const SIGNATURE_HEADER = "x-delivery-signature";

// Deep-canonical JSON: sorted keys, no whitespace. Identical to src/receipt.js canonical() and
// delivery_receipt.py _canon(), so seller, buyer, and verifier hash the same bytes.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
export const canonical = (v) => JSON.stringify(sortDeep(v));
export const sha256 = (v) => createHash("sha256").update(canonical(v)).digest("hex");
/** Same three fields the evidence model hashes for request_hash. */
export const requestHash = ({ request_body, settlement_ref = null, requested_at }) => sha256({ request_body, settlement_ref, requested_at });
export const artifactHash = (artifact) => sha256(artifact);

/**
 * In production: generated once, persisted like src/keystore.js (0600), and BOUND to payTo by
 * publishing the SPKI public key where buyers already look for payTo -- the 402 challenge's
 * accepts[].extra, or /.well-known/x402. The envelope carries a copy of the pubkey for
 * convenience; the binding is the publication, not the envelope. A verifier that trusts the
 * envelope's copy has only proved the envelope is self-consistent.
 */
export function newSellerIdentity(pay_to) {
  const kp = generateKeyPairSync("ed25519");
  return { pay_to, privateKey: kp.privateKey, pubkey: kp.publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

/** Sign at emit time. `request` is the paid call as the seller saw it: body, settlement ref, when. */
export function signAtEmit(identity, request, artifact, emitted_at = new Date().toISOString()) {
  const signed = { schema: SELLER_SIGNATURE_SCHEMA, pay_to: identity.pay_to, request_hash: requestHash(request), artifact_hash: artifactHash(artifact), emitted_at };
  const sig = sign(null, Buffer.from(canonical(signed)), identity.privateKey).toString("base64");
  return Buffer.from(JSON.stringify({ ...signed, pubkey: identity.pubkey, sig })).toString("base64url");
}

/** The seller's HTTP response for a paid call: artifact as the body, signature as a header. */
export function emitResponse(identity, request, artifact, emitted_at) {
  return {
    status: 200,
    headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signAtEmit(identity, request, artifact, emitted_at) },
    body: JSON.stringify(artifact),
  };
}

/**
 * What a verifier (or a cautious buyer) can check offline. `pubkey` should be the seller's
 * PUBLISHED key for `pay_to`; when omitted the envelope's copy is used and the result only
 * says the envelope is self-consistent. Returns { ok, reason, envelope }.
 */
export function verifySellerSignature(seller_signature, { request, artifact, pay_to, pubkey } = {}) {
  let env;
  try { env = JSON.parse(Buffer.from(seller_signature, "base64url").toString("utf8")); } catch { return { ok: false, reason: "unparseable", envelope: null }; }
  if (env.schema !== SELLER_SIGNATURE_SCHEMA) return { ok: false, reason: "unknown_schema", envelope: env };
  if (pay_to !== undefined && env.pay_to !== pay_to) return { ok: false, reason: "pay_to_mismatch", envelope: env };
  const published = pubkey ?? env.pubkey;
  if (env.pubkey !== published) return { ok: false, reason: "pubkey_not_the_published_one", envelope: env };
  if (env.request_hash !== requestHash(request)) return { ok: false, reason: "request_hash_mismatch", envelope: env };
  if (env.artifact_hash !== artifactHash(artifact)) return { ok: false, reason: "artifact_hash_mismatch", envelope: env };
  const { sig, pubkey: _copy, ...signed } = env;
  const key = createPublicKey({ key: Buffer.from(published, "base64"), format: "der", type: "spki" });
  const ok = verify(null, Buffer.from(canonical(signed)), key, Buffer.from(sig, "base64"));
  return { ok, reason: ok ? null : "bad_signature", envelope: env };
}

/** A real catalog subject (data_json, USDC 0.28/call; 61 payers, 1584 calls in the 2026-09-10 snapshot). No request is sent to it. */
export const SUBJECT = Object.freeze({
  resource_url: "https://stableenrich.dev/api/pdl/people-enrich",
  deliverable_class: "data_json",
  price_usdc: 0.28,
  pay_to: "0x5e11e7Ab5d3F7b2d3E4A9c0F1b2C3d4E5f6A7b8C",
  spec: { required_fields: { query: "string", results: "array", result_count: "number" } },
});

function main() {
  const say = (...a) => console.log(...a);
  const seller = newSellerIdentity(SUBJECT.pay_to);
  say("seller identity");
  say("  pay_to :", seller.pay_to);
  say("  pubkey :", seller.pubkey, "(publish this next to pay_to; the envelope's copy is not the binding)");

  // The paid call as the seller saw it. settlement_ref is what the facilitator settled for it.
  const request = { request_body: { query: "acme corp" }, settlement_ref: "5tGsKx8n3v2Q1w9E7r6T5y4U3i2O1p0A9s8D7f6G5h4J3k2L1z0X9c8V7b6N5m4", requested_at: "2026-09-11T04:00:00Z" };
  const artifact = { query: "acme corp", results: [{ name: "Acme Corp", domain: "acme.example" }], result_count: 1 };
  const response = emitResponse(seller, request, artifact, "2026-09-11T04:00:03Z");

  say("\nresponse the seller emits for that call");
  say("  status :", response.status);
  say("  headers:", JSON.stringify(response.headers, null, 2).replace(/\n/g, "\n  "));
  say("  body   :", response.body);

  const env = JSON.parse(Buffer.from(response.headers[SIGNATURE_HEADER], "base64url").toString("utf8"));
  say("\ndecoded signature envelope (what the header carries)");
  say(JSON.stringify(env, null, 2).replace(/^/gm, "  "));

  say("\nobservation the buyer will submit to POST /delivery/attest");
  say(JSON.stringify({ artifact: JSON.parse(response.body), observed_at: "2026-09-11T04:00:04Z", mode: "seller_integrated", http_status: response.status, seller_signature: response.headers[SIGNATURE_HEADER] }, null, 2).replace(/^/gm, "  "));

  say("\noffline checks a verifier can run with the published key");
  const good = verifySellerSignature(response.headers[SIGNATURE_HEADER], { request, artifact, pay_to: SUBJECT.pay_to, pubkey: seller.pubkey });
  const tamperedArtifact = verifySellerSignature(response.headers[SIGNATURE_HEADER], { request, artifact: { ...artifact, result_count: 2 }, pay_to: SUBJECT.pay_to, pubkey: seller.pubkey });
  const otherRequest = verifySellerSignature(response.headers[SIGNATURE_HEADER], { request: { ...request, request_body: { query: "beta llc" } }, artifact, pay_to: SUBJECT.pay_to, pubkey: seller.pubkey });
  const otherPayee = verifySellerSignature(response.headers[SIGNATURE_HEADER], { request, artifact, pay_to: "0x0000000000000000000000000000000000000000", pubkey: seller.pubkey });
  const impostor = verifySellerSignature(response.headers[SIGNATURE_HEADER], { request, artifact, pay_to: SUBJECT.pay_to, pubkey: newSellerIdentity(SUBJECT.pay_to).pubkey });
  say("  as emitted            :", good.ok, good.reason ?? "");
  say("  artifact edited       :", tamperedArtifact.ok, tamperedArtifact.reason);
  say("  different request     :", otherRequest.ok, otherRequest.reason);
  say("  different payee       :", otherPayee.ok, otherPayee.reason);
  say("  key not the published :", impostor.ok, impostor.reason);

  say("\nwhat a seller_integrated receipt built on this proves");
  say("  - this seller emitted this artifact for this request (request_hash + artifact_hash under its key)");
  say("what it does not prove");
  say("  - that the buyer received it, or received it unmodified in transit");
  say("  - that the artifact is correct: correctness is graded against the offer spec by the verifier");
  say("  - anything about sellers that do not sign: absence of a receipt is not evidence of fault");
  say("  - the key/payTo binding, unless the pubkey was read from the seller's published surface");

  const ok = good.ok && !tamperedArtifact.ok && !otherRequest.ok && !otherPayee.ok && !impostor.ok;
  say(`\n${ok ? "ok" : "FAILED"}: signing at emit time and offline verification behave as expected`);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
