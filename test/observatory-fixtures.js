import { createPublicKey, sign, verify } from "node:crypto";
import { pubkeyB64 } from "../src/receipt.js";
import { specHash } from "../src/observatory.js";

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
};

export const SEED_SPECS = [
  { question: "What price is published?", url: "https://example.com/price", retrieval: "scrape", extract: { price: "number" }, answer: "price", valid_for_ms: 3_600_000 },
  { question: "Is the endpoint healthy?", url: "https://example.com/health", retrieval: "scrape", extract: { status: "string" }, answer: "status", valid_for_ms: 3_600_000 },
  { question: "Which release is current?", url: "https://example.com/release", retrieval: "scrape", extract: { version: "string" }, answer: "version", valid_for_ms: 3_600_000 },
  { question: "Is registration open?", url: "https://example.com/register", retrieval: "browse", extract: { open: "string" }, answer: "open", valid_for_ms: 3_600_000 },
  { question: "What was the old headline?", url: "https://example.com/archive", retrieval: "scrape", extract: { headline: "string" }, answer: "headline", valid_for_ms: 600_000 },
];

export function createResult(spec, observation, key) {
  const observed = Date.parse(observation.observed_at);
  if (!Number.isFinite(observed)) throw new TypeError("invalid observed_at");
  const card = { spec_hash: specHash(spec), ...observation, valid_until: new Date(observed + spec.valid_for_ms).toISOString(), observer: { id: observation.observer, pubkey: pubkeyB64(key) } };
  return { ...card, signature: sign(null, Buffer.from(canonical(card)), key.privateKey).toString("base64") };
}

export function verifyResult(result) {
  const { signature, ...card } = result;
  const publicKey = createPublicKey({ key: Buffer.from(card.observer.pubkey, "base64"), format: "der", type: "spki" });
  return verify(null, Buffer.from(canonical(card)), publicKey, Buffer.from(signature, "base64"));
}

const SEED_OBSERVATIONS = [
  [0, "box", "2026-08-30T07:30:00.000Z", { price: 49 }, "price: 49"],
  [1, "box", "2026-08-30T07:25:00.000Z", { status: "ok" }, "status: ok"], [1, "cloud", "2026-08-30T07:27:00.000Z", { status: "ok" }, "status: ok"],
  [2, "box", "2026-08-30T07:35:00.000Z", { version: "1.4" }, "version: 1.4"], [2, "cloud", "2026-08-30T07:36:00.000Z", { version: "1.5" }, "version: 1.5"],
  [3, "box", "2026-08-30T07:40:00.000Z", { open: "yes" }, "open: yes"], [3, "cloud", "2026-08-30T07:41:00.000Z", { open: "no" }, "open: no"], [3, "peer", "2026-08-30T07:42:00.000Z", { open: "yes" }, "open: yes"],
  [4, "box", "2026-08-30T06:00:00.000Z", { headline: "hello" }, "headline: hello"],
];

export const seedResults = key => SEED_OBSERVATIONS.map(([i, vantage, observed_at, value, evidence]) => createResult(SEED_SPECS[i], { vantage, observed_at, source_hash: "seed", value, evidence, observer: "observatory-seed" }, key));

export function compareResults(specs, results, now = new Date()) {
  const at = +new Date(now);
  return specs.map(spec => {
    const spec_hash = specHash(spec);
    const all = results.filter(r => { try { return r.spec_hash === spec_hash && verifyResult(r) && +new Date(r.valid_until) === +new Date(r.observed_at) + spec.valid_for_ms; } catch { return false; } });
    const active = all.filter(r => +new Date(r.observed_at) <= at && at < +new Date(r.valid_until));
    const values = new Set(active.map(r => canonical(r.value?.[spec.answer])));
    const vantages = new Set(active.map(r => r.vantage));
    let state = "steady";
    if (!active.length) state = "dim";
    else if (values.size > 1) state = vantages.size > 2 ? "unresolved" : "flare";
    else if (vantages.size > 1) state = "double";
    return { spec_hash, question: spec.question, state, active: active.length, total: all.length };
  });
}
