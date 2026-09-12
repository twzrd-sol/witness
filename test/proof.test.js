import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tmpdir.js";
import { generateProcessKey, pubkeyB64, signReceipt, sourceHash } from "../src/receipt.js";
import { methodFromRequest, specHash, VALID_FOR_MS } from "../src/observatory.js";
import { verifyProof } from "../scripts/verify-proof.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/verify-proof.mjs", import.meta.url));

const METHOD = { url: "https://outbid.sh/top", retrieval: "scrape", extract: { rank: "number" }, assertion: "rank < 100" };
const BODY = { url: METHOD.url, extract: METHOD.extract, assertion: METHOD.assertion };

function makeBundle(key, { value = { rank: 3 }, t0 = "2026-09-09T12:00:00.000Z" } = {}) {
  const method = methodFromRequest(BODY);
  const mkReceipt = (observed_at, v) => signReceipt({
    value: v,
    assertion: method.assertion,
    observed_at,
    source_hash: sourceHash(`evidence:${observed_at}`),
    evidence: "rank: 3",
    agreement: "1-of-1",
    method,
    spec_hash: specHash(method),
    valid_until: new Date(Date.parse(observed_at) + VALID_FOR_MS).toISOString(),
    vantage: "box",
  }, key);
  const r1 = mkReceipt(t0, value);
  const r2 = mkReceipt("2026-09-09T12:04:00.000Z", value);
  return {
    method: METHOD,
    payer: "OperatorPubKey1111111111111111111111111111",
    receipts: [r1, r2],
    settlements: ["settlement-tx-aaaa", "settlement-tx-bbbb"],
    observatory: { spec_hash: specHash(method), total: 2 },
  };
}

test("happy path: a real two-receipt bundle verifies", () => {
  const key = generateProcessKey();
  const failures = verifyProof(makeBundle(key), pubkeyB64(key));
  assert.deepEqual(failures, []);
});

test("tampered receipt value -> signature_invalid", () => {
  const key = generateProcessKey();
  const b = makeBundle(key);
  b.receipts[1] = { ...b.receipts[1], value: { rank: 99999 } };
  assert.ok(verifyProof(b, pubkeyB64(key)).includes("receipt[1]_signature_invalid"));
});

test("wrong pubkey -> both signatures invalid", () => {
  const key = generateProcessKey();
  const other = generateProcessKey();
  const failures = verifyProof(makeBundle(key), pubkeyB64(other));
  assert.ok(failures.includes("receipt[0]_signature_invalid"));
  assert.ok(failures.includes("receipt[1]_signature_invalid"));
});

test("spec_hash that does not match the declared method -> mismatch", () => {
  const key = generateProcessKey();
  const b = makeBundle(key);
  b.receipts[0] = { ...b.receipts[0], spec_hash: "0".repeat(64) };
  const failures = verifyProof(b, pubkeyB64(key));
  assert.ok(failures.includes("receipts_spec_hash_differ") || failures.includes("receipt[0]_spec_hash_mismatch"));
});

test("reused settlement id -> settlements_not_distinct", () => {
  const key = generateProcessKey();
  const b = makeBundle(key);
  b.settlements = ["same-tx", "same-tx"];
  assert.ok(verifyProof(b, pubkeyB64(key)).includes("settlements_not_distinct"));
});

test("method drift between the two pays -> method_drift_between_pays", () => {
  const key = generateProcessKey();
  const b = makeBundle(key);
  const drifted = { ...METHOD, url: "https://outbid.sh/other" };
  b.receipts[1] = { ...b.receipts[1], method: { url: drifted.url, retrieval: "scrape", extract: drifted.extract, assertion: drifted.assertion } };
  assert.ok(verifyProof(b, pubkeyB64(key)).includes("method_drift_between_pays"));
});

test("observatory total < 2 -> observatory_total_below_2", () => {
  const key = generateProcessKey();
  const b = makeBundle(key);
  b.observatory = { ...b.observatory, total: 1 };
  assert.ok(verifyProof(b, pubkeyB64(key)).includes("observatory_total_below_2"));
});

test("forbidden field (payment header) is rejected", () => {
  const key = generateProcessKey();
  const b = makeBundle(key);
  b["x-payment"] = "deadbeef";
  assert.ok(verifyProof(b, pubkeyB64(key)).some((f) => f.startsWith("forbidden_field")));
});

test("no pubkey supplied -> signatures unchecked but structure still validated", () => {
  const key = generateProcessKey();
  assert.deepEqual(verifyProof(makeBundle(key)), []);
});

test("CLI: exit 0 on valid bundle, exit 1 on invalid", () => {
  const key = generateProcessKey();
  const dir = tempDir("proof-");
  const good = path.join(dir, "good.json");
  const bad = path.join(dir, "bad.json");
  const bundle = makeBundle(key);
  writeFileSync(good, JSON.stringify(bundle));
  const badBundle = makeBundle(key);
  badBundle.settlements = ["x-same", "x-same"];
  writeFileSync(bad, JSON.stringify(badBundle));

  const okOut = execFileSync(process.execPath, [SCRIPT, good, "--pubkey", pubkeyB64(key)], { encoding: "utf8" });
  assert.match(okOut, /PROOF VALID/);

  let code = 0;
  let errOut = "";
  try { execFileSync(process.execPath, [SCRIPT, bad, "--pubkey", pubkeyB64(key)], { encoding: "utf8" }); }
  catch (e) { code = e.status; errOut = e.stderr || e.stdout || ""; }
  assert.equal(code, 1);
  assert.match(errOut, /settlements_not_distinct/);
});
