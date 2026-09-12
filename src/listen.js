#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createApp, witnessAccepts } from "./server.js";
import { makeRetrieve } from "./retrieve.js";
import { makeFetchIntel } from "./intel-evidence.js";
import { openapiDoc } from "./openapi.js";

const METHOD_DOC = JSON.stringify({
  url: "https://outbid.sh/top",
  retrieval: "scrape",
  extract: { rank: "number" },
  assertion: "rank < 100",
}, null, 2);

const ROBOTS = `User-agent: *
Allow: /
Allow: /quote
Allow: /observatory
Allow: /pubkey
Allow: /llms.txt
Allow: /skill.md
Allow: /.well-known/
Allow: /verify/payout/quote
Disallow: /witness
Disallow: /verify/payout
`;

const PRICE = `{"url":"https://api.coinbase.com/v2/prices/BTC-USD/spot","extract":{"amount":"number"},"assertion":"amount < 1000000","replicas":1}`;
const STOCK = `{"url":"https://dummyjson.com/products/1","extract":{"stock":"number"},"assertion":"stock < 100000","replicas":1}`;
const RELEASE = `{"url":"https://pypi.org/pypi/requests/json","extract":{"version":"string"},"replicas":1}`;
const CLAIM = `{"url":"https://jsonplaceholder.typicode.com/todos/1","extract":{"userId":"number"},"assertion":"userId < 100","replicas":1}`;
const PAYOUT = `{"claim_url":"https://deskcrew.io/api/arena/contests","claim":{"payout_count":"decidedCount","unique_wallets":"uniqueWallets","paid_usd":"sentUsd"},"wallet":"0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8","network":"base","direction":"inbound"}`;

const LLMS = `# witness

> Confirm a published price, a stock number, a release, a ranking, or that a public record is present — and get a signed, time-bounded receipt. $0.01 USDC over x402.

- POST /quote — free deliverability probe. 200 = the observation can be performed now, and the body announces the verdict you will be issued; 422 = not. Nothing is billed either way.
- POST /witness — same body + x402 payment. Signed receipt: value, assertion, verdict, observed_at, source_hash, evidence, agreement, method, spec_hash, valid_until, vantage.
- POST /delivery/attest — after a paid call to any x402 seller, submit {offer, request, observation} and get a signed delivery receipt (delivered | contradicted | incomplete | unable_to_verify) bound to offer_hash, request_hash, artifact_hash. $0.01 USDC over x402; shape and limits at GET /openapi.json.

Verdicts. A 200 quote carries the verdict the receipt will be signed with, so you always know the answer before paying, and the price is the same for all of them:
- supported — every field was found and the claim holds.
- contradicted — every field was found and the claim does not hold. This is an answer, not an error: the source does not say what you were told.
- incomplete — a field the claim needs was requested and the source did not carry it.
A claim we cannot read is never priced: a malformed assertion, or one naming a field your extract did not request, is a free 422 (assertion_malformed, assertion_field_not_extracted). So is any failure on our side (retrieve_failed, retrieve_empty, bad_json, bad_extract, bad_assertion), and so is a document where none of your requested fields resolved (extract_none): we cannot tell a page that lacks them from one we failed to read, so you are not charged for it. incomplete is therefore only sold when some other requested field did resolve, proving we read the page. Omit assertion for a bare extract and the receipt carries no verdict at all.
- GET /pubkey — ed25519 key (receipts are signed over deep canonical JSON, 1h validity).
- GET /observatory — verified receipts; contradictions and expiry are visible.
- GET /.well-known/x402 — payment descriptor for POST /witness.
- GET /openapi.json — OpenAPI 3.1 for POST /quote, POST /witness, POST /delivery/attest, and POST /verify/payout.

Quote first. A 200 quote is worth paying whatever verdict it announces — contradicted and incomplete are answers you asked for.
- Change Proof: hold a prior receipt? POST /quote again with prior_receipt = that 200 body; the quote answers changed (true/false), previous_source_hash, and source_hash before you pay. Pay POST /witness with the same body for a signed delta receipt.

Assertion grammar: "<key> <op> <literal>" — numeric ==, <, <=, >, >=; string == with quoted literals; "<key> exists". Omit assertion for a bare extract.

Default method — public ranking on https://outbid.sh/top:

\`\`\`json
${METHOD_DOC}
\`\`\`

Candidate methods (quote is free — a 200 announces the verdict and means pay; a 422 means we could not check, and skip):

Published price (BTC-USD spot):

\`\`\`json
${PRICE}
\`\`\`

Product availability (stock on a public catalog item):

\`\`\`json
${STOCK}
\`\`\`

Current published version (PyPI requests):

\`\`\`json
${RELEASE}
\`\`\`

Public record present (JSONPlaceholder todo #1):

\`\`\`json
${CLAIM}
\`\`\`

## Payout-claim verification ($0.05)

Does a public payout or revenue figure match what TWZRD's x402 settlement corpus observed for a wallet?

- POST /verify/payout/quote — free. 200 announces the verdict: supported, discrepant, coverage_limited, or incomplete. 422 = not deliverable, nothing billed.
- POST /verify/payout — same body + x402 ($0.05 USDC). Signed receipt naming the claim page hash, the intel responses (URL + sha256), every finding, and the coverage scope.

\`\`\`json
${PAYOUT}
\`\`\`

\`claim\` maps each figure to the page's own key. \`direction\` inbound reads the wallet as a seller (settlements received, distinct counterparties, USDC received); outbound reads it as an x402 payer and can only confirm a floor — plain transfers are invisible to the corpus, so a shortfall there is coverage_limited, never discrepant. The corpus is an observed subset of x402 settlements, not a universe claim.

Docs: /skill.md
`;

const SKILL = `# witness — paid observation skill

Pay $0.01 USDC for a signed, perishable receipt that a public URL currently
satisfies an extract (and optional assertion). Agents buy the receipt, not HTML.

1. \`POST /quote\` with one of the methods in \`GET /llms.txt\` — free.
   200 \`{"can_deliver": true, "verdict": "supported|contradicted|incomplete"}\`
   means pay, and names the verdict you will be issued. 422 means we could not
   check — nothing is billed for it, ever.
2. \`POST /witness\` same body + x402 (Base or Solana). Receipt fields:
   value, assertion, verdict, observed_at, source_hash, evidence, agreement, method,
   spec_hash, valid_until (1h), vantage.
Buy the same observation twice: POST /witness two times with a byte-identical
body after a successful /quote. Two $0.01 settlements, two receipts, one
spec_hash. Do not change url, extract, assertion, or replicas between pays.
Do not attach prior_receipt on the first pair. A one-pay Change Proof delta
is not two settlements. If /quote already returned 200, do not quote again.
Do not POST empty. Send url, extract, assertion, replicas:1.
Change Proof: already holding a receipt? Ask has this page changed since that
observation: POST /quote again with prior_receipt set to the previous 200
receipt body. The quote returns changed, previous_source_hash, and this
retrieve's source_hash before any payment. Pay POST /witness with the same
body only if you want the signed delta receipt (changed + previous_source_hash
are bound inside the signature).

Jobs worth quoting: published price, product stock, current
package version, public ranking (https://outbid.sh/top), public record present.

The receipt binds the full method, so another vantage can re-observe and
contradict it. \`GET /observatory\` renders every verified receipt.

Assertion grammar: \`"<key> <op> <literal>"\` — numeric ==, <, <=, >, >=; string == with quoted literals; \`"<key> exists"\`.

Payout-claim verification ($0.05): \`POST /verify/payout/quote\` (free) then
\`POST /verify/payout\` with the same body. Body: claim_url, claim (figure ->
page key), wallet, network (solana|base), direction (inbound|outbound). The
receipt states supported / discrepant / coverage_limited / incomplete against
TWZRD's observed x402 settlement corpus, with the evidence hashes it was built
from. coverage_limited is an answer about the corpus, not a contradiction.

Key: GET /pubkey · Payment: GET /.well-known/x402 · Methods: GET /llms.txt
`;

/**
 * Paying fetch for reader.outbid.sh/scrape (Base x402, $0.005): only when
 * X402_READER_PAYMENTS_ENABLED=1 AND a valid wallet key is set. Anything
 * else returns {} — the reader stays on the unpaid path, which fails closed.
 */
export function readerPayment(env, readerFetch) {
  if (env.X402_READER_PAYMENTS_ENABLED !== "1") return {};
  const key = env.X402_READER_WALLET_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error("witness: X402_READER_PAYMENTS_ENABLED=1 but X402_READER_WALLET_KEY missing/invalid — reader stays unpaid");
    return {};
  }
  const client = new x402Client().register("eip155:8453", new ExactEvmScheme(privateKeyToAccount(key)));
  return { paymentsEnabled: true, payFetch: wrapFetchWithPayment(readerFetch ?? globalThis.fetch, client) };
}

export function createHostApp(env = process.env, { readerFetch, probeFetch, gateTtlMs, attest, importModel, intelFetch } = {}) {
  const base = env.PUBLIC_BASE_URL || "https://witness.outbid.sh";
  const paywall = { evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS };
  const app = createApp({ paywall, facilitatorUrl: env.FACILITATOR_URL, publicBaseUrl: base, observationsDir: env.OBSERVATIONS_DIR || "data", retrieve: makeRetrieve({ fetch: readerFetch, ...readerPayment(env, readerFetch) }), probeFetch, gateTtlMs, quoteRateLimit: env.QUOTE_RATE_LIMIT_PER_MINUTE, quoteGlobalRateLimit: env.QUOTE_RATE_LIMIT_GLOBAL_PER_MINUTE, attestRateLimit: env.ATTEST_RATE_LIMIT_PER_MINUTE, attest, importModel, fetchIntel: makeFetchIntel({ fetch: intelFetch }) });
  app.get("/openapi.json", (_q, res) => res.json(openapiDoc(env)));
  const text = (res, body, type = "text/plain") => res.type(type).send(body);
  app.get("/robots.txt", (_q, res) => text(res, ROBOTS));
  app.get("/llms.txt", (_q, res) => text(res, LLMS, "text/markdown"));
  app.get("/skill.md", (_q, res) => text(res, SKILL, "text/markdown"));
  app.get("/.well-known/x402", (_q, res) => res.json({
    resource: `${base}/witness`, description: "Independent fact + signed receipt. $0.01 USDC.",
    x402Version: 2, price_usdc: "0.01", accepts: witnessAccepts(paywall).map((x) => ({ ...x, amount: "10000" })),
  }));
  const card = {
    name: "witness", url: base, version: "0.1.0",
    description: "Paid, attributable, perishable observation of public web facts over x402.",
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      { id: "observe", name: "Observe", description: "POST /quote once, then POST /witness twice with the same body; $0.02 USDC; two signed receipts.", tags: ["observation", "x402", "receipt"] },
      { id: "verify-payout", name: "Verify payout claim", description: "POST /verify/payout/quote (free), then POST /verify/payout with the same body; $0.05 USDC; signed receipt holding a public payout figure against TWZRD's x402 settlement corpus.", tags: ["verification", "x402", "receipt"] },
    ],
  };
  app.get("/.well-known/agent.json", (_q, res) => res.json(card));
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

/** Bind `app` after the error handler is armed. Express 5's `app.listen(cb)`
 *  registers `cb` as an 'error' listener, so EADDRINUSE invokes the "listening"
 *  callback, swallows the error, and (if nothing else is on the loop) exits 0 —
 *  systemd Restart=on-failure reads a clean stop. `exclusive` so a taken port
 *  cannot be shared. Tests pass `onError` that rejects; the default exits 1. */
export function listenExclusive(app, { host = "127.0.0.1", port = 0, exclusive = true } = {}, { onListening, onError } = {}) {
  const server = createHttpServer(app);
  server.on("error", onError ?? ((e) => {
    console.error("witness: listen error — exiting 1 for systemd to restart", e && (e.stack || e.message || e));
    process.exit(1);
  }));
  server.listen({ host, port, exclusive }, onListening);
  return server;
}

export function start(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 4032);
  return listenExclusive(createHostApp(env), { host, port }, {
    onListening: () => console.log(`witness listening on http://${host}:${port}`),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const guard = installCrashGuard();
  start().once("listening", guard.listening);
}
