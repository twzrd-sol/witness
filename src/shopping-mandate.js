/**
 * Shopping mandate + Done-gate for the x402 digital-product pilot.
 *
 * Schema and docs: docs/consumer/schemas/shopping-mandate-v1.json,
 * docs/consumer/schemas/shopify-store-url-env-v1.json,
 * docs/consumer/shopping-mandate.md. Pure functions. No HTTP, no storefront
 * host, no wallet. SHOPIFY_STORE_URL is env-gated and a no-op when unset.
 * Caller-supplied keys in the document are never a trust anchor.
 */
import { createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonical } from "./receipt.js";

export const SCHEMA = "witness.shopping_mandate.v1";
export const AUDIENCE = "witness.shopping.digital_product";
export const RAIL = "x402";
export const CURRENCY = "USDC";
export const RECURRING = "never";
export const SIGNING_DOMAIN = "witness.shopping_mandate.v1";
export const STORE_URL_ENV = "SHOPIFY_STORE_URL";

export const MANDATE_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL("../docs/consumer/schemas/shopping-mandate-v1.json", import.meta.url), "utf8"),
);

export const STORE_URL_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL("../docs/consumer/schemas/shopify-store-url-env-v1.json", import.meta.url), "utf8"),
);

export const DONE_PREDICATES = Object.freeze([
  "mandate_schema",
  "mandate_signature",
  "mandate_fresh",
  "rail_x402",
  "human_checkout_untouched",
  "mandate_binds_quote",
  "quote_passed",
  "amount_in_budget",
  "receipt_check",
]);

const REQUIRED = Object.freeze([
  "schema", "audience", "issuer_kid", "subject", "mandate_id", "offer_id",
  "merchant", "payee", "product", "quantity", "currency", "max_total_minor",
  "expires_at", "recurring", "rail",
]);
const OPTIONAL = Object.freeze([
  "resource_url", "network", "asset", "purpose", "license_url", "terms_digest", "signature",
]);
const ALLOWED = new Set([...REQUIRED, ...OPTIONAL]);
const NETWORKS = Object.freeze(["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
const PURPOSES = Object.freeze(["research_api", "software", "digital_deliverable"]);
const ID = /^[A-Za-z0-9._:-]+$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const HTTPS = /^https:\/\//;
const CALLER_KEYS = Object.freeze(["issuer_pubkey", "operatorPubkeyPem", "operator_pubkey", "public_key"]);

const fail = (reason) => ({ ok: false, reason });
const own = (o, k) => o != null && Object.hasOwn(o, k);

function isHttpsUrl(s, max = 2048) {
  if (typeof s !== "string" || !HTTPS.test(s) || s.length > max) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

const storeUnset = () => ({ ok: true, enabled: false, store_url: null, reason: "store_url_unset" });
const storeInvalid = () => ({ ok: false, enabled: false, store_url: null, reason: "store_url_invalid" });

/**
 * Env-gated store URL. Unset/blank is a no-op. A set value is checked as
 * https and never fetched. Not a mandate field and not a Done predicate.
 */
export function resolveStoreUrl(env = process.env) {
  const raw = env == null ? undefined : env[STORE_URL_ENV];
  if (raw == null) return storeUnset();
  if (typeof raw !== "string") return storeInvalid();
  const trimmed = raw.trim();
  if (!trimmed) return storeUnset();
  if (!isHttpsUrl(trimmed)) return storeInvalid();
  return { ok: true, enabled: true, store_url: trimmed, reason: "store_url_configured" };
}

function boundedString(s, max) {
  return typeof s === "string" && s.length >= 1 && s.length <= max;
}

/** Schema check only. Does not verify a signature. */
export function validateMandate(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail("bad_json");
  for (const k of Object.keys(doc)) {
    if (!ALLOWED.has(k)) return fail("unexpected_field");
  }
  for (const k of CALLER_KEYS) {
    if (own(doc, k)) return fail("caller_supplied_key");
  }
  for (const k of REQUIRED) {
    if (!own(doc, k)) return fail("missing_field");
  }
  if (doc.schema !== SCHEMA) return fail("schema_mismatch");
  if (doc.audience !== AUDIENCE) return fail("audience_mismatch");
  if (doc.rail !== RAIL) return fail("rail_not_x402");
  if (doc.currency !== CURRENCY) return fail("currency_unsupported");
  if (doc.recurring !== RECURRING) return fail("recurring_unsupported");
  if (!boundedString(doc.issuer_kid, 128) || !ID.test(doc.issuer_kid)) return fail("bad_issuer_kid");
  if (!boundedString(doc.subject, 128)) return fail("bad_subject");
  if (!boundedString(doc.mandate_id, 128) || doc.mandate_id.length < 8 || !ID.test(doc.mandate_id)) return fail("bad_mandate_id");
  if (!boundedString(doc.offer_id, 64)) return fail("bad_offer_id");
  if (!boundedString(doc.merchant, 64)) return fail("bad_merchant");
  if (!boundedString(doc.payee, 128)) return fail("bad_payee");
  if (!boundedString(doc.product, 128)) return fail("bad_product");
  if (!Number.isInteger(doc.quantity) || doc.quantity < 1 || doc.quantity > 99) return fail("bad_quantity");
  if (!Number.isInteger(doc.max_total_minor) || doc.max_total_minor < 1 || doc.max_total_minor > 10_000_000) {
    return fail("bad_max_total_minor");
  }
  if (typeof doc.expires_at !== "string" || !ISO.test(doc.expires_at) || Number.isNaN(Date.parse(doc.expires_at))) {
    return fail("bad_expires_at");
  }
  if (own(doc, "resource_url") && !isHttpsUrl(doc.resource_url)) return fail("bad_resource_url");
  if (own(doc, "network") && !NETWORKS.includes(doc.network)) return fail("bad_network");
  if (own(doc, "asset") && !boundedString(doc.asset, 128)) return fail("bad_asset");
  if (own(doc, "purpose") && !PURPOSES.includes(doc.purpose)) return fail("bad_purpose");
  if (own(doc, "license_url") && doc.license_url !== null && !isHttpsUrl(doc.license_url)) return fail("bad_license_url");
  if (own(doc, "terms_digest") && doc.terms_digest !== null && (typeof doc.terms_digest !== "string" || !HEX64.test(doc.terms_digest))) {
    return fail("bad_terms_digest");
  }
  if (own(doc, "signature") && (typeof doc.signature !== "string" || !doc.signature.length)) return fail("bad_signature");
  return { ok: true, mandate: doc };
}

function unsignedBody(doc) {
  const { signature: _sig, ...rest } = doc;
  return rest;
}

function signedBytes(body) {
  return Buffer.from(canonical({ domain: SIGNING_DOMAIN, ...unsignedBody(body) }));
}

/** Attach Ed25519 over the signing domain + canonical unsigned body. */
export function signMandate(body, kp) {
  const checked = validateMandate(unsignedBody(body));
  if (!checked.ok) throw new Error(checked.reason);
  const signature = edSign(null, signedBytes(checked.mandate), kp.privateKey).toString("base64");
  return { ...checked.mandate, signature };
}

function pinnedKey(pin) {
  if (!pin) return null;
  if (typeof pin === "object" && typeof pin.verify === "function") return pin;
  if (typeof pin === "string") {
    return createPublicKey({ key: Buffer.from(pin, "base64"), format: "der", type: "spki" });
  }
  return pin;
}

/** Verify against an independently pinned key. A key inside the document is ignored. */
export function verifyMandate(doc, issuerPublicKey) {
  const schema = validateMandate(doc);
  if (!schema.ok) return schema;
  if (typeof doc.signature !== "string" || !doc.signature.length) return fail("signature_missing");
  let key;
  try {
    key = pinnedKey(issuerPublicKey);
  } catch {
    return fail("trusted_key_invalid");
  }
  if (!key) return fail("trusted_key_invalid");
  try {
    if (edVerify(null, signedBytes(doc), key, Buffer.from(doc.signature, "base64")) !== true) {
      return fail("signature_invalid");
    }
  } catch {
    return fail("signature_invalid");
  }
  return { ok: true, mandate: doc };
}

/** wzrd-final resourceAllow: same origin, exact path or child path, no userinfo. */
export function resourceScopeAllows(scopeRaw, resourceRaw) {
  try {
    const scope = new URL(scopeRaw);
    const resource = new URL(resourceRaw);
    if (scope.protocol !== "https:" || resource.protocol !== "https:") return false;
    if (scope.origin !== resource.origin) return false;
    if (scope.username || scope.password || resource.username || resource.password) return false;
    const exact = resource.pathname === scope.pathname;
    const child = (scope.pathname.endsWith("/") ? scope.pathname : `${scope.pathname}/`);
    if (!exact && !resource.pathname.startsWith(child)) return false;
    return !scope.search || resource.search === scope.search;
  } catch {
    return false;
  }
}

/** True when the quote is the human merchant rail or still carries its handoff. */
export function isHumanCheckoutQuote(quote) {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return false;
  if (quote.rail === "merchant_checkout") return true;
  if (quote.checkout === "merchant_hosted") return true;
  if (typeof quote.checkout_url === "string" && quote.checkout_url.length) return true;
  if (typeof quote.cart_url === "string" && quote.cart_url.length) return true;
  if (typeof quote.cart === "string" && quote.cart.length) return true;
  if (quote.cart && typeof quote.cart === "object") return true;
  return false;
}

/** Accept `{status, body}`, `{status, json}`, or a bare quote object. */
function unwrapQuote(quoteWrap) {
  if (!quoteWrap || typeof quoteWrap !== "object" || Array.isArray(quoteWrap)) return null;
  if (own(quoteWrap, "body") && quoteWrap.body != null && typeof quoteWrap.body === "object" && !Array.isArray(quoteWrap.body)) {
    return quoteWrap.body;
  }
  if (own(quoteWrap, "json") && quoteWrap.json != null && typeof quoteWrap.json === "object" && !Array.isArray(quoteWrap.json)) {
    return quoteWrap.json;
  }
  if (own(quoteWrap, "rail") || own(quoteWrap, "checkout") || own(quoteWrap, "checkout_url") || own(quoteWrap, "cart") || own(quoteWrap, "cart_url")) {
    return quoteWrap;
  }
  return null;
}

function sameAddr(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

export function bindMandateToQuote(mandate, quote) {
  const failed = [];
  if (!quote || typeof quote !== "object") return { ok: false, failed: ["quote_missing"] };
  if (quote.offer_id !== mandate.offer_id) failed.push("offer_mismatch");
  if (quote.merchant !== mandate.merchant) failed.push("merchant_mismatch");
  if (quote.rail !== RAIL) failed.push("rail_mismatch");
  const asset = quote.price?.asset;
  if (asset !== mandate.currency) failed.push("currency_mismatch");
  const accepts = Array.isArray(quote.accepts) ? quote.accepts : [];
  if (!accepts.some((a) => sameAddr(a.payTo, mandate.payee))) failed.push("payee_mismatch");
  if (own(mandate, "network") && !accepts.some((a) => a.network === mandate.network && sameAddr(a.payTo, mandate.payee))) {
    failed.push("network_mismatch");
  }
  if (own(mandate, "asset") && !accepts.some((a) => a.asset === mandate.asset && sameAddr(a.payTo, mandate.payee))) {
    failed.push("asset_mismatch");
  }
  const resource = quote.request?.url;
  if (own(mandate, "resource_url") && !resourceScopeAllows(mandate.resource_url, resource ?? "")) {
    failed.push("resource_scope");
  }
  if (typeof quote.product === "string" && quote.product !== mandate.product) failed.push("product_mismatch");
  if (own(mandate, "purpose") && own(quote, "purpose") && quote.purpose !== mandate.purpose) {
    failed.push("purpose_mismatch");
  }
  return { ok: failed.length === 0, failed };
}

function receiptCheckOk(check) {
  if (!check || typeof check !== "object" || Array.isArray(check)) return false;
  if (check.approve !== true) return false;
  if (check.reason !== "receipt_supported") return false;
  if (!Number.isInteger(check.verifier_pid) || check.verifier_pid <= 0) return false;
  if (check.verifier_pid === process.pid) return false;
  if (typeof check.receipt_hash !== "string" || !HEX64.test(check.receipt_hash)) return false;
  if (typeof check.key_hash !== "string" || !HEX64.test(check.key_hash)) return false;
  return true;
}

/**
 * Library Done-gate. Incomplete is the default. Narration, HTTP 200, and
 * success flags are ignored. Human merchant checkout cannot complete.
 */
export function evaluateDone(bundle, opts = {}) {
  const failed = [];
  const now = opts.now ?? Date.now();
  const store = resolveStoreUrl(opts.env ?? process.env);
  const mandate = bundle && typeof bundle === "object" ? bundle.mandate : null;
  const quoteWrap = bundle && typeof bundle === "object" ? bundle.quote : null;
  const quote = unwrapQuote(quoteWrap);

  if (!validateMandate(mandate).ok) failed.push("mandate_schema");
  if (!verifyMandate(mandate, opts.issuerPublicKey).ok) failed.push("mandate_signature");

  const exp = mandate && typeof mandate.expires_at === "string" ? Date.parse(mandate.expires_at) : NaN;
  if (Number.isNaN(exp) || now >= exp) failed.push("mandate_fresh");

  const mandateRail = mandate?.rail === RAIL;
  const quoteRail = quote?.rail === RAIL && quote?.checkout === RAIL;
  if (!mandateRail || (quote && !quoteRail)) failed.push("rail_x402");

  if (isHumanCheckoutQuote(quote)) failed.push("human_checkout_untouched");

  if (!mandate || !validateMandate(mandate).ok) {
    failed.push("mandate_binds_quote");
  } else {
    const bind = bindMandateToQuote(mandate, quote);
    if (!bind.ok) failed.push("mandate_binds_quote");
  }

  if (quoteWrap?.status !== 200 || quote?.gate?.status !== "passed") failed.push("quote_passed");

  const quoted = Number(quote?.price?.amount_atomic);
  const reserved = bundle?.reserved_minor ?? 0;
  const ceiling = mandate?.max_total_minor;
  if (!Number.isInteger(quoted) || quoted < 1 || !Number.isInteger(reserved) || reserved < 0
    || !Number.isInteger(ceiling) || quoted + reserved > ceiling) {
    failed.push("amount_in_budget");
  }

  if (!receiptCheckOk(bundle?.check)) failed.push("receipt_check");

  const unique = [...new Set(failed)];
  const complete = unique.length === 0;
  return {
    completion: complete ? "complete" : "incomplete",
    checkout_approved: complete,
    failed: unique,
    check: { approve: complete, reason: complete ? "mandate_done" : unique[0] },
    store: { env: STORE_URL_ENV, enabled: store.enabled, reason: store.reason },
  };
}
