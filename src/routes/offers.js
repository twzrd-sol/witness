import express from "express";
import { buildOfferJson, buildOfferTask, getOffer, handleOfferQuote, renderOfferHtml } from "../offers.js";

/**
 * Consumer offer surface (standalone router, mounted in ../server.js).
 *
 * - GET /offers/:id — offer page with a buy link and the agent task.
 * - GET /api/offers/:id — offer as structured data (catalog record).
 * - GET /api/offers/:id/task.json — copyable agent task.
 * - POST /api/quotes — build a cart and return the merchant checkout URL.
 */

export function createOffersRouter() {
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

  return router;
}
