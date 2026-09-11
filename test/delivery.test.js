import { test } from "node:test";
import assert from "node:assert";
import { canonical, generateProcessKey, pubkeyB64, signReceipt, verifyReceipt } from "../src/receipt.js";
import {
  CONTRADICTED, DELIVERED, INCOMPLETE, UNABLE_TO_VERIFY, MODES, MODE_LIMITS, NEVER_PROVES, SCHEMA, VERDICTS,
  attest, attestDelivery, binds, checkSpec, hashValue, offerHash, requestHash, verifyDelivery,
} from "../src/delivery.js";

const KEY = generateProcessKey();
const OTHER = generateProcessKey();
const VERIFIER = "witness.outbid.sh/dev";
const T0 = "2026-09-11T04:00:00+00:00";
const FRESH = "2026-09-11T04:00:20+00:00";
const STALE = "2026-09-11T06:30:00+00:00";

/** Five real high-demand resources from the saved CDP catalog. No request is sent to
 *  any of them: every artifact below is a constructed fixture standing in for what a
 *  paid call would return. The question under test is whether the EVIDENCE MODEL
 *  holds, never whether these sellers work. */
const SUBJECTS = {
  financial_action: { url: "https://api.bitrefill.com/x402/invoice/pay", price: 1000.0 },
  compute_result: { url: "https://spawnxchange-api-485602182462.europe-west4.run.app/api/v1/items/:uuid/acquire", price: 1.0 },
  data_json: { url: "https://stableenrich.dev/api/pdl/people-enrich", price: 0.28 },
  issued_credential: { url: "https://cheaptokens.ai/api/buy", price: 1.0 },
  verification_result: { url: "https://centry.cybercentry.co.uk/api/services/web_application_verification", price: 1.0 },
};

/** One offer spec per deliverable class - the "delivery contract": what would a buyer
 *  have to be able to check for the purchase to mean anything? */
const SPECS = {
  financial_action: { required_fields: { invoice_id: "string", status: "string", amount_usd: "number" }, must_equal: { status: "settled" } },
  compute_result: { required_fields: { run_id: "string", output: "object", finished: "boolean" }, must_equal: { finished: true } },
  data_json: { required_fields: { query: "string", results: "array", result_count: "number" } },
  issued_credential: { required_fields: { credential_id: "string", secret: "string", expires_at: "string" } },
  verification_result: { required_fields: { target: "string", verdict: "string", checked_at: "string" } },
};

const GOOD = {
  financial_action: { invoice_id: "inv_88231", status: "settled", amount_usd: 1000.0 },
  compute_result: { run_id: "r_5512", output: { rows: 40 }, finished: true },
  data_json: { query: "acme corp", results: [{ name: "A" }], result_count: 1 },
  issued_credential: { credential_id: "card_9f2", secret: "tok_live_x", expires_at: "2027-01-01" },
  verification_result: { target: "https://example.com", verdict: "clean", checked_at: T0 },
};
// Present-and-wrong, one per class: two must_equal contradictions, three wrong types.
const WRONG_PATCH = {
  financial_action: { status: "pending" },
  compute_result: { finished: false },
  data_json: { result_count: "many" },
  issued_credential: { secret: 12345 },
  verification_result: { verdict: ["clean"] },
};

const offerFor = (cls) => ({ resource_url: SUBJECTS[cls].url, deliverable_class: cls, price_usdc: SUBJECTS[cls].price, spec: SPECS[cls] });
const requestFor = (cls) => ({ request_body: { op: "buy", class: cls }, settlement_ref: "5tGsKx_settlement_sig_stub", requested_at: T0 });
const obs = (artifact, observed_at, mode, http_status = 200, seller_signature = undefined) =>
  ({ artifact, observed_at, mode, http_status, seller_signature });
const signed = (cls, observation, extra = {}) =>
  attestDelivery({ key: KEY, offer: offerFor(cls), request: requestFor(cls), observation, verifier: VERIFIER, ...extra });

/** Six outcomes per class. `unsigned_claim` is the mode-downgrade case: it claims
 *  seller_integrated, carries no signature, and must drop to buyer_attested while
 *  keeping a delivered verdict - the artifact is fine, the label was not earned. */
const CASES = (cls) => {
  const good = GOOD[cls];
  const wrong = { ...good, ...WRONG_PATCH[cls] };
  const incomplete = Object.fromEntries(Object.entries(good).slice(1));
  return {
    valid: { o: obs(good, FRESH, "seller_integrated", 200, "sig_seller_abc"), verdict: DELIVERED, mode: "seller_integrated" },
    wrong: { o: obs(wrong, FRESH, "buyer_attested"), verdict: CONTRADICTED, mode: "buyer_attested" },
    incomplete: { o: obs(incomplete, FRESH, "buyer_attested"), verdict: INCOMPLETE, mode: "buyer_attested" },
    stale: { o: obs(good, STALE, "verifier_observed"), verdict: UNABLE_TO_VERIFY, mode: "verifier_observed" },
    unavailable: { o: obs(null, FRESH, "verifier_observed", 503), verdict: UNABLE_TO_VERIFY, mode: "verifier_observed" },
    unsigned_claim: { o: obs(good, FRESH, "seller_integrated"), verdict: DELIVERED, mode: "buyer_attested" },
  };
};

// ---- the 5 x 6 matrix: verdict, effective mode, limits, bindings, signature ----
for (const cls of Object.keys(SUBJECTS)) {
  for (const [name, { o, verdict, mode }] of Object.entries(CASES(cls))) {
    test(`matrix: ${cls} / ${name} -> ${verdict} as ${mode}`, () => {
      const r = signed(cls, o);
      assert.equal(r.schema, SCHEMA);
      assert.equal(r.delivery_verdict, verdict);
      assert.equal(r.evidence_mode, mode);
      assert.equal(r.declared_mode, o.mode);
      // Limits ride inside the body, for the effective mode, plus the universal list.
      assert.deepEqual(r.this_receipt_proves, [...MODE_LIMITS[mode]]);
      assert.deepEqual(r.this_receipt_does_not_prove, [...NEVER_PROVES]);
      // Binding: offer, request, verifier, timestamps always; artifact iff one came back.
      assert.equal(r.offer_hash, offerHash(offerFor(cls)));
      assert.equal(r.request_hash, requestHash(requestFor(cls)));
      assert.equal(r.artifact_hash, o.artifact === null ? null : hashValue(o.artifact));
      assert.equal(r.verifier, VERIFIER);
      assert.equal(r.requested_at, T0);
      assert.equal(r.observed_at, o.observed_at);
      assert.deepEqual(binds(r), { offer: true, request: true, artifact: o.artifact !== null, verifier: true, timestamp: true, settlement: true });
      // Signed with the process key; verifies offline against the pubkey alone.
      assert.equal(verifyReceipt(r, KEY.publicKey), true);
      assert.deepEqual(verifyDelivery(r, KEY.publicKey), { valid: true, reason: null, verdict, evidence_mode: mode, binds: binds(r) });
      assert.equal(verifyDelivery(r, OTHER.publicKey).valid, false);
    });
  }
}

// ---- verdict discipline ----
test("unable_to_verify never collapses into contradicted", () => {
  const nothing = attest({ offer: offerFor("data_json"), request: requestFor("data_json"), observation: obs(null, FRESH, "verifier_observed", 503), verifier: VERIFIER });
  assert.equal(nothing.delivery_verdict, UNABLE_TO_VERIFY);
  assert.deepEqual(nothing.reasons, ["no artifact was presented or observed"]);
  assert.equal(nothing.artifact_hash, null);
  const late = attest({ offer: offerFor("data_json"), request: requestFor("data_json"), observation: obs(GOOD.data_json, STALE, "verifier_observed"), verifier: VERIFIER });
  assert.equal(late.delivery_verdict, UNABLE_TO_VERIFY);
  assert.notEqual(late.delivery_verdict, CONTRADICTED);
  assert.match(late.reasons.join("\n"), /freshness window/);
  assert.deepEqual(VERDICTS, [DELIVERED, CONTRADICTED, INCOMPLETE, UNABLE_TO_VERIFY]);
});

test("staleness only downgrades: wrong stays contradicted, incomplete stays incomplete, only delivered drops", () => {
  const cls = "financial_action";
  const at = (artifact, when) => attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(artifact, when, "verifier_observed"), verifier: VERIFIER });
  const { wrong, incomplete } = { wrong: { ...GOOD[cls], ...WRONG_PATCH[cls] }, incomplete: Object.fromEntries(Object.entries(GOOD[cls]).slice(1)) };
  assert.equal(at(wrong, STALE).delivery_verdict, CONTRADICTED);
  assert.equal(at(incomplete, STALE).delivery_verdict, INCOMPLETE);
  assert.equal(at(null, STALE).delivery_verdict, UNABLE_TO_VERIFY);
  assert.equal(at(GOOD[cls], STALE).delivery_verdict, UNABLE_TO_VERIFY);
  // Observed before it was requested is not fresh either: a negative gap is stale.
  assert.equal(at(GOOD[cls], "2026-09-11T03:59:59+00:00").delivery_verdict, UNABLE_TO_VERIFY);
  // Exactly on the window edge is fresh; one second past is not.
  assert.equal(at(GOOD[cls], "2026-09-11T04:05:00Z").delivery_verdict, DELIVERED);
  assert.equal(at(GOOD[cls], "2026-09-11T04:05:01Z").delivery_verdict, UNABLE_TO_VERIFY);
  // A wider window is a signed parameter, not an ambient one.
  const wide = attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], STALE, "verifier_observed"), verifier: VERIFIER, max_staleness_seconds: 4 * 3600 });
  assert.equal(wide.delivery_verdict, DELIVERED);
  assert.equal(wide.max_staleness_seconds, 4 * 3600);
});

test("unparseable or offset-less timestamps are stale, never fresh", () => {
  const cls = "compute_result";
  const at = (requested_at, observed_at) => attest({
    offer: offerFor(cls), request: { ...requestFor(cls), requested_at }, observation: obs(GOOD[cls], observed_at, "verifier_observed"), verifier: VERIFIER,
  });
  for (const [a, b] of [["garbage", FRESH], [T0, "garbage"], [null, FRESH], [T0, 1757563220000], ["2026-09-11T04:00:00", "2026-09-11T04:00:20"]]) {
    const r = at(a, b);
    assert.equal(r.delivery_verdict, UNABLE_TO_VERIFY, `${a} / ${b}`);
    assert.match(r.reasons.join("\n"), /timestamps unparseable/);
  }
  // The unparseable reason is recorded even when there is nothing to downgrade.
  const wrong = attest({ offer: offerFor(cls), request: { ...requestFor(cls), requested_at: "nope" }, observation: obs({ ...GOOD[cls], finished: false }, FRESH, "buyer_attested"), verifier: VERIFIER });
  assert.equal(wrong.delivery_verdict, CONTRADICTED);
  assert.match(wrong.reasons.join("\n"), /timestamps unparseable/);
});

// ---- mode discipline ----
test("declared seller_integrated without a signature is downgraded to buyer_attested, with the reason recorded", () => {
  const cls = "issued_credential";
  for (const sig of [undefined, null, ""]) {
    const r = attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], FRESH, "seller_integrated", 200, sig), verifier: VERIFIER });
    assert.equal(r.declared_mode, "seller_integrated");
    assert.equal(r.evidence_mode, "buyer_attested");
    assert.equal(r.seller_signature_present, false);
    assert.equal(r.delivery_verdict, DELIVERED);
    assert.deepEqual(r.this_receipt_proves, [...MODE_LIMITS.buyer_attested]);
    assert.match(r.reasons.join("\n"), /downgraded to buyer_attested/);
  }
  const kept = attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], FRESH, "seller_integrated", 200, "sig"), verifier: VERIFIER });
  assert.equal(kept.evidence_mode, "seller_integrated");
  assert.equal(kept.seller_signature_present, true);
  assert.equal(kept.reasons.length, 0);
});

test("a signature never upgrades a mode: buyer_attested with a seller_signature stays buyer_attested", () => {
  const cls = "data_json";
  const r = attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], FRESH, "buyer_attested", 200, "sig_the_buyer_pasted"), verifier: VERIFIER });
  assert.equal(r.evidence_mode, "buyer_attested");
  assert.equal(r.declared_mode, "buyer_attested");
  assert.equal(r.seller_signature_present, true);
});

test("unknown mode, missing verifier, or missing key is a thrown error, not a receipt", () => {
  const cls = "data_json";
  assert.throws(() => attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], FRESH, "trust_me"), verifier: VERIFIER }), /delivery_unknown_mode/);
  assert.throws(() => attest({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], FRESH, "buyer_attested"), verifier: "" }), /delivery_no_verifier/);
  assert.throws(() => attestDelivery({ offer: offerFor(cls), request: requestFor(cls), observation: obs(GOOD[cls], FRESH, "buyer_attested"), verifier: VERIFIER }), /delivery_no_key/);
  assert.deepEqual(MODES, ["buyer_attested", "seller_integrated", "verifier_observed"]);
});

// ---- JS type semantics: what typeof gets wrong, the spec checker must get right ----
test("arrays are not objects", () => {
  const spec = { required_fields: { output: "object" } };
  assert.deepEqual(checkSpec({ output: [] }, spec), { verdict: CONTRADICTED, reasons: ["output: expected object, got array"] });
  assert.deepEqual(checkSpec({ output: [{ rows: 40 }] }, spec), { verdict: CONTRADICTED, reasons: ["output: expected object, got array"] });
  assert.equal(checkSpec({ output: { rows: 40 } }, spec).verdict, DELIVERED);
  // And the artifact itself: a top-level array is not a JSON object either.
  assert.deepEqual(checkSpec([{ output: {} }], spec), { verdict: CONTRADICTED, reasons: ["expected a JSON object, got array"] });
});

test("null is not an object, and a null artifact is unable_to_verify rather than contradicted", () => {
  const spec = { required_fields: { output: "object" } };
  assert.deepEqual(checkSpec({ output: null }, spec), { verdict: CONTRADICTED, reasons: ["output: expected object, got null"] });
  assert.equal(checkSpec(null, spec).verdict, UNABLE_TO_VERIFY);
  assert.equal(checkSpec(undefined, spec).verdict, UNABLE_TO_VERIFY);
});

test("booleans are not numbers, numbers are not booleans", () => {
  assert.deepEqual(checkSpec({ n: true }, { required_fields: { n: "number" } }), { verdict: CONTRADICTED, reasons: ["n: expected number, got boolean"] });
  assert.deepEqual(checkSpec({ n: false }, { required_fields: { n: "number" } }), { verdict: CONTRADICTED, reasons: ["n: expected number, got boolean"] });
  assert.deepEqual(checkSpec({ b: 1 }, { required_fields: { b: "boolean" } }), { verdict: CONTRADICTED, reasons: ["b: expected boolean, got number"] });
  assert.deepEqual(checkSpec({ b: "true" }, { required_fields: { b: "boolean" } }), { verdict: CONTRADICTED, reasons: ["b: expected boolean, got string"] });
  assert.equal(checkSpec({ n: 0, b: false }, { required_fields: { n: "number", b: "boolean" } }).verdict, DELIVERED);
});

test("NaN and Infinity are not numbers: canonical() would sign them as null", () => {
  assert.deepEqual(checkSpec({ n: NaN }, { required_fields: { n: "number" } }), { verdict: CONTRADICTED, reasons: ["n: expected number, got NaN"] });
  assert.deepEqual(checkSpec({ n: Infinity }, { required_fields: { n: "number" } }), { verdict: CONTRADICTED, reasons: ["n: expected number, got Infinity"] });
  assert.deepEqual(checkSpec({ n: -Infinity }, { required_fields: { n: "number" } }), { verdict: CONTRADICTED, reasons: ["n: expected number, got -Infinity"] });
  assert.equal(checkSpec({ n: 1000.0 }, { required_fields: { n: "number" } }).verdict, DELIVERED);
  assert.equal(checkSpec({ n: -0.28 }, { required_fields: { n: "number" } }).verdict, DELIVERED);
});

test("strings are not arrays or objects; objects are not arrays; unknown spec types reject every value", () => {
  assert.equal(checkSpec({ r: "[]" }, { required_fields: { r: "array" } }).verdict, CONTRADICTED);
  assert.equal(checkSpec({ r: "{}" }, { required_fields: { r: "object" } }).verdict, CONTRADICTED);
  assert.equal(checkSpec({ r: { 0: "a" } }, { required_fields: { r: "array" } }).verdict, CONTRADICTED);
  assert.equal(checkSpec({ r: "x" }, { required_fields: { r: "text" } }).verdict, CONTRADICTED);
  // "constructor" as a type name must not resolve to Object.prototype.constructor and pass.
  assert.equal(checkSpec({ r: "x" }, { required_fields: { r: "constructor" } }).verdict, CONTRADICTED);
});

test("an undefined value and a prototype-chain key are both absent, matching what the hash signs", () => {
  const spec = { required_fields: { secret: "string" } };
  assert.deepEqual(checkSpec({ secret: undefined }, spec), { verdict: INCOMPLETE, reasons: ["missing required field: secret"] });
  assert.equal(hashValue({ secret: undefined }), hashValue({}));
  assert.deepEqual(checkSpec({}, { required_fields: { constructor: "object" } }), { verdict: INCOMPLETE, reasons: ["missing required field: constructor"] });
  assert.equal(checkSpec({}, { required_fields: { constructor: "object" }, must_equal: { toString: "x" } }).verdict, INCOMPLETE);
});

test("must_equal compares structure, and never lets true equal 1", () => {
  const spec = { required_fields: { output: "object" }, must_equal: { output: { rows: 40 } } };
  assert.equal(checkSpec({ output: { rows: 40 } }, spec).verdict, DELIVERED);
  assert.deepEqual(checkSpec({ output: { rows: 41 } }, spec), { verdict: CONTRADICTED, reasons: ['output: expected {"rows":40}, got {"rows":41}'] });
  // Python's True == 1 would pass this; the port must not.
  const loose = { required_fields: {}, must_equal: { finished: true } };
  assert.equal(checkSpec({ finished: 1 }, loose).verdict, CONTRADICTED);
  assert.equal(checkSpec({ finished: true }, loose).verdict, DELIVERED);
  // A must_equal key that is absent compares as null, so a null expectation holds and anything else does not.
  assert.equal(checkSpec({}, { must_equal: { gone: null } }).verdict, DELIVERED);
  assert.equal(checkSpec({}, { must_equal: { gone: "x" } }).verdict, CONTRADICTED);
});

// ---- hash discipline ----
test("two different artifacts never share an artifact_hash; the same offer always hashes identically", () => {
  const cls = "financial_action";
  const v = signed(cls, CASES(cls).valid.o), w = signed(cls, CASES(cls).wrong.o);
  assert.notEqual(v.artifact_hash, w.artifact_hash);
  assert.equal(v.offer_hash, w.offer_hash);
  assert.equal(v.request_hash, w.request_hash);
  assert.match(v.artifact_hash, /^[0-9a-f]{64}$/);
  assert.match(v.offer_hash, /^[0-9a-f]{64}$/);
  // Key order is not identity: the canonical form sorts every level.
  const a = { spec: { must_equal: { status: "settled" }, required_fields: { status: "string", amount_usd: "number" } }, price_usdc: 1000, deliverable_class: cls, resource_url: SUBJECTS[cls].url };
  const b = { resource_url: SUBJECTS[cls].url, deliverable_class: cls, price_usdc: 1000, spec: { required_fields: { amount_usd: "number", status: "string" }, must_equal: { status: "settled" } } };
  assert.equal(offerHash(a), offerHash(b));
  assert.equal(hashValue({ x: [{ b: 1, a: 2 }] }), hashValue({ x: [{ a: 2, b: 1 }] }));
  // Array order is identity.
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
  // Unknown settlement hashes one way whether it is omitted, undefined, or null.
  const base = { request_body: { op: "buy" }, requested_at: T0 };
  assert.equal(requestHash(base), requestHash({ ...base, settlement_ref: null }));
  assert.equal(requestHash(base), requestHash({ ...base, settlement_ref: undefined }));
  assert.notEqual(requestHash(base), requestHash({ ...base, settlement_ref: "sig" }));
  // And any change to what was promised or asked changes the binding.
  assert.notEqual(offerHash(a), offerHash({ ...a, price_usdc: 999 }));
  assert.notEqual(requestHash({ ...base, settlement_ref: "sig" }), requestHash({ ...base, settlement_ref: "sig", requested_at: FRESH }));
});

// ---- signature discipline ----
test("tampering with any bound field fails verification", () => {
  const cls = "compute_result";
  const r = signed(cls, CASES(cls).valid.o);
  assert.equal(verifyDelivery(r, KEY.publicKey).valid, true);
  const tampered = {
    offer_hash: "0".repeat(64), request_hash: "0".repeat(64), artifact_hash: "0".repeat(64),
    verifier: "someone.else", requested_at: FRESH, observed_at: T0, settlement_ref: "other_sig",
    delivery_verdict: CONTRADICTED, evidence_mode: "verifier_observed", declared_mode: "buyer_attested",
    seller_signature_present: false, http_status: 503, resource_url: "https://evil.example/", deliverable_class: "data_json",
    price_usdc: 0, max_staleness_seconds: 999999, reasons: ["nothing to see"],
    this_receipt_proves: [], this_receipt_does_not_prove: [], signer: pubkeyB64(OTHER), schema: "delivery-attestation/v1",
  };
  for (const [field, value] of Object.entries(tampered)) {
    const doc = { ...r, [field]: value };
    assert.equal(verifyReceipt(doc, KEY.publicKey), false, `${field} tampered but signature still verified`);
    assert.equal(verifyDelivery(doc, KEY.publicKey).valid, false, `${field} tampered but receipt still valid`);
  }
  // Dropping a field, adding a field, or dropping the signature all fail too.
  const { artifact_hash, ...dropped } = r;
  assert.equal(verifyReceipt(dropped, KEY.publicKey), false);
  assert.equal(verifyReceipt({ ...r, extra: true }, KEY.publicKey), false);
  const { receipt, ...unsigned } = r;
  assert.equal(verifyReceipt(unsigned, KEY.publicKey), false);
  assert.equal(verifyDelivery(unsigned, KEY.publicKey).reason, "signature_invalid");
  assert.equal(verifyDelivery(r, OTHER.publicKey).reason, "signature_invalid");
  assert.equal(verifyDelivery(null, KEY.publicKey).reason, "malformed_receipt");
  assert.equal(verifyDelivery(r, null).reason, "no_trusted_key");
});

test("verifyDelivery rejects a well-signed receipt that violates the design", () => {
  const cls = "verification_result";
  const body = attest({ offer: offerFor(cls), request: requestFor(cls), observation: CASES(cls).valid.o, verifier: VERIFIER });
  const resign = (patch) => signReceipt({ ...body, signer: pubkeyB64(KEY), ...patch }, KEY);
  assert.equal(verifyDelivery(resign({}), KEY.publicKey).valid, true);
  // A seller_integrated label with no signature behind it: exactly the borrow attest() refuses.
  assert.equal(verifyDelivery(resign({ seller_signature_present: false }), KEY.publicKey).reason, "mode_unsupported_by_signature");
  assert.equal(verifyDelivery(resign({ delivery_verdict: "probably_fine" }), KEY.publicKey).reason, "verdict_unknown");
  assert.equal(verifyDelivery(resign({ evidence_mode: "oracle" }), KEY.publicKey).reason, "mode_unknown");
  assert.equal(verifyDelivery(resign({ this_receipt_does_not_prove: [] }), KEY.publicKey).reason, "limits_missing");
  assert.equal(verifyDelivery(resign({ this_receipt_does_not_prove: undefined }), KEY.publicKey).reason, "limits_missing");
  assert.equal(verifyDelivery(resign({ verifier: "" }), KEY.publicKey).reason, "binding_incomplete");
  assert.equal(verifyDelivery(resign({ offer_hash: null }), KEY.publicKey).reason, "binding_incomplete");
  assert.equal(verifyDelivery(resign({ signer: pubkeyB64(OTHER) }), KEY.publicKey).reason, "signer_mismatch");
  assert.equal(verifyDelivery(resign({ schema: "witness.evidence.v2" }), KEY.publicKey).reason, "schema_mismatch");
});

test("the signed body is exactly attest()'s body plus signer: canonical bytes reproduce across processes", () => {
  const cls = "data_json";
  const args = { offer: offerFor(cls), request: requestFor(cls), observation: CASES(cls).valid.o, verifier: VERIFIER };
  const { receipt, ...rest } = attestDelivery({ key: KEY, ...args });
  assert.deepEqual(rest, { ...attest(args), signer: pubkeyB64(KEY) });
  assert.equal(canonical(rest), canonical(JSON.parse(JSON.stringify(rest))));
  assert.equal(attest(args).offer_hash, attest(structuredClone(args)).offer_hash);
});
