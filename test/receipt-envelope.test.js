import { test } from "node:test";
import assert from "node:assert";
import { generateProcessKey, sourceHash, verifyReceipt } from "../src/receipt.js";
import { fillExtract } from "../src/extract.js";
import { handleWitness } from "../src/server.js";

const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const BODY = { url: "https://example.com/pricing", extract: { starter_price: "number", currency: "string" }, assertion: "starter_price < 100" };

// Tracer 1: time-addressed evidence binding.
// The receipt must name the representation it actually hashed (reader plaintext,
// not origin bytes), bind the requested URL + retrieval time, and carry the
// evidence spans inside the signature so a quote shows its location, not just
// a 160-char display excerpt.
test("paid receipt binds URL, retrieval time, representation identity, and evidence spans", async () => {
  const key = generateProcessKey();
  const out = await handleWitness(BODY, {
    retrieve: async () => ({ text: FIXTURE }),
    paid: true,
    key,
    now: () => "2026-08-30T00:00:00.000Z",
  });
  assert.equal(out.status, 200);
  const r = out.json;

  // URL binding
  assert.equal(r.requested_url, BODY.url);
  assert.equal(r.final_url, null);

  // Origin honesty: the reader hides the origin fetch, so these stay null.
  assert.equal(r.origin_status, null);
  assert.equal(r.origin_content_type, null);

  // Representation identity: what source_hash actually covers.
  assert.equal(r.representation.kind, "reader_plaintext");
  assert.equal(r.representation.sha256, sourceHash(FIXTURE));
  assert.equal(r.representation.sha256, r.source_hash);
  assert.equal(r.representation.retrieved_at, r.observed_at);

  // Evidence spans bound inside the signature, matching the extractor.
  const { spans } = fillExtract(FIXTURE, BODY.extract);
  assert.deepEqual(r.evidence_spans, JSON.parse(JSON.stringify(spans)));

  // Everything above is signed.
  assert.ok(verifyReceipt(r, key.publicKey));
  assert.equal(verifyReceipt({ ...r, representation: { ...r.representation, sha256: "0".repeat(64) } }, key.publicKey), false);
});
