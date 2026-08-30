import http from "node:http";
import { assertPublicHttps, SsrfError } from "./ssrf.js";
import { fillExtract } from "./extract.js";
import { loadOrCreateKeystore } from "./keystore.js";
import {
  evalAssertion,
  pubkeyB64,
  signReceipt,
  sourceHash,
} from "./receipt.js";

export const PRICE_USDC = "0.01";
const AMOUNT_ATOMIC = "10000"; // 0.01 USDC, 6 decimals

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
  return { status: 200, json: { price_usdc: PRICE_USDC, replicas: replicas || 1, can_deliver: true } };
}

/** Unpaid → 402 only if quote would 200. Paid (deps.paid) → retrieve again, sign. */
export async function handleWitness(body, deps = {}) {
  const q = await handleQuote(body, deps);
  if (q.status !== 200) return q;
  if (!deps.paid) {
    return {
      status: 402,
      json: {
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
          maxAmountRequired: AMOUNT_ATOMIC,
          extra: { price_usdc: PRICE_USDC },
        }],
      },
    };
  }
  let text;
  try {
    const res = await deps.retrieve(body.url);
    text = typeof res === "string" ? res : res && res.text;
  } catch {
    return { status: 422, json: { reason: "retrieve_failed" } };
  }
  if (!text) return { status: 422, json: { reason: "retrieve_empty" } };
  const { values, missing } = fillExtract(text, body.extract);
  if (missing.length) return { status: 422, json: { reason: "extract_missing", missing } };
  if (!evalAssertion(values, body.assertion)) {
    return { status: 422, json: { reason: "assertion_failed" } };
  }
  const rest = {
    value: values,
    assertion: body.assertion ?? null,
    observed_at: (deps.now ?? (() => new Date().toISOString()))(),
    source_hash: sourceHash(text),
    evidence: text.slice(0, 160),
    agreement: "1-of-1",
  };
  return { status: 200, json: signReceipt(rest, processKey(deps)) };
}

export function createApp(deps = {}) {
  const key = processKey(deps);
  const wired = { ...deps, key };
  return http.createServer(async (req, res) => {
    const json = (s, o) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method === "GET" && req.url === "/pubkey") {
      return json(200, { pubkey: pubkeyB64(key) });
    }
    if (req.method !== "POST" || (req.url !== "/quote" && req.url !== "/witness")) {
      return json(404, { reason: "not_found" });
    }
    let raw = "";
    for await (const c of req) raw += c;
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { body = null; }
    const out = req.url === "/witness"
      ? await handleWitness(body, wired)
      : await handleQuote(body, wired);
    json(out.status, out.json);
  });
}
