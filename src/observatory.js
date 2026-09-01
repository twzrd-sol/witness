import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { verifyReceipt } from "./receipt.js";

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
