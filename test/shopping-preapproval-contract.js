/**
 * Wave9 DD — OpenAPI shopping-preapproval / Done-child contract map.
 *
 * Wave6 Q (`test/openapi-matrix.js`) walks every published route's error
 * statuses. This map is the shopping-preapproval slice plus the 200 shapes
 * and the offline Done-child (`scripts/verify-shopping-receipt.mjs`) that
 * Wave6 does not lock:
 *
 *   OpenAPI  POST /quote, POST /witness, GET /witness, GET /pubkey
 *        ⇄   runtime host (GATE_METHOD card)
 *        ⇄   Done-child status / reason / report shape
 *
 * The document, the host, and the child are three surfaces. Drift detected
 * in one direction only is drift that ships — the class #31 taught on
 * /delivery/attest. Tests-only. No host change, no spend.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { documentedCells, documentedReasonRows, unique } from "./openapi-matrix.js";
import { GATE_METHOD } from "../scripts/shopping-preapproval.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHILD_SCRIPT = path.join(ROOT, "scripts/verify-shopping-receipt.mjs");
export const PARENT_SCRIPT = path.join(ROOT, "scripts/shopping-preapproval.mjs");

/** Paths the shopping-preapproval card actually talks to (plus GET /witness discovery). */
export const PREAPPROVAL_PATHS = Object.freeze(["/quote", "/witness", "/pubkey"]);

/** 200 is the half Wave6 deliberately omitted (CONTRACT_STATUSES is 4xx/5xx). */
export const PREAPPROVAL_SUCCESS_STATUSES = Object.freeze(["200"]);

/**
 * Fields `verify-shopping-receipt.mjs` reads on a /witness 200 receipt.
 * `receipt` is the signature member `verifyReceipt` strips.
 */
export const DONE_CHILD_RECEIPT_FIELDS = Object.freeze([
  "receipt",
  "method",
  "spec_hash",
  "requested_url",
  "assertion",
  "observed_at",
  "valid_until",
  "source_hash",
  "evidence",
  "evidence_spans",
  "agreement",
  "value",
  "verdict",
]);

/**
 * Child-required receipt fields OpenAPI `POST /witness` 200 does not name.
 * Documenting one requires dropping it from this list (the intersection
 * test fails if a field is both documented and listed here).
 */
export const OPENAPI_OMITTED_CHILD_FIELDS = Object.freeze([
  "requested_url",
  "evidence_spans",
]);

/** Quote 200 fields the GATE_METHOD gate / decideGate actually consume. */
export const QUOTE_200_GATE_FIELDS = Object.freeze([
  "price_usdc",
  "replicas",
  "can_deliver",
  "verdict",
]);

/** Quote 200 fields runtime emits for GATE_METHOD that OpenAPI properties omit. */
export const OPENAPI_OMITTED_QUOTE_FIELDS = Object.freeze([
  "verdict",
  "verdict_reason",
]);

/** Locked Done-child reason vocabulary. Adding/renaming one without this list fails. */
export const DONE_CHILD_REASONS = Object.freeze([
  "evidence_invalid",
  "signature_invalid",
  "method_mismatch",
  "freshness_invalid",
  "verdict_not_supported",
  "assertion_not_supported",
  "receipt_supported",
]);

export const DONE_CHILD_ACCEPT_REASON = "receipt_supported";

/** Accepting child report — what the parent requires before checkout_approved. */
export const DONE_CHILD_REPORT_FIELDS = Object.freeze([
  "approve",
  "reason",
  "verifier_pid",
  "expected_method",
  "receipt_verified",
  "checked_at",
  "receipt_hash",
  "trusted_key_hash",
]);

/**
 * Static decision/check reasons the parent emits (not `witness_http_*` /
 * `verdict_<name>` templates). Child reasons may pass through on accept.
 */
export const PARENT_STATIC_REASONS = Object.freeze([
  "trusted_key_invalid",
  "quote_not_deliverable",
  "verifier_failed",
  "run_failed",
  "verdict_supported",
  "verdict_missing",
  "not_run",
  "receipt_supported",
]);

export const CARD_METHOD = GATE_METHOD;

const REASON_LITERAL = /reason\s*[:=]\s*["']([a-z][a-z0-9_]*)["']/g;
/** Property access only — do not match `../src/receipt.js`. */
const RECEIPT_PROP = /(?<![\w./])receipt\.([a-z_]+)/g;

export function reasonsInSource(src) {
  return unique([...src.matchAll(REASON_LITERAL)].map((m) => m[1])).sort();
}

export function receiptFieldsInSource(src) {
  return unique([...src.matchAll(RECEIPT_PROP)].map((m) => m[1])).sort();
}

export function childSource() {
  return readFileSync(CHILD_SCRIPT, "utf8");
}

export function parentSource() {
  return readFileSync(PARENT_SCRIPT, "utf8");
}

export function jsonSchemaAt(doc, path, method, status) {
  const op = doc.paths?.[path]?.[method.toLowerCase()];
  return op?.responses?.[String(status)]?.content?.["application/json"]?.schema ?? null;
}

export function requestSchemaAt(doc, path, method) {
  const op = doc.paths?.[path]?.[method.toLowerCase()];
  return op?.requestBody?.content?.["application/json"]?.schema ?? null;
}

export function preapprovalErrorCells(doc) {
  return documentedCells(doc).filter((c) => PREAPPROVAL_PATHS.includes(c.path));
}

export function preapprovalSuccessCells(doc) {
  return documentedCells(doc, { statuses: [...PREAPPROVAL_SUCCESS_STATUSES] })
    .filter((c) => PREAPPROVAL_PATHS.includes(c.path));
}

export function preapprovalCells(doc) {
  return [...preapprovalErrorCells(doc), ...preapprovalSuccessCells(doc)];
}

export function preapprovalReasonRows(doc) {
  return documentedReasonRows(preapprovalCells(doc));
}

export function openapiReceiptProperties(doc) {
  return Object.keys(jsonSchemaAt(doc, "/witness", "POST", "200")?.properties ?? {});
}

export function openapiQuote200Properties(doc) {
  return Object.keys(jsonSchemaAt(doc, "/quote", "POST", "200")?.properties ?? {});
}

export function openapiVerdictEnum(doc) {
  return jsonSchemaAt(doc, "/witness", "POST", "200")?.properties?.verdict?.enum ?? [];
}
