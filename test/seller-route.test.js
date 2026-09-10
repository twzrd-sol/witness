import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHostApp } from "../src/listen.js";
import { SELLER_OFFER_SCHEMA_VERSION } from "../src/seller.js";

const offer = {
  schema_version: SELLER_OFFER_SCHEMA_VERSION,
  seller_id: "agent:research-1",
  capability: "cited research pack",
  price_minor: 10000,
  currency: "USDC",
  network: "base",
  payout_wallet: "0xabc0000000000000000000000000000000000001",
  sla_minutes: 15,
  deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
};

async function withServer(fn) {
  const server = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-seller-")) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("POST /seller/offer/validate returns a wrapped seller card", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/seller/offer/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer, outcomes: [{ status: "accepted", delivery_minutes: 12 }] }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.success, true);
    assert.equal(json.data.seller_card.seller_id, offer.seller_id);
    assert.equal(json.data.seller_card.payout_wallet, offer.payout_wallet);
    assert.equal(json.data.seller_card.outcomes.completed_jobs, 1);
    assert.equal(json.data.seller_card.outcomes.approval_rate, 1);
    assert.equal(json.request_metadata.outcome_count, 1);
  });
});

test("POST /seller/offer/validate rejects bad seller offers with structured details", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/seller/offer/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer: { ...offer, currency: "VIRTUAL", price_minor: 0 } }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.reason, "bad_seller_offer");
    assert.ok(Array.isArray(json.error.details));
    assert.ok(json.error.details.some((d) => d.field === "currency"));
    assert.ok(json.error.details.some((d) => d.field === "price_minor"));
    assert.equal(json.data, null);
  });
});

test("POST /seller/offer/validate rejects non-array outcomes with structured details", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/seller/offer/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer, outcomes: { status: "accepted" } }),
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.reason, "bad_outcomes");
    assert.ok(Array.isArray(json.error.details));
    assert.ok(json.error.details.some((d) => d.field === "outcomes"));
    assert.equal(json.data, null);
  });
});

test("POST /seller/offer/validate wraps malformed JSON as bad_json", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/seller/offer/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.success, false);
    assert.equal(json.error.reason, "bad_json");
    assert.ok(Array.isArray(json.error.details));
    assert.equal(json.error.details[0].field, "offer");
    assert.equal(json.data, null);
  });
});

test('parseable JSON primitives are bad_seller_offer, not bad_json', async () => {
  await withServer(async base => {
    for (const body of ['null', '42', 'true', '"offer"']) {
      const res = await fetch(`${base}/seller/offer/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error.reason, 'bad_seller_offer');
    }
  });
});
