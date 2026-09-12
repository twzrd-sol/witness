/**
 * Locks the 2026-09-12 operator live-spend bundle. Offline: no live reader,
 * no live 402, no wallet. The paid run already happened; this file refuses
 * a bundle that lost the receipt, the txs, or grew a secret.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReceipt } from "../src/receipt.js";
import { assertNoSecrets } from "../scripts/wave21-live-host-probes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "docs/operator/evidence/live-spend-2026-09-12");
const load = (name) => JSON.parse(readFileSync(path.join(DIR, name), "utf8"));

const FILES = [
  "quote-scrape.json",
  "quote-browse.json",
  "witness-scrape.json",
  "intel-trust.json",
  "agent-browser.json",
  "pubkey.json",
];

for (const name of FILES) {
  test(`bundle ${name} carries no payment secrets`, () => {
    assertNoSecrets(load(name));
  });
}

test("spend-log names the four hops and no secrets", () => {
  const lines = readFileSync(path.join(DIR, "spend-log.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  lines.forEach(assertNoSecrets);
  assert.equal(lines[0].reason, "quote_deliverable_scrape");
  assert.equal(lines[1].reason, "quote_deliverable_browse");
  assert.equal(lines[2].reason, "signed_receipt_scrape");
  assert.equal(lines[3].reason, "intel_pay_v7");
  assert.equal(lines[3].note.includes("/v1/witness/attest"), true);
});

test("scrape quote is $0.01 and browse quote is explicit $0.06", () => {
  const scrape = load("quote-scrape.json");
  const browse = load("quote-browse.json");
  assert.equal(scrape.price_usdc, "0.01");
  assert.equal(scrape.retrieval, "scrape");
  assert.equal(scrape.can_deliver, true);
  assert.equal(scrape.verdict, "supported");
  assert.equal(browse.price_usdc, "0.06");
  assert.equal(browse.retrieval, "browse");
  assert.equal(browse.can_deliver, true);
});

test("signed scrape receipt verifies and matches agent-browser stock 99", () => {
  const { pubkey } = load("pubkey.json");
  const { status, settlement, receipt } = load("witness-scrape.json");
  const browser = load("agent-browser.json");
  assert.equal(status, 200);
  assert.equal(receipt.method.retrieval, "scrape");
  assert.equal(receipt.method.url, "https://dummyjson.com/products/1");
  assert.equal(receipt.value.stock, 99);
  assert.equal(receipt.verdict, "supported");
  assert.equal(browser.stock, 99);
  assert.equal(browser.url, receipt.method.url);
  const pk = createPublicKey({ key: Buffer.from(pubkey, "base64"), format: "der", type: "spki" });
  assert.equal(verifyReceipt(receipt, pk), true);
  assert.equal(settlement.network, "eip155:8453");
  assert.match(settlement.transaction, /^0x[0-9a-f]{64}$/);
  assert.equal(settlement.transaction, "0xd131e3c113ed840c16e544916f93560b313fe7de91a8e0490c3bf619c519f31b");
});

test("intel PAY is a v7 trust receipt, not device attest", () => {
  const intel = load("intel-trust.json");
  assert.equal(intel.paid, true);
  assert.equal(intel.receipt_version, "v7");
  assert.equal(intel.trust_score, 48);
  assert.equal(intel.seller_wallet, "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM");
  assert.equal(intel.tx, "0x7c740a90f7d6a1d1ef0e14ae443c4d5580cb7fb2d6d0faff8123fabd810cf637");
  assert.equal(intel.settlement.transaction, intel.tx);
});
