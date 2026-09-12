import express from "express";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertPublicHttps, SsrfError } from "../ssrf.js";
import { fillExtract } from "../extract.js";
import { loadOrCreateKeystore } from "../keystore.js";
import { specHash } from "../observatory.js";
import { funnelOutcome, recordFunnel } from "../funnel.js";
import { IntelUnavailable } from "../intel-evidence.js";
import {
  buildPayoutReceipt, claimExtract, classifyPayoutVerdict, comparePayoutClaim, isPayoutBillable,
  normalizePayoutRequest, observeIntel, PAYOUT_AMOUNT_ATOMIC, PAYOUT_PRICE_USDC, payoutMethod, projectClaim,
} from "../payout-claim.js";

/** Payout-claim verification surface, mounted on the witness app.
 *
 *   POST /verify/payout/quote  free: 200 announces the verdict, 4xx explains why not
 *   POST /verify/payout        x402 $0.05: same body, signed receipt after settlement
 *   GET  /verify/payout        crawlable 402 discovery, zero retrieve
 *
 * Same discipline as /quote -> /witness: a 4xx never sees a 402, a paid call
 * reuses the quote's retrieval, and a receipt is signed only after payment. */
export const PAYOUT_ROUTE = "/verify/payout";
export const PAYOUT_QUOTE_ROUTE = "/verify/payout/quote";
const SVM_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SVM_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LOG_FILE = "payout-claims.ndjson";
const DEFAULT_QUOTE_LIMIT = 30;
const QUOTE_WINDOW_MS = 60_000;

/** Intel first: it is free and cached, so an intel outage never spends a reader scrape. */
export async function handlePayoutQuote(body, { retrieve, fetchIntel } = {}) {
  const norm = normalizePayoutRequest(body);
  if (!norm.ok) return { status: norm.status, json: { reason: norm.reason } };
  const { request } = norm;
  try {
    await assertPublicHttps(request.claim_url);
  } catch (e) {
    if (!(e instanceof SsrfError)) throw e;
    return { status: 422, json: { reason: e.message } };
  }
  if (typeof retrieve !== "function") return { status: 503, json: { reason: "retrieve_not_wired" } };
  if (typeof fetchIntel !== "function") return { status: 503, json: { reason: "intel_not_wired" } };
  let intel;
  try {
    intel = await fetchIntel(request.wallet, request.direction, request.network);
  } catch (e) {
    if (e instanceof IntelUnavailable) return { status: 422, json: { reason: "intel_unavailable" } };
    throw e;
  }
  let text;
  try {
    const res = await retrieve(request.claim_url);
    text = typeof res === "string" ? res : res && res.text;
  } catch {
    return { status: 422, json: { reason: "retrieve_failed" } };
  }
  if (!text) return { status: 422, json: { reason: "retrieve_empty" } };
  const { values, missing } = projectClaim(request.claim, fillExtract(text, claimExtract(request.claim)));
  const observed = observeIntel(intel, request.direction);
  const findings = comparePayoutClaim(values, observed, request.direction);
  const classified = classifyPayoutVerdict(findings, { values, missing });
  if (!isPayoutBillable(classified.verdict)) {
    return { status: 422, json: { reason: classified.reason, ...(classified.missing ? { missing: classified.missing } : {}) } };
  }
  const announced = {
    price_usdc: PAYOUT_PRICE_USDC, can_deliver: true,
    verdict: classified.verdict, verdict_reason: classified.reason, findings,
    coverage: { in_corpus: observed.in_corpus, window: observed.window, direction: request.direction },
  };
  if (classified.missing) announced.missing = classified.missing;
  return {
    status: 200, json: announced,
    request, text, values, missing, findings, observed, intelSources: intel.sources,
    verdict: classified.verdict, verdict_reason: classified.reason,
  };
}

export async function handlePayoutVerify(body, deps = {}) {
  const q = await handlePayoutQuote(body, deps);
  if (q.status !== 200) return q;
  if (!deps.paid) {
    const accepts = deps.accepts ?? [];
    return {
      status: 402,
      json: {
        x402Version: 1,
        accepts: accepts.length ? accepts : [{ scheme: "exact", network: SVM_NET, maxAmountRequired: PAYOUT_AMOUNT_ATOMIC, asset: SVM_USDC, payTo: "<WITNESS_SOLANA>" }],
      },
    };
  }
  const observed_at = (deps.now ?? (() => new Date().toISOString()))();
  const json = buildPayoutReceipt({
    request: q.request, text: q.text, values: q.values, missing: q.missing, findings: q.findings, observed: q.observed,
    intelSources: q.intelSources, verdict: q.verdict, verdict_reason: q.verdict_reason,
    observed_at, key: deps.key ?? loadOrCreateKeystore(deps.keystoreDir), vantage: deps.vantage,
  });
  if (deps.observationsDir) appendPayoutClaim(deps.observationsDir, json);
  return { status: 200, json };
}

/** Paid payout receipts keep their own log: they are not observations of a page
 *  value, so they must not enter the star map's comparison. */
export function appendPayoutClaim(dir, receipt) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, LOG_FILE), `${JSON.stringify(receipt)}\n`);
}

export function readPayoutClaims(dir) {
  const file = path.join(dir, LOG_FILE);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip junk */ }
  }
  return out;
}

const hasPaymentHeaders = (req) => Boolean(req.headers["payment-signature"] || req.headers["x-payment"]);

export function createPayoutClaimRouter(wired, {
  accepts = [], paymentMiddlewareWithBody, resourceServer = null, publicBaseUrl, funnelDir, quoteRateLimit,
} = {}) {
  const router = express.Router();
  const resourceUrl = `${publicBaseUrl || "https://witness.outbid.sh"}${PAYOUT_ROUTE}`;
  const reply = (res, out) => res.status(out.status).json(out.json);
  const guard = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const limit = Number.isInteger(quoteRateLimit) && quoteRateLimit > 0 ? quoteRateLimit : DEFAULT_QUOTE_LIMIT;
  const hits = new Map();
  const quoteAllowed = (ip) => {
    const now = Date.now();
    const prior = hits.get(ip);
    const h = prior && now - prior.startedAt < QUOTE_WINDOW_MS ? prior : { startedAt: now, count: 0 };
    h.count += 1;
    hits.set(ip, h);
    return h.count <= limit;
  };

  // Demand evidence in the shared funnel taxonomy: outcome + one-way spec_hash,
  // never the wallet, claim URL, or any figure.
  router.use((req, res, next) => {
    if (req.method !== "POST" || (req.path !== PAYOUT_ROUTE && req.path !== PAYOUT_QUOTE_ROUTE)) return next();
    res.on("finish", () => {
      try {
        const norm = normalizePayoutRequest(req.body);
        recordFunnel(funnelDir, {
          ts: new Date().toISOString(),
          route: req.path,
          status: res.statusCode,
          outcome: funnelOutcome(req.path === PAYOUT_QUOTE_ROUTE ? "/quote" : "/witness", res.statusCode),
          ...(norm.ok ? { spec_hash: specHash(payoutMethod(norm.request)) } : {}),
        });
      } catch { /* funnel must never break the response path */ }
    });
    next();
  });

  router.post(PAYOUT_QUOTE_ROUTE, guard(async (req, res) => {
    if (!quoteAllowed(req.ip)) return reply(res, { status: 429, json: { reason: "quote_rate_limited" } });
    return reply(res, await handlePayoutQuote(req.body, wired));
  }));

  if (accepts.length && resourceServer && paymentMiddlewareWithBody) {
    const deliverable = guard(async (req, res, next) => {
      if (hasPaymentHeaders(req)) return next();
      const out = await handlePayoutQuote(req.body, wired);
      if (out.status === 200) return next();
      return reply(res, out);
    });
    const meta = { serviceName: "witness", tags: ["verification", "payout", "receipt", "x402"] };
    router.post(
      PAYOUT_ROUTE,
      deliverable,
      paymentMiddlewareWithBody({ [`POST ${PAYOUT_ROUTE}`]: { resource: resourceUrl, accepts, mimeType: "application/json", description: "Payout-claim verification against the TWZRD settlement corpus + signed receipt. $0.05 USDC.", ...meta } }, resourceServer),
      guard(async (req, res) => reply(res, await handlePayoutVerify(req.body, { ...wired, paid: true, accepts }))),
    );
    router.get(PAYOUT_ROUTE, (req, res, next) => {
      if (hasPaymentHeaders(req)) return res.status(405).json({ reason: "get_discovery_only_use_post" });
      next();
    }, paymentMiddlewareWithBody({ [`GET ${PAYOUT_ROUTE}`]: { resource: resourceUrl, accepts, mimeType: "application/json", description: "Discovery challenge — the paid deliverable is POST /verify/payout.", ...meta } }, resourceServer));
  } else {
    router.post(PAYOUT_ROUTE, guard(async (req, res) => reply(res, await handlePayoutVerify(req.body, { ...wired, paid: false, accepts }))));
  }
  return router;
}
