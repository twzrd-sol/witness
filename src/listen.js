#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createApp, witnessAccepts } from "./server.js";
import { makeRetrieve } from "./retrieve.js";
import { openapiDoc } from "./openapi.js";
import { buildAgentCard, buildLlmsText, buildSkillText } from "./discovery.js";

const ROBOTS = `User-agent: *
Allow: /
Allow: /quote
Allow: /observatory
Allow: /pubkey
Allow: /llms.txt
Allow: /skill.md
Allow: /.well-known/
Disallow: /witness
`;

const LLMS = buildLlmsText();
const SKILL = buildSkillText();

export const READER_HOST = "reader.outbid.sh";
/** Scrape is $0.005. Bound before sign — the SDK default is $1. */
export const READER_MAX_AMOUNT_PER_PAYMENT = "$0.005";

/**
 * Paying fetch for reader.outbid.sh/scrape (Base x402, $0.005): only when
 * X402_READER_PAYMENTS_ENABLED=1 AND a valid wallet key is set. Anything
 * else returns {} — the reader stays on the unpaid path, which fails closed.
 * The wrapper is host-pinned and spend-capped so a 402 from anywhere else,
 * or above scrape price, cannot be signed.
 */
export function readerPayment(env, readerFetch) {
  if (env.X402_READER_PAYMENTS_ENABLED !== "1") return {};
  const key = env.X402_READER_WALLET_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error("witness: X402_READER_PAYMENTS_ENABLED=1 but X402_READER_WALLET_KEY missing/invalid — reader stays unpaid");
    return {};
  }
  const client = new x402Client()
    .register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(key)))
    .setSpendControls({ maxAmountPerPayment: READER_MAX_AMOUNT_PER_PAYMENT });
  const inner = wrapFetchWithPayment(readerFetch ?? globalThis.fetch, client);
  const payFetch = async (input, init) => {
    const raw = typeof input === "string" || input instanceof URL ? String(input) : input && input.url;
    let host;
    try { host = new URL(raw).hostname; } catch { throw new Error("reader_host_refused"); }
    if (host !== READER_HOST) throw new Error("reader_host_refused");
    return inner(input, init);
  };
  return { paymentsEnabled: true, payFetch, maxAmountPerPayment: READER_MAX_AMOUNT_PER_PAYMENT };
}

export function createHostApp(env = process.env, { readerFetch } = {}) {
  const base = env.PUBLIC_BASE_URL || "https://witness.outbid.sh";
  const paywall = { evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS };
  const app = createApp({ paywall, facilitatorUrl: env.FACILITATOR_URL, publicBaseUrl: base, observationsDir: env.OBSERVATIONS_DIR || "data", retrieve: makeRetrieve({ fetch: readerFetch, ...readerPayment(env, readerFetch) }) });
  app.get("/openapi.json", (_q, res) => res.json(openapiDoc(env)));
  const text = (res, body, type = "text/plain") => res.type(type).send(body);
  app.get("/robots.txt", (_q, res) => text(res, ROBOTS));
  app.get("/llms.txt", (_q, res) => text(res, LLMS, "text/markdown"));
  app.get("/skill.md", (_q, res) => text(res, SKILL, "text/markdown"));
  app.get("/.well-known/x402", (_q, res) => res.json({
    resource: `${base}/witness`, description: "Independent fact + signed receipt. $0.01 USDC.",
    x402Version: 2, price_usdc: "0.01", accepts: witnessAccepts(paywall).map((x) => ({ ...x, amount: "10000" })),
  }));
  app.get("/.well-known/agent.json", (_q, res) => res.json(buildAgentCard(base)));
  return app;
}

/** Process-level backstop in two phases. Until the server is listening every failure
 *  is fatal — log and exit 1 so systemd's Restart=on-failure retries in 3s (a swallowed
 *  EADDRINUSE drains the loop and exits 0, which systemd reads as a clean stop: the
 *  service stays down). Once listening, an unhandled rejection is logged and the process
 *  keeps serving — one stray promise from a bad request must not take the paid endpoint
 *  down. An uncaught exception exits 1 in both phases: Node guarantees nothing about the
 *  process after one, and every request path is already routed to the 500 handler, so
 *  whatever reaches here is outside any request; a 3s restart beats signing receipts
 *  from an unknown state. Installed only by the entrypoint below, so a stray rejection
 *  in tests still fails loudly. Returns the arming hook for the "listening" event. */
export function installCrashGuard(proc = process, log = console.error) {
  let listening = false;
  const report = (kind, fatal) => (e) => {
    log(`witness: ${kind}${fatal ? " — exiting 1 for systemd to restart" : ""}`, e && (e.stack || e.message || e));
    if (fatal) proc.exit(1);
  };
  proc.on("unhandledRejection", (e) => report("unhandled rejection", !listening)(e));
  proc.on("uncaughtException", report("uncaught exception", true));
  return { listening: () => { listening = true; } };
}

export function start(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 4032);
  const server = createHostApp(env).listen(port, host, () => console.log(`witness listening on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const guard = installCrashGuard();
  start().once("listening", guard.listening);
}
