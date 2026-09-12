/**
 * Env-gated Shopify mandate path for the x402 digital-product pilot.
 *
 * SHOPIFY_STORE_URL is operator env. Unset or blank is a no-op: this path
 * does not inspect the bundle. A set value is validated as https with no
 * userinfo and is never fetched. When armed, offline predicates check that
 * the mandate/quote do not leak the store origin or human-checkout markers.
 * The path cannot invent a URL, cannot call Catalog or UCP, and cannot
 * complete checkout. Human merchant-checkout stays on the offers rail.
 *
 * Schema: docs/consumer/schemas/shopify-mandate-path-v1.json
 * Env resolution: shopify-mandate-stub.js / shopify-store-url-env-v1.json
 */
import { readFileSync } from "node:fs";
import { evaluateShopifyMandateStub, resolveStoreUrl } from "./shopify-mandate-stub.js";

export const KIND = "witness.shopify_mandate_path.v1";

export const PATH_PREDICATES = Object.freeze([
  "mandate_rejects_store_fields",
  "resource_not_store_origin",
  "quote_not_store_origin",
  "human_checkout_untouched",
]);

export const PATH_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL("../docs/consumer/schemas/shopify-mandate-path-v1.json", import.meta.url), "utf8"),
);

const STORE_FIELDS = Object.freeze([
  "store_url", "cart_url", "checkout_url", "product_url", "variant_id",
]);

const own = (o, k) => o != null && Object.hasOwn(o, k);

function isHumanCheckoutQuote(quote) {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return false;
  if (quote.rail === "merchant_checkout") return true;
  if (quote.checkout === "merchant_hosted") return true;
  if (typeof quote.checkout_url === "string" && quote.checkout_url.length) return true;
  if (typeof quote.cart_url === "string" && quote.cart_url.length) return true;
  if (typeof quote.cart === "string" && quote.cart.length) return true;
  if (quote.cart && typeof quote.cart === "object") return true;
  return false;
}

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

function sameHttpsOrigin(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === "https:" && right.protocol === "https:" && left.origin === right.origin;
  } catch {
    return false;
  }
}

function mandateRejectsStoreFields(mandate) {
  if (mandate == null) return true;
  if (typeof mandate !== "object" || Array.isArray(mandate)) return true;
  return STORE_FIELDS.every((k) => !own(mandate, k));
}

function resourceNotStoreOrigin(mandate, storeUrl) {
  if (mandate == null || typeof mandate !== "object" || Array.isArray(mandate)) return true;
  if (!own(mandate, "resource_url")) return true;
  return !sameHttpsOrigin(mandate.resource_url, storeUrl);
}

function quoteUrls(quote) {
  if (!quote || typeof quote !== "object") return [];
  const out = [];
  for (const k of ["checkout_url", "cart_url", "store_url"]) {
    if (typeof quote[k] === "string") out.push(quote[k]);
  }
  if (typeof quote.cart === "string") out.push(quote.cart);
  if (typeof quote.request?.url === "string") out.push(quote.request.url);
  return out;
}

function quoteNotStoreOrigin(quote, storeUrl) {
  return quoteUrls(quote).every((u) => !sameHttpsOrigin(u, storeUrl));
}

function idleReport(stub, action, reason) {
  return {
    kind: KIND,
    live_store: false,
    fetched: false,
    invented: false,
    armed: false,
    ready: false,
    path: "idle",
    action,
    store: stub.store,
    failed: [],
    completion: "incomplete",
    checkout_approved: false,
    check: { approve: false, reason },
  };
}

/**
 * Shopify mandate path. Unset/invalid is a no-op (bundle ignored).
 * Armed evaluation is offline only. Narration, success flags, and a
 * caller-supplied store_url cannot arm or approve it.
 */
export function evaluateShopifyMandatePath(bundle, opts = {}) {
  const env = opts && typeof opts === "object" && !Array.isArray(opts)
    ? (opts.env ?? process.env)
    : process.env;
  const stub = evaluateShopifyMandateStub({ env });
  if (!stub.armed) {
    const action = stub.store.reason === "store_url_invalid" ? "invalid_noop" : "unset_noop";
    const reason = stub.store.reason === "store_url_invalid" ? "store_url_invalid" : "store_url_unset";
    return idleReport(stub, action, reason);
  }

  const resolved = resolveStoreUrl(env);
  const mandate = bundle && typeof bundle === "object" ? bundle.mandate : null;
  const quote = unwrapQuote(bundle && typeof bundle === "object" ? bundle.quote : null);
  const failed = [];

  if (!mandateRejectsStoreFields(mandate)) failed.push("mandate_rejects_store_fields");
  if (!resourceNotStoreOrigin(mandate, resolved.store_url)) failed.push("resource_not_store_origin");
  if (!quoteNotStoreOrigin(quote, resolved.store_url)) failed.push("quote_not_store_origin");
  if (isHumanCheckoutQuote(quote)) failed.push("human_checkout_untouched");

  const ready = failed.length === 0;
  return {
    kind: KIND,
    live_store: false,
    fetched: false,
    invented: false,
    armed: true,
    ready,
    path: "env_ready",
    action: "configured_eval",
    store: stub.store,
    failed,
    completion: "incomplete",
    checkout_approved: false,
    check: { approve: false, reason: ready ? "path_ready_not_live" : failed[0] },
  };
}

export function pathSummary(report) {
  return {
    kind: report.kind,
    armed: report.armed,
    ready: report.ready,
    action: report.action,
    reason: report.check.reason,
  };
}
