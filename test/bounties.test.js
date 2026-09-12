import test from "node:test";
import assert from "node:assert/strict";
import { tempDir } from "./helpers/tmpdir.js";
import {
  bountyState,
  handleClaimBounty,
  handleCompleteBounty,
  handleGetBounty,
  handlePostBounty,
  withBountyLock,
} from "../src/bounties.js";
import { SELLER_OFFER_SCHEMA_VERSION, buildSellerCard } from "../src/seller.js";
import { generateProcessKey } from "../src/receipt.js";
import { createApp } from "../src/server.js";

const POSTER = {
  schema_version: SELLER_OFFER_SCHEMA_VERSION,
  seller_id: "agent:poster-1",
  capability: "cited research pack",
  price_minor: 10000,
  currency: "USDC",
  network: "base",
  payout_wallet: "0xabc0000000000000000000000000000000000001",
  sla_minutes: 60,
  deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
};
const CLAIMER = { ...POSTER, seller_id: "agent:hunter-7", payout_wallet: "0xdef0000000000000000000000000000000000002" };
const TASK = { description: "Confirm the starter price on https://example.com/pricing" };
const NOW = "2026-09-10T12:00:00.000Z";
const now = () => NOW;

test("post validates the poster and opens a bounty", () => {
  const out = handlePostBounty({ poster: POSTER, task: TASK }, { id: "b1", now });
  assert.equal(out.status, 200);
  assert.equal(out.json.success, true);
  assert.equal(out.json.data.bounty.id, "b1");
  assert.equal(out.json.data.bounty.status, "open");
  assert.equal(out.json.data.bounty.poster_card.payout_wallet, POSTER.payout_wallet);
  assert.equal(out.json.data.bounty.task.description, TASK.description);
  assert.equal(out.event.type, "posted");
});

test("post rejects bad posters and bad tasks with structured details", () => {
  const badPoster = handlePostBounty({ poster: { ...POSTER, currency: "VIRTUAL" }, task: TASK }, { id: "b1", now });
  assert.equal(badPoster.status, 400);
  assert.equal(badPoster.json.error.reason, "bad_poster_offer");
  assert.ok(badPoster.json.error.details.some((d) => d.field === "currency"));

  const badTask = handlePostBounty({ poster: POSTER, task: { description: "  " } }, { id: "b1", now });
  assert.equal(badTask.status, 400);
  assert.equal(badTask.json.error.reason, "bad_task");
});

test("poster cannot claim their own bounty", () => {
  const posted = handlePostBounty({ poster: POSTER, task: TASK }, { id: "b1", now });
  const self = handleClaimBounty(bountyState([posted.event]), "b1", { claimer: POSTER }, { now });
  assert.equal(self.status, 409);
  assert.equal(self.json.error.reason, "self_claim_refused");
});

test("claim binds the claimer card; a second claim is refused", () => {
  const posted = handlePostBounty({ poster: POSTER, task: TASK }, { id: "b1", now });
  const state = bountyState([posted.event]);
  const claimed = handleClaimBounty(state, "b1", { claimer: CLAIMER }, { now });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.data.bounty.status, "claimed");
  assert.equal(claimed.json.data.bounty.claim.claimer_card.payout_wallet, CLAIMER.payout_wallet);

  const again = handleClaimBounty(bountyState([posted.event, claimed.event]), "b1", { claimer: CLAIMER }, { now });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.reason, "bounty_not_open");

  const missing = handleClaimBounty(state, "nope", { claimer: CLAIMER }, { now });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.reason, "bounty_not_found");
});

test("complete records the explicit outcome row future cards build from", () => {
  const posted = handlePostBounty({ poster: POSTER, task: TASK }, { id: "b1", now });
  const claimed = handleClaimBounty(bountyState([posted.event]), "b1", { claimer: CLAIMER }, { now });
  const state = bountyState([posted.event, claimed.event]);
  const done = handleCompleteBounty(state, "b1", { outcome: { decision: "accepted", delivery_minutes: 42 } }, { now });
  assert.equal(done.status, 200);
  assert.equal(done.json.data.bounty.status, "complete");
  assert.deepEqual(done.json.data.bounty.outcome, { status: "accepted", decision: "accepted", delivery_minutes: 42, completed_at: NOW });

  const bad = handleCompleteBounty(state, "b1", { outcome: { decision: "maybe" } }, { now });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.reason, "bad_outcome");

  const early = handleCompleteBounty(bountyState([posted.event]), "b1", { outcome: { decision: "accepted" } }, { now });
  assert.equal(early.status, 409);
  assert.equal(early.json.error.reason, "bounty_not_claimed");

  const card = buildSellerCard(CLAIMER, [done.json.data.bounty.outcome]);
  assert.equal(card.outcomes.completed_jobs, 1, "bounty outcome is a seller-card row, not a parallel vocabulary");
  assert.equal(card.outcomes.accepted_jobs, 1);
  assert.equal(card.outcomes.median_delivery_minutes, 42);
});

test("fold ignores out-of-order and unknown events; get reads one record", () => {
  const posted = handlePostBounty({ poster: POSTER, task: TASK }, { id: "b1", now });
  const state = bountyState([
    { type: "completed", id: "b1", outcome: { decision: "accepted" }, at: NOW },
    { type: "mystery", id: "b1", at: NOW },
    posted.event,
  ]);
  assert.equal(state.b1.status, "open", "complete-before-claim is ignored");
  assert.equal(handleGetBounty(state, "b1").status, 200);
  assert.equal(handleGetBounty(state, "nope").json.error.reason, "bounty_not_found");
});

test("HTTP round-trip: post → claim → complete → get, state survives per-request refold", async () => {
  const dir = tempDir("wit-bounty-");
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: "x" }), observationsDir: dir, bountiesDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const posted = await (await post("/bounties", { poster: POSTER, task: TASK })).json();
    assert.equal(posted.success, true);
    const id = posted.data.bounty.id;
    assert.ok(typeof id === "string" && id.length >= 8, "server-minted id");

    const claimed = await (await post(`/bounties/${id}/claim`, { claimer: CLAIMER })).json();
    assert.equal(claimed.data.bounty.status, "claimed");

    const done = await (await post(`/bounties/${id}/complete`, { outcome: { decision: "rejected", delivery_minutes: 5 } })).json();
    assert.equal(done.data.bounty.status, "complete");
    assert.equal(done.data.bounty.outcome.decision, "rejected");

    const got = await (await fetch(`${base}/bounties/${id}`)).json();
    assert.deepEqual(got.data.bounty, done.data.bounty, "event log refolded identically");

    const missing = await fetch(`${base}/bounties/does-not-exist`);
    assert.equal(missing.status, 404);

    const badJson = await fetch(`${base}/bounties`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(badJson.status, 400);
    const badBody = await badJson.json();
    assert.equal(badBody.success, false);
    assert.equal(badBody.error.reason, "bad_json");
    assert.equal(badBody.data, null);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("concurrent claims: exactly one winner, the loser is 409", async () => {
  const dir = tempDir("wit-bounty-race-");
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: "x" }), observationsDir: dir, bountiesDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const posted = await (await fetch(`${base}/bounties`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ poster: POSTER, task: TASK }),
    })).json();
    const id = posted.data.bounty.id;
    const claimerB = { ...CLAIMER, seller_id: "agent:hunter-8", payout_wallet: "0xaaa0000000000000000000000000000000000003" };
    const claim = (claimer) => fetch(`${base}/bounties/${id}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimer }),
    });
    const [a, b] = await Promise.all([claim(CLAIMER), claim(claimerB)]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const got = await (await fetch(`${base}/bounties/${id}`)).json();
    assert.equal(got.data.bounty.status, "claimed");
    assert.equal(got.data.bounty.claim.claimer_card.seller_id === CLAIMER.seller_id
      || got.data.bounty.claim.claimer_card.seller_id === claimerB.seller_id, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("withBountyLock serializes overlapping writers", async () => {
  const dir = tempDir("wit-bounty-lock-");
  const order = [];
  await Promise.all([
    Promise.resolve().then(async () => {
      await withBountyLock(dir, async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-end");
      });
    }),
    Promise.resolve().then(async () => {
      await new Promise((r) => setTimeout(r, 5));
      await withBountyLock(dir, async () => {
        order.push("b-start");
        order.push("b-end");
      });
    }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});
