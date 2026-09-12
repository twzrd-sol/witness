/**
 * StorefrontBackend for Claude Commerce Agents (anthropics/commerce-agents).
 *
 * Method names match the blueprint: search_products, get_product_detail,
 * get_order_status, get_policy, prepare_checkout. This module lives in the
 * Witness tree (JS) so it can be tested here; a Python port for the blueprint
 * package layout is a later wiring step, not a second product.
 *
 * prepare_checkout never pays, never signs, never authorizes a card. It builds
 * a merchant-hosted checkout URL and returns it only after an injected Witness
 * observation of the live merchant page verdicts supported. contradicted,
 * stale, and every other non-supported verdict withhold the URL.
 */

import { OFFERS, buildOfferJson, getOffer, handleOfferQuote } from "./offers.js";
import { evaluateMandate } from "./mandate.js";
import { decideGate } from "../scripts/shopping-preapproval.mjs";

const FORBIDDEN_CHECKOUT_KEYS = Object.freeze([
  "decision",
  "reason",
  "payment_authorized",
  "order_status",
  "enforcement_scope",
]);

function haystack(offer) {
  return [offer.id, offer.merchant, offer.product, offer.variant, offer.outcome, offer.deliverable]
    .filter((s) => typeof s === "string")
    .join(" ")
    .toLowerCase();
}

export function createStorefrontBackend({ catalog = OFFERS, observe, issuerKeys, ledger } = {}) {
  return {
    search_products(query = "") {
      const q = String(query ?? "").trim().toLowerCase();
      const rows = Object.values(catalog).map(buildOfferJson);
      if (!q) return rows;
      return rows.filter((row) => haystack(row).includes(q));
    },

    get_product_detail(id) {
      const offer = getOffer(id, catalog);
      return offer ? buildOfferJson(offer) : null;
    },

    get_order_status() {
      return {
        available: false,
        reason: "merchant_hosted",
        note: "Order status lives at the merchant. This backend does not invent it.",
      };
    },

    get_policy(id) {
      const offer = getOffer(id, catalog);
      if (!offer) return null;
      return { offer_id: offer.id, license_url: offer.license_url };
    },

    evaluate_mandate(mandate, request) {
      return evaluateMandate(mandate, { catalog, issuerKeys, ledger, ...request });
    },

    async prepare_checkout(cart) {
      const quoted = handleOfferQuote(cart ?? {}, catalog);
      if (quoted.status !== 200) {
        return { ok: false, status: quoted.status, error: quoted.json, checkout_url: undefined };
      }
      let mandateDecision;
      if (cart?.mandate) {
        const mandate = evaluateMandate(cart.mandate, {
          catalog,
          issuerKeys,
          ledger,
          subject: cart.subject,
          offer_id: quoted.json.offer_id,
          quantity: quoted.json.cart.items[0].quantity,
          attempt: cart.attempt,
        });
        if (!mandate.ok) {
          return { ok: false, status: mandate.status, error: mandate.json, checkout_url: undefined };
        }
        mandateDecision = mandate.json;
      }
      if (typeof observe !== "function") {
        return { ok: false, status: 422, error: { reason: "observe_required" }, checkout_url: undefined };
      }

      const offer = getOffer(quoted.json.offer_id, catalog);
      let receipt;
      try {
        receipt = await observe(offer);
      } catch {
        return { ok: false, status: 422, error: { reason: "observe_failed" }, checkout_url: undefined };
      }

      const gate = decideGate(receipt);
      if (!gate.approve) {
        return {
          ok: false,
          status: 422,
          error: { reason: "page_not_supported", gate: gate.reason },
          receipt,
          checkout_url: undefined,
        };
      }

      const checkout = { ...quoted.json, receipt, gate: gate.reason };
      for (const k of FORBIDDEN_CHECKOUT_KEYS) delete checkout[k];
      if (mandateDecision) checkout.mandate = mandateDecision;
      return { ok: true, status: 200, checkout, checkout_url: quoted.json.checkout_url };
    },
  };
}
