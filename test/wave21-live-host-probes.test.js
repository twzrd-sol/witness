/**
 * Wave21 ZZZ — live-probe helper locks. Default npm test does not hit the
 * public host (SPEC: no live reader / live 402 in CI). The live run is
 * `node scripts/wave21-live-host-probes.mjs --live`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AMOUNT_ATOMIC,
  CHECK_NAMES,
  DOCUMENTED_METHOD,
  DOCUMENTED_PAYER_PATHS,
  GATE_METHOD,
  LIVE_HOST,
  PRICE_USDC,
  allowedLiveBase,
  assertNoSecrets,
  decideSpend,
  parseChallenge,
  resolveDocumentedPayer,
  sanitizeChallenge,
} from "../scripts/wave21-live-host-probes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "wave21-live-host-probes.mjs");

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("CHECK_NAMES is the frozen live matrix", () => {
  assert.equal(CHECK_NAMES.length, 30);
  assert.ok(CHECK_NAMES.includes("quote_never_402"));
  assert.ok(CHECK_NAMES.includes("attest_unpaid_402"));
  assert.ok(CHECK_NAMES.includes("done_gate_dry_not_complete"));
  assert.ok(CHECK_NAMES.includes("wash_fail_closed"));
  assert.ok(CHECK_NAMES.includes("no_invented_payer"));
});

test("only the documented live host is allowlisted", () => {
  assert.equal(allowedLiveBase(LIVE_HOST), true);
  assert.equal(allowedLiveBase(`${LIVE_HOST}/`), true);
  assert.equal(allowedLiveBase("https://witness.outbid.sh/witness"), true);
  assert.equal(allowedLiveBase("http://witness.outbid.sh"), false);
  assert.equal(allowedLiveBase("https://evil.example"), false);
  assert.equal(allowedLiveBase("http://127.0.0.1:4032"), false);
});

test("documented methods stay the issue #1 card and the Done-gate card", () => {
  assert.equal(DOCUMENTED_METHOD.url, "https://outbid.sh/top");
  assert.deepEqual(DOCUMENTED_METHOD.extract, { rank: "number" });
  assert.equal(GATE_METHOD.url, "https://dummyjson.com/products/1");
  assert.equal(PRICE_USDC, "0.01");
  assert.equal(AMOUNT_ATOMIC, "10000");
});

test("parseChallenge reads JSON and base64url PAYMENT-REQUIRED", () => {
  const payload = { x402Version: 2, resource: { url: `${LIVE_HOST}/witness` }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "10000", payTo: "0xabc" }] };
  const jsonRes = { headers: { get: (n) => n.toLowerCase() === "payment-required" ? JSON.stringify(payload) : null } };
  assert.deepEqual(parseChallenge(jsonRes), payload);
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const b64Res = { headers: { get: (n) => n.toLowerCase() === "payment-required" ? b64 : null } };
  assert.equal(sanitizeChallenge(parseChallenge(b64Res)).resource, `${LIVE_HOST}/witness`);
  assert.equal(sanitizeChallenge(parseChallenge(b64Res)).accepts[0].amount, "10000");
});

test("decideSpend fail-closes on wash, block, missing payer, and unpaid-preferred", () => {
  assert.equal(decideSpend({ merchant: { wash_flagged: true } }).reason, "wash_flagged");
  assert.equal(decideSpend({ wash: { classification: "self_pay", is_circular: true } }).reason, "wash_flagged");
  assert.equal(decideSpend({ preflight: { decision: "block", recommended_action: "do_not_pay" } }).reason, "preflight_block");
  assert.equal(decideSpend({ merchant: { decision: "refuse", wash_flagged: false }, wash: { classification: "clean", is_circular: false } }).reason, "merchant_refuse");
  assert.equal(decideSpend({ merchant: { wash_flagged: null, decision: "insufficient_evidence" } }).reason, "wash_unevaluated");
  assert.equal(decideSpend({
    payRequested: true,
    payerPath: "/tmp/stranger.json",
    merchant: { wash_flagged: false },
    wash: { classification: "unknown", is_circular: false },
  }).reason, "wash_unevaluated");
  assert.equal(decideSpend({
    merchant: { wash_flagged: false },
    wash: { classification: "clean", is_circular: false },
  }).reason, "unpaid_preferred");
  assert.equal(decideSpend({
    payRequested: true,
    merchant: { wash_flagged: false },
    wash: { classification: "clean", is_circular: false },
  }).reason, "no_documented_payer");
  assert.equal(decideSpend({
    payRequested: true,
    payerPath: DOCUMENTED_PAYER_PATHS[0],
    merchant: { wash_flagged: false },
    wash: { classification: "clean", is_circular: false },
    preflight: { decision: "warn", price_usdc: 0.01, maximum_recommended_spend_usdc: 0.001 },
  }).reason, "over_cap");
  assert.deepEqual(decideSpend({
    payRequested: true,
    payerPath: DOCUMENTED_PAYER_PATHS[0],
    merchant: { wash_flagged: false },
    wash: { classification: "clean", is_circular: false },
    preflight: { decision: "warn", price_usdc: 0.01, maximum_recommended_spend_usdc: 0.01 },
  }), { spend: true, reason: "preflight_allows_micro", price: 0.01, cap: 0.01 });
});

test("resolveDocumentedPayer never invents or accepts a stranger key", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "w21-payer-"));
  const stranger = path.join(tmp, "stranger.json");
  writeFileSync(stranger, "[1,2,3]");
  assert.equal(resolveDocumentedPayer({ env: {}, argv: [] }), null);
  assert.equal(resolveDocumentedPayer({ env: { WITNESS_PAYER_KEYPAIR: stranger }, argv: [] }), null);
  assert.equal(resolveDocumentedPayer({ env: {}, argv: [`--keypair=${stranger}`] }), null);
  const minted = path.resolve(DOCUMENTED_PAYER_PATHS[0]);
  assert.equal(resolveDocumentedPayer({
    env: {},
    argv: [`--keypair=${minted}`],
    createdThisRun: new Set([minted]),
  }), null);
});

test("assertNoSecrets refuses payment material in recorded evidence", () => {
  assert.throws(() => assertNoSecrets({ "payment-signature": "x" }), /forbidden log key/);
  assert.throws(() => assertNoSecrets({ nested: { privateKey: "0x" } }), /forbidden log key/);
  assert.doesNotThrow(() => assertNoSecrets({ payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM", amount: "10000" }));
});

test("CLI refuses without --live and refuses a stranger --base (no fetch)", async () => {
  const none = await runCli([]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /pass --live/);
  const stranger = await runCli(["--live", "--base=https://evil.example"]);
  assert.equal(stranger.status, 2);
  assert.match(stranger.stderr, /only https:\/\/witness\.outbid\.sh/);
  assert.equal(stranger.stdout.includes("LIVE_OK"), false);
});
