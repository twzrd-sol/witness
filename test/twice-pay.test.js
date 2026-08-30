import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateProcessKey } from "../src/receipt.js";
import { compareReceipts, readObservations, specHash } from "../src/observatory.js";
import { handleWitness } from "../src/server.js";

// PLAN method — falsifiable public-world observation. Retrieve is canned;
// nothing here touches the network or the envelope.
const METHOD = {
  url: "https://api.github.com/repos/openai/openai-node",
  retrieval: "scrape",
  extract: { open_issues_count: "number" },
  assertion: "open_issues_count < 100000",
};
const FIXTURE = `{"full_name": "openai/openai-node", "open_issues_count": 42, "state": "open"}`;
const BODY = { url: METHOD.url, extract: METHOD.extract, assertion: METHOD.assertion };

test("twice-pay: two paid receipts for one PLAN method group into one card", async () => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-2x-"));
  const retrieve = async () => ({ text: FIXTURE });

  const first = await handleWitness(BODY, { retrieve, paid: true, key, observationsDir: dir, now: () => "2026-08-30T15:00:00.000Z" });
  const second = await handleWitness(BODY, { retrieve, paid: true, key, observationsDir: dir, now: () => "2026-08-30T15:05:00.000Z" });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.json.method, METHOD);
  assert.deepEqual(second.json.method, METHOD);
  assert.equal(first.json.spec_hash, specHash(METHOD), "receipt binds its own method");
  assert.equal(second.json.spec_hash, specHash(METHOD));
  assert.equal(first.json.spec_hash, second.json.spec_hash, "same canonical observation");
  assert.equal(first.json.value.open_issues_count, 42);
  assert.equal(second.json.value.open_issues_count, 42);
  assert.equal(second.json.observed_at > first.json.observed_at, true, "two commissions, not one");

  const loaded = readObservations(dir);
  assert.equal(loaded.length, 2, "one NDJSON line per paid receipt");

  const sky = compareReceipts(loaded, key.publicKey, "2026-08-30T15:10:00.000Z");
  assert.equal(sky.length, 1, "both receipts group under one spec_hash");
  assert.equal(sky[0].total, 2);
  assert.equal(sky[0].state, "steady");
});
