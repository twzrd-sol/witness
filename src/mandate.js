/**
 * Operator-signed purchase mandate — eligibility only.
 *
 * Separate signature domain from observation receipts. Caller-supplied
 * public keys are ignored. A valid mandate never authorizes payment:
 * payment_authorized is always false until a tested payment adapter exists.
 */

import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { canonical } from "./receipt.js";
import { OFFERS, getOffer, handleOfferQuote } from "./offers.js";
import { createMandateLedger } from "./mandate-ledger.js";

export const MANDATE_SCHEMA = "witness.mandate.v1";
export const MANDATE_AUDIENCE = "witness";

const REQUIRED = Object.freeze([
  "schema",
  "audience",
  "kid",
  "subject",
  "mandate_id",
  "offer_id",
  "merchant",
  "payee",
  "variant_id",
  "quantity",
  "currency",
  "max_total_minor",
  "expires_at",
  "recurring",
  "license_url",
  "license_digest",
]);

const NOT_AUTHORIZED = Object.freeze({
  payment_authorized: false,
  order_status: "not_created",
  enforcement_scope: "eligibility_only",
});

export function licenseUrlDigest(url) {
  return createHash("sha256").update(`url:${url}`).digest("hex");
}

export function merchantPayee(offer) {
  return new URL(offer.cart_base).origin;
}

/** kid → KeyObject from a JSON file of base64 SPKI public keys. Private keys are refused. */
export function loadIssuerPubkeys(file) {
  if (typeof file !== "string" || !file || !existsSync(file)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const out = {};
  for (const [kid, b64] of Object.entries(parsed)) {
    if (typeof kid !== "string" || !kid || typeof b64 !== "string") continue;
    try {
      out[kid] = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
    } catch {
      /* skip unreadable kids; do not invent a trust anchor */
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function unsigned(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  const { signature, publicKey, pubkey, ...rest } = doc;
  return { signature, rest };
}

export function signMandate(fields, kp) {
  const rest = {
    ...fields,
    schema: MANDATE_SCHEMA,
    audience: MANDATE_AUDIENCE,
    license_digest: fields.license_digest ?? licenseUrlDigest(fields.license_url),
  };
  const signature = sign(null, Buffer.from(canonical(rest)), kp.privateKey).toString("base64");
  return { ...rest, signature };
}

export function verifyMandate(doc, publicKey) {
  const parts = unsigned(doc);
  if (!parts?.signature || !publicKey) return false;
  try {
    return verify(null, Buffer.from(canonical(parts.rest)), publicKey, Buffer.from(parts.signature, "base64"));
  } catch {
    return false;
  }
}

function requestHash({ mandate_id, offer_id, quantity, subject, attempt }) {
  return createHash("sha256").update(canonical({
    mandate_id,
    offer_id,
    quantity,
    subject,
    attempt: typeof attempt === "string" && attempt ? attempt : "",
  })).digest("hex");
}

function payloadHash(rest) {
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

function deny(reason, extra = {}) {
  return { ok: false, status: extra.status ?? 422, json: { reason, ...NOT_AUTHORIZED, ...extra.fields } };
}

function bindErrors(rest, offer, quantity, subject) {
  if (rest.subject !== subject) return "subject_mismatch";
  if (rest.offer_id !== offer.id) return "offer_mismatch";
  if (rest.merchant !== offer.merchant) return "merchant_mismatch";
  if (rest.variant_id !== offer.variant_id) return "variant_mismatch";
  if (rest.quantity !== quantity) return "quantity_mismatch";
  if (rest.currency !== offer.currency) return "currency_mismatch";
  if (rest.license_url !== offer.license_url) return "license_mismatch";
  if (rest.license_digest !== licenseUrlDigest(offer.license_url)) return "license_digest_mismatch";
  if (rest.payee !== merchantPayee(offer)) return "payee_mismatch";
  return null;
}

/**
 * Evaluate a signed mandate against a catalog quote.
 * issuerKeys is a map of kid -> KeyObject. Attacker keys on the document are ignored.
 */
export function evaluateMandate(doc, { catalog = OFFERS, issuerKeys, subject, offer_id, quantity, attempt, now = () => new Date(), ledger } = {}) {
  if (!issuerKeys || typeof issuerKeys !== "object") return deny("issuer_unconfigured", { status: 503 });
  if (typeof subject !== "string" || !subject) return deny("subject_required", { status: 401 });

  const parts = unsigned(doc);
  if (!parts) return deny("bad_mandate", { status: 400 });
  const rest = parts.rest;
  for (const key of REQUIRED) {
    if (rest[key] === undefined || rest[key] === null || rest[key] === "") return deny("bad_schema", { status: 400, fields: { field: key } });
  }
  if (rest.schema !== MANDATE_SCHEMA) return deny("bad_schema", { status: 400 });
  if (rest.audience !== MANDATE_AUDIENCE) return deny("bad_audience");
  if (rest.recurring !== "none") return deny("unsupported_recurring");
  if (!Number.isInteger(rest.max_total_minor) || rest.max_total_minor < 1) return deny("bad_amount", { status: 400 });
  if (!Number.isInteger(rest.quantity) || rest.quantity < 1) return deny("bad_quantity", { status: 400 });

  const issuer = issuerKeys[rest.kid];
  if (!issuer) return deny("unknown_issuer");
  if (!verifyMandate(doc, issuer)) return deny("invalid_signature");

  const expiry = Date.parse(rest.expires_at);
  if (!Number.isFinite(expiry)) return deny("bad_expiry", { status: 400 });
  if (+now() >= expiry) return deny("expired");

  const quoted = handleOfferQuote({ offer_id, quantity }, catalog);
  if (quoted.status !== 200) return deny(quoted.json.reason ?? "offer_not_found", { status: quoted.status });
  const offer = getOffer(quoted.json.offer_id, catalog);
  const bind = bindErrors(rest, offer, quoted.json.cart.items[0].quantity, subject);
  if (bind) return deny(bind);

  const amount = quoted.json.cart.subtotal_minor;
  const store = ledger ?? createMandateLedger();
  const reserved = store.reserve({
    mandateId: rest.mandate_id,
    payloadHash: payloadHash(rest),
    requestHash: requestHash({ mandate_id: rest.mandate_id, offer_id: rest.offer_id, quantity: rest.quantity, subject, attempt }),
    amountMinor: amount,
    maxTotalMinor: rest.max_total_minor,
    subject,
    decide: ({ purchase_id, replay }) => ({
      ok: true,
      eligible: true,
      purchase_id,
      replay: replay === true,
      mandate_id: rest.mandate_id,
      offer_id: rest.offer_id,
      ...NOT_AUTHORIZED,
    }),
  });

  if (reserved.status === "idempotency_conflict") return deny("idempotency_conflict", { status: 409 });
  if (reserved.status === "budget_exceeded") return deny("budget_exceeded");
  return { ok: true, status: 200, json: reserved.decision };
}

export function handleGetPurchase({ purchase_id, subject } = {}, { ledger } = {}) {
  if (typeof subject !== "string" || !subject) return deny("subject_required", { status: 401 });
  const row = typeof ledger?.get === "function" ? ledger.get(purchase_id) : null;
  if (!row || row.subject !== subject) {
    return { ok: false, status: 404, json: { reason: "purchase_not_found", ...NOT_AUTHORIZED } };
  }
  const decision = row.decision && typeof row.decision === "object" && !Array.isArray(row.decision) ? row.decision : {};
  return {
    ok: true,
    status: 200,
    json: {
      ...decision,
      purchase_id: typeof decision.purchase_id === "string" ? decision.purchase_id : purchase_id,
      ...NOT_AUTHORIZED,
    },
  };
}

export function handleAuthorizePurchase(body, deps) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  return evaluateMandate(b.mandate, {
    ...deps,
    subject: b.subject,
    offer_id: b.offer_id,
    quantity: b.quantity === undefined ? 1 : b.quantity,
    attempt: b.attempt,
  });
}
