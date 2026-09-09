import { test } from "node:test";
import assert from "node:assert";
import { VERDICTS } from "../src/evidence.js";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server.js";
import { generateProcessKey } from "../src/receipt.js";
import { funnelOutcome, funnelReason } from "../src/funnel.js";

const SVM = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BODY = { url: "https://example.com/pricing", extract: { starter_price: "number" }, assertion: "starter_price < 100" };
const FIXTURE = "<p>starter_price: $49/mo</p>";

function readFunnel(dir) {
  return readFileSync(path.join(dir, "funnel.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("funnel outcomes map statuses to the five contract categories", () => {
  assert.equal(funnelOutcome("/quote", 200), "quote_deliverable");
  assert.equal(funnelOutcome("/quote", 422), "quote_non_deliverable");
  assert.equal(funnelOutcome("/quote", 400), "quote_non_deliverable");
  assert.equal(funnelOutcome("/witness", 402), "witness_402_challenge");
  assert.equal(funnelOutcome("/witness", 200), "witness_signed_receipt");
  assert.equal(funnelOutcome("/witness", 422), "witness_non_deliverable");
  assert.equal(funnelOutcome("/witness", 400), "witness_non_deliverable", "witness 400 falls into the five-label taxonomy");
  assert.equal(funnelOutcome("/witness", 500), "witness_non_deliverable");
});

test("funnel reason admits only the handler's enum tokens, never free text", () => {
  assert.equal(funnelReason({ reason: "bad_extract", expected: { "<key>": "number|string" } }), "bad_extract");
  assert.equal(funnelReason({ reason: "prior_method_mismatch" }), "prior_method_mismatch");
  for (const bad of [undefined, null, {}, { reason: 7 }, { reason: "" }, { reason: "https://example.com" }, { reason: "Bad Extract" }, { reason: "x".repeat(65) }]) {
    assert.equal(funnelReason(bad), null, `rejected: ${JSON.stringify(bad)}`);
  }
});

test("funnel log records outcomes with spec_hash and zero sensitive fields", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "funnel-"));
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: FIXTURE }), funnelDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) });
    assert.equal(ok.status, 200);
    const miss = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: BODY.url, extract: {} }) });
    assert.equal(miss.status, 400);
    const unpaid = await fetch(`${base}/witness`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) });
    assert.equal(unpaid.status, 402);
    await new Promise((r) => setTimeout(r, 20));

    const events = readFunnel(dir);
    assert.deepEqual(events.map((e) => e.outcome), ["quote_deliverable", "quote_non_deliverable", "witness_402_challenge"]);
    assert.deepEqual(events.map((e) => e.status), [200, 400, 402]);
    assert.deepEqual(events.map((e) => e.route), ["/quote", "/quote", "/witness"]);
    assert.ok(events[0].spec_hash, "valid method carries its one-way spec_hash");
    assert.equal(events[1].spec_hash, undefined, "invalid method carries no spec_hash");
    assert.ok(events[2].spec_hash, "402 challenge names the same canonical method");
    assert.equal(events[0].spec_hash, events[2].spec_hash, "quote and 402 agree on the method");
    assert.deepEqual(events.map((e) => e.reason), [undefined, "bad_extract", undefined], "reason only on the error row; 200 and 402 carry none");
    for (const e of events) {
      assert.deepEqual(Object.keys(e).sort(), ["outcome", "reason", "route", "spec_hash", "status", "ts", "verdict"].filter((k) => k in e).sort(), "only whitelisted fields");
      // The verdict keeps the funnel's no-free-text guarantee: a closed
      // vocabulary only, so paid contradictions stay countable and auditable.
      if ("verdict" in e) assert.ok(VERDICTS.includes(e.verdict), `verdict outside the vocabulary: ${e.verdict}`);
      const raw = JSON.stringify(e);
      for (const forbidden of ["example.com", "starter_price", "x-payment", "payment-signature", "user-agent", "0x", "evidence", "http://", "https://"]) {
        assert.ok(!raw.includes(forbidden), `no sensitive material: ${forbidden}`);
      }
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("funnel is disabled when funnelDir is explicitly null", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "funnel-off-"));
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: FIXTURE }), funnelDir: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await fetch(`http://127.0.0.1:${server.address().port}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) });
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.throws(() => readFileSync(path.join(dir, "funnel.ndjson"), "utf8"), "no funnel file written");
});

test("malformed JSON POST still records a non-deliverable outcome", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "funnel-bad-"));
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: FIXTURE }), funnelDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/quote`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{not json",
    });
    assert.equal(res.status, 400);
    await new Promise((r) => setTimeout(r, 20));
    const event = readFunnel(dir)[0];
    assert.deepEqual({ route: event.route, status: event.status, outcome: event.outcome }, { route: "/quote", status: 400, outcome: "quote_non_deliverable" });
    assert.equal(event.spec_hash, undefined);
    assert.equal(event.reason, "bad_json");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("funnel reason splits non-deliverable into its 400 shape errors and 422 capability limits", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "funnel-reason-"));
  const app = createApp({ key: generateProcessKey(), retrieve: async () => ({ text: FIXTURE }), funnelDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cases = [
      ["/quote", { url: BODY.url, extract: ["starter_price"] }, 400, "bad_extract"],
      ["/quote", { url: BODY.url, extract: { rank: "number" } }, 422, "extract_missing"],
      ["/quote", { ...BODY, replicas: 2 }, 422, "replicas_unsupported"],
      ["/quote", { url: "http://example.com/pricing", extract: BODY.extract }, 422, "https_only"],
      ["/witness", { url: BODY.url, extract: { rank: { type: "number" } } }, 422, "extract_missing"],
    ];
    for (const [route, body, status] of cases) {
      const res = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, status, `${route} ${JSON.stringify(body)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
    const events = readFunnel(dir);
    assert.deepEqual(events.map((e) => [e.route, e.status, e.reason]), cases.map(([route, , status, reason]) => [route, status, reason]));
    assert.ok(events.every((e) => e.outcome.endsWith("_non_deliverable")), "reason refines the outcome label, it does not replace it");
    assert.ok(!JSON.stringify(events).includes("rank"), "reason is the server's enum, never the request's key names");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
