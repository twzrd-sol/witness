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
 *      sent an x-delivery-signature header, JSON.parse it into
 *      observation.seller_signature and declare mode seller_integrated;
 *      otherwise buyer_attested.
 *   3. Verify the `receipt` field offline against GET /pubkey (one fetch, then
 *      never again for that key).
 *   4. Read this_receipt_proves / this_receipt_does_not_prove BEFORE acting on
 *      delivery_verdict. A buyer_attested "contradicted" is your complaint on
 *      the record, not proof of the seller's fault.
 *
 * The route returns the receipt BARE - the same shape /witness returns. There
 * is no {success, data} envelope to unwrap; the top-level object IS the receipt.
 *
 * DECLARING seller_integrated IS NOT CLAIMING IT. The verifier checks the
 * signature against the payTo you paid and signs the RESULT into the receipt.
 * A signature that does not verify does not fail your request - it comes back
 * as evidence_mode buyer_attested with seller_verification saying why. You
 * cannot talk your way into the stronger mode.
 *
 * Runs against WITNESS_BASE when set; otherwise boots the host in-process on
 * loopback (no network).
 *
 *   node examples/delivery-buyer.mjs
 *   WITNESS_BASE=https://witness.outbid.sh node examples/delivery-buyer.mjs
 */
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXAMPLE_ARTIFACT, EXAMPLE_REQUEST, SIGNATURE_HEADER, SUBJECT,
  artifactHash, canonical, emitResponse, requestHash, solanaSeller,
} from "./delivery-seller.mjs";

const say = (...a) => console.log(...a);
const block = (v) => JSON.stringify(v, null, 2).replace(/^/gm, "  ");

async function boot() {
  if (process.env.WITNESS_BASE) return { base: process.env.WITNESS_BASE.replace(/\/$/, ""), model: "remote", close: async () => {} };
  const { createApp } = await import("../src/server.js");
  const { generateProcessKey } = await import("../src/receipt.js");
  const { attest } = await import("../src/delivery.js");
  const app = createApp({ key: generateProcessKey(), observationsDir: mkdtempSync(path.join(os.tmpdir(), "wit-buyer-")), attest, publicBaseUrl: "http://127.0.0.1" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { base: `http://127.0.0.1:${server.address().port}`, model: "src/delivery.js", close: () => new Promise((r) => server.close(r)) };
}

/** Step 3: offline verification. Drop `receipt`, deep-canonical JSON, ed25519 against GET /pubkey. */
export function verifyReceiptOffline(receipt, pubkeyB64) {
  const { receipt: sig, ...rest } = receipt;
  const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(canonical(rest)), key, Buffer.from(sig, "base64"));
}

/**
 * Step 2: build the observation from the response exactly as received. The
 * signature header carries {network, payTo, signature}; it is passed through
 * as an object, not as a string.
 */
export function observationFrom(response, observed_at) {
  const header = response.headers[SIGNATURE_HEADER];
  const seller_signature = header == null ? null : JSON.parse(header);
  return {
    artifact: response.body == null ? null : JSON.parse(response.body),
    observed_at,
    mode: seller_signature ? "seller_integrated" : "buyer_attested",
    http_status: response.status,
    seller_signature,
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
    // spec_origin seller_published: this spec was read from the seller's own surface, not
    // written by the buyer. It is signed into the receipt so a reader can weigh it.
    const offer = { ...SUBJECT, spec_origin: "seller_published" };
    const request = { ...EXAMPLE_REQUEST };
    const artifact = { ...EXAMPLE_ARTIFACT };
    const seller = solanaSeller();
    const signedResponse = await emitResponse(seller, { offer, request, artifact });
    const unsignedResponse = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(artifact) };

    const { pubkey } = await (await fetch(`${host.base}/pubkey`)).json();
    say("verifier pubkey:", pubkey);

    // A: the seller signed at emit time, and the signature verifies against the payTo -> seller_integrated.
    say("\nA. seller signed its response, signature verifies against payTo -> seller_integrated");
    const a = await attest(host.base, { offer, request, observation: observationFrom(signedResponse, "2026-09-11T04:00:04Z") });
    const ra = a.json;
    say(`  HTTP ${a.status}`);
    expect(a.status === 200 && typeof ra.receipt === "string", "receipt issued, bare (no success/data envelope)");
    expect(ra.success === undefined && ra.data === undefined, "no envelope keys on the response");
    say(`  delivery_verdict=${ra.delivery_verdict}  evidence_mode=${ra.evidence_mode}  declared_mode=${ra.declared_mode}`);
    say(`  spec_origin=${ra.spec_origin}  within_freshness_window=${ra.within_freshness_window}  observation_gap_seconds=${ra.observation_gap_seconds}`);
    say("  binds  : offer_hash", ra.offer_hash.slice(0, 16) + "...", "request_hash", ra.request_hash.slice(0, 16) + "...", "artifact_hash", String(ra.artifact_hash).slice(0, 16) + "...");
    say("  seller_verification:", JSON.stringify({ verified: ra.seller_verification?.verified, reason: ra.seller_verification?.reason, rail: ra.seller_verification?.rail }));
    say("  seller_signature_covers:", JSON.stringify(ra.seller_signature_covers));
    expect(ra.evidence_mode === "seller_integrated", "the strong mode survived verification");
    expect(ra.seller_verification?.verified === true, "the verifier checked the signature against payTo itself");
    expect(ra.request_hash === requestHash(request), "request_hash matches what the buyer can recompute");
    expect(ra.artifact_hash === artifactHash(artifact), "artifact_hash matches the artifact as received");
    expect(ra.spec_origin === "seller_published", "declared spec_origin survived into the receipt");
    expect(verifyReceiptOffline(ra, pubkey), "signature verifies offline against GET /pubkey");
    expect(ra.delivery_verdict === "delivered", "the artifact satisfied the offer spec");
    expect(!verifyReceiptOffline({ ...ra, delivery_verdict: "contradicted" }, pubkey), "a flipped verdict fails verification");
    expect(!verifyReceiptOffline({ ...ra, spec_origin: "seller_published_probably" }, pubkey), "an edited spec_origin fails verification");
    expect(!verifyReceiptOffline({ ...ra, this_receipt_does_not_prove: [] }, pubkey), "stripped limits fail verification");
    say("  this_receipt_proves:");
    say(block(ra.this_receipt_proves));
    say("  this_receipt_does_not_prove:");
    say(block(ra.this_receipt_does_not_prove));

    // A2: the mode you declare is not the mode you get. A signature bound to a payTo
    // you did not pay is the same evidence as no signature at all, and the receipt says so.
    say("\nA2. same artifact, signature presented under a payTo the buyer did not pay -> downgraded");
    const impostor = observationFrom(signedResponse, "2026-09-11T04:00:04Z");
    impostor.seller_signature = { ...impostor.seller_signature, payTo: solanaSeller().payTo };
    const a2 = (await attest(host.base, { offer, request, observation: impostor })).json;
    say(`  declared_mode=${a2.declared_mode} -> evidence_mode=${a2.evidence_mode}  (${a2.seller_verification?.reason})`);
    expect(a2.declared_mode === "seller_integrated" && a2.evidence_mode === "buyer_attested", "declaring the strong mode did not grant it");
    expect(a2.seller_verification?.verified === false, "the refusal and its reason are signed into the receipt");

    // B: no seller signature -> buyer_attested. Same artifact, weaker evidence, and the receipt says so.
    say("\nB. seller did not sign (no header) -> buyer_attested");
    const b = (await attest(host.base, { offer, request, observation: observationFrom(unsignedResponse, "2026-09-11T04:00:04Z") })).json;
    say(`  delivery_verdict=${b.delivery_verdict}  evidence_mode=${b.evidence_mode}`);
    expect(b.evidence_mode === "buyer_attested", "buyer_attested receipt issued");
    expect(verifyReceiptOffline(b, pubkey), "signature verifies offline");

    // C: nothing came back (timeout / 5xx). artifact:null is graded, not refused.
    say("\nC. nothing came back (artifact: null, http_status 503) -> a receipt, not an HTTP error");
    const c = await attest(host.base, { offer, request, observation: { artifact: null, observed_at: "2026-09-11T04:00:30Z", mode: "buyer_attested", http_status: 503, seller_signature: null } });
    expect(c.status === 200 && typeof c.json.receipt === "string", "HTTP 200 with a signed receipt");
    expect(c.json.delivery_verdict === "unable_to_verify", "delivery_verdict is unable_to_verify");
    expect(c.json.artifact_hash === null, "artifact_hash is null");
    say("  reasons:", JSON.stringify(c.json.reasons));

    // D: a request the route cannot READ is refused (400, bare, specific reason). Contrast with C.
    say("\nD. a malformed submission (artifact key omitted) -> 400, nothing signed");
    const d = await attest(host.base, { offer, request, observation: { observed_at: "2026-09-11T04:00:30Z", mode: "buyer_attested" } });
    expect(d.status === 400 && d.json.reason === "bad_observation", "400 bad_observation");
    expect(d.json.receipt === undefined, "nothing was signed");
    say("  problems:", JSON.stringify(d.json.details.problems));

    say("\nhow to act on a receipt");
    say("  - delivered / contradicted / incomplete are answers about the artifact vs the offer spec; read evidence_mode first");
    say("  - buyer_attested proves what YOU presented satisfied or did not satisfy the spec; it is a complaint on the record");
    say("  - seller_integrated proves the seller emitted it for this request; it does not prove you received it");
    say("  - unable_to_verify is not a fault finding either way; do not treat it as delivered or as not delivered");
    say("  - evidence_mode is what the verifier could establish, not what you declared; seller_verification says why");
    say(`\n${failures.length ? "FAILED" : "ok"}: ${failures.length ? failures.join("; ") : "attestation, mode discipline, offline verification, and refusal behave as expected"}`);
    return failures.length ? 1 : 0;
  } finally {
    await host.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
