/**
 * Offline buyer checklist for the x402 digital-product pilot.
 *
 * Pre-spend readiness against a fixture storefront. Passing this checklist
 * is not Done and is not checkout approval. evaluateDone remains the
 * mandate-bound completion gate (docs/consumer/shopping-mandate.md).
 *
 * Pure functions. No HTTP, no wallet, no payment.
 */
import {
  validateMandate,
  verifyMandate,
  bindMandateToQuote,
  isHumanCheckoutQuote,
} from "./shopping-mandate.js";
import { KIND, ORIGIN, inspectCatalog, getProduct } from "./fixture-storefront.js";

export const CHECKLIST_STEPS = Object.freeze([
  "storefront_is_fixture",
  "catalog_digital_only",
  "no_store_fields",
  "mandate_schema",
  "mandate_signature",
  "mandate_fresh",
  "product_in_catalog",
  "quote_from_fixture",
  "mandate_binds_quote",
  "amount_in_budget",
  "human_checkout_untouched",
  "no_spend",
]);

const own = (o, k) => o != null && Object.hasOwn(o, k);

function isFixtureStorefront(storefront, catalog) {
  const kind = storefront?.kind ?? catalog?.kind;
  const live = storefront?.live_store ?? catalog?.live_store;
  const origin = storefront?.origin ?? catalog?.origin;
  if (kind !== KIND || live !== false || origin !== ORIGIN) return false;
  if (storefront) {
    if (storefront.kind !== KIND || storefront.live_store !== false || storefront.origin !== ORIGIN) {
      return false;
    }
  }
  return true;
}

function catalogDigitalOnly(catalog) {
  const products = catalog?.products;
  if (!Array.isArray(products) || products.length < 1) return false;
  return products.every((p) => p && p.rail === "x402" && p.checkout === "x402");
}

function isFixtureQuote(wrap, quote) {
  if (!wrap || wrap.status !== 200 || !quote || typeof quote !== "object") return false;
  if (quote.source !== "fixture_catalog") return false;
  if (quote.probed !== false) return false;
  if (quote.live_store !== false) return false;
  if (quote.rail !== "x402" || quote.checkout !== "x402") return false;
  if (quote.gate?.status !== "passed" || quote.gate?.reason !== "fixture_catalog") return false;
  if (typeof quote.checkout_url === "string" && quote.checkout_url.length) return false;
  if (quote.cart && typeof quote.cart === "object") return false;
  return true;
}

function noSpend(bundle) {
  if (!bundle || typeof bundle !== "object") return false;
  if (bundle.payment_attempted === true) return false;
  if (bundle.paid === true) return false;
  if (bundle.wallet) return false;
  if (bundle.keypair) return false;
  if (own(bundle, "payment_status") && bundle.payment_status !== "not_attempted") return false;
  return true;
}

/**
 * Library checklist. Incomplete / not-approved is the default, including
 * when every step passes: ready is not checkout_approved.
 * Narration, HTTP 200, and success flags are ignored.
 */
export function evaluateBuyerChecklist(bundle, opts = {}) {
  const failed = [];
  const now = opts.now ?? Date.now();
  const catalog = bundle && typeof bundle === "object" ? bundle.catalog : null;
  const storefront = bundle && typeof bundle === "object" ? bundle.storefront : null;
  const mandate = bundle && typeof bundle === "object" ? bundle.mandate : null;
  const quoteWrap = bundle && typeof bundle === "object" ? bundle.quote : null;
  const quote = quoteWrap && typeof quoteWrap === "object" ? (quoteWrap.body ?? null) : null;

  if (!isFixtureStorefront(storefront, catalog)) failed.push("storefront_is_fixture");
  if (!catalogDigitalOnly(catalog)) failed.push("catalog_digital_only");
  if (!inspectCatalog(catalog).ok) failed.push("no_store_fields");
  if (!validateMandate(mandate).ok) failed.push("mandate_schema");
  if (!verifyMandate(mandate, opts.issuerPublicKey).ok) failed.push("mandate_signature");

  const exp = mandate && typeof mandate.expires_at === "string" ? Date.parse(mandate.expires_at) : NaN;
  if (Number.isNaN(exp) || now >= exp) failed.push("mandate_fresh");

  if (!mandate || !getProduct(mandate.offer_id, catalog)) failed.push("product_in_catalog");
  if (!isFixtureQuote(quoteWrap, quote)) failed.push("quote_from_fixture");

  if (!mandate || !validateMandate(mandate).ok) {
    failed.push("mandate_binds_quote");
  } else {
    const bind = bindMandateToQuote(mandate, quote);
    if (!bind.ok) failed.push("mandate_binds_quote");
  }

  const quoted = Number(quote?.price?.amount_atomic);
  const reserved = bundle?.reserved_minor ?? 0;
  const ceiling = mandate?.max_total_minor;
  if (!Number.isInteger(quoted) || quoted < 1 || !Number.isInteger(reserved) || reserved < 0
    || !Number.isInteger(ceiling) || quoted + reserved > ceiling) {
    failed.push("amount_in_budget");
  }

  if (isHumanCheckoutQuote(quote)) failed.push("human_checkout_untouched");
  if (!noSpend(bundle)) failed.push("no_spend");

  const unique = [...new Set(failed)];
  const ready = unique.length === 0;
  return {
    ready,
    checklist: ready ? "passed" : "failed",
    failed: unique,
    completion: "incomplete",
    checkout_approved: false,
    payment_attempted: false,
    check: {
      approve: false,
      reason: ready ? "checklist_passed_not_done" : unique[0],
    },
  };
}
