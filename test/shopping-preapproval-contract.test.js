/**
 * Wave9 DD — OpenAPI shopping-preapproval ↔ Done-child ↔ runtime.
 *
 * Locks status / reason / shape for the surfaces the shopping-preapproval
 * card uses, plus the offline Done-child that grants checkout. Complements
 * Wave6 Q (error-status matrix, generic bodies) and Wave4 L (adversarial
 * Done-gate). This file binds GATE_METHOD 200 shapes and the child's
 * reason vocabulary — the half those suites do not generate.
 *
 * In-process host. Mocked retrieve / facilitator. Child spawned as a
 * separate process with no wallet and no network. No live reader, no
 * live settle.
 *
 * Run this file: `node --test test/shopping-preapproval-contract.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Ajv from "ajv";

import { openapiDoc } from "../src/openapi.js";
import { createApp, handleQuote, handleWitness } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey, pubkeyB64, signReceipt } from "../src/receipt.js";
import { methodFromRequest, VALID_FOR_MS } from "../src/observatory.js";
import { GATE_METHOD, decideGate, runOnce } from "../scripts/shopping-preapproval.mjs";
import { cellKey, CONTRACT_STATUSES } from "./openapi-matrix.js";
import {
  CARD_METHOD,
  CHILD_SCRIPT,
  DONE_CHILD_ACCEPT_REASON,
  DONE_CHILD_REASONS,
  DONE_CHILD_RECEIPT_FIELDS,
  DONE_CHILD_REPORT_FIELDS,
  OPENAPI_OMITTED_CHILD_FIELDS,
  OPENAPI_OMITTED_QUOTE_FIELDS,
  PARENT_STATIC_REASONS,
  PREAPPROVAL_PATHS,
  QUOTE_200_GATE_FIELDS,
  childSource,
  jsonSchemaAt,
  openapiQuote200Properties,
  openapiReceiptProperties,
  openapiVerdictEnum,
  parentSource,
  preapprovalCells,
  preapprovalReasonRows,
  receiptFieldsInSource,
  reasonsInSource,
  requestSchemaAt,
} from "./shopping-preapproval-contract.js";

const PAYWALL = {
  evmAddress: "0xabc0000000000000000000000000000000000001",
  svmAddress: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM",
};
const BASE_URL = "https://witness.example.net";
const CARD_HTML = "<p>price: $5.99</p>";
const CARD_RETRIEVE = async () => ({ text: CARD_HTML });

const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
];

const refusingFacilitator = {
  async getSupported() { return { kinds: KINDS }; },
  async verify() { return { isValid: false, invalidReason: "fixture refuses every payment" }; },
  async settle() { throw new Error("settle must not be reached on an unpaid contract probe"); },
};

const DOC = openapiDoc({
  EVM_ADDRESS: PAYWALL.evmAddress,
  SVM_ADDRESS: PAYWALL.svmAddress,
  PUBLIC_BASE_URL: BASE_URL,
});
const CELLS = preapprovalCells(DOC);
const ROWS = preapprovalReasonRows(DOC);
const CELL_BY = new Map(CELLS.map((c) => [`${c.method} ${c.path} ${c.status}`, c]));

const ajv = new Ajv({ strict: false, validateFormats: false });
const compile = (schema) => {
  assert.ok(schema, "OpenAPI schema missing for compile");
  return ajv.compile(schema);
};
const quote200Ok = compile(jsonSchemaAt(DOC, "/quote", "POST", "200"));
const witness200Ok = compile(jsonSchemaAt(DOC, "/witness", "POST", "200"));
const pubkey200Ok = compile(jsonSchemaAt(DOC, "/pubkey", "GET", "200"));
const quoteReqOk = compile(requestSchemaAt(DOC, "/quote", "POST"));
const witnessReqOk = compile(requestSchemaAt(DOC, "/witness", "POST"));

function buildApp(kind, extra = {}) {
  const base = {
    key: extra.key ?? generateProcessKey(),
    observationsDir: mkdtempSync(path.join(os.tmpdir(), "wit-oa-done-")),
    funnelDir: null,
    publicBaseUrl: BASE_URL,
    quoteRateLimit: 1000,
    quoteGlobalRateLimit: 1000,
    retrieve: extra.retrieve ?? CARD_RETRIEVE,
  };
  switch (kind) {
    case "paywalled":
      return createApp({ ...base, paywall: PAYWALL, facilitator: extra.facilitator ?? refusingFacilitator, ...extra });
    case "free":
      return createApp({ ...base, paywall: {}, ...extra });
    case "quote1":
      return createApp({ ...base, paywall: {}, quoteRateLimit: 1, ...extra });
    default:
      throw new Error(`unknown host kind: ${kind}`);
  }
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

function jsonBody(body) {
  return typeof body === "string" ? body : JSON.stringify(body);
}

function challengeOf(res) {
  const raw = res.headers.get("payment-required");
  assert.ok(raw, `${res.status} without a PAYMENT-REQUIRED header is not an x402 challenge`);
  try { return JSON.parse(raw); } catch { /* base64 */ }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

/**
 * Stimulus table. `path` is the OpenAPI path (coverage key). GATE_METHOD
 * bodies only — Wave6 already probes generic extract maps.
 */
const STIMULI = [
  { id: "quote.400.bad_json", path: "/quote", method: "POST", status: 400, reason: "bad_json", host: "free", headers: { "content-type": "application/json" }, body: "{not json" },
  { id: "quote.400.bad_extract", path: "/quote", method: "POST", status: 400, reason: "bad_extract", host: "free", body: { url: GATE_METHOD.url, extract: { price: "bogus" }, assertion: GATE_METHOD.assertion } },
  { id: "quote.400.bad_assertion", path: "/quote", method: "POST", status: 400, reason: "bad_assertion", host: "free", body: { ...GATE_METHOD, assertion: 7 } },
  { id: "quote.422.https_only", path: "/quote", method: "POST", status: 422, reason: "https_only", host: "free", body: { ...GATE_METHOD, url: "http://127.0.0.1/" } },
  { id: "quote.429.quote_rate_limited", path: "/quote", method: "POST", status: 429, reason: "quote_rate_limited", host: "quote1", body: GATE_METHOD, prime: 1 },
  { id: "quote.200.gate", path: "/quote", method: "POST", status: 200, host: "free", body: GATE_METHOD, shape: "quote200" },

  { id: "witness.post.400.bad_json", path: "/witness", method: "POST", status: 400, reason: "bad_json", host: "paywalled", headers: { "content-type": "application/json" }, body: "{not json" },
  { id: "witness.post.400.bad_extract", path: "/witness", method: "POST", status: 400, reason: "bad_extract", host: "paywalled", body: { url: GATE_METHOD.url, extract: { price: "bogus" } } },
  { id: "witness.post.400.bad_assertion", path: "/witness", method: "POST", status: 400, reason: "bad_assertion", host: "paywalled", body: { ...GATE_METHOD, assertion: 7 } },
  { id: "witness.post.402", path: "/witness", method: "POST", status: 402, host: "paywalled", body: GATE_METHOD, challenge: true },
  { id: "witness.post.422.https_only", path: "/witness", method: "POST", status: 422, reason: "https_only", host: "paywalled", body: { ...GATE_METHOD, url: "http://127.0.0.1/" }, noChallenge: true },
  { id: "witness.get.402", path: "/witness", method: "GET", status: 402, host: "paywalled", challenge: true },
  { id: "witness.get.405", path: "/witness", method: "GET", status: 405, reason: "get_discovery_only_use_post", host: "paywalled", headers: { "x-payment": "bogus" }, noChallenge: true },

  // Paid 200 is handleWitness(paid:true) — same function the paywall calls
  // after settle. No facilitator, no wallet, no spend.
  { id: "witness.post.200.gate", path: "/witness", method: "POST", status: 200, via: "handleWitness", shape: "witness200" },
  { id: "pubkey.200", path: "/pubkey", method: "GET", status: 200, host: "free", shape: "pubkey200" },
];

function coversRow(row, s) {
  if (s.path !== row.path || s.method !== row.method || String(s.status) !== row.status) return false;
  if (row.reason == null) return true;
  return s.reason === row.reason;
}

function runChild({ receipt, trustedPubkeyB64, expectedMethod = methodFromRequest(GATE_METHOD) }) {
  const child = spawnSync(process.execPath, [CHILD_SCRIPT], {
    input: JSON.stringify({ receipt, trustedPubkeyB64, expectedMethod }),
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  let report;
  try { report = JSON.parse(child.stdout); } catch {
    report = { approve: false, reason: "unparseable_child", stdout: child.stdout, stderr: child.stderr };
  }
  return { child, report };
}

async function signedCard(mutate) {
  const key = generateProcessKey();
  const out = await handleWitness(GATE_METHOD, {
    key, paid: true, retrieve: CARD_RETRIEVE,
  });
  assert.equal(out.status, 200);
  if (!mutate) return { key, receipt: out.json };
  const { receipt: _sig, ...body } = out.json;
  return { key, receipt: mutate(body, key) };
}

function assertAjv(ok, body, label) {
  assert.equal(ok(body), true, `${label}: ${ajv.errorsText(ok.errors)}`);
}

function assertNoDoneToken(json, label) {
  assert.equal(json.checkout_approved, undefined, `${label}: OpenAPI surface is not a Done token`);
  assert.equal(json.completion, undefined, `${label}: completion is a parent/child field, not a host field`);
}

// ---------------------------------------------------------------------------
// Map: OpenAPI preapproval surfaces
// ---------------------------------------------------------------------------

test("map: OpenAPI publishes every shopping-preapproval path", () => {
  for (const p of PREAPPROVAL_PATHS) {
    assert.ok(DOC.paths[p], `OpenAPI dropped ${p}`);
  }
  assert.ok(DOC.paths["/quote"].post, "POST /quote");
  assert.ok(DOC.paths["/witness"].post, "POST /witness");
  assert.ok(DOC.paths["/witness"].get, "GET /witness");
  assert.ok(DOC.paths["/pubkey"].get, "GET /pubkey");
  assert.equal(DOC.paths["/quote"].get, undefined, "preapproval never GETs /quote");
});

test("map: GATE_METHOD is the design-partner card and satisfies the documented request schema", () => {
  assert.deepEqual(CARD_METHOD, GATE_METHOD);
  assert.equal(quoteReqOk(GATE_METHOD), true, ajv.errorsText(quoteReqOk.errors));
  assert.equal(witnessReqOk(GATE_METHOD), true, ajv.errorsText(witnessReqOk.errors));
  const req = requestSchemaAt(DOC, "/quote", "POST");
  assert.deepEqual(req.required, ["url", "extract"]);
  assert.deepEqual(req.properties.retrieval.enum, ["scrape"]);
  assert.deepEqual(requestSchemaAt(DOC, "/witness", "POST"), req, "quote and witness share one request schema");
});

test("map: every OpenAPI preapproval status/reason cell has a GATE_METHOD stimulus", () => {
  assert.ok(CELLS.length >= 10, `expected a real preapproval matrix, got ${CELLS.length} cells`);
  const missing = ROWS.filter((row) => !STIMULI.some((s) => coversRow(row, s)));
  assert.deepEqual(
    missing.map((r) => cellKey(r)),
    [],
    `OpenAPI preapproval cell has no probe: ${missing.map((r) => cellKey(r)).join(", ")}`,
  );
});

test("map: every stimulus targets a documented preapproval status", () => {
  const undocumented = STIMULI.filter((s) => !CELL_BY.has(`${s.method} ${s.path} ${s.status}`));
  assert.deepEqual(
    undocumented.map((s) => s.id),
    [],
    `stimulus status is not in OpenAPI: ${undocumented.map((s) => `${s.id} ${s.method} ${s.path} ${s.status}`).join(", ")}`,
  );
  for (const s of STIMULI) {
    if (!s.reason) continue;
    const cell = CELL_BY.get(`${s.method} ${s.path} ${s.status}`);
    if (cell.reasonSource === "enum") {
      assert.ok(cell.reasons.includes(s.reason), `${s.id}: ${s.reason} not in OpenAPI enum [${cell.reasons}]`);
    }
  }
  assert.ok(CONTRACT_STATUSES.includes("402") && CONTRACT_STATUSES.includes("400"));
});

test("map: quote 400 / witness 400 reason enums stay the shared shape trio", () => {
  assert.deepEqual(CELL_BY.get("POST /quote 400").reasons, ["bad_json", "bad_extract", "bad_assertion"]);
  assert.deepEqual(CELL_BY.get("POST /witness 400").reasons, ["bad_json", "bad_extract", "bad_assertion"]);
});

// ---------------------------------------------------------------------------
// Map: Done-child vocabulary vs source (fail on rename)
// ---------------------------------------------------------------------------

test("map: Done-child reason literals match the locked vocabulary", () => {
  assert.deepEqual(reasonsInSource(childSource()), [...DONE_CHILD_REASONS].sort());
});

test("map: Done-child receipt.field reads match the locked field list", () => {
  const fromSrc = receiptFieldsInSource(childSource());
  const expected = [...DONE_CHILD_RECEIPT_FIELDS].filter((f) => f !== "receipt").sort();
  assert.deepEqual(fromSrc, expected, "child started reading a new receipt field (or dropped one)");
});

test("map: parent static reasons and trusted_key_hash stay the live-gate contract", () => {
  const src = parentSource();
  for (const reason of PARENT_STATIC_REASONS) {
    assert.match(src, new RegExp(`["'\`]${reason}["'\`]`), `parent no longer names ${reason}`);
  }
  assert.match(src, /trusted_key_hash/, "parent must bind the child's trusted_key_hash, not a renamed alias");
  assert.match(src, /receipt_supported/, "parent only accepts the child's accept reason");
  assert.match(src, /verifier_pid/, "parent requires a child PID distinct from itself");
});

test("map: child-required fields are documented or explicitly omitted — never silent", () => {
  const documented = openapiReceiptProperties(DOC);
  for (const field of DONE_CHILD_RECEIPT_FIELDS) {
    const inDoc = documented.includes(field);
    const omitted = OPENAPI_OMITTED_CHILD_FIELDS.includes(field);
    assert.ok(inDoc || omitted, `child requires ${field}; add it to OpenAPI or to OPENAPI_OMITTED_CHILD_FIELDS`);
    assert.ok(!(inDoc && omitted), `${field} is now in OpenAPI — drop it from OPENAPI_OMITTED_CHILD_FIELDS`);
  }
});

test("map: quote GATE fields are documented or explicitly omitted — never silent", () => {
  const documented = openapiQuote200Properties(DOC);
  for (const field of QUOTE_200_GATE_FIELDS) {
    const inDoc = documented.includes(field);
    const omitted = OPENAPI_OMITTED_QUOTE_FIELDS.includes(field);
    assert.ok(inDoc || omitted, `gate requires quote.${field}; document it or list it in OPENAPI_OMITTED_QUOTE_FIELDS`);
  }
  for (const field of OPENAPI_OMITTED_QUOTE_FIELDS) {
    assert.equal(documented.includes(field), false, `${field} is now in OpenAPI quote 200 — drop it from OPENAPI_OMITTED_QUOTE_FIELDS`);
  }
});

test("map: OpenAPI witness verdict enum still contains the only child-accepting verdict", () => {
  const enumerated = openapiVerdictEnum(DOC);
  assert.ok(enumerated.includes("supported"), "OpenAPI dropped verdict=supported; the child cannot accept any other");
  assert.ok(enumerated.includes("contradicted") && enumerated.includes("incomplete"));
  assert.equal(decideGate({ verdict: "supported" }).reason, "verdict_supported");
  for (const verdict of enumerated.filter((v) => v && v !== "supported")) {
    const d = decideGate({ verdict });
    assert.equal(d.approve, false, `decideGate must block OpenAPI verdict ${verdict}`);
    assert.equal(d.reason, `verdict_${verdict}`);
  }
});

test("map: OpenAPI valid_until description still names the child's one-hour lifetime", () => {
  const desc = jsonSchemaAt(DOC, "/witness", "POST", "200").properties.valid_until.description;
  assert.match(desc, /1h/, "OpenAPI no longer says receipts perish in 1h");
  assert.equal(VALID_FOR_MS, 3_600_000, "child freshness window drifted from one hour");
});

test("map: signed method drops replicas — GATE_METHOD itself is not the child's expectedMethod", () => {
  const expected = methodFromRequest(GATE_METHOD);
  assert.equal(Object.hasOwn(expected, "replicas"), false);
  assert.equal(Object.hasOwn(GATE_METHOD, "replicas"), true);
  assert.deepEqual(expected, {
    url: GATE_METHOD.url,
    retrieval: GATE_METHOD.retrieval,
    extract: { ...GATE_METHOD.extract },
    assertion: GATE_METHOD.assertion,
  });
});

// ---------------------------------------------------------------------------
// Runtime: OpenAPI cells against the in-process host
// ---------------------------------------------------------------------------

async function fire(base, s) {
  const url = `${base}${s.url ?? s.path}`;
  const headers = { ...(s.body !== undefined && typeof s.body !== "string" ? { "content-type": "application/json" } : {}), ...s.headers };
  const init = { method: s.method, headers };
  if (s.body !== undefined && s.method !== "GET") init.body = jsonBody(s.body);
  const send = () => fetch(url, init);
  for (let i = 0; i < (s.prime ?? 0); i++) await send();
  return send();
}

async function runtimeBody(s) {
  if (s.via === "handleWitness") {
    const key = generateProcessKey();
    const out = await handleWitness(GATE_METHOD, { key, paid: true, retrieve: CARD_RETRIEVE });
    return { status: out.status, json: out.json, headers: new Headers(), key };
  }
  const key = generateProcessKey();
  return serve(buildApp(s.host, { key }), async (base) => {
    const res = await fire(base, s);
    const headers = res.headers;
    const json = s.textIncludes ? null : await res.json().catch(() => ({}));
    return { status: res.status, json, headers, key, raw: res };
  });
}

for (const s of STIMULI) {
  const label = s.reason
    ? `${s.method} ${s.path} → ${s.status} ${s.reason}`
    : `${s.method} ${s.path} → ${s.status}`;
  test(`runtime ${s.id}: ${label}`, async () => {
    const cell = CELL_BY.get(`${s.method} ${s.path} ${s.status}`);
    assert.ok(cell, `${s.id}: OpenAPI no longer documents ${s.method} ${s.path} ${s.status}`);
    const { status, json, headers, key } = await runtimeBody(s);
    assert.equal(status, s.status, `${s.id}: expected ${s.status}, got ${status}`);

    if (s.challenge || cell.hasPaymentRequiredHeader) {
      const challenge = challengeOf({ headers });
      assert.equal(typeof challenge, "object");
    } else if (s.noChallenge || status !== 402) {
      assert.equal(headers.get("payment-required"), null, `${s.id}: unexpected PAYMENT-REQUIRED`);
    }

    if (s.reason) assert.equal(json.reason, s.reason, `${s.id}: ${JSON.stringify(json)}`);
    if (cell.reasonSource === "enum" && json?.reason) {
      assert.ok(cell.reasons.includes(json.reason), `${s.id}: runtime reason ${json.reason} not in OpenAPI enum [${cell.reasons}]`);
    }
    if (status >= 400 && status !== 402 && json?.receipt !== undefined) {
      assert.equal(json.receipt, undefined, `${s.id}: error carried a receipt`);
    }
    if (json && status !== 200) assertNoDoneToken(json, s.id);

    if (s.shape === "quote200") {
      assertAjv(quote200Ok, json, s.id);
      for (const field of QUOTE_200_GATE_FIELDS) {
        assert.ok(Object.hasOwn(json, field), `${s.id}: runtime dropped gate field ${field}`);
      }
      assert.equal(json.can_deliver, true);
      assert.equal(json.price_usdc, "0.01");
      assert.equal(json.verdict, "supported");
      assert.equal(json.receipt, undefined);
      assertNoDoneToken(json, s.id);
    }
    if (s.shape === "witness200") {
      assertAjv(witness200Ok, json, s.id);
      const documented = openapiReceiptProperties(DOC);
      for (const field of jsonSchemaAt(DOC, "/witness", "POST", "200").required) {
        assert.ok(Object.hasOwn(json, field), `${s.id}: documented-required ${field} missing`);
      }
      for (const field of DONE_CHILD_RECEIPT_FIELDS) {
        assert.ok(Object.hasOwn(json, field), `${s.id}: child-required ${field} missing`);
      }
      const documentedMissing = documented.filter((k) =>
        !["changed", "previous_source_hash"].includes(k) && !Object.hasOwn(json, k),
      );
      assert.deepEqual(documentedMissing, [], `${s.id}: documented properties absent on a clean receipt: ${documentedMissing}`);
      assert.equal(json.verdict, "supported");
      assert.equal(json.agreement, "1-of-1");
      assert.equal(json.requested_url, GATE_METHOD.url);
      assert.equal(json.assertion, GATE_METHOD.assertion);
      assert.deepEqual(json.method, methodFromRequest(GATE_METHOD));
      assert.equal(typeof json.value.price, "number");
      assert.ok(Number.isInteger(json.evidence_spans.price.start));
      assertNoDoneToken(json, s.id);

      const { report, child } = runChild({ receipt: json, trustedPubkeyB64: pubkeyB64(key) });
      assert.equal(report.approve, true, `${s.id}: child refused a documented-valid GATE_METHOD receipt: ${JSON.stringify(report)}`);
      assert.equal(report.reason, DONE_CHILD_ACCEPT_REASON);
      assert.equal(child.status, 0);
      assert.equal(report.verifier_pid, child.pid);
      assert.notEqual(child.pid, process.pid);
      for (const field of DONE_CHILD_REPORT_FIELDS) {
        assert.ok(Object.hasOwn(report, field), `${s.id}: accepting report missing ${field}`);
      }
    }
    if (s.shape === "pubkey200") {
      assertAjv(pubkey200Ok, json, s.id);
      assert.equal(json.pubkey, pubkeyB64(key));
    }
  });
}

test("runtime 402 cells carry PAYMENT-REQUIRED naming /witness", async () => {
  await serve(buildApp("paywalled"), async (base) => {
    for (const s of STIMULI.filter((x) => x.challenge)) {
      const res = await fire(base, s);
      assert.equal(res.status, 402, s.id);
      const challenge = challengeOf(res);
      assert.equal(typeof challenge, "object");
      assert.equal(challenge.resource?.url ?? `${BASE_URL}/witness`, `${BASE_URL}/witness`);
    }
  });
});

// ---------------------------------------------------------------------------
// Done-child reason matrix — every locked reason is reachable
// ---------------------------------------------------------------------------

const CHILD_CASES = [
  {
    reason: "receipt_supported",
    approve: true,
    mutate: null,
  },
  {
    reason: "signature_invalid",
    approve: false,
    mutate: (body) => ({ ...signReceipt(body, generateProcessKey()), value: { price: 1 } }),
  },
  {
    reason: "method_mismatch",
    approve: false,
    mutate: (body, key) => signReceipt({ ...body, requested_url: "https://wrong.example/product" }, key),
  },
  {
    reason: "freshness_invalid",
    approve: false,
    mutate: (body, key) => signReceipt({
      ...body,
      observed_at: "2000-01-01T00:00:00.000Z",
      valid_until: "2000-01-01T01:00:00.000Z",
    }, key),
  },
  {
    reason: "evidence_invalid",
    approve: false,
    mutate: (body, key) => {
      delete body.source_hash;
      return signReceipt(body, key);
    },
  },
  {
    reason: "verdict_not_supported",
    approve: false,
    mutate: (body, key) => signReceipt({ ...body, verdict: "incomplete" }, key),
  },
  {
    reason: "assertion_not_supported",
    approve: false,
    mutate: (body, key) => signReceipt({ ...body, value: { ...body.value, price: 900 } }, key),
  },
];

test("map: child reason table covers the locked vocabulary", () => {
  assert.deepEqual(CHILD_CASES.map((c) => c.reason).sort(), [...DONE_CHILD_REASONS].sort());
});

for (const c of CHILD_CASES) {
  test(`child reason ${c.reason}: ${c.approve ? "accepts" : "refuses"}`, async () => {
    const { key, receipt } = await signedCard(c.mutate);
    const { report, child } = runChild({ receipt, trustedPubkeyB64: pubkeyB64(key) });
    assert.equal(report.reason, c.reason, JSON.stringify(report));
    assert.equal(report.approve, c.approve);
    assert.equal(child.status === 0, c.approve, `exit ${child.status} vs approve ${c.approve}`);
    assert.equal(Number.isInteger(report.verifier_pid), true);
    assert.notEqual(report.verifier_pid, process.pid);
    if (c.approve) {
      for (const field of DONE_CHILD_REPORT_FIELDS) {
        assert.ok(Object.hasOwn(report, field), `accepting report missing ${field}`);
      }
      assert.equal(report.receipt_verified, true);
      assert.match(report.receipt_hash, /^[a-f0-9]{64}$/);
      assert.match(report.trusted_key_hash, /^[a-f0-9]{64}$/);
    }
  });
}

test("child reason evidence_invalid: malformed stdin never approves", () => {
  const child = spawnSync(process.execPath, [CHILD_SCRIPT], {
    input: "not-json",
    encoding: "utf8",
    timeout: 5000,
    env: { PATH: process.env.PATH },
  });
  const report = JSON.parse(child.stdout);
  assert.equal(report.approve, false);
  assert.equal(report.reason, "evidence_invalid");
  assert.notEqual(child.status, 0);
});

test("child reason method_mismatch: expectedMethod=GATE_METHOD (with replicas) is not the signed method", async () => {
  const { key, receipt } = await signedCard(null);
  const { report } = runChild({
    receipt,
    trustedPubkeyB64: pubkeyB64(key),
    expectedMethod: GATE_METHOD,
  });
  assert.equal(report.approve, false);
  assert.equal(report.reason, "method_mismatch");
});

test("child refuses OpenAPI-valid contradicted / incomplete receipts", async () => {
  for (const verdict of ["contradicted", "incomplete"]) {
    const { key, receipt } = await signedCard((body, k) => signReceipt({ ...body, verdict }, k));
    assertAjv(witness200Ok, receipt, `verdict ${verdict}`);
    const { report } = runChild({ receipt, trustedPubkeyB64: pubkeyB64(key) });
    assert.equal(report.approve, false);
    assert.equal(report.reason, "verdict_not_supported");
  }
});

test("child does not import as a library — stdin/exit is the only interface", () => {
  const src = childSource();
  assert.match(src, /readFileSync\(0/);
  assert.match(src, /process\.exitCode/);
  assert.doesNotMatch(src, /export /);
});

// ---------------------------------------------------------------------------
// Parent glue: OpenAPI status → runOnce reason (no wallet)
// ---------------------------------------------------------------------------

test("parent: OpenAPI quote 400/422 maps to quote_not_deliverable; child is not_run", async () => {
  await serve(buildApp("free", { retrieve: async () => ({ text: "" }) }), async (base) => {
    const run = await runOnce({
      mode: "live",
      base,
      trustedPubkeyB64: pubkeyB64(generateProcessKey()),
      paymentTransport: async () => { throw new Error("must not load a wallet on a 422 quote"); },
    });
    assert.equal(run.status, 422);
    assert.equal(run.body.reason, "retrieve_empty");
    assert.equal(run.decision.reason, "quote_not_deliverable");
    assert.equal(run.check.reason, "not_run");
    assert.equal(run.checkout_approved, false);
    assert.equal(run.completion, "incomplete");
  });
});

test("parent: OpenAPI witness 402 maps to witness_http_402; checkout stays incomplete", async () => {
  await serve(buildApp("paywalled"), async (base) => {
    const run = await runOnce({
      mode: "live",
      base,
      trustedPubkeyB64: pubkeyB64(generateProcessKey()),
      paymentTransport: async () => ({
        payer: "fixture-not-a-wallet",
        pay: (url, init) => fetch(url, init),
      }),
    });
    assert.equal(run.step, "witness");
    assert.equal(run.status, 402);
    assert.equal(run.decision.reason, "witness_http_402");
    assert.equal(run.checkout_approved, false);
    assert.equal(run.completion, "incomplete");
    assert.equal(run.paid, false);
  });
});

test("parent: OpenAPI quote 200 + child receipt_supported is the only complete path", async () => {
  const key = generateProcessKey();
  const quote = await handleQuote(GATE_METHOD, { retrieve: CARD_RETRIEVE });
  assert.equal(quote.status, 200);
  assertAjv(quote200Ok, quote.json, "quote 200");
  assert.equal(decideGate(quote.json).approve, true);

  const paid = await handleWitness(GATE_METHOD, { key, paid: true, retrieve: CARD_RETRIEVE });
  assert.equal(paid.status, 200);
  assertAjv(witness200Ok, paid.json, "witness 200");

  const { report, child } = runChild({ receipt: paid.json, trustedPubkeyB64: pubkeyB64(key) });
  assert.equal(report.reason, DONE_CHILD_ACCEPT_REASON);
  assert.equal(report.approve, true);
  assert.equal(child.status, 0);
  assert.notEqual(report.verifier_pid, process.pid);
});
