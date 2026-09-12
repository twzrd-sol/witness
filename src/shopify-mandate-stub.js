/**
 * Env-gated Shopify mandate stub for the x402 digital-product pilot.
 *
 * SHOPIFY_STORE_URL is operator env. Unset or blank is a no-op. A set value
 * is validated as https with no userinfo and is never fetched. This stub does
 * not invent a store URL, does not call Catalog or UCP, and cannot complete
 * checkout. Human merchant-checkout stays on the offers rail.
 *
 * Schema: docs/consumer/schemas/shopify-mandate-stub-v1.json
 * Env resolution: docs/consumer/schemas/shopify-store-url-env-v1.json
 */
import { readFileSync } from "node:fs";

export const KIND = "witness.shopify_mandate_stub.v1";
export const STORE_URL_ENV = "SHOPIFY_STORE_URL";

export const STORE_URL_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL("../docs/consumer/schemas/shopify-store-url-env-v1.json", import.meta.url), "utf8"),
);

export const STUB_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL("../docs/consumer/schemas/shopify-mandate-stub-v1.json", import.meta.url), "utf8"),
);

const HTTPS = /^https:\/\//;

const storeUnset = () => ({ ok: true, enabled: false, store_url: null, reason: "store_url_unset" });
const storeInvalid = () => ({ ok: false, enabled: false, store_url: null, reason: "store_url_invalid" });

function isHttpsUrl(s, max = 2048) {
  if (typeof s !== "string" || !HTTPS.test(s) || s.length > max) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && Boolean(u.hostname) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/**
 * Env-gated store URL. Unset/blank is a no-op. A set value is checked as
 * https and never fetched. Not a mandate field and not a Done predicate.
 * Caller-supplied store_url on opts is ignored — only this env is read.
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

function storeReport(resolved) {
  return {
    env: STORE_URL_ENV,
    ok: resolved.ok,
    enabled: resolved.enabled,
    reason: resolved.reason,
  };
}

function actionFor(resolved) {
  if (resolved.reason === "store_url_configured") return "configured_noop";
  if (resolved.reason === "store_url_invalid") return "invalid_noop";
  return "unset_noop";
}

function checkReason(resolved) {
  if (resolved.reason === "store_url_configured") return "store_url_configured_not_live";
  return resolved.reason;
}

/**
 * Shopify mandate stub. Incomplete is the only completion. Narration,
 * success flags, and a caller-supplied store_url cannot arm or approve it.
 */
export function evaluateShopifyMandateStub(opts = {}) {
  const env = opts && typeof opts === "object" && !Array.isArray(opts)
    ? (opts.env ?? process.env)
    : process.env;
  const resolved = resolveStoreUrl(env);
  return {
    kind: KIND,
    live_store: false,
    fetched: false,
    invented: false,
    armed: resolved.enabled,
    action: actionFor(resolved),
    store: storeReport(resolved),
    completion: "incomplete",
    checkout_approved: false,
    check: { approve: false, reason: checkReason(resolved) },
  };
}
