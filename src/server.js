import http from "node:http";
import { assertPublicHttps, SsrfError } from "./ssrf.js";
import { fillExtract } from "./extract.js";

export const PRICE_USDC = "0.01";

export async function handleQuote(body, { retrieve } = {}) {
  if (!body || typeof body !== "object") return { status: 400, json: { reason: "bad_json" } };
  const { url, extract, replicas } = body;
  if (!extract || typeof extract !== "object" || !Object.keys(extract).length)
    return { status: 400, json: { reason: "bad_extract" } };
  if (replicas !== undefined && replicas !== 1)
    return { status: 422, json: { reason: "replicas_unsupported" } };
  try {
    assertPublicHttps(url);
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

export function createApp(deps = {}) {
  return http.createServer(async (req, res) => {
    const json = (s, o) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (req.method !== "POST" || req.url !== "/quote") return json(404, { reason: "not_found" });
    let raw = "";
    for await (const c of req) raw += c;
    let body;
    try { body = JSON.parse(raw || "{}"); } catch { body = null; }
    const out = await handleQuote(body, deps);
    json(out.status, out.json);
  });
}
