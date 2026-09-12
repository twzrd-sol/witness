/**
 * Wave11 LL — public-host attest bound smoke (post-#34 / #40).
 *
 * Locks the HTTP contract a public host must keep after the attest route
 * was bound (#34) and the adversarial suite (#40). The checker is
 * fail-closed: unbound (unpaid 200 / receipt) and mismatched (wrong
 * resource, price, or rails) cannot pass. CI stands loopback fixtures.
 * No live reader, no live facilitator, no wallet, no production host.
 *
 * Run this file: `node --test test/public-host-attest-bound-smoke.test.js`
 * CLI: `node scripts/public-host-attest-bound-smoke.mjs --base=<loopback> --public-base=<canonical>`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tmpdir.js";

import { createApp } from "../src/server.js";
import { createHostApp, listenExclusive } from "../src/listen.js";
import { generateProcessKey } from "../src/receipt.js";
import { EXAMPLE_BODY } from "../src/routes/delivery.js";
import {
  ATTEST_AMOUNT_ATOMIC,
  ATTEST_NETWORKS,
  ATTEST_PRICE_USDC,
  ATTEST_ROUTE,
  CHECK_NAMES,
  checkPublicHostAttestBound,
  expectedAttestResource,
  isLoopbackHost,
  main,
  parseChallenge,
  resolvePublicBaseUrl,
} from "../scripts/public-host-attest-bound-smoke.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "public-host-attest-bound-smoke.mjs");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

const PAYWALL = {
  evmAddress: "0xabc0000000000000000000000000000000000001",
  svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
};
const PUBLIC_BASE = "https://witness.example.net";
const EXPECTED_RESOURCE = `${PUBLIC_BASE}${ATTEST_ROUTE}`;

const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];

const refusingFacilitator = {
  async getSupported() { return { kinds: KINDS }; },
  async verify() { return { isValid: false, invalidReason: "fixture refuses every payment" }; },
  async settle() { throw new Error("bound smoke must not settle"); },
};

/** Async CLI so the in-process loopback host can still accept connections (spawnSync would stall it). */
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

function countingAttest() {
  const calls = [];
  const attest = async (input) => {
    calls.push(input);
    return {
      schema: "delivery-attestation/v0",
      offer_hash: "o".repeat(64),
      request_hash: "r".repeat(64),
      artifact_hash: "a".repeat(64),
      delivery_verdict: "delivered",
      reasons: [],
      evidence_mode: input.observation.mode,
      declared_mode: input.observation.mode,
      this_receipt_proves: ["fixture"],
      this_receipt_does_not_prove: ["fixture"],
    };
  };
  return { attest, calls };
}

async function serve(app, fn) {
  const server = await new Promise((resolve, reject) => {
    const s = listenExclusive(app, { port: 0 }, {
      onListening: () => resolve(s),
      onError: (e) => reject(new Error(`host listen failed (${e.code}): ${e.message}`, { cause: e })),
    });
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function paywalledHost(attest) {
  return createApp({
    key: generateProcessKey(),
    observationsDir: tempDir("wit-bound-smoke-"),
    funnelDir: null,
    facilitator: refusingFacilitator,
    paywall: PAYWALL,
    publicBaseUrl: PUBLIC_BASE,
    attest,
  });
}

function challengeHeader({ resource = EXPECTED_RESOURCE, amount = ATTEST_AMOUNT_ATOMIC, networks = ATTEST_NETWORKS, x402Version = 2 } = {}) {
  const body = {
    x402Version,
    resource: { url: resource },
    accepts: networks.map((network) => ({
      scheme: "exact",
      network,
      amount,
      payTo: PAYWALL.evmAddress,
    })),
  };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

async function serveFixture(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Loopback stub that speaks the three smoke probes. Overrides isolate one failure. */
function fixtureHost({ challenge = challengeHeader(), onForged, onShape } = {}) {
  return (req, res) => {
    const forged = Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let json = {};
      try { json = JSON.parse(raw); } catch { json = {}; }
      const offShape = !json.offer || typeof json.offer !== "object" || !json.offer.resource_url;
      if (offShape) {
        if (onShape) return onShape(res);
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ reason: "bad_offer" }));
      }
      if (forged && onForged) return onForged(res);
      res.writeHead(402, { "content-type": "application/json", "payment-required": challenge });
      res.end("{}");
    });
  };
}

test("contract constants lock the /witness price and both rails on POST /delivery/attest", () => {
  assert.equal(ATTEST_ROUTE, "/delivery/attest");
  assert.equal(ATTEST_PRICE_USDC, "0.01");
  assert.equal(ATTEST_AMOUNT_ATOMIC, "10000");
  assert.deepEqual([...ATTEST_NETWORKS].sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
  assert.equal(expectedAttestResource(PUBLIC_BASE), EXPECTED_RESOURCE);
  assert.deepEqual([...CHECK_NAMES], [
    "unpaid_well_formed_is_402",
    "challenge_names_attest_resource",
    "challenge_price_matches_witness",
    "challenge_has_both_rails",
    "shape_error_never_402",
    "forged_payment_does_not_unlock",
    "refusal_carries_no_receipt",
  ]);
});

test("loopback is recognized; a public URL is not, so the checker will not fetch it by default", () => {
  assert.equal(isLoopbackHost("http://127.0.0.1:4032"), true);
  assert.equal(isLoopbackHost("http://localhost:9"), true);
  assert.equal(isLoopbackHost("https://witness.outbid.sh"), false);
  assert.equal(resolvePublicBaseUrl("http://127.0.0.1:1", { publicBaseUrl: PUBLIC_BASE }), PUBLIC_BASE);
  assert.equal(resolvePublicBaseUrl("https://witness.outbid.sh", { allowRemote: true }), "https://witness.outbid.sh");
  assert.equal(resolvePublicBaseUrl("http://127.0.0.1:1"), null);
});

test("parseChallenge accepts JSON, base64, and base64url PAYMENT-REQUIRED values", () => {
  const payload = { x402Version: 2, resource: { url: EXPECTED_RESOURCE }, accepts: [] };
  const json = JSON.stringify(payload);
  const header = (value) => ({ headers: { get: (n) => (n.toLowerCase() === "payment-required" ? value : null) } });
  assert.deepEqual(parseChallenge(header(json)).resource, payload.resource);
  assert.deepEqual(parseChallenge(header(Buffer.from(json).toString("base64"))).resource, payload.resource);
  assert.deepEqual(parseChallenge(header(Buffer.from(json).toString("base64url"))).resource, payload.resource);
  assert.equal(parseChallenge(header(null)), null);
});

test("paywalled loopback host (public-host wiring) is BOUND — every named check passes, model stays at zero", async () => {
  const fake = countingAttest();
  await serve(paywalledHost(fake.attest), async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, true, JSON.stringify(result, null, 2));
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.checks.map((c) => c.name), [...CHECK_NAMES]);
    assert.ok(result.checks.every((c) => c.pass));
    assert.equal(fake.calls.length, 0, "smoke must not reach the model");
  });
});

test("createHostApp without payee env is UNBOUND — unpaid attest signs, checker fail-closes", async () => {
  const fake = countingAttest();
  const app = createHostApp({
    OBSERVATIONS_DIR: tempDir("wit-unbound-smoke-"),
    PUBLIC_BASE_URL: PUBLIC_BASE,
  }, { attest: fake.attest });
  await serve(app, async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, false);
    assert.ok(result.failed.includes("unpaid_well_formed_is_402"), result.failed.join(","));
    assert.ok(result.codes.includes("attest_unbound"), JSON.stringify(result.codes));
    assert.ok(result.failed.includes("challenge_names_attest_resource"));
    assert.ok(result.failed.includes("refusal_carries_no_receipt"));
    assert.ok(fake.calls.length >= 1, "the unbound host reached the key");
  });
});

test("mismatched challenge resource (names /witness) fail-closes", async () => {
  const header = challengeHeader({ resource: `${PUBLIC_BASE}/witness` });
  await serveFixture(fixtureHost({ challenge: header }), async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, false);
    assert.ok(result.codes.includes("attest_mismatch"), JSON.stringify(result.codes));
    assert.deepEqual(result.failed, ["challenge_names_attest_resource"]);
  });
});

test("mismatched challenge price fail-closes", async () => {
  await serveFixture(fixtureHost({ challenge: challengeHeader({ amount: "1" }) }), async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, false);
    assert.deepEqual(result.failed, ["challenge_price_matches_witness"]);
    assert.ok(result.codes.includes("attest_mismatch"));
  });
});

test("a single-rail challenge fail-closes", async () => {
  await serveFixture(fixtureHost({ challenge: challengeHeader({ networks: ["eip155:8453"] }) }), async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, false);
    assert.deepEqual(result.failed, ["challenge_has_both_rails"]);
  });
});

test("shape error that 402s fail-closes (400 never 402)", async () => {
  await serveFixture(fixtureHost({
    onShape: (res) => {
      res.writeHead(402, { "content-type": "application/json", "payment-required": challengeHeader() });
      res.end("{}");
    },
  }), async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, false);
    assert.deepEqual(result.failed, ["shape_error_never_402"]);
    assert.ok(result.codes.includes("attest_shape_reached_paywall"));
  });
});

test("forged payment that unlocks a receipt fail-closes", async () => {
  await serveFixture(fixtureHost({
    onForged: (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ receipt: "forged-unlock", delivery_verdict: "delivered" }));
    },
  }), async (base) => {
    const result = await checkPublicHostAttestBound(base, { publicBaseUrl: PUBLIC_BASE });
    assert.equal(result.bound, false);
    assert.ok(result.failed.includes("forged_payment_does_not_unlock"), result.failed.join(","));
    assert.ok(result.failed.includes("refusal_carries_no_receipt"));
    assert.ok(result.codes.includes("attest_forged_unlocked"));
  });
});

test("unreachable host fail-closes every check that did not run", async () => {
  const result = await checkPublicHostAttestBound("http://127.0.0.1:1", {
    publicBaseUrl: PUBLIC_BASE,
    fetch: async () => { throw new Error("offline fixture"); },
  });
  assert.equal(result.bound, false);
  assert.ok(result.codes.includes("attest_unreachable"));
  assert.equal(result.failed.length, CHECK_NAMES.length);
});

test("remote public host is refused unless allowRemote — fetch is never called", async () => {
  let called = 0;
  const result = await checkPublicHostAttestBound("https://witness.outbid.sh", {
    fetch: async () => { called += 1; throw new Error("must not fetch prod"); },
  });
  assert.equal(result.bound, false);
  assert.equal(called, 0);
  assert.ok(result.codes.includes("remote_host_refused"));
  assert.equal(result.failed.length, CHECK_NAMES.length);
});

test("allowRemote still fail-closes when the remote fetch throws", async () => {
  const result = await checkPublicHostAttestBound("https://witness.outbid.sh", {
    allowRemote: true,
    fetch: async () => { throw new Error("offline"); },
  });
  assert.equal(result.bound, false);
  assert.ok(result.codes.includes("attest_unreachable"));
});

test("CLI without --base exits 2 and does not default to production", async () => {
  const lines = [];
  const code = await main(["node", SCRIPT], { log: (s) => lines.push(s), err: (s) => lines.push(s), fetch: async () => { throw new Error("no fetch"); } });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /no default/i);
  assert.doesNotMatch(SCRIPT_SRC, /process\.env\.WITNESS_BASE/);
  assert.doesNotMatch(SCRIPT_SRC, /argOf\(\s*argv,\s*"base",\s*process\.env/);
  assert.doesNotMatch(SCRIPT_SRC, /argOf\(\s*argv,\s*"base",\s*"https:\/\/witness\.outbid\.sh"/);
});

test("CLI loopback --base without --public-base exits 2", async () => {
  const lines = [];
  const code = await main(["node", SCRIPT, "--base=http://127.0.0.1:4032"], {
    log: (s) => lines.push(s),
    err: (s) => lines.push(s),
    fetch: async () => { throw new Error("no fetch"); },
  });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /public-base/);
});

test("CLI refuses a remote --base without --allow-remote (exit 2, no fetch)", async () => {
  const lines = [];
  let called = 0;
  const code = await main(["node", SCRIPT, "--base=https://witness.outbid.sh"], {
    log: (s) => lines.push(s),
    err: (s) => lines.push(s),
    fetch: async () => { called += 1; throw new Error("no fetch"); },
  });
  assert.equal(code, 2);
  assert.equal(called, 0);
  assert.match(lines.join("\n"), /allow-remote/);
});

test("CLI against a paywalled loopback host exits 0 and prints BOUND", async () => {
  const fake = countingAttest();
  await serve(paywalledHost(fake.attest), async (base) => {
    const ran = await runCli([`--base=${base}`, `--public-base=${PUBLIC_BASE}`]);
    assert.equal(ran.status, 0, ran.stderr + ran.stdout);
    assert.match(ran.stdout, /^BOUND$/m);
    for (const name of CHECK_NAMES) assert.match(ran.stdout, new RegExp(`PASS  ${name}`));
    assert.equal(fake.calls.length, 0);
  });
});

test("CLI against an unbound loopback host exits 1 and prints UNBOUND", async () => {
  const fake = countingAttest();
  const app = createHostApp({
    OBSERVATIONS_DIR: tempDir("wit-unbound-cli-"),
    PUBLIC_BASE_URL: PUBLIC_BASE,
  }, { attest: fake.attest });
  await serve(app, async (base) => {
    const ran = await runCli([`--base=${base}`, `--public-base=${PUBLIC_BASE}`]);
    assert.equal(ran.status, 1, ran.stderr + ran.stdout);
    assert.match(ran.stdout, /^UNBOUND/m);
    assert.match(ran.stdout, /FAIL  unpaid_well_formed_is_402/);
    assert.doesNotMatch(ran.stdout, /This operation was aborted/);
  });
});

test("EXAMPLE_BODY used by the smoke is still a well-formed attest request", () => {
  assert.equal(typeof EXAMPLE_BODY.offer.resource_url, "string");
  assert.equal(typeof EXAMPLE_BODY.request.request_body, "object");
  assert.equal(EXAMPLE_BODY.observation.mode, "buyer_attested");
});
