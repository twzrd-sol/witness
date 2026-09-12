import express from "express";
import { buildSellerCard, validateSellerOffer } from "../seller.js";

/**
 * Seller HTTP contract (standalone router, mounted in ../server.js).
 *
 * Single public endpoint — one route validates AND returns the card, so
 * callers have one shape to parse:
 *
 * - POST /seller/offer/validate — body is { offer, outcomes? } or a bare
 *   offer (outcomes defaults to []). No registry, no persistence: the card
 *   is pure over the request body, and empty history stays unknown — never
 *   a trust claim. Never billed.
 *
 * Success wrapper:
 *   { "success": true, "data": { "seller_card": { ... } }, "request_metadata": { ... } }
 * Failure wrapper (HTTP 400):
 *   { "success": false, "error": { "reason": "bad_seller_offer" | "bad_outcomes", "details": [...] },
 *     "data": null, "request_metadata": { ... } }
 */

function asOffer(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const offer = b.offer ?? b;
  return { container: b, offer };
}

function buildMetadata(container, offer, now) {
  return {
    received_at: now(),
    seller_id: typeof offer?.seller_id === "string" ? offer.seller_id : null,
    has_wrapped_offer: Object.prototype.hasOwnProperty.call(container, "offer"),
  };
}

export function handleSellerOfferValidate(body, { now = () => new Date().toISOString() } = {}) {
  const { container, offer } = asOffer(body);
  const request_metadata = buildMetadata(container, offer, now);
  if (container.outcomes !== undefined && !Array.isArray(container.outcomes)) {
    return {
      status: 400,
      json: {
        success: false,
        error: { reason: "bad_outcomes", details: [{ field: "outcomes", reason: "array_required" }] },
        data: null,
        request_metadata,
      },
    };
  }
  const validation = validateSellerOffer(offer);
  if (!validation.valid) {
    return {
      status: 400,
      json: {
        success: false,
        error: { reason: "bad_seller_offer", details: validation.errors },
        data: null,
        request_metadata,
      },
    };
  }
  const seller_card = buildSellerCard(offer, container.outcomes ?? []);
  return {
    status: 200,
    json: {
      success: true,
      data: { seller_card },
      request_metadata: { ...request_metadata, outcome_count: Array.isArray(container.outcomes) ? container.outcomes.length : 0 },
    },
  };
}

export function createSellerRouter() {
  const router = express.Router();
  router.post("/seller/offer/validate", (req, res, next) => {
    try {
      const out = handleSellerOfferValidate(req.body);
      res.status(out.status).json(out.json);
    } catch (e) {
      next(e);
    }
  });
  return router;
}
