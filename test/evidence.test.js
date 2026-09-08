import { test } from "node:test";
import assert from "node:assert";
import { generateProcessKey, signReceipt } from "../src/receipt.js";
import {
  ASSERTION_GRAMMAR, EXTRACTOR_VERSION, SCHEMA, VERDICTS,
  classifyVerdict, compareObservations, observeEvidence, parseAssertion, verifyEvidence,
} from "../src/evidence.js";

const KEY = generateProcessKey();
const OTHER = generateProcessKey();
const at = (iso) => () => iso;
const T0 = "2026-09-08T12:00:00.000Z";
// CASES name the source `url`; the observation contract takes `requested_url`.
const norm = ({ name, expect, url, ...rest }) => ({ requested_url: url, ...rest });
const observe = (o) => observeEvidence({ key: KEY, now: at(T0), ...norm(o) });

/** Ten controlled sources. No network: every URL is a fixture and every reader
 *  metadata block is fabricated, so the suite tests the observation contract and
 *  never a live page's mood. */
const CASES = [
  { name: "json number supported",   url: "https://fixture.example/product",  text: '{"price":9.99,"title":"Mascara"}',
    extract: { price: "number" }, assertion: "price < 10",            expect: "supported" },
  { name: "json string supported",   url: "https://fixture.example/status",   text: '{"indicator":"none","description":"All Systems Operational"}',
    extract: { indicator: "string" }, assertion: 'indicator == "none"', expect: "supported" },
  { name: "html prose supported",    url: "https://fixture.example/pricing",  text: "<p>starter_price: $49/mo</p><p>rank: 7</p>",
    extract: { rank: "number" }, assertion: "rank < 100",              expect: "supported" },
  { name: "exists supported",        url: "https://fixture.example/todo",     text: '{"userId":1,"title":"delectus aut autem"}',
    extract: { title: "string" }, assertion: "title exists",           expect: "supported" },
  { name: "numeric contradicted",    url: "https://fixture.example/product",  text: '{"price":49.99}',
    extract: { price: "number" }, assertion: "price < 10",             expect: "contradicted" },
  { name: "string contradicted",     url: "https://fixture.example/status",   text: '{"indicator":"minor"}',
    extract: { indicator: "string" }, assertion: 'indicator == "none"', expect: "contradicted" },
  { name: "field absent incomplete", url: "https://fixture.example/empty",    text: '{"other":1}',
    extract: { price: "number" }, assertion: "price < 10",             expect: "incomplete" },
  { name: "null field incomplete",   url: "https://fixture.example/null",     text: '{"pricing":null,"tax":20}',
    extract: { pricing: "number" }, assertion: "pricing < 50",         expect: "incomplete" },
  { name: "malformed unverifiable",  url: "https://fixture.example/product",  text: '{"price":9.99}',
    extract: { price: "number" }, assertion: "price ~~ cheap",         expect: "unable_to_verify" },
  { name: "no assertion",            url: "https://fixture.example/product",  text: '{"price":9.99}',
    extract: { price: "number" }, assertion: null,                     expect: "unable_to_verify" },
];

test("day-one proof: ten controlled sources produce the verdict each one earns", () => {
  for (const c of CASES) {
    const { receipt } = observe(c);
    assert.equal(receipt.verdict, c.expect, `${c.name}: got ${receipt.verdict}`);
    assert.ok(VERDICTS.includes(receipt.verdict), `${c.name}: verdict outside the vocabulary`);
  }
});

test("every supported assertion carries verifiable source evidence", () => {
  for (const c of CASES.filter((c) => c.expect === "supported")) {
    const { receipt, source } = observe(c);
    assert.ok(receipt.evidence.length > 0, `${c.name}: supported with no evidence`);
    for (const e of receipt.evidence) {
      // The quote must be the actual bytes at the recorded offsets, not a retelling.
      assert.equal(source.text.slice(e.location.start, e.location.end), e.quote, `${c.name}: quote is not at its offsets`);
      assert.ok(e.quote_hash.startsWith("sha256:"));
      assert.equal(typeof e.value === "number" || typeof e.value === "string", true);
    }
    assert.equal(verifyEvidence({ receipt, source }, KEY.publicKey, { now: () => Date.parse(T0) }).valid, true);
  }
});

test("a malformed assertion cannot produce supported, and neither can no assertion", () => {
  for (const bad of ["price ~~ cheap", "", "   ", "1 == 1", 'price < "ten"', "price ==", "drop table", null, undefined, 42, {}]) {
    const v = classifyVerdict({ price: 9.99 }, [], bad);
    assert.notEqual(v.verdict, "supported", `${JSON.stringify(bad)} produced supported`);
    assert.equal(v.verdict, "unable_to_verify", `${JSON.stringify(bad)} -> ${v.verdict}`);
  }
  // The parser and the evaluator must agree on what the grammar admits.
  assert.equal(parseAssertion("rank < 100").kind, "compare");
  assert.equal(parseAssertion("title exists").kind, "exists");
  assert.equal(parseAssertion('x < "y"'), null);
});

test("absent evidence is incomplete, never contradicted -- missing is not fraud", () => {
  assert.equal(classifyVerdict({}, ["price"], "price < 10").verdict, "incomplete");
  // The claim names a field the extract never requested: unproven, not refuted.
  assert.equal(classifyVerdict({ title: "x" }, [], "price < 10").verdict, "incomplete");
  assert.equal(classifyVerdict({ price: 9.99 }, [], "price < 10").verdict, "supported");
  assert.equal(classifyVerdict({ price: 49.99 }, [], "price < 10").verdict, "contradicted");
});

test("offline verification succeeds with only the bundle and a pinned key", () => {
  const { receipt, source } = observe(CASES[0]);
  const r = verifyEvidence({ receipt, source }, KEY.publicKey, { now: () => Date.parse(T0) });
  assert.equal(r.valid, true);
  assert.equal(r.historical_verdict, "supported");
  assert.equal(r.current_verdict, "supported");
  // A key the receipt supplied for itself proves nothing; the caller pins one.
  assert.equal(verifyEvidence({ receipt, source }, OTHER.publicKey, { now: () => Date.parse(T0) }).reason, "signature_invalid");
  assert.equal(verifyEvidence({ receipt, source }, null).reason, "no_trusted_key");
});

test("changing the source body invalidates the content match", () => {
  const { receipt, source } = observe(CASES[0]);
  const tampered = { text: source.text.replace("9.99", "1.99"), sha256: source.sha256 };
  assert.equal(verifyEvidence({ receipt, source: tampered }, KEY.publicKey, { now: () => Date.parse(T0) }).reason, "source_hash_mismatch");
  assert.equal(verifyEvidence({ receipt }, KEY.publicKey).reason, "missing_source_text");
});

test("changing the assertion invalidates the receipt", () => {
  const { receipt, source } = observe(CASES[4]); // contradicted: price 49.99 < 10
  const edited = { ...receipt, method: { ...receipt.method, assertion: "price < 100" } };
  assert.equal(verifyEvidence({ receipt: edited, source }, KEY.publicKey, { now: () => Date.parse(T0) }).reason, "signature_invalid");
  const flipped = { ...receipt, verdict: "supported" };
  assert.equal(verifyEvidence({ receipt: flipped, source }, KEY.publicKey, { now: () => Date.parse(T0) }).reason, "signature_invalid");
});

test("recomputation catches a forgery that is correctly signed", () => {
  // The point of replaying rather than trusting: an insider holding the signing
  // key still cannot make the source say what it does not say. Re-sign the
  // tampered payload so the signature is genuinely valid, then verify.
  const { receipt, source } = observe(CASES[4]); // price 49.99, claim price < 10
  assert.equal(receipt.verdict, "contradicted");
  const { receipt: _sig, ...rest } = receipt;
  const forged = signReceipt({ ...rest, verdict: "supported", verdict_reason: null }, KEY);
  const r = verifyEvidence({ receipt: forged, source }, KEY.publicKey, { now: () => Date.parse(T0) });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "verdict_mismatch", "a validly signed lie must fail on recomputation");
  assert.equal(r.historical_verdict, "supported");

  // Same for fabricated evidence: a quote the source never contained.
  const badEvidence = signReceipt({ ...rest, evidence: [{ ...rest.evidence[0], value: 1.99, quote: "1.99" }] }, KEY);
  assert.equal(verifyEvidence({ receipt: badEvidence, source }, KEY.publicKey, { now: () => Date.parse(T0) }).reason, "evidence_mismatch");
});

test("a stale receipt is distinguishable from a current observation", () => {
  const { receipt, source } = observe({ ...CASES[0], valid_for_ms: 1000 });
  const fresh = verifyEvidence({ receipt, source }, KEY.publicKey, { now: () => Date.parse(T0) + 500 });
  assert.equal(fresh.current_verdict, "supported");
  assert.equal(fresh.expired, false);
  const later = verifyEvidence({ receipt, source }, KEY.publicKey, { now: () => Date.parse(T0) + 5000 });
  // Still valid, still historically supported -- only the freshness changed.
  assert.equal(later.valid, true);
  assert.equal(later.historical_verdict, "supported");
  assert.equal(later.current_verdict, "stale");
  assert.equal(later.expired, true);
});

test("a receipt observed in the future is not evidence about any past", () => {
  const { receipt, source } = observe(CASES[0]);
  assert.equal(verifyEvidence({ receipt, source }, KEY.publicKey, { now: () => Date.parse(T0) - 3600_000 }).reason, "observed_in_future");
});

test("a receipt from a different extractor replays as unable_to_verify, not tampering", () => {
  // Today's extractor unwraps the reader envelope and anchors numbers on a digit.
  // A receipt made before those fixes is intact evidence we can no longer replay;
  // saying so is honest, calling it tampering is not.
  const { receipt, source } = observe(CASES[0]);
  const { receipt: _sig, ...rest } = receipt;
  const older = signReceipt({ ...rest, extractor: "witness.extract.v1" }, KEY);
  const r = verifyEvidence({ receipt: older, source }, KEY.publicKey, { now: () => Date.parse(T0) });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "extractor_version_mismatch");
  assert.equal(r.historical_verdict, "supported", "the signed verdict is still reported");
  assert.equal(r.current_verdict, "unable_to_verify");
});

test("the receipt labels reader metadata as the reader's and leaves origin null", () => {
  const { receipt } = observe({ ...CASES[0], reader: { url: "https://reader.example/scrape", http_status: 200, content_type: "application/json" } });
  assert.deepEqual(receipt.origin, { final_url: null, http_status: null, content_type: null });
  assert.equal(receipt.reader.http_status, 200);
  assert.equal(receipt.representation.kind, "reader_plaintext");
  assert.equal(receipt.schema, SCHEMA);
  assert.equal(receipt.extractor, EXTRACTOR_VERSION);
  assert.equal(receipt.assertion_grammar, ASSERTION_GRAMMAR);
});

test("refetch comparison names the four cases without explaining them", () => {
  const a = observe(CASES[0]).receipt;
  const same = observeEvidence({ key: KEY, now: at("2026-09-08T13:00:00.000Z"), ...norm(CASES[0]) }).receipt;
  assert.deepEqual(compareObservations(a, same).source, "same");
  assert.deepEqual(compareObservations(a, same).verdict, "same");

  const changed = observeEvidence({ key: KEY, now: at("2026-09-08T13:00:00.000Z"), ...norm(CASES[0]), text: '{"price":49.99,"title":"Mascara"}' }).receipt;
  const c = compareObservations(a, changed);
  assert.equal(c.source, "changed");
  assert.equal(c.verdict, "changed");
  assert.equal(c.prior_verdict, "supported");
  assert.equal(c.current_verdict, "contradicted");

  assert.equal(compareObservations(a, null).source, "unavailable");
  assert.equal(compareObservations(null, a).reason, "no_prior");
  // A different method answers a different question, and says so.
  const otherMethod = observeEvidence({ key: KEY, now: at(T0), ...norm(CASES[1]) }).receipt;
  assert.equal(compareObservations(a, otherMethod).reason, "method_changed");
});

test("malformed input cannot crash the verifier", () => {
  for (const junk of [null, undefined, 42, "receipt", [], {}, { receipt: null }, { receipt: [] }, { receipt: {}, source: {} }])
    assert.equal(verifyEvidence(junk, KEY.publicKey).valid, false);
  for (const bad of [{ text: "" }, { text: null }, { requested_url: "http://x.example/" }])
    assert.throws(() => observeEvidence({ requested_url: "https://f.example/", text: "x", extract: { a: "number" }, key: KEY, ...bad }));
});
