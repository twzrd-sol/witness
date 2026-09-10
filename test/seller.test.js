import test from "node:test";
import assert from "node:assert/strict";
import { buildSellerCard, SELLER_OFFER_SCHEMA_VERSION, validateSellerOffer } from "../src/seller.js";

const offer = {
  schema_version: SELLER_OFFER_SCHEMA_VERSION,
  seller_id: "agent:research-1",
  capability: "cited research pack",
  price_minor: 10000,
  currency: "USDC",
  network: "base",
  payout_wallet: "0x seller",
  sla_minutes: 15,
  deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
};

test("validates a machine-readable seller offer", () => {
  assert.deepEqual(validateSellerOffer(offer), { valid: true, errors: [] });
});

test("rejects unsupported currency, network, and malformed price", () => {
  const result = validateSellerOffer({ ...offer, currency: "VIRTUAL", network: "ethereum", price_minor: 0 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((e) => e.field), ["currency", "network", "price_minor"]);
});

test("seller card leaves performance unknown without history", () => {
  const card = buildSellerCard(offer);
  assert.equal(card.payout_wallet, offer.payout_wallet);
  assert.equal(card.outcomes.completed_jobs, 0);
  assert.equal(card.outcomes.approval_rate, null);
  assert.equal(card.outcomes.median_delivery_minutes, null);
  assert.equal(card.evidence_status, "none");
});

test("seller card computes rates from explicit outcomes", () => {
  const card = buildSellerCard(offer, [
    { status: "accepted", delivery_minutes: 12 },
    { status: "rejected", delivery_minutes: 20 },
    { status: "accepted", delivery_minutes: 8 },
    { status: "refunded" },
  ]);
  assert.equal(card.outcomes.completed_jobs, 3);
  assert.equal(card.outcomes.accepted_jobs, 2);
  assert.equal(card.outcomes.approval_rate, 2 / 3);
  assert.equal(card.outcomes.refund_rate, 1 / 4);
  assert.equal(card.outcomes.median_delivery_minutes, 8);
});

test("rejects non-HTTPS evidence links", () => {
  const result = validateSellerOffer({ ...offer, evidence_url: "http://example.test/evidence" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.field === "evidence_url"));
});
