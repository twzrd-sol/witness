import express from "express";
import {
  appendBountyEvent,
  bountyState,
  handleClaimBounty,
  handleCompleteBounty,
  handleGetBounty,
  handlePostBounty,
  readBountyEvents,
} from "../bounties.js";

/**
 * Bounty coordination routes (pilot, API-only). Post a bounty with a
 * validated poster offer, claim it with a validated claimer offer, complete
 * it with an explicit outcome row. No money movement, no token, no checkout —
 * settlement is out of band. State is the append-only event log folded per
 * request, so every read sees every prior write with no cache to skew it.
 */

export function createBountiesRouter({ storeDir = "data" } = {}) {
  const router = express.Router();
  const withState = (fn) => (req, res, next) => {
    try {
      const out = fn(bountyState(readBountyEvents(storeDir)), req);
      if (out.event) appendBountyEvent(storeDir, out.event);
      res.status(out.status).json(out.json);
    } catch (e) {
      next(e);
    }
  };
  router.post("/bounties", withState((state, req) => handlePostBounty(req.body)));
  router.post("/bounties/:id/claim", withState((state, req) => handleClaimBounty(state, req.params.id, req.body)));
  router.post("/bounties/:id/complete", withState((state, req) => handleCompleteBounty(state, req.params.id, req.body)));
  router.get("/bounties/:id", withState((state, req) => handleGetBounty(state, req.params.id)));
  return router;
}
