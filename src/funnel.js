import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { normalizeExtract } from "./extract.js";
import { methodFromRequest, specHash } from "./observatory.js";

/** Privacy-safe demand evidence: one append-only NDJSON line per POST /quote
 *  or POST /witness outcome. Fields: ts, route, status, outcome, the one-way
 *  spec_hash when the body names a valid method, and reason (the handler's
 *  fixed-vocabulary enum, e.g. bad_extract) on non-2xx rows. Never raw URL,
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

/** The response body's `reason`, admitted only as a snake_case enum token so
 *  the funnel can never carry free text, a URL, or an extract key. 2xx rows
 *  and the 402 challenge have none. */
export function funnelReason(json) {
  const r = json && typeof json === "object" ? json.reason : undefined;
  return typeof r === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(r) ? r : null;
}

export function funnelSpecHash(body) {
  try {
    if (!body || typeof body !== "object") return null;
    if (typeof body.url !== "string" || !body.url) return null;
    const extract = normalizeExtract(body.extract);
    if (!extract) return null;
    return specHash(methodFromRequest({ ...body, extract }, "scrape"));
  } catch {
    return null;
  }
}
