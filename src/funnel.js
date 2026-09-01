import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { methodFromRequest, specHash } from "./observatory.js";

/** Privacy-safe demand evidence: one append-only NDJSON line per POST /quote
 *  or POST /witness outcome. Fields: ts, route, status, outcome, and the
 *  one-way spec_hash when the body names a valid method. Never raw URL,
 *  extract values, evidence, IP, request/payment headers, payer, wallet, tx,
 *  or secrets. */
export function recordFunnel(dir, event) {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "funnel.ndjson"), `${JSON.stringify(event)}\n`);
}

export function funnelOutcome(route, status) {
  if (route === "/quote") return status === 200 ? "quote_deliverable" : "quote_non_deliverable";
  if (status === 200) return "witness_signed_receipt";
  if (status === 402) return "witness_402_challenge";
  return "witness_non_deliverable";
}

export function funnelSpecHash(body) {
  try {
    if (!body || typeof body !== "object") return null;
    if (typeof body.url !== "string" || !body.url) return null;
    if (typeof body.extract !== "object" || !Object.keys(body.extract).length) return null;
    return specHash(methodFromRequest(body, "scrape"));
  } catch {
    return null;
  }
}
