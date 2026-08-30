#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createApp, witnessAccepts } from "./server.js";
import { makeRetrieve } from "./retrieve.js";

const METHOD_DOC = JSON.stringify({
  url: "https://outbid.sh/top",
  retrieval: "scrape",
  extract: { rank: "number", url: "string", bid_usdc: "number" },
  assertion: "rank == 1",
}, null, 2);

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

const LLMS = `# witness

> Paid, attributable, perishable observation of public web facts. $0.01 USDC per observation over x402.

- POST /quote — free deliverability probe. 200 = the experiment can be performed; 422 = not.
- POST /witness — same body + x402 payment. Returns a signed receipt: value, assertion, observed_at, source_hash, evidence, agreement, method, spec_hash, valid_until, vantage.
- GET /pubkey — the ed25519 signing key (receipts are signed over deep canonical JSON, 1h validity).
- GET /observatory — every verified receipt, rendered; contradictions and expiry are visible.
- GET /.well-known/x402 — payment descriptor for POST /witness.

Default documented method — observe https://outbid.sh/top:

\`\`\`json
${METHOD_DOC}
\`\`\`

Docs: /skill.md
`;

const SKILL = `# witness — paid observation skill

Observe a public web fact; receive a signed, verifiable, perishable receipt.

1. \`POST /quote\` \`{"url": ..., "extract": {...}}\` — free deliverability probe.
   200 \`{"can_deliver": true}\` means the observation can be performed now; 422 means it cannot.
2. \`POST /witness\` same body with an x402 payment — $0.01 USDC (Base or Solana).
   The response is a receipt signed ed25519 over deep canonical JSON, carrying:
   value, assertion, observed_at, source_hash, evidence, agreement, method,
   spec_hash, valid_until (1h), vantage.

The receipt binds the full method (url, retrieval, extract, assertion), so a second
vantage can re-observe the same canonical observation and contradict it; \`GET /observatory\`
renders every verified receipt logged by this host, with contradictions and expiry visible.

Default documented method — observe https://outbid.sh/top (full method JSON: GET /llms.txt).

Key: GET /pubkey · Payment descriptor: GET /.well-known/x402
`;

export function createHostApp(env = process.env, { readerFetch } = {}) {
  const base = env.PUBLIC_BASE_URL || "https://witness.outbid.sh";
  const paywall = { evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS };
  const app = createApp({ paywall, facilitatorUrl: env.FACILITATOR_URL, observationsDir: env.OBSERVATIONS_DIR || "data", retrieve: makeRetrieve({ fetch: readerFetch }) });
  const text = (res, body, type = "text/plain") => res.type(type).send(body);
  app.get("/robots.txt", (_q, res) => text(res, ROBOTS));
  app.get("/llms.txt", (_q, res) => text(res, LLMS, "text/markdown"));
  app.get("/skill.md", (_q, res) => text(res, SKILL, "text/markdown"));
  app.get("/.well-known/x402", (_q, res) => res.json({
    resource: "POST /witness", description: "Independent fact + signed receipt. $0.01 USDC.",
    x402Version: 2, price_usdc: "0.01", accepts: witnessAccepts(paywall),
  }));
  const card = {
    name: "witness", url: base, version: "0.1.0",
    description: "Paid, attributable, perishable observation of public web facts over x402.",
    capabilities: { streaming: false, pushNotifications: false },
    skills: [{ id: "observe", name: "Observe", description: "POST /quote then POST /witness; $0.01 USDC; signed receipt.", tags: ["observation", "x402", "receipt"] }],
  };
  app.get("/.well-known/agent.json", (_q, res) => res.json(card));
  return app;
}

export function start(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 4032);
  const server = createHostApp(env).listen(port, host, () => console.log(`witness listening on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
