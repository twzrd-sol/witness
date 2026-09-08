import { createHash } from "node:crypto";
import { fillExtract, normalizeExtract } from "./extract.js";
import { canonical, evalAssertion, signReceipt, sourceHash, verifyReceipt } from "./receipt.js";

/** Signed into every receipt. A verifier that replays an observation must run the
 *  same extractor the observation was made with: today's extractor unwraps the
 *  reader envelope, prefers quoted fields, and anchors numbers on a digit, so a
 *  receipt signed before those fixes replays to a different value. Version skew is
 *  reported as unable_to_verify, never as tampering — the receipt is intact, we
 *  simply no longer hold the code that produced it. */
export const SCHEMA = "witness.evidence.v2";
export const EXTRACTOR_VERSION = "witness.extract.v2";
export const ASSERTION_GRAMMAR = "witness.assertion.v1";
export const DEFAULT_VALID_FOR_MS = 60 * 60 * 1000;

/** The five states. `stale` is never signed: it is a property of reading a receipt
 *  later, not of the observation, so it appears only as a current_verdict. */
export const VERDICTS = ["supported", "contradicted", "incomplete", "unable_to_verify"];

const sha256 = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");
const own = (o, k) => (o != null && Object.hasOwn(o, k) ? o[k] : undefined);

/** Parse-only twin of evalAssertion's grammar. evalAssertion answers "is it true"
 *  and collapses malformed, missing, and false into one `false`; the product needs
 *  those apart. This returns the shape so the caller can tell which it is, and
 *  never decides truth — classifyVerdict defers to evalAssertion for that, so the
 *  two cannot drift into disagreeing about what is supported. */
export function parseAssertion(assertion) {
  if (assertion === null || assertion === undefined) return { kind: "absent" };
  if (typeof assertion !== "string") return null;
  const s = assertion.trim();
  const exists = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+exists$/);
  if (exists) return { kind: "exists", field: exists[1] };
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|<=|>=|<|>)\s*(.*)$/);
  if (!m) return null;
  const [, field, op, raw] = m;
  const rhs = raw.trim();
  const num = rhs.match(/^(-?\d+(?:\.\d+)?)$/);
  if (num) return { kind: "compare", field, op, expected: Number(num[1]), expected_type: "number" };
  const str = rhs.match(/^(?:"([^"]*)"|'([^']*)')$/);
  if (str) {
    // Only == is defined over strings; `<` on a quoted literal is a claim the
    // grammar cannot evaluate, which is unable_to_verify, not a false claim.
    if (op !== "==") return null;
    return { kind: "compare", field, op, expected: str[1] ?? str[2], expected_type: "string" };
  }
  return null;
}

/**
 * The verdict for one observation. Order matters and encodes the product's
 * honesty rules: absent evidence is never fraud, and an unparseable claim is
 * never contradicted (we would be asserting something about a question we could
 * not read).
 *
 *   unable_to_verify  the assertion is malformed, or there is no assertion at all
 *   incomplete        the source did not carry a field the claim or extract needs
 *   contradicted      every field was found and the claim does not hold
 *   supported         every field was found and the claim holds
 */
export function classifyVerdict(values, missing, assertion) {
  const parsed = parseAssertion(assertion);
  // No claim cannot be a supported claim. It is an observation, not a verdict.
  if (parsed === null) return { verdict: "unable_to_verify", reason: "assertion_malformed" };
  if (parsed.kind === "absent") return { verdict: "unable_to_verify", reason: "assertion_absent" };
  // A claim about a field the extract never requested is unanswerable by
  // construction: we did not look, so we cannot report on it. That is "we could
  // not check", which is free -- distinct from incomplete, which means we looked
  // and the source did not carry it. The separation is what keeps a paid
  // incomplete honest, and it is also the prototype guard: "constructor exists"
  // names a field no extract requested, so it can never mint a receipt.
  const requested = Object.hasOwn(values ?? {}, parsed.field) || (missing ?? []).includes(parsed.field);
  if (!requested) return { verdict: "unable_to_verify", reason: "assertion_field_not_extracted" };
  if (missing && missing.length) return { verdict: "incomplete", reason: "extract_missing", missing: [...missing] };
  if (own(values, parsed.field) === undefined || own(values, parsed.field) === null)
    return { verdict: "incomplete", reason: "assertion_field_absent", missing: [parsed.field] };
  return evalAssertion(values, assertion)
    ? { verdict: "supported", reason: null }
    : { verdict: "contradicted", reason: "assertion_false" };
}

/** Bind each extracted field to the exact bytes it came from: the substring, its
 *  hash, and UTF-16 offsets into the retained text. Spans come from the extractor,
 *  so a receipt cannot claim a quote the matcher did not actually produce. */
function buildEvidence(text, extract, values, spans) {
  return Object.keys(extract).sort().filter((f) => Object.hasOwn(values, f)).map((field) => {
    const span = spans?.[field];
    const quote = span ? text.slice(span.start, span.end) : null;
    return {
      field, type: extract[field], value: values[field],
      quote, quote_hash: quote === null ? null : sha256(quote),
      location: span ? { encoding: "utf16", start: span.start, end: span.end } : null,
    };
  });
}

/**
 * Observe a claim against retained text and sign the result — whatever the result
 * is. This is the change that makes contradicted, incomplete, and unable_to_verify
 * into products rather than 422s: the caller learns what the source actually said,
 * which is the thing they could not safely take on trust.
 *
 * `reader` metadata describes OUR fetch of the reader, and is labelled as such.
 * `origin` stays null throughout: the reader returns its own derivation of the
 * page, so we never observed the origin's status, final URL, or content type and
 * must not imply we did.
 *
 * Returns { receipt, source } — the receipt is signed, the source bundle carries
 * the exact text a verifier replays. Without the text a verifier can check a
 * signature but cannot check that the evidence follows from the source.
 */
export function observeEvidence({
  requested_url, text, extract, assertion = null, key,
  now = () => new Date().toISOString(), valid_for_ms = DEFAULT_VALID_FOR_MS,
  reader = null, vantage = "box",
}) {
  if (typeof text !== "string" || !text.length) throw new Error("evidence_no_text");
  if (typeof requested_url !== "string" || !requested_url.startsWith("https://")) throw new Error("evidence_bad_url");
  const spec = normalizeExtract(extract);
  if (!spec) throw new Error("evidence_bad_extract");

  // One extraction, one set of spans: extracting twice could bind a quote that
  // the values in the same receipt did not come from.
  const filled = fillExtract(text, spec);
  const { values, missing } = filled;
  const spans = filled.spans ?? {};
  const { verdict, reason, missing: vmissing } = classifyVerdict(values, missing, assertion);
  const observed_at = now();

  const rest = {
    schema: SCHEMA,
    extractor: EXTRACTOR_VERSION,
    assertion_grammar: ASSERTION_GRAMMAR,
    requested_url,
    // What we actually saw was the reader's derivation. Naming the origin fields
    // and leaving them null is the honest form: the gap is stated, not hidden.
    origin: { final_url: null, http_status: null, content_type: null },
    reader: reader ? { ...reader } : null,
    representation: { kind: "reader_plaintext", encoding: "utf16" },
    source_hash: sha256(text),
    source_bytes: text.length,
    retrieved_at: observed_at,
    observed_at,
    valid_until: new Date(Date.parse(observed_at) + valid_for_ms).toISOString(),
    method: { url: requested_url, extract: spec, assertion: assertion ?? null },
    evidence: buildEvidence(text, spec, values, spans),
    missing: vmissing ?? (missing.length ? [...missing] : []),
    verdict,
    verdict_reason: reason,
    vantage,
    signer: key ? key.publicKey.export({ type: "spki", format: "der" }).toString("base64") : null,
  };
  return { receipt: signReceipt(rest, key), source: { text, sha256: sha256(text) } };
}

const fail = (reason, extra = {}) => ({
  valid: false, reason, historical_verdict: null, current_verdict: "unable_to_verify", ...extra,
});

/**
 * Verify a receipt offline against a public key the caller already trusts.
 *
 * The key is a parameter, never read from the receipt: a receipt that carries its
 * own key proves only that whoever wrote it had a key. `signer` is checked to
 * match the pinned key so a swapped signer is caught rather than ignored.
 *
 * Verification recomputes rather than re-reads — the source hash, every quote,
 * the extraction, and the verdict are derived again from the retained text. A
 * receipt whose evidence does not follow from its own source fails even with a
 * perfect signature.
 */
export function verifyEvidence(bundle, trustedPublicKey, { now = Date.now } = {}) {
  if (!bundle || typeof bundle !== "object") return fail("malformed_bundle");
  const { receipt, source } = bundle;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return fail("malformed_receipt");
  if (!source || typeof source.text !== "string") return fail("missing_source_text");
  if (!trustedPublicKey) return fail("no_trusted_key");
  if (receipt.schema !== SCHEMA) return fail("schema_mismatch");

  let sigOk;
  try { sigOk = verifyReceipt(receipt, trustedPublicKey); } catch { return fail("signature_unverifiable"); }
  if (!sigOk) return fail("signature_invalid");
  // A valid signature under a different declared signer means the receipt is
  // internally inconsistent, even though the bytes check out under our key.
  try {
    const pinned = trustedPublicKey.export({ type: "spki", format: "der" }).toString("base64");
    if (receipt.signer && receipt.signer !== pinned) return fail("signer_mismatch");
  } catch { /* a raw KeyObject without export stays acceptable; the signature already bound it */ }

  if (sha256(source.text) !== receipt.source_hash) return fail("source_hash_mismatch");
  for (const t of ["observed_at", "valid_until", "retrieved_at"]) {
    if (typeof receipt[t] !== "string" || Number.isNaN(Date.parse(receipt[t]))) return fail("bad_timestamp", { field: t });
  }
  const nowMs = typeof now === "function" ? now() : now;
  // A receipt observed in the future is not evidence about any past we can name.
  if (Date.parse(receipt.observed_at) > nowMs + 60_000) return fail("observed_in_future");
  if (Date.parse(receipt.valid_until) < Date.parse(receipt.observed_at)) return fail("expiry_before_observation");

  if (receipt.extractor !== EXTRACTOR_VERSION) {
    return { valid: false, reason: "extractor_version_mismatch", historical_verdict: receipt.verdict, current_verdict: "unable_to_verify" };
  }
  const spec = normalizeExtract(receipt.method?.extract);
  if (!spec || canonical(spec) !== canonical(receipt.method?.extract ?? {})) return fail("method_extract_invalid");

  const replay = fillExtract(source.text, spec);
  const expected = buildEvidence(source.text, spec, replay.values, replay.spans ?? {});
  if (canonical(expected) !== canonical(receipt.evidence ?? [])) return fail("evidence_mismatch", { historical_verdict: receipt.verdict });

  const again = classifyVerdict(replay.values, replay.missing, receipt.method?.assertion ?? null);
  if (again.verdict !== receipt.verdict) return fail("verdict_mismatch", { historical_verdict: receipt.verdict });

  // The signed verdict is historical and does not change. Freshness is the
  // reader's question, answered separately, and never rewrites what was signed.
  const expired = nowMs > Date.parse(receipt.valid_until);
  return {
    valid: true, reason: null,
    historical_verdict: receipt.verdict,
    current_verdict: expired ? "stale" : receipt.verdict,
    observed_at: receipt.observed_at,
    expired,
  };
}

/**
 * Refetch comparison. Answers the four cases the spec names by comparing a prior
 * receipt against a fresh observation of the same method, without claiming the
 * fresh read explains why anything changed.
 */
export function compareObservations(prior, fresh) {
  if (!prior || typeof prior !== "object") return { source: "unknown", verdict: "unknown", reason: "no_prior" };
  if (fresh === null || fresh === undefined) return { source: "unavailable", verdict: "unknown", reason: "source_unavailable" };
  const sameMethod = canonical(prior.method ?? {}) === canonical(fresh.method ?? {});
  return {
    source: prior.source_hash === fresh.source_hash ? "same" : "changed",
    verdict: prior.verdict === fresh.verdict ? "same" : "changed",
    same_method: sameMethod,
    prior_verdict: prior.verdict ?? null,
    current_verdict: fresh.verdict ?? null,
    // Comparing across different methods answers a different question than the
    // one the prior receipt was signed for, so say so rather than imply drift.
    reason: sameMethod ? null : "method_changed",
  };
}
