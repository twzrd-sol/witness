import express from "express";
import { handleAuthorizePurchase, handleGetPurchase } from "../mandate.js";
import { buildOfferJson, buildOfferTask, getOffer, handleOfferQuote, renderOfferHtml } from "../offers.js";

/**
 * Consumer offer surface (standalone router, mounted in ../server.js).
 *
 * - GET /offers/:id — offer page with a buy link and the agent task.
 * - GET /api/offers/:id — offer as structured data (catalog record).
 * - GET /api/offers/:id/task.json — copyable agent task.
 * - POST /api/quotes — build a cart and return the merchant checkout URL.
 * - POST /authorize-purchase — signed mandate → eligibility only; never pays.
 * - GET /api/purchases/:id — same-subject status; header auth only; never infers paid.
 */

export function createOffersRouter(deps = {}) {
  const router = express.Router();

  router.get("/offers/:id", (req, res) => {
    const offer = getOffer(req.params.id);
    if (!offer) return res.status(404).type("text/plain").send("offer_not_found");
    res.type("text/html").send(renderOfferHtml(offer));
  });

  router.get("/api/offers/:id", (req, res) => {
    const offer = getOffer(req.params.id);
    if (!offer) return res.status(404).json({ reason: "offer_not_found", offer_id: req.params.id });
    res.json(buildOfferJson(offer));
  });

  router.get("/api/offers/:id/task.json", (req, res) => {
    const offer = getOffer(req.params.id);
    if (!offer) return res.status(404).json({ reason: "offer_not_found", offer_id: req.params.id });
    res.json(buildOfferTask(offer));
  });

  router.post("/api/quotes", (req, res, next) => {
    try {
      const out = handleOfferQuote(req.body);
      res.status(out.status).json(out.json);
    } catch (e) {
      next(e);
    }
  });

  router.get("/api/purchases/:id", (req, res, next) => {
    try {
      const out = handleGetPurchase(
        { purchase_id: req.params.id, subject: req.get("x-witness-subject") },
        { ledger: deps.ledger ?? deps.mandateLedger },
      );
      res.status(out.status).json(out.json);
    } catch (e) {
      next(e);
    }
  });

  router.post("/authorize-purchase", (req, res, next) => {
    try {
      const out = handleAuthorizePurchase(req.body, {
        issuerKeys: deps.issuerKeys ?? deps.mandateIssuerKeys,
        ledger: deps.ledger ?? deps.mandateLedger,
      });
      res.status(out.status).json(out.json);
    } catch (e) {
      next(e);
    }
  });

  return router;
}
