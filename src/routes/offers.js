import express from "express";
import { buildOfferJson, buildOfferTask, getOffer, handleOfferQuote, probeX402Offer, renderOfferHtml, verifyMerchantOffer } from "../offers.js";

/**
 * Consumer offer surface (standalone router, mounted in ../server.js).
 *
 * - GET /offers/:id — offer page with a buy link and the agent task.
 * - GET /api/offers/:id — offer as structured data (catalog record).
 * - GET /api/offers/:id/task.json — copyable agent task.
 * - POST /api/quotes — build a cart and return the gated checkout: the
 *   merchant checkout URL (after Witness confirms the live price) or the
 *   live x402 accepts[] (after the payee matches the catalog). 409 withholds.
 *
 * Gate runs cost the operator a reader call each, so a gate result is cached
 * per offer for gateTtlMs (default 5 min) and a cache miss is subject to the
 * same per-IP limiter as POST /quote (deps.quoteAllowed).
 */

export const DEFAULT_GATE_TTL_MS = 5 * 60 * 1000;

export function createOffersRouter(deps = {}) {
  const router = express.Router();
  const ttl = Number.isFinite(deps.gateTtlMs) ? deps.gateTtlMs : DEFAULT_GATE_TTL_MS;
  const clock = deps.clock ?? Date.now;
  const now = deps.now ?? (() => new Date().toISOString());
  const cache = new Map();

  // One cached result per cache key; a miss consumes a limiter slot for the caller's IP.
  const gated = async (key, ip, run) => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > clock()) return { ...hit.result, cached: true };
    if (typeof deps.quoteAllowed === "function" && !deps.quoteAllowed(ip)) return { limited: true };
    const result = await run();
    if (ttl > 0) cache.set(key, { result, expiresAt: clock() + ttl });
    return result;
  };

  // handleQuote is injected by ../server.js (which mounts this router) to avoid a circular import.
  const quote = (method) => deps.handleQuote(method, { retrieve: deps.retrieve, key: deps.key, retrieval: method.retrieval ?? deps.retrieval });
  const probeFetch = deps.probeFetch ?? globalThis.fetch;

  const gateDeps = (req) => ({
    catalog: deps.catalog,
    verifyMerchant: typeof deps.retrieve === "function" && typeof deps.handleQuote === "function"
      ? (offer) => gated(`merchant:${offer.id}`, req.ip, () => verifyMerchantOffer(offer, { quote, now }))
      : undefined,
    probeX402: typeof probeFetch === "function"
      ? (offer, resourceUrl) => gated(`x402:${offer.id}`, req.ip, () => probeX402Offer(offer, resourceUrl, { fetch: probeFetch, now }))
      : undefined,
  });

  router.get("/offers/:id", (req, res) => {
    const offer = getOffer(req.params.id, deps.catalog);
    if (!offer) return res.status(404).type("text/plain").send("offer_not_found");
    res.type("text/html").send(renderOfferHtml(offer));
  });

  router.get("/api/offers/:id", (req, res) => {
    const offer = getOffer(req.params.id, deps.catalog);
    if (!offer) return res.status(404).json({ reason: "offer_not_found", offer_id: req.params.id });
    res.json(buildOfferJson(offer));
  });

  router.get("/api/offers/:id/task.json", (req, res) => {
    const offer = getOffer(req.params.id, deps.catalog);
    if (!offer) return res.status(404).json({ reason: "offer_not_found", offer_id: req.params.id });
    res.json(buildOfferTask(offer));
  });

  router.post("/api/quotes", (req, res, next) => {
    handleOfferQuote(req.body, gateDeps(req))
      .then((out) => res.status(out.status).json(out.json))
      .catch(next);
  });

  return router;
}
