import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildSellerCard, validateSellerOffer } from "./seller.js";

/** Minimal bounty coordination substrate (pilot).
 *
 * Operator override (2026-09-10): post/claim/complete coordination lives
 * here. Every other standing constraint still binds — no token, no dashboard
 * UI, no permissionless workers, no money movement. Settlement is out of
 * band; this board records who offered what, who claimed it, and the
 * explicit outcome rows future seller cards are built from. Empty history
 * stays unknown; nothing here scores trust.
 *
 * Storage follows the repo's event-log convention (funnel/observations):
 * append-only NDJSON, state derived by folding. One bad line never kills the
 * board — it is skipped.
 */

export const BOUNTY_EVENTS_FILE = "bounties.ndjson";
const BOUNTY_LOCK_FILE = ".bounties.lock";

/** Exclusive lock around read-fold-append so two processes sharing a store
 *  cannot both claim the same open bounty. Single-process HTTP is already
 *  serialized (the handler is sync); this covers a second listener on the
 *  same directory. */
export async function withBountyLock(dir, fn) {
  mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, BOUNTY_LOCK_FILE);
  const deadline = Date.now() + 5000;
  let fd;
  while (true) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error("bounty_lock_timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try { unlinkSync(lockPath); } catch { /* next waiter retries */ }
  }
}

const err = (field, reason) => ({ field, reason });
const fail = (status, reason, details = []) => ({ status, json: { success: false, error: { reason, details }, data: null } });

export function appendBountyEvent(dir, event) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, BOUNTY_EVENTS_FILE), `${JSON.stringify(event)}\n`);
}

export function readBountyEvents(dir) {
  const file = path.join(dir, BOUNTY_EVENTS_FILE);
  if (!existsSync(file)) return [];
  const events = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object" && typeof e.type === "string" && typeof e.id === "string") events.push(e);
    } catch { /* one bad line never kills the board */ }
  }
  return events;
}

function blankRecord(id, poster, task, at) {
  return {
    id,
    status: "open",
    task: { description: task.description },
    poster_card: buildSellerCard(poster, []),
    claim: null,
    outcome: null,
    created_at: at,
    updated_at: at,
  };
}

/** Fold an event log into {id: bounty}. Out-of-order and unknown events are
 *  ignored; the first post wins, transitions only move forward. */
export function bountyState(events) {
  const bounties = {};
  for (const e of events) {
    if (e.type === "posted") {
      if (!bounties[e.id] && e.poster && e.task) bounties[e.id] = blankRecord(e.id, e.poster, e.task, e.at);
    } else if (e.type === "claimed") {
      const b = bounties[e.id];
      if (b && b.status === "open" && e.claimer) {
        b.status = "claimed";
        b.claim = { claimer_card: buildSellerCard(e.claimer, []), claimed_at: e.at };
        b.updated_at = e.at;
      }
    } else if (e.type === "completed") {
      const b = bounties[e.id];
      if (b && b.status === "claimed" && e.outcome) {
        b.status = "complete";
        b.outcome = e.outcome;
        b.updated_at = e.at;
      }
    }
  }
  return bounties;
}

const ok = (bounty) => ({ status: 200, json: { success: true, data: { bounty } } });

export function handlePostBounty(body, { id = randomUUID(), now = () => new Date().toISOString() } = {}) {
  const offer = body && typeof body === "object" && !Array.isArray(body) ? body.poster : undefined;
  const checked = validateSellerOffer(offer);
  if (!checked.valid) return { ...fail(400, "bad_poster_offer", checked.errors) };
  const task = body.task;
  if (!task || typeof task !== "object" || Array.isArray(task))
    return { ...fail(400, "bad_task", [err("task", "object_required")]) };
  if (typeof task.description !== "string" || task.description.trim() === "")
    return { ...fail(400, "bad_task", [err("task.description", "required")]) };
  const at = now();
  const event = { type: "posted", id, poster: offer, task: { description: task.description }, at };
  return { ...ok(bountyState([event])[id]), event };
}

function lookup(state, id) {
  const bounty = state && typeof state === "object" ? state[id] : undefined;
  if (!bounty) return { error: fail(404, "bounty_not_found") };
  return { bounty };
}

export function handleClaimBounty(state, id, body, { now = () => new Date().toISOString() } = {}) {
  const found = lookup(state, id);
  if (found.error) return found.error;
  if (found.bounty.status !== "open") return fail(409, "bounty_not_open");
  const offer = body && typeof body === "object" && !Array.isArray(body) ? body.claimer : undefined;
  const checked = validateSellerOffer(offer);
  if (!checked.valid) return { ...fail(400, "bad_claimer_offer", checked.errors) };
  if (offer.seller_id === found.bounty.poster_card.seller_id) return fail(409, "self_claim_refused");
  const at = now();
  const event = { type: "claimed", id, claimer: offer, at };
  const next = structuredClone(found.bounty);
  next.status = "claimed";
  next.claim = { claimer_card: buildSellerCard(offer, []), claimed_at: at };
  next.updated_at = at;
  return { ...ok(next), event };
}

export function handleCompleteBounty(state, id, body, { now = () => new Date().toISOString() } = {}) {
  const found = lookup(state, id);
  if (found.error) return found.error;
  if (found.bounty.status !== "claimed") return fail(409, "bounty_not_claimed");
  const outcome = body && typeof body === "object" && !Array.isArray(body) ? body.outcome : undefined;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome))
    return { ...fail(400, "bad_outcome", [err("outcome", "object_required")]) };
  if (outcome.decision !== "accepted" && outcome.decision !== "rejected")
    return { ...fail(400, "bad_outcome", [err("outcome.decision", "must_be_accepted_or_rejected")]) };
  if (outcome.delivery_minutes !== undefined && !(Number.isFinite(outcome.delivery_minutes) && outcome.delivery_minutes >= 0))
    return { ...fail(400, "bad_outcome", [err("outcome.delivery_minutes", "non_negative_number_required")]) };
  const at = now();
  const event = {
    type: "completed",
    id,
    // `status` is the seller-card field; `decision` is the request spelling.
    outcome: { status: outcome.decision, decision: outcome.decision, delivery_minutes: outcome.delivery_minutes ?? null, completed_at: at },
    at,
  };
  const next = structuredClone(found.bounty);
  next.status = "complete";
  next.outcome = event.outcome;
  next.updated_at = at;
  return { ...ok(next), event };
}

export function handleGetBounty(state, id) {
  const found = lookup(state, id);
  if (found.error) return found.error;
  return ok(found.bounty);
}
