import express from "express";
import { pubkeyB64, signReceipt } from "../receipt.js";
import { SPEC_ORIGINS, hashValue, offerHash, requestHash } from "../delivery.js";

// Lazily resolved so a process without the verifier fails loudly at use, not at boot.
let _verifier = null;
const loadVerifier = async () => (_verifier ??= (await import("../delivery-signature.js")).verifySellerSignature);

/**
 * Delivery attestation surface (standalone router, mounted in ../server.js
 * AHEAD of the app-wide JSON parser so this route owns its own body errors and
 * can answer them in its envelope).
 *
 * - POST /delivery/attest — grade {offer, request, observation} with the
 *   evidence model and return the receipt, signed by the process key.
 *
 * THE MODEL IS NOT HERE. ../delivery.js is owned by another lane; this router
 * calls exactly one function of it and nothing else:
 *
 *   attest(offer, request, observation, { verifier, maxStalenessSeconds })
 *     -> receipt | Promise<receipt>
 *
 *   offer        { resource_url, deliverable_class, price_usdc, spec: { required_fields?, must_equal? } }
 *   request      { request_body, settlement_ref, requested_at }             (the paid call)
 *   observation  { artifact, observed_at, mode, http_status, seller_signature, notes }
 *   receipt      a plain, UNSIGNED object carrying at least: schema, delivery_verdict (one of
 *                DELIVERY_VERDICTS), reasons[], evidence_mode, declared_mode, offer_hash,
 *                request_hash, artifact_hash, this_receipt_proves[], this_receipt_does_not_prove[].
 *                It must not carry `receipt` or `attested_at`; those are this router's.
 *
 *   The model grades. It does not throw for input it cannot grade — that is a
 *   receipt with delivery_verdict "unable_to_verify", and this route returns it
 *   as a 200 like any other verdict. Inability to verify is a result.
 *
 * This router validates SHAPE before calling the model (every bad_* below),
 * signs after, and adds exactly two fields to what the model emitted:
 * attested_at (the signing clock) and receipt (the signature). It never
 * removes, rewrites, or summarises a model field: the limits
 * (this_receipt_proves / this_receipt_does_not_prove) travel verbatim inside
 * the signature, and a model output that lacks them is refused
 * (500 attest_invalid), never patched.
 *
 * Envelope (this route only; the rest of the host answers bare bodies):
 *   200      the signed receipt, bare, as /witness returns its own
 *   4xx/5xx  { reason, details, verifier, served_at }
 *   details is always { problems: string[] } plus, on shape errors, expected + example to copy.
 *
 * Reasons (distinct; nothing is graded or signed on any of them):
 *   400 bad_json          body is not JSON: unparseable, a bare primitive, or not application/json
 *   400 bad_body          JSON, but not an object (e.g. an array)
 *   400 bad_offer         offer missing or off-shape (details.problems names each field)
 *   400 bad_paid_request  request (the paid call) missing or off-shape
 *   400 bad_observation   observation missing or off-shape; `artifact` must be PRESENT (null = nothing came back)
 *   400 bad_mode          observation.mode outside MODES
 *   413 body_too_large    over MAX_BODY
 *   500 attest_failed     the model threw (our defect, logged)
 *   500 attest_invalid    the model returned something that is not a receipt (no verdict, no limits, pre-signed)
 *   500 internal_error    anything else on our side
 *   503 attest_not_wired  no model in this process (deps.attest absent and ../delivery.js not importable)
 *   429 attest_rate_limited  this client is over its per-IP budget (deps.attestAllowed); nothing graded or signed
 *   402 (x402 challenge)     the host has a paywall (deps.paywall) and the request carried no valid payment;
 *                            the challenge is in the PAYMENT-REQUIRED header, the body may be {}
 *
 * Order is the contract: parse -> shape -> limiter -> paywall -> model. A request we
 * cannot read is answered 400 before it costs a limiter slot or sees a 402, the
 * limiter bounds how often one client can reach the key at all, and the paywall
 * (when the host has one; ../server.js wires it at the /witness price) stands
 * between a well-formed request and a signature. Without deps.paywall the route
 * serves unpaid (tests, embedders, the in-process examples) but stays limited.
 *
 * NOT HERE, ON PURPOSE: authentication. A buyer identity (payer address or bearer)
 * would be checked in the handler before attest() and never written into the
 * receipt unless the model binds it. Payment is not recorded in the receipt either:
 * the receipt binds the call it grades, not the fee paid to grade it.
 */

export const ROUTE = "/delivery/attest";
export const MODES = Object.freeze(["buyer_attested", "seller_integrated", "verifier_observed"]);
export const DELIVERY_VERDICTS = Object.freeze(["delivered", "contradicted", "incomplete", "unable_to_verify"]);
/** Type vocabulary an offer spec may name for a required field (mirrors the model's grader). */
export const SPEC_TYPES = Object.freeze(["string", "number", "boolean", "array", "object"]);
/** Artifacts are real payloads, not a witness extract: wider than the host's 64kb, still bounded. */
export const MAX_BODY = "256kb";
export const DEFAULT_MAX_STALENESS_SECONDS = 300;
/** Fields the router owns on the signed document; a model that emits them is refused. */
const RESERVED = ["receipt", "attested_at"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.length > 0;

/** A real subject from the catalog analysis (data_json, USDC 0.28/call): what a buyer would send. */
export const EXAMPLE_BODY = Object.freeze({
  offer: {
    resource_url: "https://stableenrich.dev/api/pdl/people-enrich",
    deliverable_class: "data_json",
    price_usdc: 0.28,
    spec: { required_fields: { query: "string", results: "array", result_count: "number" } },
  },
  request: { request_body: { query: "acme corp" }, settlement_ref: "<settlement tx signature, or null when unknown>", requested_at: "2026-09-11T04:00:00Z" },
  observation: { artifact: { query: "acme corp", results: [{ name: "A" }], result_count: 1 }, observed_at: "2026-09-11T04:00:20Z", mode: "buyer_attested", http_status: 200, seller_signature: null },
});

const OFFER_SHAPE = { resource_url: "string", deliverable_class: "string", price_usdc: "number", spec: { required_fields: { "<field>": SPEC_TYPES.join("|") }, must_equal: { "<field>": "<literal>" } }, spec_origin: `${SPEC_ORIGINS.join("|")} (optional; absent = buyer_authored)` };
const REQUEST_SHAPE = { request_body: "object", settlement_ref: "string|null", requested_at: "string (ISO-8601)" };
const OBSERVATION_SHAPE = { artifact: "any JSON value; null = nothing came back (required key)", observed_at: "string (ISO-8601)", mode: MODES.join("|"), http_status: "integer|null", seller_signature: "{network, payTo, signature}|null", notes: "string[]" };

function checkOffer(o) {
  if (!isObj(o)) return ["offer: object required"];
  const p = [];
  if (!isStr(o.resource_url)) p.push("offer.resource_url: non-empty string required");
  if (!isStr(o.deliverable_class)) p.push("offer.deliverable_class: non-empty string required");
  if (typeof o.price_usdc !== "number" || !Number.isFinite(o.price_usdc) || o.price_usdc < 0) p.push("offer.price_usdc: finite number >= 0 required");
  if (!isObj(o.spec)) p.push("offer.spec: object required ({required_fields?, must_equal?})");
  else {
    const rf = o.spec.required_fields;
    if (rf !== undefined) {
      if (!isObj(rf)) p.push("offer.spec.required_fields: object of field -> type required");
      else for (const [k, t] of Object.entries(rf)) if (!SPEC_TYPES.includes(t)) p.push(`offer.spec.required_fields.${k}: type must be one of ${SPEC_TYPES.join("|")}`);
    }
    if (o.spec.must_equal !== undefined && !isObj(o.spec.must_equal)) p.push("offer.spec.must_equal: object of field -> literal required");
  }
  // Declared provenance of the spec. Optional, but if declared it must be one we
  // know, so a typo cannot silently fall back to buyer_authored and read as a
  // deliberate admission.
  if (o.spec_origin !== undefined && !SPEC_ORIGINS.includes(o.spec_origin)) {
    p.push(`offer.spec_origin: one of ${SPEC_ORIGINS.join("|")}`);
  }
  return p;
}

function checkPaidRequest(r) {
  if (!isObj(r)) return ["request: object required (the paid call)"];
  const p = [];
  if (!isObj(r.request_body)) p.push("request.request_body: object required");
  if (r.settlement_ref != null && typeof r.settlement_ref !== "string") p.push("request.settlement_ref: string or null");
  if (!isStr(r.requested_at)) p.push("request.requested_at: ISO-8601 string required");
  return p;
}

/** Shape only. Parseability of timestamps and the meaning of the artifact are the model's call. */
function checkObservation(o) {
  if (!isObj(o)) return ["observation: object required"];
  const p = [];
  if (!Object.hasOwn(o, "artifact")) p.push("observation.artifact: key required; send null when nothing came back");
  if (!isStr(o.observed_at)) p.push("observation.observed_at: ISO-8601 string required");
  if (!isStr(o.mode)) p.push("observation.mode: string required");
  if (o.http_status != null && !Number.isInteger(o.http_status)) p.push("observation.http_status: integer or null");
  // Not a bare string. Verifying a seller signature needs the payee and the network
  // it was paid on, because the whole point is binding the signature to the payTo the
  // buyer actually paid - a signature with nothing to bind it to proves nothing.
  if (o.seller_signature != null) {
    const sig = o.seller_signature;
    if (typeof sig !== "object" || Array.isArray(sig)) p.push("observation.seller_signature: object or null {network, payTo, signature}");
    else for (const k of ["network", "payTo", "signature"]) {
      if (typeof sig[k] !== "string" || !sig[k]) p.push(`observation.seller_signature.${k}: non-empty string`);
    }
  }
  if (o.notes !== undefined && !(Array.isArray(o.notes) && o.notes.every((n) => typeof n === "string"))) p.push("observation.notes: array of strings");
  return p;
}

/** What we refuse to sign: a receipt with no verdict we recognise, no limits, or fields we own. */
function checkReceipt(r) {
  if (!isObj(r)) return ["model returned a non-object"];
  const p = [];
  if (!DELIVERY_VERDICTS.includes(r.delivery_verdict)) p.push(`delivery_verdict must be one of ${DELIVERY_VERDICTS.join("|")}`);
  if (!MODES.includes(r.evidence_mode)) p.push("evidence_mode missing or unknown");
  if (!Array.isArray(r.reasons)) p.push("reasons[] missing");
  if (!Array.isArray(r.this_receipt_proves) || !r.this_receipt_proves.length) p.push("this_receipt_proves[] missing: a receipt without its limits is not signed");
  if (!Array.isArray(r.this_receipt_does_not_prove) || !r.this_receipt_does_not_prove.length) p.push("this_receipt_does_not_prove[] missing: a receipt without its limits is not signed");
  for (const k of RESERVED) if (Object.hasOwn(r, k)) p.push(`${k} is set by the route, not the model`);
  return p;
}

export function requestMetadata(deps = {}) {
  return {
    route: ROUTE,
    served_at: (deps.now ?? (() => new Date().toISOString()))(),
    verifier: deps.verifier ?? null,
    pubkey_path: "/pubkey",
    signature: "ed25519 over deep-canonical JSON of every data field except receipt; verify against GET /pubkey",
    auth: null,
    payment: null,
  };
}

// Bare bodies, matching /witness and /api/offers. /witness returns its signed
// receipt unwrapped and delivery attestation is the same shape, so a consumer
// verifies both with identical code - an envelope would invite verifying the
// wrapper instead of the artifact inside it.
const failure = (meta) => (status, reason, details) => ({ status, json: { reason, details, verifier: meta.verifier, served_at: meta.served_at } });

/**
 * Shape only, pure: the 400 this body earns, or null when it can be handed to the
 * model. The router runs it ahead of the limiter and the paywall, so a request we
 * cannot read never consumes a slot and never sees a 402.
 */
export function checkDeliveryShape(body, deps = {}) {
  const fail = failure(requestMetadata(deps));
  if (!isObj(body)) return fail(400, "bad_body", { problems: ["body must be a JSON object with offer, request, observation"], expected: { offer: OFFER_SHAPE, request: REQUEST_SHAPE, observation: OBSERVATION_SHAPE }, example: EXAMPLE_BODY });
  const offerProblems = checkOffer(body.offer);
  if (offerProblems.length) return fail(400, "bad_offer", { problems: offerProblems, expected: OFFER_SHAPE, example: EXAMPLE_BODY.offer });
  const requestProblems = checkPaidRequest(body.request);
  if (requestProblems.length) return fail(400, "bad_paid_request", { problems: requestProblems, expected: REQUEST_SHAPE, example: EXAMPLE_BODY.request });
  const observationProblems = checkObservation(body.observation);
  if (observationProblems.length) return fail(400, "bad_observation", { problems: observationProblems, expected: OBSERVATION_SHAPE, example: EXAMPLE_BODY.observation });
  if (!MODES.includes(body.observation.mode)) return fail(400, "bad_mode", { problems: [`observation.mode "${body.observation.mode}" is not an evidence mode`], expected: [...MODES], example: EXAMPLE_BODY.observation.mode });
  return null;
}

/** Pure: body in, {status, json} out. The router below is the only HTTP in this file. */
export async function handleDeliveryAttest(body, deps = {}) {
  const meta = requestMetadata(deps);
  const fail = failure(meta);
  const refused = checkDeliveryShape(body, deps);
  if (refused) return refused;

  // Pass the model exactly the fields it hashes, with the optional ones made explicit.
  // spec_origin rides through. It was dropped by an earlier four-field destructure,
  // which made every receipt this route issued read "buyer_authored" no matter what
  // the caller declared - silently defeating the one field that lets a consumer
  // discount a spec the accuser wrote.
  const { resource_url, deliverable_class, price_usdc, spec, spec_origin } = body.offer;
  const offer = { resource_url, deliverable_class, price_usdc, spec, ...(spec_origin === undefined ? {} : { spec_origin }) };
  const request = { request_body: body.request.request_body, settlement_ref: body.request.settlement_ref ?? null, requested_at: body.request.requested_at };
  const o = body.observation;
  const observation = { artifact: o.artifact, observed_at: o.observed_at, mode: o.mode, http_status: o.http_status ?? null, seller_signature: o.seller_signature ?? null, notes: o.notes ?? [] };

  const model = typeof deps.attest === "function" ? deps.attest : typeof deps.loadAttest === "function" ? await deps.loadAttest() : null;
  if (typeof model !== "function") return fail(503, "attest_not_wired", { problems: ["no evidence model in this process"] });

  // The route owns the async half: verify the seller signature here, hand the model
  // its RESULT. Keeping the model pure and sync is what makes a receipt reproducible
  // from its own body. A signature that is merely present is not evidence, so the
  // result - including the reason it failed - is what gets signed into the receipt.
  let seller_verification = null;
  if (observation.seller_signature) {
    const verify = deps.verifySellerSignature ?? (await loadVerifier());
    const { network, payTo, signature } = observation.seller_signature;
    try {
      seller_verification = await verify({
        network, payTo, signature,
        offer_hash: offerHash(offer), request_hash: requestHash(request),
        artifact_hash: observation.artifact === null ? null : hashValue(observation.artifact),
      });
    } catch (e) {
      (deps.log ?? console.error)("delivery: signature verification threw", e && (e.message || e));
      seller_verification = { verified: false, reason: "verification_threw", rail: null, checked: [] };
    }
  }

  let receipt;
  try {
    receipt = await model({
      offer, request, observation, seller_verification,
      verifier: meta.verifier,
      max_staleness_seconds: deps.maxStalenessSeconds ?? DEFAULT_MAX_STALENESS_SECONDS,
    });
  } catch (e) {
    (deps.log ?? console.error)("delivery: attest threw", e && (e.stack || e.message || e));
    return fail(500, "attest_failed", { problems: ["the evidence model threw; nothing was signed"] });
  }
  const invalid = checkReceipt(receipt);
  if (invalid.length) {
    (deps.log ?? console.error)("delivery: attest returned an invalid receipt", invalid);
    return fail(500, "attest_invalid", { problems: invalid });
  }
  // signer is part of the signed body: verifyDelivery (the offline verifier) refuses a
  // receipt whose signer is not the key it was told to trust, so a route that omits it
  // issues receipts its own library cannot verify.
  const signed = signReceipt({ ...receipt, signer: pubkeyB64(deps.key), attested_at: meta.served_at }, deps.key);
  return { status: 200, json: signed };
}

export function createDeliveryRouter(deps = {}) {
  const router = express.Router();
  const reply = (res, out) => res.status(out.status).json(out.json);
  // The model is resolved lazily and once: deps.attest wins (tests, embedders); otherwise
  // ../delivery.js is imported on first use. A missing module is 503, not a crash at boot.
  let model;
  const loadAttest = () => (model ??= (deps.importModel ?? (() => import("../delivery.js")))()
    .then((m) => (typeof m?.attest === "function" ? m.attest : null))
    .catch((e) => {
      model = undefined;
      if (e && e.code === "ERR_MODULE_NOT_FOUND") return null;
      throw e;
    }));
  const handlerDeps = { ...deps, loadAttest };

  const contentType = (req, res, next) => {
    if (!req.is("application/json")) return reply(res, failure(requestMetadata(deps))(400, "bad_json", { problems: ["body must be application/json"] }));
    next();
  };
  const shape = (req, res, next) => {
    const refused = checkDeliveryShape(req.body, deps);
    return refused ? reply(res, refused) : next();
  };
  // Per-IP budget on requests that have already passed the shape check, so a 400 is
  // free to debug against and a 429 means "you reached the key too often", nothing else.
  const limiter = (req, res, next) => {
    if (typeof deps.attestAllowed === "function" && !deps.attestAllowed(req.ip)) {
      return reply(res, failure(requestMetadata(deps))(429, "attest_rate_limited", { problems: ["too many attestation requests from this client; retry after a minute"] }));
    }
    next();
  };
  // The paywall is the host's (../server.js builds it at the /witness price); it only
  // ever sees a request the shape check accepted, so a 400 never sees a 402.
  const paywall = typeof deps.paywall === "function" ? [deps.paywall] : [];
  router.post(ROUTE, contentType, express.json({ limit: deps.maxBody ?? MAX_BODY }), shape, limiter, ...paywall, (req, res, next) => {
    handleDeliveryAttest(req.body, handlerDeps).then((out) => reply(res, out)).catch(next);
  });

  // Body-parser and handler errors for this route only, answered in the envelope.
  router.use(ROUTE, (err, _req, res, next) => {
    if (!err) return next();
    const fail = failure(requestMetadata(deps));
    if (err.type === "entity.parse.failed" || err.type === "charset.unsupported" || err.type === "encoding.unsupported") return reply(res, fail(400, "bad_json", { problems: ["body is not valid JSON"] }));
    if (err.type === "entity.too.large") return reply(res, fail(413, "body_too_large", { problems: [`body exceeds ${deps.maxBody ?? MAX_BODY}`] }));
    (deps.log ?? console.error)("delivery:", err && (err.stack || err.message || err));
    return reply(res, fail(500, "internal_error", { problems: ["unexpected error; nothing was signed"] }));
  });

  return router;
}
