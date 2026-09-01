import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pubkeyB64, verifyReceipt } from "./receipt.js";

export const VALID_FOR_MS = 3_600_000;

export function methodFromRequest(body, retrieval = "scrape") {
  return { url: body.url, retrieval, extract: body.extract, assertion: body.assertion ?? null };
}

export const SCHEMAS = {
  method: { $id: "witness.method.v1", type: "object", required: ["question", "url", "retrieval", "extract", "answer", "valid_for_ms"], properties: { question: { type: "string" }, url: { type: "string", format: "uri" }, retrieval: { enum: ["scrape", "browse"] }, extract: { type: "object", minProperties: 1 }, answer: { type: "string" }, valid_for_ms: { type: "integer", minimum: 1 } }, additionalProperties: false },
  result: { $id: "witness.result.v1", type: "object", required: ["spec_hash", "vantage", "observed_at", "valid_until", "source_hash", "value", "evidence", "observer", "signature"], properties: { spec_hash: { type: "string" }, vantage: { type: "string" }, observed_at: { type: "string", format: "date-time" }, valid_until: { type: "string", format: "date-time" }, source_hash: { type: "string" }, value: {}, evidence: { type: "string" }, observer: { type: "object" }, signature: { type: "string" } }, additionalProperties: false },
};

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
export const specHash = (spec) => hash(canonical(spec));

export function createResult(spec, observation, key) {
  const observed = Date.parse(observation.observed_at);
  if (!Number.isFinite(observed)) throw new TypeError("invalid observed_at");
  const card = {
    spec_hash: specHash(spec),
    ...observation,
    valid_until: new Date(observed + spec.valid_for_ms).toISOString(),
    observer: { id: observation.observer, pubkey: pubkeyB64(key) },
  };
  const signature = sign(null, Buffer.from(canonical(card)), key.privateKey).toString("base64");
  return { ...card, signature };
}

export function verifyResult(result) {
  const { signature, ...card } = result;
  const publicKey = createPublicKey({ key: Buffer.from(card.observer.pubkey, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(canonical(card)), publicKey, Buffer.from(signature, "base64"));
}

export const SEED_SPECS = [
  { question: "What price is published?", url: "https://example.com/price", retrieval: "scrape", extract: { price: "number" }, answer: "price", valid_for_ms: 3_600_000 },
  { question: "Is the endpoint healthy?", url: "https://example.com/health", retrieval: "scrape", extract: { status: "string" }, answer: "status", valid_for_ms: 3_600_000 },
  { question: "Which release is current?", url: "https://example.com/release", retrieval: "scrape", extract: { version: "string" }, answer: "version", valid_for_ms: 3_600_000 },
  { question: "Is registration open?", url: "https://example.com/register", retrieval: "browse", extract: { open: "string" }, answer: "open", valid_for_ms: 3_600_000 },
  { question: "What was the old headline?", url: "https://example.com/archive", retrieval: "scrape", extract: { headline: "string" }, answer: "headline", valid_for_ms: 600_000 },
];

const SEED_OBSERVATIONS = [
  [0, "box", "2026-08-30T07:30:00.000Z", { price: 49 }, "price: 49"],
  [1, "box", "2026-08-30T07:25:00.000Z", { status: "ok" }, "status: ok"], [1, "cloud", "2026-08-30T07:27:00.000Z", { status: "ok" }, "status: ok"],
  [2, "box", "2026-08-30T07:35:00.000Z", { version: "1.4" }, "version: 1.4"], [2, "cloud", "2026-08-30T07:36:00.000Z", { version: "1.5" }, "version: 1.5"],
  [3, "box", "2026-08-30T07:40:00.000Z", { open: "yes" }, "open: yes"], [3, "cloud", "2026-08-30T07:41:00.000Z", { open: "no" }, "open: no"], [3, "peer", "2026-08-30T07:42:00.000Z", { open: "yes" }, "open: yes"],
  [4, "box", "2026-08-30T06:00:00.000Z", { headline: "hello" }, "headline: hello"],
];

export const seedResults = (key) => SEED_OBSERVATIONS.map(([i, vantage, observed_at, value, evidence]) => createResult(SEED_SPECS[i], { vantage, observed_at, source_hash: hash(evidence), value, evidence, observer: "observatory-seed" }, key));

export function compareResults(specs, results, now = new Date()) {
  const at = +new Date(now);
  return specs.map((spec) => {
    const spec_hash = specHash(spec);
    const all = results.filter((r) => {
      try { return r.spec_hash === spec_hash && verifyResult(r) && +new Date(r.valid_until) === +new Date(r.observed_at) + spec.valid_for_ms; }
      catch { return false; }
    });
    const active = all.filter((r) => +new Date(r.observed_at) <= at && at < +new Date(r.valid_until));
    const values = new Set(active.map((r) => canonical(r.value?.[spec.answer])));
    const vantages = new Set(active.map((r) => r.vantage));
    let state = "steady";
    if (!active.length) state = "dim";
    else if (values.size > 1) state = vantages.size > 2 ? "unresolved" : "flare";
    else if (vantages.size > 1) state = "double";
    return { spec_hash, question: spec.question, state, active: active.length, total: all.length };
  });
}

export function appendObservation(dir, card) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "observations.ndjson"), `${JSON.stringify(card)}\n`);
}

export function readObservations(dir) {
  const file = path.join(dir, "observations.ndjson");
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip junk */ }
  }
  return out;
}

export function compareReceipts(results, publicKey, now = new Date()) {
  const at = +new Date(now);
  const groups = new Map();
  for (const r of results) {
    if (!verifyReceipt(r, publicKey)) continue;
    if (!r.method || specHash(r.method) !== r.spec_hash) continue;
    const list = groups.get(r.spec_hash) ?? [];
    list.push(r);
    groups.set(r.spec_hash, list);
  }
  return [...groups.entries()].map(([spec_hash, all]) => {
    const active = all.filter((r) => +new Date(r.observed_at) <= at && at < +new Date(r.valid_until));
    const values = new Set(active.map((r) => canonical(r.value)));
    const vantages = new Set(active.map((r) => r.vantage));
    let state = "steady";
    if (!active.length) state = "dim";
    else if (values.size > 1) state = vantages.size > 2 ? "unresolved" : "flare";
    else if (vantages.size > 1) state = "double";
    return { spec_hash, question: spec_hash.slice(0, 16), state, active: active.length, total: all.length };
  });
}
