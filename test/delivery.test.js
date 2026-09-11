import { test } from "node:test";
import assert from "node:assert";
import { canonical, generateProcessKey, pubkeyB64, signReceipt, verifyReceipt } from "../src/receipt.js";
import {
  CONTRADICTED, DELIVERED, INCOMPLETE, UNABLE_TO_VERIFY, MODES, MODE_LIMITS, NEVER_PROVES, SCHEMA, SELLER_SIGNATURE_COVERS, VERDICTS,
  attest, attestDelivery, binds, checkSpec, hashValue, offerHash, requestHash, verifyDelivery,
} from "../src/delivery.js";
// The same module instance src/delivery.js resolves. The stub this lane used while
// src/delivery-signature.js did not yet exist is gone; these run against the real verifier.
import { SIGNING_DOMAIN as DOMAIN, signingMessage, verifySellerSignature } from "../src/delivery-signature.js";

const KEY = generateProcessKey();
const OTHER = generateProcessKey();
const VERIFIER = "witness.outbid.sh/dev";
const T0 = "2026-09-11T04:00:00+00:00";
const FRESH = "2026-09-11T04:00:20+00:00";
const STALE = "2026-09-11T06:30:00+00:00";
const NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const PAY_TO = "SeLLerPayTo11111111111111111111111111111111";

/** Verification results in the delivery-signature.js contract shape. The model is
 *  handed one of these by the route layer; it never checks a rail itself. */
const VERIFIED = { verified: true, reason: "ok", rail: "svm", checked: ["rail_resolved", "payTo_resolved", "message_derived", "signature_checked"], signer: PAY_TO };
const ABSENT = { verified: false, reason: "signature_absent", rail: "svm", checked: ["rail_resolved"], signer: null };
const INVALID = { verified: false, reason: "signature_invalid", rail: "svm", checked: ["rail_resolved", "payTo_resolved", "message_derived", "signature_checked"], signer: null };

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
const obs = (artifact, observed_at, mode, http_status = 200) => ({ artifact, observed_at, mode, http_status });
const plain = (cls, observation, extra = {}) =>
  attest({ offer: offerFor(cls), request: requestFor(cls), observation, verifier: VERIFIER, ...extra });
const signed = (cls, observation, extra = {}) =>
  attestDelivery({ key: KEY, offer: offerFor(cls), request: requestFor(cls), observation, verifier: VERIFIER, ...extra });

/** Seven outcomes per class. `unsigned_claim` and `invalid_claim` are the
 *  mode-downgrade cases: both declare seller_integrated, one with no signature and
 *  one with a signature that does not verify, and both must drop to buyer_attested
 *  while keeping a delivered verdict - the artifact is fine, the label was not earned. */
const CASES = (cls) => {
  const good = GOOD[cls];
  const wrong = { ...good, ...WRONG_PATCH[cls] };
  const incomplete = Object.fromEntries(Object.entries(good).slice(1));
  return {
    valid: { o: obs(good, FRESH, "seller_integrated"), sv: VERIFIED, verdict: DELIVERED, mode: "seller_integrated" },
    wrong: { o: obs(wrong, FRESH, "buyer_attested"), sv: null, verdict: CONTRADICTED, mode: "buyer_attested" },
    incomplete: { o: obs(incomplete, FRESH, "buyer_attested"), sv: null, verdict: INCOMPLETE, mode: "buyer_attested" },
    stale: { o: obs(good, STALE, "verifier_observed"), sv: null, verdict: UNABLE_TO_VERIFY, mode: "verifier_observed" },
    unavailable: { o: obs(null, FRESH, "verifier_observed", 503), sv: null, verdict: UNABLE_TO_VERIFY, mode: "verifier_observed" },
    unsigned_claim: { o: obs(good, FRESH, "seller_integrated"), sv: ABSENT, verdict: DELIVERED, mode: "buyer_attested" },
    invalid_claim: { o: obs(good, FRESH, "seller_integrated"), sv: INVALID, verdict: DELIVERED, mode: "buyer_attested" },
  };
};

// ---- the 5 x 7 matrix: verdict, effective mode, limits, bindings, signature ----
for (const cls of Object.keys(SUBJECTS)) {
  for (const [name, { o, sv, verdict, mode }] of Object.entries(CASES(cls))) {
    test(`matrix: ${cls} / ${name} -> ${verdict} as ${mode}`, () => {
      const r = signed(cls, o, { seller_verification: sv });
      assert.equal(r.schema, SCHEMA);
      assert.equal(r.delivery_verdict, verdict);
      assert.equal(r.evidence_mode, mode);
      assert.equal(r.declared_mode, o.mode);
      // Limits ride inside the body, for the effective mode, plus the universal list.
      assert.deepEqual(r.this_receipt_proves, [...MODE_LIMITS[mode]]);
      assert.deepEqual(r.this_receipt_does_not_prove, [...NEVER_PROVES]);
      // Why the mode was granted or refused is in the body, never a bare downgrade.
      assert.equal(r.seller_verification.verified, sv?.verified === true);
      assert.equal(r.seller_verification.reason, sv ? sv.reason : "verification_not_performed");
      assert.deepEqual(r.seller_verification.checked, sv ? sv.checked : []);
      if (mode !== o.mode) assert.match(r.reasons.join("\n"), new RegExp(`did not verify \\(${sv.reason}\\); downgraded to buyer_attested`));
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
  const nothing = plain("data_json", obs(null, FRESH, "verifier_observed", 503));
  assert.equal(nothing.delivery_verdict, UNABLE_TO_VERIFY);
  assert.deepEqual(nothing.reasons, ["no artifact was presented or observed"]);
  assert.equal(nothing.artifact_hash, null);
  const late = plain("data_json", obs(GOOD.data_json, STALE, "verifier_observed"));
  assert.equal(late.delivery_verdict, UNABLE_TO_VERIFY);
  assert.notEqual(late.delivery_verdict, CONTRADICTED);
  assert.match(late.reasons.join("\n"), /freshness window/);
  assert.deepEqual(VERDICTS, [DELIVERED, CONTRADICTED, INCOMPLETE, UNABLE_TO_VERIFY]);
});

test("staleness caps EVERY verdict, not only delivered - an accuser cannot recycle an old broken response", () => {
  const cls = "financial_action";
  const at = (artifact, when, extra) => plain(cls, obs(artifact, when, "verifier_observed"), extra);
  const wrong = { ...GOOD[cls], ...WRONG_PATCH[cls] }, incomplete = Object.fromEntries(Object.entries(GOOD[cls]).slice(1));
  // Adversarial review, 2026-09-11: gating the downgrade on DELIVERED applied the
  // freshness rule only when it helped the seller. "This may not be what the call
  // returned" is exactly as true of a broken artifact, and the asymmetry let a
  // dishonest buyer present a genuinely broken response from an earlier or unpaid
  // call and keep a clean `contradicted`.
  assert.equal(at(wrong, STALE).delivery_verdict, UNABLE_TO_VERIFY);
  assert.equal(at(incomplete, STALE).delivery_verdict, UNABLE_TO_VERIFY);
  // The freshness facts are fields, not only prose in `reasons`.
  assert.equal(at(wrong, STALE).within_freshness_window, false);
  assert.ok(at(wrong, STALE).observation_gap_seconds > 0);
  assert.equal(at(null, STALE).delivery_verdict, UNABLE_TO_VERIFY);
  assert.equal(at(GOOD[cls], STALE).delivery_verdict, UNABLE_TO_VERIFY);
  // Observed before it was requested is not fresh either: a negative gap is stale.
  assert.equal(at(GOOD[cls], "2026-09-11T03:59:59+00:00").delivery_verdict, UNABLE_TO_VERIFY);
  // Exactly on the window edge is fresh; one second past is not.
  assert.equal(at(GOOD[cls], "2026-09-11T04:05:00Z").delivery_verdict, DELIVERED);
  assert.equal(at(GOOD[cls], "2026-09-11T04:05:01Z").delivery_verdict, UNABLE_TO_VERIFY);
  // A wider window is a signed parameter, not an ambient one.
  const wide = at(GOOD[cls], STALE, { max_staleness_seconds: 4 * 3600 });
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
    assert.equal(r.observation_gap_seconds, null, "an unparseable pair has no measurable gap");
    assert.equal(r.within_freshness_window, null, "and no window claim is made about it");
  }
  // An unparseable pair caps a contradiction too, now that staleness is symmetric:
  // if we cannot place the observation in time we cannot attribute it to this call,
  // in either direction.
  const wrong = attest({ offer: offerFor(cls), request: { ...requestFor(cls), requested_at: "nope" }, observation: obs({ ...GOOD[cls], finished: false }, FRESH, "buyer_attested"), verifier: VERIFIER });
  assert.equal(wrong.delivery_verdict, UNABLE_TO_VERIFY);
  assert.match(wrong.reasons.join("\n"), /timestamps unparseable/);
});

// ---- mode discipline ----
test("seller_integrated is granted only on verified === true; absent, invalid, unperformed and loose truthy all downgrade with the reason recorded", () => {
  const cls = "issued_credential";
  const o = obs(GOOD[cls], FRESH, "seller_integrated");
  const refused = [
    [ABSENT, "signature_absent"], [INVALID, "signature_invalid"], [null, "verification_not_performed"], [undefined, "verification_not_performed"],
    [{ verified: "true", reason: "string_true", checked: [] }, "string_true"], [{ verified: 1, reason: "one", checked: [] }, "one"], ["verified", "verification_not_performed"],
  ];
  for (const [sv, reason] of refused) {
    const r = plain(cls, o, { seller_verification: sv });
    assert.equal(r.declared_mode, "seller_integrated");
    assert.equal(r.evidence_mode, "buyer_attested", `${JSON.stringify(sv)} kept the stronger label`);
    assert.equal(r.seller_verification.verified, false);
    assert.equal(r.seller_verification.reason, reason);
    assert.equal(r.delivery_verdict, DELIVERED);
    assert.deepEqual(r.this_receipt_proves, [...MODE_LIMITS.buyer_attested]);
    assert.match(r.reasons.join("\n"), new RegExp(`declared seller_integrated but the seller signature did not verify \\(${reason}\\); downgraded to buyer_attested`));
  }
  const kept = plain(cls, o, { seller_verification: VERIFIED });
  assert.equal(kept.evidence_mode, "seller_integrated");
  assert.deepEqual(kept.seller_verification, { ...VERIFIED, detail: null });
  assert.equal(kept.reasons.length, 0);
  assert.deepEqual(kept.this_receipt_proves, [...MODE_LIMITS.seller_integrated]);
});

test("route-shaped flow: a REAL signature from a real key is what attest() records", async () => {
  // Written against the real verifier, not a stub: a genuine ed25519 keypair, its
  // base58 payTo, and a signature over the domain-separated message. A stub that
  // accepts a placeholder string cannot tell a forged signature from a real one,
  // which is the exact hole this module exists to close.
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { encodeBase58 } = await import("../src/delivery-signature.js");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payTo = encodeBase58(publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  const cls = "compute_result";
  const o = obs(GOOD[cls], FRESH, "seller_integrated");
  const hashes = { offer_hash: offerHash(offerFor(cls)), request_hash: requestHash(requestFor(cls)), artifact_hash: hashValue(GOOD[cls]) };
  const realSig = encodeBase58(sign(null, Buffer.from(signingMessage(hashes)), privateKey));

  const ok = await verifySellerSignature({ network: NET, payTo, signature: realSig, ...hashes });
  const good = signed(cls, o, { seller_verification: ok });
  assert.equal(good.evidence_mode, "seller_integrated");
  assert.equal(good.seller_verification.signer, payTo);
  assert.equal(good.seller_verification.rail, "solana");
  assert.ok(good.seller_verification.checked.includes("signer_matches_payto"));
  assert.equal(verifyDelivery(good, KEY.publicKey).valid, true);

  // The same signature replayed onto a different artifact must not survive.
  const replayed = await verifySellerSignature({ network: NET, payTo, signature: realSig, ...hashes, artifact_hash: hashValue({ tampered: true }) });
  assert.equal(replayed.verified, false);

  // Forged, absent, and another seller's key all downgrade - and each records WHY.
  const other = generateKeyPairSync("ed25519");
  const otherPayTo = encodeBase58(other.publicKey.export({ type: "spki", format: "der" }).subarray(-32));
  const cases = [
    await verifySellerSignature({ network: NET, payTo, signature: "forged", ...hashes }),
    await verifySellerSignature({ network: NET, payTo, signature: undefined, ...hashes }),
    await verifySellerSignature({ network: NET, payTo: otherPayTo, signature: realSig, ...hashes }),
  ];
  for (const sv of cases) {
    const r = signed(cls, o, { seller_verification: sv });
    assert.equal(r.evidence_mode, "buyer_attested", `a ${sv.reason} verification granted the strong mode`);
    assert.ok(r.seller_verification.reason, "a downgrade must record its reason");
    assert.equal(verifyDelivery(r, KEY.publicKey).valid, true);
  }
});

test("a verified seller signature never upgrades a mode: buyer_attested stays buyer_attested", () => {
  const cls = "data_json";
  const r = plain(cls, obs(GOOD[cls], FRESH, "buyer_attested"), { seller_verification: VERIFIED });
  assert.equal(r.evidence_mode, "buyer_attested");
  assert.equal(r.declared_mode, "buyer_attested");
  assert.equal(r.seller_verification.verified, true);
  const v = plain(cls, obs(GOOD[cls], FRESH, "verifier_observed"), { seller_verification: ABSENT });
  assert.equal(v.evidence_mode, "verifier_observed");
});

test("the seller signs exactly the three hashes the receipt names, and nothing else the receipt binds", () => {
  const cls = "financial_action";
  const r = signed(cls, obs(GOOD[cls], FRESH, "seller_integrated"), { seller_verification: VERIFIED });
  assert.deepEqual(r.seller_signature_covers, [...SELLER_SIGNATURE_COVERS]);
  assert.deepEqual(SELLER_SIGNATURE_COVERS, ["offer_hash", "request_hash", "artifact_hash"]);
  const msg = signingMessage({ offer_hash: r.offer_hash, request_hash: r.request_hash, artifact_hash: r.artifact_hash });
  assert.equal(msg, `${DOMAIN}\n` + canonical({ artifact_hash: r.artifact_hash, offer_hash: r.offer_hash, request_hash: r.request_hash }),
    "domain and payload are newline-separated; a stub that concatenated them would sign different bytes");
  for (const k of SELLER_SIGNATURE_COVERS) assert.ok(msg.includes(r[k]), `${k} not in the signed message`);
  // The verifier's own claims are outside the seller's signature; the body says so.
  for (const outside of [r.observed_at, VERIFIER, r.delivery_verdict, r.evidence_mode]) assert.equal(msg.includes(outside), false);
  assert.match(r.this_receipt_proves.join("\n"), /covers offer_hash, request_hash and artifact_hash only/);
});

test("unknown mode, missing verifier, or missing key is a thrown error, not a receipt", () => {
  const cls = "data_json";
  assert.throws(() => plain(cls, obs(GOOD[cls], FRESH, "trust_me")), /delivery_unknown_mode/);
  assert.throws(() => plain(cls, obs(GOOD[cls], FRESH, "buyer_attested"), { verifier: "" }), /delivery_no_verifier/);
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

test("strings are not arrays or objects; objects are not arrays; unknown spec types are UNUSABLE SPECS, not seller faults", () => {
  assert.equal(checkSpec({ r: "[]" }, { required_fields: { r: "array" } }).verdict, CONTRADICTED);
  assert.equal(checkSpec({ r: "{}" }, { required_fields: { r: "object" } }).verdict, CONTRADICTED);
  assert.equal(checkSpec({ r: { 0: "a" } }, { required_fields: { r: "array" } }).verdict, CONTRADICTED);
  // An unusable spec is the verifier's problem, not the seller's: "text", "integer",
  // "str" are plausible typos, and grading them as contradicted collapses
  // "could not tell" into "did it wrong".
  assert.equal(checkSpec({ r: "x" }, { required_fields: { r: "text" } }).verdict, UNABLE_TO_VERIFY);
  assert.match(checkSpec({ r: "x" }, { required_fields: { r: "integer" } }).reasons.join(" "), /unknown type "integer"/);
  // "constructor" as a type name must not resolve to Object.prototype.constructor and pass.
  assert.equal(checkSpec({ r: "x" }, { required_fields: { r: "constructor" } }).verdict, UNABLE_TO_VERIFY);
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
  // Absent is not unequal. A must_equal naming a field the offer never required
  // would otherwise manufacture a contradiction out of an omission.
  assert.equal(checkSpec({}, loose).verdict, INCOMPLETE);
  assert.match(checkSpec({}, loose).reasons.join(" "), /missing field constrained by must_equal/);
  assert.equal(checkSpec({ finished: true }, loose).verdict, DELIVERED);
  // Absent no longer collapses to null. Both of these are omissions, and an
  // omission is incomplete - a must_equal expecting null must not be satisfiable
  // by a field that was simply never sent.
  assert.equal(checkSpec({}, { must_equal: { gone: null } }).verdict, INCOMPLETE);
  assert.equal(checkSpec({}, { must_equal: { gone: "x" } }).verdict, INCOMPLETE);
  assert.equal(checkSpec({ gone: null }, { must_equal: { gone: null } }).verdict, DELIVERED);
});

// ---- hash discipline ----
test("two different artifacts never share an artifact_hash; the same offer always hashes identically", () => {
  const cls = "financial_action";
  const v = signed(cls, CASES(cls).valid.o, { seller_verification: VERIFIED }), w = signed(cls, CASES(cls).wrong.o);
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
  const r = signed(cls, CASES(cls).valid.o, { seller_verification: VERIFIED });
  assert.equal(verifyDelivery(r, KEY.publicKey).valid, true);
  const tampered = {
    offer_hash: "0".repeat(64), request_hash: "0".repeat(64), artifact_hash: "0".repeat(64),
    verifier: "someone.else", requested_at: FRESH, observed_at: T0, settlement_ref: "other_sig",
    delivery_verdict: CONTRADICTED, evidence_mode: "verifier_observed", declared_mode: "buyer_attested",
    seller_verification: { ...VERIFIED, verified: false, reason: "signature_invalid" }, seller_signature_covers: [],
    http_status: 503, resource_url: "https://evil.example/", deliverable_class: "data_json",
    price_usdc: 0, max_staleness_seconds: 999999, reasons: ["nothing to see"],
    this_receipt_proves: [], this_receipt_does_not_prove: [], signer: pubkeyB64(OTHER), schema: "delivery-attestation/v1",
  };
  for (const [field, value] of Object.entries(tampered)) {
    const doc = { ...r, [field]: value };
    assert.equal(verifyReceipt(doc, KEY.publicKey), false, `${field} tampered but signature still verified`);
    assert.equal(verifyDelivery(doc, KEY.publicKey).valid, false, `${field} tampered but receipt still valid`);
  }
  // A nested edit inside the verification record is caught too: the whole object is signed.
  assert.equal(verifyReceipt({ ...r, seller_verification: { ...r.seller_verification, signer: "someone" } }, KEY.publicKey), false);
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
  const body = plain(cls, CASES(cls).valid.o, { seller_verification: VERIFIED });
  const resign = (patch) => signReceipt({ ...body, signer: pubkeyB64(KEY), ...patch }, KEY);
  assert.equal(verifyDelivery(resign({}), KEY.publicKey).valid, true);
  // A seller_integrated label with no verified signature behind it: exactly the borrow attest() refuses.
  assert.equal(verifyDelivery(resign({ seller_verification: { ...VERIFIED, verified: false } }), KEY.publicKey).reason, "mode_unsupported_by_signature");
  assert.equal(verifyDelivery(resign({ seller_verification: { ...VERIFIED, verified: "true" } }), KEY.publicKey).reason, "mode_unsupported_by_signature");
  assert.equal(verifyDelivery(resign({ seller_verification: null }), KEY.publicKey).reason, "seller_verification_missing");
  assert.equal(verifyDelivery(resign({ seller_verification: { verified: true } }), KEY.publicKey).reason, "seller_verification_missing");
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
  const args = { offer: offerFor(cls), request: requestFor(cls), observation: CASES(cls).valid.o, verifier: VERIFIER, seller_verification: VERIFIED };
  const { receipt, ...rest } = attestDelivery({ key: KEY, ...args });
  assert.deepEqual(rest, { ...attest(args), signer: pubkeyB64(KEY) });
  assert.equal(canonical(rest), canonical(JSON.parse(JSON.stringify(rest))));
  assert.equal(attest(args).offer_hash, attest(structuredClone(args)).offer_hash);
  assert.equal(Object.hasOwn(rest, "seller_signature_present"), false);
});
