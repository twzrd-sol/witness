/**
 * Generated OpenAPI status/reason cells for contract tests.
 *
 * The document is the source of truth: walk `openapiDoc()` at test time and
 * emit every documented (path, method, status) plus any reason codes the
 * response names (schema enum, or snake_case tokens in the response
 * description). Runtime probes live in test/openapi-status-matrix.test.js.
 *
 * Tests-only. No host, no spend.
 */

/** Statuses Wave6 Q locks: 402/429/400/405 and related documented cousins. */
export const CONTRACT_STATUSES = Object.freeze([
  "400", "402", "404", "405", "409", "413", "422", "429", "500", "502", "503",
]);

const HTTP_METHODS = Object.freeze(["get", "post", "put", "patch", "delete"]);

/** Reason-shaped tokens that appear in OpenAPI prose (not verdicts like "supported"). */
const REASON_TOKEN = /\b(bad_[a-z0-9_]+|attest_[a-z0-9_]+|body_too_large|paywall_unavailable|internal_error|offer_not_found|quote_rate_limited|get_discovery_only_use_post|gate_not_wired|needs_browser)\b/g;
const QUOTED = /"([a-z][a-z0-9_]{2,})"/g;

const REASON_PREFIX = /^(bad_|attest_|prior_|retrieve_|extract_|assertion_|quote_|get_|gate_|body_|paywall_|offer_|intel_|internal_)/;

const REASON_EXACT = /^(bad_[a-z0-9_]+|attest_[a-z0-9_]+|body_too_large|paywall_unavailable|internal_error|offer_not_found|quote_rate_limited|get_discovery_only_use_post|gate_not_wired|needs_browser)$/;

export function isReasonLike(token) {
  return typeof token === "string" && (REASON_PREFIX.test(token) || REASON_EXACT.test(token));
}

export function unique(xs) {
  return [...new Set(xs)];
}

export function extractDocumentedReasons(response = {}) {
  const schema = response.content?.["application/json"]?.schema?.properties?.reason?.enum;
  const fromSchema = Array.isArray(schema) ? schema.filter((r) => typeof r === "string") : [];
  const text = typeof response.description === "string" ? response.description : "";
  const fromText = [];
  for (const m of text.matchAll(QUOTED)) {
    if (isReasonLike(m[1])) fromText.push(m[1]);
  }
  for (const m of text.matchAll(REASON_TOKEN)) fromText.push(m[1]);
  const reasons = unique([...fromSchema, ...fromText]);
  return {
    reasons,
    reasonSource: fromSchema.length ? "enum" : reasons.length ? "description" : "status-only",
  };
}

export function cellKey({ path, method, status, reason }) {
  return reason ? `${method} ${path} ${status} ${reason}` : `${method} ${path} ${status}`;
}

/**
 * Every documented (path, method, status) on the contract-status set, with
 * reason codes the document names for that response.
 */
export function documentedCells(doc, { statuses = CONTRACT_STATUSES } = {}) {
  const want = new Set(statuses);
  const cells = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op?.responses) continue;
      for (const [status, response] of Object.entries(op.responses)) {
        if (!want.has(String(status))) continue;
        const { reasons, reasonSource } = extractDocumentedReasons(response);
        cells.push({
          path,
          method: method.toUpperCase(),
          status: String(status),
          reasons,
          reasonSource,
          hasPaymentRequiredHeader: Boolean(response.headers?.["payment-required"]?.required),
          description: typeof response.description === "string" ? response.description : "",
        });
      }
    }
  }
  cells.sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  return cells;
}

/** Flatten to one row per documented reason, plus a status-only row when none are named. */
export function documentedReasonRows(cells) {
  const rows = [];
  for (const cell of cells) {
    if (!cell.reasons.length) {
      rows.push({ ...cell, reason: null });
      continue;
    }
    for (const reason of cell.reasons) rows.push({ ...cell, reason });
  }
  return rows;
}
