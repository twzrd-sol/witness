import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProcessKey, signReceipt, verifyReceipt } from "../src/receipt.js";
import {
  appendObservation,
  compareReceipts,
  compareResults,
  createResult,
  methodFromRequest,
  readObservations,
  seedResults,
  SEED_SPECS,
  specHash,
  VALID_FOR_MS,
  verifyResult,
} from "../src/observatory.js";
import { renderStarMap } from "../src/star-map.js";

test("method identity is canonical and results are attributable", () => {
  const key = generateProcessKey();
  const spec = SEED_SPECS[0];
  const reordered = Object.fromEntries(Object.entries(spec).reverse());
  assert.equal(specHash(spec), specHash(reordered));
  const card = createResult(spec, { vantage: "test", observed_at: "2026-08-30T07:30:00.000Z", source_hash: "abc", value: { price: 49 }, evidence: "price: 49", observer: "test" }, key);
  assert.equal(card.spec_hash, specHash(spec));
  assert.equal(card.valid_until, "2026-08-30T08:30:00.000Z");
  assert.ok(verifyResult(card));
  assert.equal(verifyResult({ ...card, value: { price: 50 } }), false);
});

test("comparator derives the five star states mechanically", () => {
  const cards = seedResults(generateProcessKey());
  assert.ok(cards.every(verifyResult));
  const states = compareResults(SEED_SPECS, cards, "2026-08-30T08:00:00.000Z").map((x) => x.state);
  assert.deepEqual(states, ["steady", "double", "flare", "unresolved", "dim"]);
  const tampered = { ...cards[0], value: { price: 50 } };
  assert.equal(compareResults(SEED_SPECS, [...cards, tampered], "2026-08-30T08:00:00.000Z")[0].state, "steady");
  assert.equal(compareResults(SEED_SPECS, [...cards, cards[4]], "2026-08-30T08:00:00.000Z")[2].state, "flare");
  const html = renderStarMap(compareResults(SEED_SPECS, cards, "2026-08-30T08:00:00.000Z"), "2026-08-30T08:00:00.000Z");
  assert.match(html, /The Observatory/);
  for (const state of states) assert.match(html, new RegExp(`class="card ${state}"`));
});

test("paid-shaped receipts append, verify with process key, and skip junk", () => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-"));
  const spec = methodFromRequest({ url: "https://example.com/pricing", extract: { starter_price: "number" }, assertion: "starter_price < 100" });
  const observed_at = "2026-08-30T00:00:00.000Z";
  const rest = {
    value: { starter_price: 49 },
    assertion: spec.assertion,
    observed_at,
    source_hash: "aa",
    evidence: "starter_price: 49",
    agreement: "1-of-1",
    method: spec,
    spec_hash: specHash(spec),
    valid_until: new Date(Date.parse(observed_at) + VALID_FOR_MS).toISOString(),
    vantage: "box",
  };
  const card = signReceipt(rest, key);
  appendObservation(dir, card);
  appendObservation(dir, { not: "a receipt" });
  const drifted = signReceipt({ ...rest, method: { ...spec, url: "https://example.com/other" } }, key);
  appendObservation(dir, drifted);
  const loaded = readObservations(dir);
  assert.equal(loaded.length, 3);
  assert.ok(verifyReceipt(loaded[0], key.publicKey));
  assert.ok(verifyReceipt(loaded[2], key.publicKey), "drifted card is validly signed but must not group");
  const sky = compareReceipts(loaded, key.publicKey, observed_at);
  assert.deepEqual(sky.map((x) => x.state), ["steady"]);
  assert.equal(sky[0].total, 1, "method/spec_hash drift must not group");
});
