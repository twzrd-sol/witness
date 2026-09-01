import express from "express";
import { assertPublicHttps, SsrfError } from "./ssrf.js";
import { fillExtract } from "./extract.js";
import { loadOrCreateKeystore } from "./keystore.js";
import { evalAssertion, pubkeyB64, signReceipt, sourceHash } from "./receipt.js";
import { appendObservation, compareReceipts, methodFromRequest, readObservations, specHash, VALID_FOR_MS } from "./observatory.js";
import { renderStarMap } from "./star-map.js";
import { funnelOutcome, funnelSpecHash, recordFunnel } from "./funnel.js";
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
  const funnelDir = deps.funnelDir === undefined ? wired.observationsDir : deps.funnelDir;
  app.use((req, res, next) => {
    if (req.method !== "POST" || (req.path !== "/quote" && req.path !== "/witness")) return next();
    res.on("finish", () => {
      try {
        const spec_hash = funnelSpecHash(req.body);
        recordFunnel(funnelDir, {
          ts: new Date().toISOString(),
          route: req.path,
          status: res.statusCode,
          outcome: funnelOutcome(req.path, res.statusCode),
          ...(spec_hash ? { spec_hash } : {}),
        });
      } catch { /* funnel must never break the response path */ }
    });
    next();
  });
  const reply = (res, out) => res.status(out.status).json(out.json);
  const witness = async (req, res) => reply(res, await handleWitness(req.body, { ...wired, paid: false }));
  const paidWitness = async (req, res) => reply(res, await handleWitness(req.body, { ...wired, paid: true }));
  app.get("/pubkey", (_req, res) => res.json({ pubkey: pubkeyB64(key) }));
  app.get("/observatory", (_req, res) => {
    const now = (wired.now ?? (() => new Date().toISOString()))();
    res.type("html").send(renderStarMap(compareReceipts(readObservations(wired.observationsDir), key.publicKey, now), now));
  });
  app.post("/quote", async (req, res) => reply(res, await handleQuote(req.body, wired)));
  const accepts = witnessAccepts(deps.paywall);
  if (accepts.length) {
    const bazaar = declareDiscoveryExtension({
      bodyType: "json",
      input: { url: "https://outbid.sh/top", extract: { rank: "number" }, assertion: "rank < 100", replicas: 1 },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          extract: { type: "object", minProperties: 1, additionalProperties: { type: "string" } },
          assertion: { type: "string" },
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
    const deliverable = async (req, res, next) => {
      if (req.headers["payment-signature"] || req.headers["x-payment"]) return next();
      const out = await handleQuote(req.body, wired);
      if (out.status === 200) return next();
      return reply(res, out);
    };
    const witnessMeta = { serviceName: "witness", tags: ["observation", "receipt", "x402", "empiricism"] };
    app.post("/witness", deliverable, paymentMiddleware({ "POST /witness": { resource: resourceUrl, accepts, mimeType: "application/json", description: "Independent fact + signed receipt. $0.01 USDC.", ...witnessMeta, extensions: bazaar } }, rs), paidWitness);
    // Crawlable discovery: GET answers the same 402 challenge with zero retrieve.
    app.get("/witness", (req, res, next) => {
      if (req.headers["payment-signature"] || req.headers["x-payment"]) {
        return res.status(405).json({ reason: "get_discovery_only_use_post" });
      }
      next();
    }, paymentMiddleware({ "GET /witness": { resource: resourceUrl, accepts, mimeType: "application/json", description: "Discovery challenge — the paid deliverable is POST /witness.", ...witnessMeta } }, rs));
  } else {
    app.post("/witness", witness);
  }
  app.use((err, _req, res, _next) => {
    console.error("witness:", err && (err.stack || err.message || err));
    res.status(500).json({ reason: "internal_error" });
  });
  return app;
}
