import express from "express";
import { assertPublicHttps, SsrfError } from "./ssrf.js";
import { fillExtract } from "./extract.js";
import { loadOrCreateKeystore } from "./keystore.js";
import { evalAssertion, pubkeyB64, signReceipt, sourceHash } from "./receipt.js";
import { appendObservation, compareReceipts, methodFromRequest, readObservations, specHash, VALID_FOR_MS } from "./observatory.js";
import { renderStarMap } from "./star-map.js";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";

export const PRICE_USDC = "0.01";
const AMOUNT_ATOMIC = "10000"; // 0.01 USDC, 6 decimals
const EVM_NET = "eip155:8453";
const SVM_NET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SVM_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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

export async function handleQuote(body, { retrieve } = {}) {
  if (!body || typeof body !== "object") return { status: 400, json: { reason: "bad_json" } };
  const { url, extract, replicas } = body;
  if (!extract || typeof extract !== "object" || !Object.keys(extract).length)
    return { status: 400, json: { reason: "bad_extract" } };
  if (replicas !== undefined && replicas !== 1)
    return { status: 422, json: { reason: "replicas_unsupported" } };
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
  const { missing } = fillExtract(text, extract);
  if (missing.length) return { status: 422, json: { reason: "extract_missing", missing } };
  return { status: 200, json: { price_usdc: PRICE_USDC, replicas: replicas || 1, can_deliver: true }, text };
}

/** Unpaid without paywall → inline 402. Payment settled upstream (or deps.paid) → sign. */
export async function handleWitness(body, deps = {}) {
  const q = await handleQuote(body, deps);
  if (q.status !== 200) return q;
  if (!deps.paid && !deps.payment) {
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
  const { values, missing } = fillExtract(text, body.extract);
  if (missing.length) return { status: 422, json: { reason: "extract_missing", missing } };
  if (!evalAssertion(values, body.assertion)) {
    return { status: 422, json: { reason: "assertion_failed" } };
  }
  const observed_at = (deps.now ?? (() => new Date().toISOString()))();
  const method = methodFromRequest(body, deps.retrieval ?? "scrape");
  const rest = {
    value: values,
    assertion: body.assertion ?? null,
    observed_at,
    source_hash: sourceHash(text),
    evidence: text.slice(0, 160),
    agreement: "1-of-1",
    method,
    spec_hash: specHash(method),
    valid_until: new Date(Date.parse(observed_at) + VALID_FOR_MS).toISOString(),
    vantage: deps.vantage ?? "box",
  };
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
  app.use(express.json({ limit: "64kb" }));
  const reply = (res, out) => res.status(out.status).json(out.json);
  const witness = async (req, res) =>
    reply(res, await handleWitness(req.body, { ...wired, payment: req.headers["payment-signature"] || req.headers["x-payment"] }));
  app.get("/pubkey", (_req, res) => res.json({ pubkey: pubkeyB64(key) }));
  app.get("/observatory", (_req, res) => {
    const now = (wired.now ?? (() => new Date().toISOString()))();
    res.type("html").send(renderStarMap(compareReceipts(readObservations(wired.observationsDir), key.publicKey, now), now));
  });
  app.post("/quote", async (req, res) => reply(res, await handleQuote(req.body, wired)));
  const accepts = witnessAccepts(deps.paywall);
  if (accepts.length) {
    const facilitator = deps.facilitator ?? new HTTPFacilitatorClient({ url: deps.facilitatorUrl || "https://facilitator.payai.network" });
    const rs = new x402ResourceServer(facilitator);
    if (deps.paywall.evmAddress) rs.register(EVM_NET, new ExactEvmScheme());
    if (deps.paywall.svmAddress) rs.register(SVM_NET, new ExactSvmScheme());
    // Deliverability-first: an unpaid probe runs the quote; only a deliverable
    // request reaches the paywall. A 422 never sees a 402, matching the reader.
    const deliverable = async (req, res, next) => {
      if (req.headers["payment-signature"] || req.headers["x-payment"]) return next();
      const out = await handleQuote(req.body, wired);
      if (out.status === 200) return next();
      return reply(res, out);
    };
    app.post("/witness", deliverable, paymentMiddleware({ "POST /witness": { resource: resourceUrl, accepts, mimeType: "application/json", description: "Independent fact + signed receipt. $0.01 USDC." } }, rs), witness);
  } else {
    app.post("/witness", witness);
  }
  app.use((err, _req, res, _next) => {
    console.error("witness:", err && (err.stack || err.message || err));
    res.status(500).json({ reason: "internal_error" });
  });
  return app;
}
