#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fillExtract, normalizeExtract } from "./extract.js";
import { classifyVerdict } from "./evidence.js";
import { funnelReason, funnelSpecHash, funnelVerdict, recordFunnel } from "./funnel.js";
import { loadOrCreateKeystore } from "./keystore.js";
import { pubkeyB64 } from "./receipt.js";
import { MAX_ASSERTION_LENGTH, isBillable } from "./server.js";
import { handleSellerOfferValidate } from "./routes/seller.js";
import { buildLlmsText, buildSkillText } from "./discovery.js";
import { openapiDoc } from "./openapi.js";
import { SsrfError, assertPublicHttps } from "./ssrf.js";

/**
 * Witness MCP wrapper (stdio). Developer agents that speak MCP get the free
 * surfaces as tools; the paid observation stays POST /witness over HTTP.
 *
 * Tools (free, never billed): witness_quote, witness_validate_offer,
 * witness_pubkey. There is deliberately no paid tool: settling x402 needs the
 * caller's wallet, and MCP has no payment flow. A paid witness must go
 * through quote-first POST /witness, where the paywall actually settles.
 *
 * Resources (docs, not tools): witness:///llms.txt, witness:///skill.md,
 * witness:///openapi.json — the same strings the HTTP host serves.
 *
 * Transport note: this uses the low-level Server with hand-written JSON
 * Schema, not McpServer+zod — the installed SDK's tool() shape detection
 * does not accept zod v4 schemas, and input validation belongs in the one
 * authoritative handler per surface anyway, so MCP never disagrees with HTTP
 * about what is valid.
 *
 * Fetch model: witness_quote probes the URL DIRECTLY (one fetch, no reader,
 * no reader spend). This is curl-equivalent behavior for a local tool — the
 * caller is the machine owner, not a remote stranger — but it is NOT the paid
 * pipeline: no SSRF allowlist beyond the loopback carve-out below, no signed
 * receipt. Anything fetched here is a probe; evidence still comes from paid
 * POST /witness.
 */

export const MCP_TOOL_NAMES = Object.freeze(["witness_quote", "witness_validate_offer", "witness_pubkey"]);
export const MCP_RESOURCE_URIS = Object.freeze(["witness:///llms.txt", "witness:///skill.md", "witness:///openapi.json"]);

const PROBE_TIMEOUT_MS = 20000;
const LOOPBACK_HOST = [/^localhost$/i, /\.localhost$/i, /^127\./, /^\[?::1\]?$/i];

/** Local-probe URL policy: loopback (http or https, no DNS) for local dev
 *  and tests; anything else goes through the full public-https guard.
 *  Loopback is allowed because the caller is local; every other private
 *  range (metadata, RFC1918, link-local) stays refused, as does DNS that
 *  resolves into one. */
export async function assertProbeableUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid_url");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (LOOPBACK_HOST.some((re) => re.test(host))) {
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("https_only");
    return u;
  }
  return assertPublicHttps(raw);
}

/** Direct-fetch deliverability probe. Same verdict vocabulary and reason
 *  strings as POST /quote (same fillExtract/classifyVerdict core and the
 *  same billability guards), minus price_usdc (this call is free) and Change
 *  Proof (prior receipts belong to the reader-mediated pipeline). */
export async function handleMcpQuote(body, { fetch: doFetch = globalThis.fetch } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, json: { reason: "bad_json" } };
  const extract = normalizeExtract(body.extract);
  if (!extract) return { status: 400, json: { reason: "bad_extract" } };
  const { assertion } = body;
  if (assertion != null && (typeof assertion !== "string" || assertion.length > MAX_ASSERTION_LENGTH))
    return { status: 400, json: { reason: "bad_assertion" } };
  if (body.replicas !== undefined && body.replicas !== 1)
    return { status: 422, json: { reason: "replicas_unsupported" } };
  try {
    await assertProbeableUrl(body.url);
  } catch (e) {
    if (!(e instanceof SsrfError)) throw e;
    return { status: 422, json: { reason: e.message } };
  }
  let text;
  try {
    const res = await doFetch(body.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), headers: { accept: "text/plain" } });
    if (!res.ok) return { status: 422, json: { reason: "retrieve_failed" } };
    text = await res.text();
  } catch {
    return { status: 422, json: { reason: "retrieve_failed" } };
  }
  if (!text || !text.trim()) return { status: 422, json: { reason: "retrieve_empty" } };
  const filled = fillExtract(text, extract);
  const { values, missing } = filled;
  const classified = classifyVerdict(values, missing, body.assertion);
  const verdict = body.assertion == null ? null : classified.verdict;
  if (verdict === null && missing.length) return { status: 422, json: { reason: "extract_missing", missing } };
  if (verdict === "incomplete" && !Object.keys(values).length)
    return { status: 422, json: { reason: "extract_none", missing } };
  if (!isBillable(verdict)) return { status: 422, json: { reason: classified.reason ?? "unable_to_verify" } };
  const verdict_reason = verdict === null ? null : classified.reason ?? null;
  const announced = verdict === null ? {} : { verdict, verdict_reason };
  if (verdict === "incomplete") announced.missing = classified.missing ?? [...missing];
  return { status: 200, json: { replicas: body.replicas || 1, can_deliver: true, ...announced }, values };
}

/** Quote results render as human-readable text (verdict + assertion + value);
 *  refusals stay machine-readable JSON. Follows the src/render.js precedent:
 *  non-200 sets isError, and no signal is lost either way. */
export function renderMcpQuote(out, args) {
  if (out.status !== 200) {
    return { content: [{ type: "text", text: JSON.stringify(out.json) }], isError: true };
  }
  const verdict = out.json.verdict ?? null;
  const assertion = args && typeof args.assertion === "string" ? args.assertion : "no assertion";
  const lines = [
    `${String(verdict ?? "no_verdict").toUpperCase()} — ${assertion}`,
    "can_deliver: true (free probe; the signed receipt is POST /witness over HTTP + $0.01 x402)",
  ];
  if (out.json.verdict_reason) lines.push(`reason: ${out.json.verdict_reason}`);
  if (out.json.missing) lines.push(`missing: ${JSON.stringify(out.json.missing)}`);
  if (out.values) lines.push(`value: ${JSON.stringify(out.values)}`);
  return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
}

/** HTTP status mapped onto the MCP error flag: a non-200 answer sets
 *  isError while the structured body rides along as text. */
function toolResult(out) {
  return { content: [{ type: "text", text: JSON.stringify(out.json) }], isError: out.status !== 200 };
}

const quoteInputSchema = {
  type: "object",
  required: ["url", "extract"],
  properties: {
    url: { type: "string", description: "URL to probe. Loopback http(s) is allowed for local dev; anything else must be public https." },
    extract: { type: "object", description: 'Field name -> expected type ("number" | "string", or {"type": ...} spelling).' },
    assertion: { type: "string", description: 'Optional post-condition, grammar "<key> <op> <literal>". Omit for a bare extract.' },
    replicas: { type: "integer", description: "Must be 1 when present." },
    prior_receipt: { type: "object", description: "Not supported on this direct probe (no Change Proof here); use POST /quote. Ignored when present." },
  },
};

const validateInputSchema = {
  type: "object",
  description: "A seller-offer/v1 body: either {offer, outcomes?} or a bare offer (bare fields pass through untouched).",
  properties: {
    offer: { type: "object", description: "A seller-offer/v1 object. Omit and pass the offer's fields at top level instead." },
    outcomes: { type: "array", description: "Explicit outcome rows; empty/omitted stays unknown, never a trust claim." },
  },
};

function recordMcpQuote(funnelDir, args, out) {
  if (!funnelDir) return;
  try {
    recordFunnel(funnelDir, {
      ts: new Date().toISOString(),
      route: "mcp",
      status: out.status,
      outcome: out.status === 200 ? "mcp_quote_deliverable" : "mcp_quote_non_deliverable",
      ...(funnelSpecHash(args) ? { spec_hash: funnelSpecHash(args) } : {}),
      ...(out.status >= 400 && funnelReason(out.json) ? { reason: funnelReason(out.json) } : {}),
      ...(out.status < 400 && funnelVerdict(out.json) ? { verdict: funnelVerdict(out.json) } : {}),
    });
  } catch { /* funnel must never break the tool path */ }
}

export function createMcpServer(deps = {}) {
  const key = deps.key ?? loadOrCreateKeystore(deps.keystoreDir);
  const funnelDir = deps.funnelDir ?? null;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const publicBaseUrl = deps.publicBaseUrl ?? "https://witness.outbid.sh";
  const server = new Server({ name: "witness", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });

  const tools = [
    {
      name: "witness_quote",
      description:
        "Free deliverability probe for a paid observation (direct fetch, one request, no reader spend). " +
        "200 renders the verdict the paid receipt would carry; 422 is JSON with a fixed-vocabulary reason and is never billed. " +
        "The paid observation itself stays POST /witness over HTTP with x402.",
      inputSchema: quoteInputSchema,
    },
    {
      name: "witness_validate_offer",
      description:
        "Validate a seller offer and return the wrapped seller card (free, never billed). " +
        "Accepts {offer, outcomes?} or a bare offer. Empty history stays null, never a trust claim.",
      inputSchema: validateInputSchema,
    },
    {
      name: "witness_pubkey",
      description: "The ed25519 signing key witness receipts verify against (same key as GET /pubkey).",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = req.params.arguments && typeof req.params.arguments === "object" ? req.params.arguments : {};
    if (req.params.name === "witness_quote") {
      const out = await handleMcpQuote(args, { fetch: doFetch });
      recordMcpQuote(funnelDir, args, out);
      return renderMcpQuote(out, args);
    }
    if (req.params.name === "witness_validate_offer") {
      return toolResult(handleSellerOfferValidate(args));
    }
    if (req.params.name === "witness_pubkey") {
      return { content: [{ type: "text", text: JSON.stringify({ pubkey: pubkeyB64(key) }) }] };
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${req.params.name}`);
  });

  const docs = [
    ["witness:///llms.txt", "Agent docs — endpoints, methods, prices.", "text/markdown", buildLlmsText],
    ["witness:///skill.md", "Agent skill — quote-first flow and receipt fields.", "text/markdown", buildSkillText],
    [
      "witness:///openapi.json",
      "Machine contract — OpenAPI 3.1 for the HTTP surfaces.",
      "application/json",
      () => JSON.stringify(openapiDoc({ PUBLIC_BASE_URL: publicBaseUrl }), null, 2),
    ],
  ];
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: docs.map(([uri, description, mimeType]) => ({ uri, name: uri, description, mimeType })),
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (req) => {
    const found = docs.find(([uri]) => uri === req.params.uri);
    if (!found) throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${req.params.uri}`);
    const [, , mimeType, read] = found;
    return { contents: [{ uri: req.params.uri, text: read(), mimeType }] };
  });

  return server;
}

export async function startMcp(env = process.env) {
  const server = createMcpServer({
    keystoreDir: env.MCP_KEYSTORE_DIR ?? env.KEYSTORE_DIR,
    funnelDir: env.MCP_FUNNEL_DIR ?? env.MCP_OBSERVATIONS_DIR ?? env.OBSERVATIONS_DIR ?? null,
    publicBaseUrl: env.PUBLIC_BASE_URL || "https://witness.outbid.sh",
  });
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startMcp();
}
