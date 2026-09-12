import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHostApp } from "../src/listen.js";

const ID = "pixel-surplus-vintage-polaroid";

async function withServer(fn) {
  const server = createHostApp({ OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-offers-")) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("GET /offers/:id serves the handoff page with merchant links", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/offers/${ID}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const html = await res.text();
    assert.match(html, /vintage finish/i);
    assert.match(html, /pixelsurplus\.com\/products\/vintage-polaroid-photo-frames/);
    assert.match(html, /pixelsurplus\.com\/pages\/licensing/);
    assert.match(html, /task\.json/);
    assert.match(html, /No partnership/i);
  });
});

test("GET /offers/:id is 404 for unknown offers", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/offers/nope`);
    assert.equal(res.status, 404);
  });
});

test("GET /api/offers/:id returns handoff_only structured data", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/offers/${ID}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.id, ID);
    assert.equal(json.agent_execution, "handoff_only");
    assert.equal(json.price_kind, "observed_item_price");
    assert.equal(json.variant_id, "46117070209071");
    assert.equal(json.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    const missing = await fetch(`${base}/api/offers/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).reason, "offer_not_found");
  });
});

test("GET /api/offers/:id/task.json carries intent with authorization null", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/offers/${ID}/task.json`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.offer_id, ID);
    assert.equal(json.authorization, null);
    assert.match(json.intent, /Polaroid/i);
    assert.ok(Array.isArray(json.requirements) && json.requirements.length > 0);
    assert.equal(json.merchant.cart_url, "https://pixel-surplus.myshopify.com/cart/46117070209071:1");
    const missing = await fetch(`${base}/api/offers/nope/task.json`);
    assert.equal(missing.status, 404);
  });
});

test("POST /api/quotes answers handoff_required, never a commitment", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer_id: ID }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.decision, "handoff_required");
    assert.equal(json.reason, "final_quote_required");
    assert.equal(json.payment_authorized, false);
    assert.equal(json.order_status, "not_created");
    assert.equal(json.enforcement_scope, "eligibility_only");
    assert.match(json.cart_url, /myshopify\.com\/cart\//);

    const unknown = await fetch(`${base}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offer_id: "nope" }),
    });
    assert.equal(unknown.status, 404);

    const bad = await fetch(`${base}/api/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
  });
});
