import { test } from "node:test";
import assert from "node:assert";
import { tempDir } from "./helpers/tmpdir.js";
import { generateProcessKey, verifyReceipt } from "../src/receipt.js";
import { compareReceipts, readObservations, specHash } from "../src/observatory.js";
import { BILLABLE_VERDICTS, NEVER_BILLED, handleQuote, handleWitness } from "../src/server.js";

const URL = "https://example.com/pricing";
const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const EXTRACT = { starter_price: "number" };
const body = (assertion) => ({ url: URL, extract: EXTRACT, assertion });
const reader = (text) => async () => ({ text });

/** Every verdict a caller can actually reach, with the source that produces it. */
const REACHABLE = [
  ["supported",    body("starter_price < 100"),      FIXTURE],
  ["contradicted", body("starter_price < 10"),       FIXTURE],
  // incomplete must be reached the only way it now bills: another requested field
  // resolves, proving the extractor read this document, so the miss is the source's.
  ["incomplete",   { url: URL, extract: { starter_price: "number", currency: "string" }, assertion: "starter_price < 100" }, "<p>currency: USD</p>"],
];

test("what you are quoted is what you are issued, for every reachable verdict", async () => {
  for (const [expected, b, text] of REACHABLE) {
    const q = await handleQuote(b, { retrieve: reader(text) });
    assert.equal(q.status, 200, expected);
    assert.equal(q.json.verdict, expected, `quote announced the wrong verdict for ${expected}`);
    const w = await handleWitness(b, { retrieve: reader(text), paid: true, key: generateProcessKey() });
    assert.equal(w.status, 200, expected);
    // The binding condition: the announcement and the receipt cannot disagree.
    assert.equal(w.json.verdict, q.json.verdict, `announced ${q.json.verdict} but issued ${w.json.verdict}`);
  }
});

test("one price for every verdict -- the answer costs the same whatever it is", async () => {
  const prices = new Set();
  for (const [, b, text] of REACHABLE) {
    const q = await handleQuote(b, { retrieve: reader(text) });
    prices.add(q.json.price_usdc);
    assert.equal(q.json.can_deliver, true);
  }
  assert.deepEqual([...prices], ["0.01"], "verdict-based pricing is an operator decision, not ours");
});

test("every issued receipt verifies offline against the pinned key, whatever its verdict", async () => {
  for (const [expected, b, text] of REACHABLE) {
    const key = generateProcessKey();
    const w = await handleWitness(b, { retrieve: reader(text), paid: true, key });
    assert.equal(w.json.verdict, expected);
    assert.equal(verifyReceipt(w.json, key.publicKey), true, `${expected} must verify`);
    assert.equal(verifyReceipt({ ...w.json, verdict: "supported" }, key.publicKey), expected === "supported",
      "the verdict is inside the signature");
    assert.equal(verifyReceipt(w.json, generateProcessKey().publicKey), false, "another key must not verify");
  }
});

test("the billing line is a constant, and nothing outside it is ever charged", async () => {
  assert.deepEqual([...BILLABLE_VERDICTS], ["supported", "contradicted", "incomplete"]);
  assert.ok(!BILLABLE_VERDICTS.includes("unable_to_verify"), "we cannot charge for not knowing");
  for (const r of ["unable_to_verify", "assertion_malformed", "assertion_field_not_extracted",
                   "retrieve_failed", "retrieve_empty", "needs_browser", "bad_json", "bad_extract", "bad_assertion", "bad_retrieval"])
    assert.ok(NEVER_BILLED.includes(r), `${r} must be permanently free`);

  // And the paths that produce them return a free 422, never a challenge.
  const free = [
    [body("starter_price ~~ cheap"), reader(FIXTURE), "assertion_malformed"],
    [body("nowhere exists"), reader(FIXTURE), "assertion_field_not_extracted"],
    [body("starter_price < 100"), async () => { throw new Error("reader_500"); }, "retrieve_failed"],
    [body("starter_price < 100"), reader(""), "retrieve_empty"],
  ];
  for (const [b, retrieve, reason] of free) {
    const q = await handleQuote(b, { retrieve });
    assert.deepEqual([q.status, q.json.reason], [422, reason]);
    assert.equal(q.json.price_usdc, undefined, `${reason} was priced`);
    const w = await handleWitness(b, { retrieve });
    assert.equal(w.status, 422, `${reason} reached the paywall`);
  }
});

test("twice-pay survives the new class: two contradicted receipts group into one card", async () => {
  const key = generateProcessKey();
  const dir = tempDir("wit-contra-");
  const b = body("starter_price < 10");
  const deps = { retrieve: reader(FIXTURE), paid: true, key, observationsDir: dir };
  const first = await handleWitness(b, { ...deps, now: () => "2026-08-30T15:00:00.000Z" });
  const second = await handleWitness(b, { ...deps, now: () => "2026-08-30T15:05:00.000Z" });

  assert.equal(first.json.verdict, "contradicted");
  assert.equal(second.json.verdict, "contradicted");
  assert.equal(first.json.spec_hash, second.json.spec_hash, "same canonical observation");
  assert.equal(second.json.observed_at > first.json.observed_at, true, "two commissions, not one");
  assert.equal(readObservations(dir).length, 2);

  const cards = compareReceipts(readObservations(dir), key.publicKey, new Date("2026-08-30T15:06:00.000Z"));
  assert.equal(cards.length, 1, "one method, one card");
  assert.equal(cards[0].active, 2);
  assert.equal(cards[0].state, "steady", "two agreeing observations");
  // Steady agreement about a false claim is still a false claim.
  assert.equal(cards[0].verdict, "contradicted");
  assert.equal(cards[0].spec_hash, specHash(first.json.method));
});

test("a document where nothing extracted is never billed as incomplete", async () => {
  // The hazard this closes: extract_missing covers both "the source lacks the
  // field" and "our matcher could not read it", and those are not mechanically
  // distinguishable. Eight of ten realistic claims failed the second way as
  // recently as last week. One other field returning proves the extractor works
  // on this document; nothing returning proves nothing, so it stays free.
  const b = { url: URL, extract: { starter_price: "number" }, assertion: "starter_price < 100" };
  const q = await handleQuote(b, { retrieve: reader("<p>nothing here</p>") });
  assert.deepEqual([q.status, q.json.reason], [422, "extract_none"]);
  assert.equal(q.json.price_usdc, undefined, "a document we may simply have failed to read is not priced");
  assert.equal((await handleWitness(b, { retrieve: reader("<p>nothing here</p>") })).status, 422, "and never reaches the paywall");
  assert.ok(NEVER_BILLED.includes("extract_none"));
});

test("incomplete still bills when another field proves the extractor read the page", async () => {
  // currency is found, starter_price is genuinely absent: the miss is the source's.
  const b = { url: URL, extract: { starter_price: "number", currency: "string" }, assertion: "starter_price < 100" };
  const q = await handleQuote(b, { retrieve: reader("<p>currency: USD</p>") });
  assert.equal(q.status, 200);
  assert.equal(q.json.verdict, "incomplete");
  assert.deepEqual(q.json.missing, ["starter_price"]);
  const w = await handleWitness(b, { retrieve: reader("<p>currency: USD</p>"), paid: true, key: generateProcessKey() });
  assert.equal(w.json.verdict, "incomplete");
  assert.equal(w.json.value.currency, "USD", "the evidence we did find is still in the receipt");
});
