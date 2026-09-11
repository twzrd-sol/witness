import { createHash } from "node:crypto";
import { canonical, pubkeyB64, signReceipt, verifyReceipt } from "./receipt.js";

/**
 * Call-specific delivery attestation for A2A commerce.
 *
 * Settlement proves money moved and nothing about what came back: a wallet with a
 * thousand clean settlements could have delivered nothing a thousand times and
 * score identically on every settlement-derived signal. And a public URL that
 * satisfies a schema proves the endpoint CAN deliver, not that it DID deliver to
 * this buyer for this paid request. The difference is exactly the binding this
 * receipt carries - offer + request + artifact + verifier + time. Without all of
 * them it is a page check wearing a receipt's clothes.
 */
export const SCHEMA = "delivery-attestation/v0";

/** Four verdicts, not two. "did not deliver" and "cannot tell" are different
 *  claims and must never collapse: the same discipline as wash_flagged=null
 *  meaning "not evaluated" rather than "clean". Only checkSpec() can produce
 *  contradicted; nothing downstream of it (staleness, mode) may. */
export const DELIVERED = "delivered";
export const CONTRADICTED = "contradicted";
export const INCOMPLETE = "incomplete";
export const UNABLE_TO_VERIFY = "unable_to_verify";
export const VERDICTS = Object.freeze([DELIVERED, CONTRADICTED, INCOMPLETE, UNABLE_TO_VERIFY]);

/** Three evidence modes proving three different things. Conflating them is the
 *  whole failure mode, so the mode is a required field and its limits ride along
 *  inside every receipt body rather than being left to the reader. */
export const MODES = Object.freeze(["buyer_attested", "seller_integrated", "verifier_observed"]);
export const DEFAULT_MAX_STALENESS_SECONDS = 300;

export const MODE_LIMITS = Object.freeze({
  buyer_attested: Object.freeze([
    "The artifact was presented by the buyer, not observed from the seller.",
    "Does not prove the seller emitted it, nor that this request was paid.",
    "A buyer able to fabricate an artifact can obtain a 'contradicted' verdict.",
  ]),
  seller_integrated: Object.freeze([
    "The seller signed this artifact at emit time for this request.",
    "Does not prove the buyer received it, only that the seller emitted it.",
    "Requires seller opt-in; absence of a receipt is not evidence of fault.",
  ]),
  verifier_observed: Object.freeze([
    "The verifier paid and called the endpoint itself.",
    "Proves delivery to the verifier at observed_at, for no other buyer.",
    "Says nothing about the buyer's own call, which may have differed.",
  ]),
});

/** Ships in every receipt, whatever the verdict or mode. */
export const NEVER_PROVES = Object.freeze([
  "funds are recoverable",
  "the seller is honest in general",
  "the buyer received the artifact",
  "an order was fulfilled end to end",
  "a dispute would be resolved in anyone's favour",
]);

/** sha256 over Witness's canonical JSON (deep key sort, compact) so a hash made
 *  here reproduces in any process holding the same value. Bare hex, as sourceHash(). */
export const hashValue = (value) => createHash("sha256").update(canonical(value)).digest("hex");

/** What was promised. Hashing this is what makes a verdict mean anything. */
export const offerHash = ({ resource_url, deliverable_class, price_usdc, spec }) =>
  hashValue({ resource_url, deliverable_class, price_usdc, spec });

/** The specific call. settlement_ref is the on-chain payment when known; unknown
 *  is normalised to null so "unknown" hashes one way (canonical() drops undefined). */
export const requestHash = ({ request_body, settlement_ref, requested_at }) =>
  hashValue({ request_body, settlement_ref: settlement_ref ?? null, requested_at });

/** JSON types checked the way JSON means them, not the way typeof does.
 *  typeof null and typeof [] are both "object"; a boolean is not a number even
 *  though Python's bool subclasses int; NaN and Infinity are not JSON values at
 *  all - canonical() serialises them as null, so accepting one would sign the hash
 *  of a value that was never graded. */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const TYPE_OK = Object.freeze({
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: isObject,
});
const typeName = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && !Number.isFinite(v) ? String(v) : typeof v;

/** Own fields only, and undefined counts as absent: canonical() drops an undefined
 *  value, so the signed artifact_hash covers an artifact without that key. Grading
 *  it as "present" would make the verdict disagree with what was signed. Prototype
 *  keys ("constructor") are not the artifact's fields, same as receipt.js. */
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

/**
 * Grade an artifact against the offer spec. Reject-by-default: anything it cannot
 * positively confirm is not silently a pass, and an unknown type name in the spec
 * makes every value wrong rather than every value right.
 *
 *   unable_to_verify  nothing came back to grade
 *   contradicted      not an object, a field present with the wrong type, or a
 *                     must_equal that does not hold - a field present and wrong
 *                     is a stronger signal than a field absent, so it wins
 *   incomplete        a required field is absent and nothing present is wrong
 *   delivered         everything required is present, typed, and equal
 */
export function checkSpec(artifact, spec) {
  if (artifact === null || artifact === undefined) return { verdict: UNABLE_TO_VERIFY, reasons: ["no artifact was presented or observed"] };
  if (!isObject(artifact)) return { verdict: CONTRADICTED, reasons: [`expected a JSON object, got ${typeName(artifact)}`] };

  const required = isObject(spec?.required_fields) ? spec.required_fields : {};
  const missing = [], wrong = [];
  for (const [key, want] of Object.entries(required)) {
    const got = own(artifact, key);
    if (got === undefined) { missing.push(key); continue; }
    const ok = Object.hasOwn(TYPE_OK, want) ? TYPE_OK[want] : null;
    if (!ok || !ok(got)) wrong.push(`${key}: expected ${want}, got ${typeName(got)}`);
  }
  if (wrong.length) return { verdict: CONTRADICTED, reasons: wrong };
  if (missing.length) return { verdict: INCOMPLETE, reasons: missing.map((k) => `missing required field: ${k}`) };

  // Structural equality via the same canonical form the hash uses: {rows:40} equals
  // {rows:40}, and true never equals 1 (Python's == would say it does).
  const mustEqual = isObject(spec?.must_equal) ? spec.must_equal : {};
  for (const [key, expected] of Object.entries(mustEqual)) {
    const got = own(artifact, key) ?? null;
    if (canonical(got) !== canonical(expected)) {
      return { verdict: CONTRADICTED, reasons: [`${key}: expected ${canonical(expected)}, got ${canonical(got)}`] };
    }
  }
  return { verdict: DELIVERED, reasons: [] };
}

/** Only a timestamp that carries its own offset is accepted. Date.parse reads a
 *  naive "2026-09-11T04:00:00" as host-local time, so one receipt would grade
 *  fresh on one verifier and stale on another; unparseable is stale, never fresh. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const parseIso = (s) => (typeof s === "string" && ISO_WITH_OFFSET.test(s) ? Date.parse(s) : NaN);

/**
 * Produce an unsigned delivery receipt. Pure: same inputs, same body, so the hash
 * a holder recomputes matches the one that was signed. Signing is attestDelivery's job.
 *
 *   offer        { resource_url, deliverable_class, price_usdc, spec }
 *   request      { request_body, settlement_ref, requested_at }
 *   observation  { artifact, observed_at, mode, http_status, seller_signature }
 *                artifact null means nothing came back
 */
export function attest({ offer, request, observation: obs, verifier, max_staleness_seconds = DEFAULT_MAX_STALENESS_SECONDS }) {
  if (!obs || !MODES.includes(obs.mode)) throw new Error(`delivery_unknown_mode: ${obs?.mode}`);
  if (typeof verifier !== "string" || !verifier) throw new Error("delivery_no_verifier");
  if (!isObject(offer) || !isObject(request)) throw new Error("delivery_bad_input");

  const artifact = obs.artifact ?? null;
  let { verdict, reasons } = checkSpec(artifact, offer.spec);

  // Staleness can only downgrade a verdict, never upgrade one: an artifact observed
  // long after the request may not be the one that call returned, but a wrong or
  // incomplete artifact stays wrong or incomplete however late it was seen.
  const t0 = parseIso(request.requested_at), t1 = parseIso(obs.observed_at);
  let stale;
  if (Number.isNaN(t0) || Number.isNaN(t1)) {
    stale = true;
    reasons = [...reasons, "timestamps unparseable; staleness could not be established"];
  } else {
    const gap = (t1 - t0) / 1000;
    stale = gap > max_staleness_seconds || gap < 0;
  }
  if (stale && verdict === DELIVERED) {
    verdict = UNABLE_TO_VERIFY;
    reasons = [...reasons, "artifact observed outside the freshness window for this request; it may not be what this call returned"];
  }

  // seller_integrated claims its strength from a signature. Without one it is only
  // as good as buyer attestation and must not borrow the stronger label. The
  // declared mode is kept beside the effective one so the downgrade is visible.
  let effective_mode = obs.mode;
  if (obs.mode === "seller_integrated" && !obs.seller_signature) {
    effective_mode = "buyer_attested";
    reasons = [...reasons, "declared seller_integrated but carried no seller signature; downgraded to buyer_attested"];
  }

  return {
    schema: SCHEMA,
    offer_hash: offerHash(offer),
    request_hash: requestHash(request),
    artifact_hash: artifact === null ? null : hashValue(artifact),
    delivery_verdict: verdict,
    reasons,
    evidence_mode: effective_mode,
    declared_mode: obs.mode,
    observed_at: obs.observed_at,
    requested_at: request.requested_at,
    settlement_ref: request.settlement_ref ?? null,
    http_status: obs.http_status ?? null,
    seller_signature_present: Boolean(obs.seller_signature),
    verifier,
    resource_url: offer.resource_url,
    deliverable_class: offer.deliverable_class,
    price_usdc: offer.price_usdc,
    // The window is signed too: a verdict that depends on an unsigned parameter
    // could be re-read under a different window than the one that produced it.
    max_staleness_seconds,
    this_receipt_proves: [...MODE_LIMITS[effective_mode]],
    this_receipt_does_not_prove: [...NEVER_PROVES],
  };
}

/** The signed receipt. Same key, same canonical form, same verifyReceipt() as every
 *  other Witness receipt, so a holder checks it offline against GET /pubkey.
 *  `signer` sits inside the signature so a receipt cannot be re-homed under
 *  another key without failing. */
export function attestDelivery({ key, ...args }) {
  if (!key) throw new Error("delivery_no_key");
  return signReceipt({ ...attest(args), signer: pubkeyB64(key) }, key);
}

/** What is this receipt actually anchored to? artifact and settlement may honestly
 *  be false (nothing came back; payment unknown); the other four never may. */
export function binds(receipt) {
  return {
    offer: Boolean(receipt?.offer_hash),
    request: Boolean(receipt?.request_hash),
    artifact: receipt?.artifact_hash != null,
    verifier: Boolean(receipt?.verifier),
    timestamp: Boolean(receipt?.observed_at),
    settlement: receipt?.settlement_ref != null,
  };
}

const fail = (reason) => ({ valid: false, reason, verdict: null, evidence_mode: null, binds: null });

/**
 * Verify a delivery receipt offline against a key the caller already trusts -
 * never one read from the receipt. Beyond the signature it re-checks the shape the
 * design promises: the schema, a verdict from the closed set, modes from the closed
 * set with the effective one no stronger than a signature supports, the four
 * mandatory bindings, and the limits text. A receipt that verifies but omits what
 * it cannot prove is not a delivery receipt, whoever signed it.
 */
export function verifyDelivery(doc, trustedPublicKey) {
  if (!isObject(doc)) return fail("malformed_receipt");
  if (!trustedPublicKey) return fail("no_trusted_key");
  if (doc.schema !== SCHEMA) return fail("schema_mismatch");
  let sigOk;
  try { sigOk = verifyReceipt(doc, trustedPublicKey); } catch { return fail("signature_unverifiable"); }
  if (!sigOk) return fail("signature_invalid");
  if (doc.signer !== pubkeyB64({ publicKey: trustedPublicKey })) return fail("signer_mismatch");
  if (!VERDICTS.includes(doc.delivery_verdict)) return fail("verdict_unknown");
  if (!MODES.includes(doc.evidence_mode) || !MODES.includes(doc.declared_mode)) return fail("mode_unknown");
  if (doc.evidence_mode === "seller_integrated" && doc.seller_signature_present !== true) return fail("mode_unsupported_by_signature");
  const b = binds(doc);
  if (!(b.offer && b.request && b.verifier && b.timestamp)) return fail("binding_incomplete");
  if (!Array.isArray(doc.this_receipt_does_not_prove) || !doc.this_receipt_does_not_prove.length) return fail("limits_missing");
  return { valid: true, reason: null, verdict: doc.delivery_verdict, evidence_mode: doc.evidence_mode, binds: b };
}
