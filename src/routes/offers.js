import express from "express";
import { buildOfferJson, buildOfferTask, getOffer, handleOfferQuote, renderOfferHtml } from "../offers.js";

/**
 * Consumer pilot offer surface (standalone router, mounted in ../server.js).
 *
 * Handoff-only pilot step per docs/consumer/implementation-contract.md:
 *
 * - GET /offers/:id — public read-only HTML. No checkout creation,
 *   reservation, or paid observation.
 * - GET /api/offers/:id — same offer as structured data
 *   (agent_execution:handoff_only, price_kind:observed_item_price).
 * - GET /api/offers/:id/task.json — reusable intent; authorization:null.
 * - POST /api/quotes — no merchant adapter yet, so always handoff_required
 *   with the public merchant link. Never bills, never reserves.
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
