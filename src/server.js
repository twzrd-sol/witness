import express from "express";
import { assertPublicHttps, SsrfError } from "./ssrf.js";
import { evidenceSnippet, EXTRACT_SCHEMA, fillExtract, normalizeExtract } from "./extract.js";
import { loadOrCreateKeystore } from "./keystore.js";
import { pubkeyB64, signReceipt, sourceHash, verifyReceipt } from "./receipt.js";
import { classifyVerdict } from "./evidence.js";
import { appendObservation, compareReceipts, methodFromRequest, readObservations, specHash, VALID_FOR_MS } from "./observatory.js";
import { renderStarMap } from "./star-map.js";
import { funnelOutcome, funnelReason, funnelSpecHash, funnelVerdict, recordFunnel } from "./funnel.js";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

export const PRICE_USDC = "0.01";
const AMOUNT_ATOMIC = "10000"; // 0.01 USDC, 6 decimals
const EVM_NET = "eip155:8453";
const SVM_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SVM_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** A malformed extract is a request-shape error (400), never a capability claim (422): the body teaches the fix. */
const BAD_EXTRACT = { reason: "bad_extract", expected: { "<key>": "number|string" }, example: { url: "https://outbid.sh/top", extract: { rank: "number" } } };
/** The assertion is grammar text, never a structure: String() on a deep array recurses without bound, and a receipt carries it verbatim. */
export const MAX_ASSERTION_LENGTH = 512;
/** What both published contracts (openapi.json, the bazaar inputSchema) declare for `assertion`. null is the
 *  documented "no assertion": a receipt's method echoes it, and that method must validate as the next body. */
export const ASSERTION_SCHEMA = { type: ["string", "null"], maxLength: MAX_ASSERTION_LENGTH };
const BAD_ASSERTION = { reason: "bad_assertion", expected: '"<key> <op> <literal>" or "<key> exists"', example: "rank < 100" };

function paymentMiddlewareWithBody(routes, rs) {
  const inner = paymentMiddleware(routes, rs);
  return (req, res, next) => {
    const orig = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 402 && body && typeof body === "object" && Object.keys(body).length === 0) {
        const pr = res.getHeader("PAYMENT-REQUIRED") || res.getHeader("payment-required");
        if (typeof pr === "string") {
          let decoded = null;
          try { decoded = JSON.parse(pr); } catch { /* header may be base64url-encoded */ }
          if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
            try { decoded = JSON.parse(Buffer.from(pr, "base64url").toString("utf8")); } catch { /* keep {} */ }
          }
          if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) body = decoded;
        }
      }
      return orig(body);
    };
    return inner(req, res, next);
  };
}

/** Paywall route options per rail (v2 style: middleware builds requirements). */
export function witnessAccepts({ evmAddress, svmAddress } = {}) {
  const a = [];
  if (evmAddress) a.push({ scheme: "exact", network: EVM_NET, price: "$0.01", payTo: evmAddress, maxTimeoutSeconds: 300 });
  if (svmAddress) a.push({ scheme: "exact", network: SVM_NET, price: "$0.01", payTo: svmAddress, maxTimeoutSeconds: 300 });
  return a;
}

function processKey(deps) {
  return deps.key ?? loadOrCreateKeystore(deps.keystoreDir);
}

/** What a caller can be charged for. `contradicted` and `incomplete` are answers
 *  about the source -- the page does not say what you were told, or it never
 *  carried the field -- and both cost the same as `supported`, which was always
 *  the paid product. A request that states no assertion makes no claim, carries
 *  verdict null, and bills exactly as it did before verdicts existed. */
export const BILLABLE_VERDICTS = Object.freeze(["supported", "contradicted", "incomplete"]);

/** Never billed, permanently. Two kinds live here and both must stay free: "we
 *  could not check" (a malformed claim we cannot read) and every one of our own
 *  defects (retrieval, parsing, wiring, crashes). Charging for either is the one
 *  way paid non-supported verdicts become a scam, so this is a constant the
 *  billing path reads -- not a comment describing an intention. */
export const NEVER_BILLED = Object.freeze([
  "unable_to_verify", "assertion_malformed", "assertion_field_not_extracted",
  "evidence_mismatch", "verdict_mismatch",
  "retrieve_failed", "retrieve_empty", "retrieve_not_wired",
  "bad_json", "bad_extract", "bad_assertion", "replicas_unsupported",
  "ssrf_refused", "server_error",
]);

/** The single billing decision, so quote and witness cannot answer it differently. */
export const isBillable = (verdict) => verdict === null || BILLABLE_VERDICTS.includes(verdict);

/** Change Proof: fail-closed prior validation before any retrieve. Returns a reason string or null. */
function checkPrior(prior, publicKey, method) {
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return "prior_invalid";
  if (typeof prior.receipt !== "string") return "prior_invalid";
  let ok = false;
  try { ok = verifyReceipt(prior, publicKey); } catch { ok = false; }
  if (!ok) return "prior_invalid";
  if (typeof prior.source_hash !== "string") return "prior_invalid";
  if (!prior.method || typeof prior.method !== "object" || Array.isArray(prior.method)) return "prior_invalid";
  if (specHash(method) !== prior.spec_hash || specHash(prior.method) !== prior.spec_hash) return "prior_method_mismatch";
  return null;
}

export async function handleQuote(body, { retrieve, key, retrieval } = {}) {
  if (!body || typeof body !== "object") return { status: 400, json: { reason: "bad_json" } };
  const { url, replicas } = body;
  // Dialects collapse to the canonical flat map here, before any specHash(): one method, one identity.
  const extract = normalizeExtract(body.extract);
  if (!extract) return { status: 400, json: BAD_EXTRACT };
  const { assertion } = body;
  if (assertion != null && (typeof assertion !== "string" || assertion.length > MAX_ASSERTION_LENGTH))
    return { status: 400, json: BAD_ASSERTION };
  if (replicas !== undefined && replicas !== 1)
    return { status: 422, json: { reason: "replicas_unsupported" } };
  const prior = body.prior_receipt;
  let priorInfo = null;
  if (prior !== undefined) {
    const bad = checkPrior(prior, key?.publicKey, methodFromRequest({ ...body, extract }, retrieval ?? "scrape"));
    if (bad) return { status: 422, json: { reason: bad } };
    priorInfo = prior;
  }
  try {
    await assertPublicHttps(url);
  } catch (e) {
    if (!(e instanceof SsrfError)) throw e;
    return { status: 422, json: { reason: e.message } };
  }
  if (typeof retrieve !== "function") return { status: 503, json: { reason: "retrieve_not_wired" } };
  let text;
  try {
    const res = await retrieve(url);
    text = typeof res === "string" ? res : res && res.text;
  } catch {
    return { status: 422, json: { reason: "retrieve_failed" } };
  }
  if (!text) return { status: 422, json: { reason: "retrieve_empty" } };
  const filled = fillExtract(text, extract);
  const { values, missing } = filled;
  // One classification, on the retrieval this quote already performed. /witness
  // consumes this rather than deriving its own, so what the caller is told they
  // will get and what they pay for cannot disagree.
  const classified = classifyVerdict(values, missing, body.assertion);
  // A request with no assertion asks us to observe, not to check. That is not a
  // failed verification -- it carries no verdict at all, and never reads supported.
  const verdict = body.assertion == null ? null : classified.verdict;
  // `incomplete` is an answer about a claim: the source did not carry what the
  // claim needed. With no claim there is nothing for it to be incomplete about
  // and nothing to sell, so a bare extract miss stays the free refusal it was.
  if (verdict === null && missing.length) return { status: 422, json: { reason: "extract_missing", missing } };
  if (!isBillable(verdict)) return { status: 422, json: { reason: classified.reason ?? "unable_to_verify" } };
  const verdict_reason = verdict === null ? null : classified.reason ?? null;
  // A quote is a price announcement, not a signed document: a request that made no
  // claim gets no verdict field at all, so its body keeps the shape it always had.
  // The signed receipt still carries an explicit null, where "no claim was made"
  // must be readable and distinct from "the field is absent".
  const announced = verdict === null ? {} : { verdict, verdict_reason };
  if (verdict === "incomplete") announced.missing = classified.missing ?? [...missing];
  const carry = { text, extract, values, missing, spans: filled.spans ?? {}, verdict, verdict_reason };
  if (priorInfo) {
    const source = sourceHash(text);
    return {
      status: 200,
      json: { price_usdc: PRICE_USDC, replicas: replicas || 1, can_deliver: true, ...announced, changed: source !== priorInfo.source_hash, previous_source_hash: priorInfo.source_hash, source_hash: source },
      ...carry,
      prior: priorInfo,
    };
  }
  return { status: 200, json: { price_usdc: PRICE_USDC, replicas: replicas || 1, can_deliver: true, ...announced }, ...carry };
}

/** Unpaid without deps.paid → 402. Signing only after explicit paid (x402 middleware or test). */
export async function handleWitness(body, deps = {}) {
  const q = await handleQuote(body, deps);
  if (q.status !== 200) return q;
  if (!deps.paid) {
    return {
      status: 402,
      json: {
        x402Version: 1,
        accepts: witnessAccepts(deps.paywall).length
          ? witnessAccepts(deps.paywall)
          : [{ scheme: "exact", network: SVM_NET, maxAmountRequired: AMOUNT_ATOMIC, asset: SVM_USDC, payTo: "<WITNESS_SOLANA>" }],
      },
    };
  }
  // Quote already retrieved the source — reuse it; a paid /witness must not scrape twice.
  let text = q.text;
  if (text === undefined) {
    try {
      const res = await deps.retrieve(body.url);
      text = typeof res === "string" ? res : res && res.text;
    } catch {
      return { status: 422, json: { reason: "retrieve_failed" } };
    }
    if (!text) return { status: 422, json: { reason: "retrieve_empty" } };
  }
  // Consume the quote's extraction and classification. Re-deriving here would
  // let the issued receipt drift from the announced verdict on a source that
  // changed between the two calls -- the caller would pay for a different answer
  // than the one they were quoted.
  let { values, spans, verdict, verdict_reason } = q;
  if (values === undefined) {
    const filled = fillExtract(text, q.extract);
    if (filled.missing.length && body.assertion == null) return { status: 422, json: { reason: "extract_missing", missing: filled.missing } };
    const c = classifyVerdict(filled.values, filled.missing, body.assertion);
    verdict = body.assertion == null ? null : c.verdict;
    if (!isBillable(verdict)) return { status: 422, json: { reason: c.reason ?? "unable_to_verify" } };
    ({ values } = filled);
    spans = filled.spans ?? {};
    verdict_reason = verdict === null ? null : c.reason ?? null;
  }
  const observed_at = (deps.now ?? (() => new Date().toISOString()))();
  const method = methodFromRequest({ ...body, extract: q.extract }, deps.retrieval ?? "scrape");
  const source_hash = sourceHash(text);
  const rest = {
    value: values,
    assertion: body.assertion ?? null,
    observed_at,
    source_hash,
    // Time-addressed evidence binding: source_hash covers the reader's
    // plaintext derivation, not the origin bytes (which the reader hides).
    // Origin fetch metadata stays null rather than implying what we saw.
    requested_url: body.url,
    final_url: null,
    origin_status: null,
    origin_content_type: null,
    representation: { kind: "reader_plaintext", sha256: source_hash, retrieved_at: observed_at },
    evidence: evidenceSnippet(text, spans),
    evidence_spans: JSON.parse(JSON.stringify(spans ?? {})),
    // The verdict travels with the observation so no reader downstream -- the
    // observatory, a star map, an agent -- can render a contradiction as a fact.
    verdict: verdict ?? null,
    verdict_reason: verdict_reason ?? null,
    agreement: "1-of-1",
    method,
    spec_hash: specHash(method),
    valid_until: new Date(Date.parse(observed_at) + VALID_FOR_MS).toISOString(),
    vantage: deps.vantage ?? "box",
  };
  if (q.prior) {
    rest.changed = rest.source_hash !== q.prior.source_hash;
    rest.previous_source_hash = q.prior.source_hash;
  }
  const json = signReceipt(rest, processKey(deps));
  // Only paid receipts reach here (402/422 return above) — append nothing else.
  if (deps.observationsDir) appendObservation(deps.observationsDir, json);
  return { status: 200, json };
}

export function createApp(deps = {}) {
  const key = processKey(deps);
  const wired = { ...deps, key, observationsDir: deps.observationsDir ?? "data" };
  const resourceUrl = `${deps.publicBaseUrl || "https://witness.outbid.sh"}/witness`;
  const app = express();
  const funnelDir = deps.funnelDir === undefined ? wired.observationsDir : deps.funnelDir;
  const quoteHits = new Map();
  const configuredQuoteLimit = Number(deps.quoteRateLimit ?? process.env.QUOTE_RATE_LIMIT_PER_MINUTE ?? 30);
  const quoteLimit = Number.isInteger(configuredQuoteLimit) && configuredQuoteLimit > 0 ? configuredQuoteLimit : 30;
  const quoteWindowMs = 60_000;
  const quoteAllowed = (ip) => {
    const now = Date.now();
    const prior = quoteHits.get(ip);
    const hits = prior && now - prior.startedAt < quoteWindowMs ? prior : { startedAt: now, count: 0 };
    hits.count += 1;
    quoteHits.set(ip, hits);
    return hits.count <= quoteLimit;
  };
  app.use((req, res, next) => {
    if (req.method !== "POST" || (req.path !== "/quote" && req.path !== "/witness")) return next();
    // Every reply (handlers, bad_json, 402 challenge) is written via res.json: read its enum reason there.
    let reason = null;
    let verdict = null;
    const json = res.json.bind(res);
    res.json = (body) => { reason = funnelReason(body); verdict = funnelVerdict(body); return json(body); };
    res.on("finish", () => {
      try {
        const spec_hash = funnelSpecHash(req.body);
        recordFunnel(funnelDir, {
          ts: new Date().toISOString(),
          route: req.path,
          status: res.statusCode,
          outcome: funnelOutcome(req.path, res.statusCode),
          ...(spec_hash ? { spec_hash } : {}),
          ...(reason && res.statusCode >= 400 ? { reason } : {}),
          // 2xx only: a paid contradiction must stay countable against the
          // day-one numbers, and must never be tallied as a supported fact.
          ...(verdict && res.statusCode < 400 ? { verdict } : {}),
        });
      } catch { /* funnel must never break the response path */ }
    });
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  const reply = (res, out) => res.status(out.status).json(out.json);
  // Express 4 drops a rejected async handler on the floor: the request hangs and the
  // process dies on the unhandled rejection. Route every rejection to the 500 handler.
  const guard = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const witness = guard(async (req, res) => reply(res, await handleWitness(req.body, { ...wired, paid: false })));
  const paidWitness = guard(async (req, res) => reply(res, await handleWitness(req.body, { ...wired, paid: true })));
  app.get("/pubkey", (_req, res) => res.json({ pubkey: pubkeyB64(key) }));
  app.get("/observatory", (_req, res) => {
    const now = (wired.now ?? (() => new Date().toISOString()))();
    res.type("html").send(renderStarMap(compareReceipts(readObservations(wired.observationsDir), key.publicKey, now), now));
  });
  app.post("/quote", guard(async (req, res) => {
    if (!quoteAllowed(req.ip)) return reply(res, { status: 429, json: { reason: "quote_rate_limited" } });
    return reply(res, await handleQuote(req.body, wired));
  }));
  const accepts = witnessAccepts(deps.paywall);
  if (accepts.length) {
    const bazaar = declareDiscoveryExtension({
      bodyType: "json",
      input: { url: "https://outbid.sh/top", extract: { rank: "number" }, assertion: "rank < 100", replicas: 1 },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          extract: EXTRACT_SCHEMA,
          assertion: ASSERTION_SCHEMA,
          replicas: { type: "integer", enum: [1] },
        },
        required: ["url", "extract"],
      },
      output: {
        example: {
          value: { rank: 1 }, assertion: "rank < 100", observed_at: "2026-08-30T00:00:00.000Z",
          source_hash: "<sha256>", evidence: "<first 160 chars>", agreement: "1-of-1",
          method: { url: "https://outbid.sh/top", retrieval: "scrape", extract: { rank: "number" }, assertion: "rank < 100" },
          spec_hash: "<sha256>", valid_until: "2026-08-30T01:00:00.000Z", vantage: "box", receipt: "<ed25519>",
        },
      },
    });
    const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: deps.facilitatorUrl || "https://facilitator.payai.network" });
    const rs = new x402ResourceServer(facilitator);
    if (deps.paywall.evmAddress) rs.register(EVM_NET, new ExactEvmScheme());
    if (deps.paywall.svmAddress) rs.register(SVM_NET, new ExactSvmScheme());
    // Deliverability-first: an unpaid probe runs the quote; only a deliverable
    // request reaches the paywall. A 422 never sees a 402, matching the reader.
    const deliverable = guard(async (req, res, next) => {
      if (req.headers["payment-signature"] || req.headers["x-payment"]) return next();
      const out = await handleQuote(req.body, wired);
      if (out.status === 200) return next();
      return reply(res, out);
    });
    const witnessMeta = { serviceName: "witness", tags: ["observation", "receipt", "x402", "empiricism"] };
    app.post("/witness", deliverable, paymentMiddlewareWithBody({ "POST /witness": { resource: resourceUrl, accepts, mimeType: "application/json", description: "Independent fact + signed receipt. $0.01 USDC.", ...witnessMeta, extensions: bazaar } }, rs), paidWitness);
    // Crawlable discovery: GET answers the same 402 challenge with zero retrieve.
    app.get("/witness", (req, res, next) => {
      if (req.headers["payment-signature"] || req.headers["x-payment"]) {
        return res.status(405).json({ reason: "get_discovery_only_use_post" });
      }
      next();
    }, paymentMiddlewareWithBody({ "GET /witness": { resource: resourceUrl, accepts, mimeType: "application/json", description: "Discovery challenge — the paid deliverable is POST /witness.", ...witnessMeta } }, rs));
  } else {
    app.post("/witness", witness);
  }
  app.use((err, _req, res, next) => {
    if (err && (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400 && "body" in err))) {
      return res.status(400).json({ reason: "bad_json" });
    }
    next(err);
  });
  app.use((err, _req, res, _next) => {
    console.error("witness:", err && (err.stack || err.message || err));
    res.status(500).json({ reason: "internal_error" });
  });
  return app;
}
