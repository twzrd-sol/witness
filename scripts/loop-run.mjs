#!/usr/bin/env node
/**
 * ACTOR for the agent-rail loop. It does the work and writes evidence. It never
 * decides whether the work is done: that is scripts/loop-check.mjs, a separate
 * process that did not write any of this and recomputes everything from the raw
 * files. This script prints one line, the directory it wrote, and nothing that
 * reads as a verdict.
 *
 *   node scripts/loop-run.mjs --offer=outbid-reader-scrape --url=https://example.com \
 *        --keypair=~/.witness-payer/solana-keypair.json --out=data/loop-runs/<id>
 *
 * Steps, each leaving a file even when it fails so the checker can say where it stopped:
 *   1. quote.json      POST /api/quotes — the gate. A withheld gate stops here.
 *   2. request.json    the exact paid call: method, url, body, requested_at
 *   3. response.json   status, headers, body text AS RECEIVED (the checker hashes it)
 *   4. settlement.json the decoded payment-response header (tx signature, network, payer)
 *   5. offer.json      the delivery offer sent to attest, built from the quote + catalog
 *   6. receipt.json    the bare receipt POST /delivery/attest returned
 *
 * One payment, no retries. The wallet is loaded only after the gate passed.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const arg = (name, dflt = undefined) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const expand = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

const base = (arg("base", process.env.WITNESS_BASE || "https://witness.outbid.sh")).replace(/\/$/, "");
const offerId = arg("offer");
const inputUrl = arg("url");
const keypairPath = expand(arg("keypair"));
const out = arg("out", path.join("data", "loop-runs", new Date().toISOString().replace(/[:.]/g, "-")));
const rpcUrl = arg("rpc", "https://api.mainnet-beta.solana.com");

if (!offerId || !inputUrl || !keypairPath) {
  console.error("usage: loop-run --offer=<id> --url=<public url> --keypair=<path> [--out=<dir>] [--base=<witness>]");
  process.exit(2);
}

mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
const now = () => new Date().toISOString();

async function main() {
  // 1. Gate. Whatever it says is recorded; only a passed gate proceeds to spend.
  const quoteRes = await fetch(`${base}/api/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer_id: offerId, input: { url: inputUrl } }),
  });
  const quote = await quoteRes.json().catch(() => null);
  write("quote.json", { status: quoteRes.status, body: quote, at: now() });
  if (quoteRes.status !== 200 || quote?.gate?.status !== "passed") return;

  const catalogRes = await fetch(`${base}/api/offers/${encodeURIComponent(offerId)}`);
  const catalog = await catalogRes.json().catch(() => null);
  write("catalog.json", { status: catalogRes.status, body: catalog, at: now() });
  if (catalogRes.status !== 200 || !catalog?.delivery) return;

  // 2. The paid call, exactly as sent.
  const request = { method: quote.request.method, url: quote.request.url, body: null, requested_at: now() };
  write("request.json", request);

  // Wallet only now. One payment; the client library handles the 402 round trip.
  const { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } = require("@x402/fetch");
  const { ExactSvmScheme } = require("@x402/svm/exact/client");
  const { createKeyPairSignerFromBytes } = require("@solana/kit");
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  const client = new x402Client().register("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", new ExactSvmScheme(signer, { rpcUrl }));
  const pay = wrapFetchWithPayment(globalThis.fetch, client);

  // 3. Response as received.
  const res = await pay(request.url, { method: request.method, signal: AbortSignal.timeout(60000) });
  const headers = Object.fromEntries(res.headers.entries());
  const text = await res.text();
  write("response.json", { status: res.status, headers, body_text: text, received_at: now() });

  // 4. Settlement, decoded from the header the seller/facilitator returned.
  const prHeader = headers["payment-response"] ?? headers["x-payment-response"] ?? null;
  let settlement = null;
  if (prHeader) {
    try { settlement = decodePaymentResponseHeader(prHeader); } catch { settlement = null; }
  }
  write("settlement.json", { header_present: Boolean(prHeader), decoded: settlement, payer: signer.address });

  // 5 + 6. Attest what came back, buyer_attested unless the seller signed.
  let artifact = null;
  try { artifact = JSON.parse(text); } catch { artifact = null; }
  let sellerSignature = null;
  if (headers["x-delivery-signature"]) {
    try { sellerSignature = JSON.parse(headers["x-delivery-signature"]); } catch { sellerSignature = null; }
  }
  const offer = {
    resource_url: request.url,
    deliverable_class: catalog.delivery.deliverable_class,
    price_usdc: Number(catalog.price.usd),
    spec: catalog.delivery.spec,
    spec_origin: catalog.delivery.spec_origin,
  };
  write("offer.json", offer);
  const attestBody = {
    offer,
    request: { request_body: { url: inputUrl }, settlement_ref: settlement?.transaction ?? null, requested_at: request.requested_at },
    observation: {
      artifact,
      observed_at: now(),
      mode: sellerSignature ? "seller_integrated" : "buyer_attested",
      http_status: res.status,
      seller_signature: sellerSignature,
      notes: [],
    },
  };
  write("attest-request.json", attestBody);
  const attestRes = await fetch(`${base}/delivery/attest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(attestBody),
  });
  const receipt = await attestRes.json().catch(() => null);
  write("receipt.json", { status: attestRes.status, body: receipt, at: now() });
}

main()
  .catch((e) => write("error.json", { message: String(e?.message ?? e), at: now() }))
  .finally(() => console.log(out));
