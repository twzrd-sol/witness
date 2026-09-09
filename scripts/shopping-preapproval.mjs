#!/usr/bin/env node
/** Shopping-preapproval experiment harness (DISTRIBUTION-PLAN.json: shopping-preapproval).
 *
 * Runs the design-partner card method against a witness endpoint, in two modes:
 *   --mode=dry   POST /quote only. Free. Proves deliverability + announced verdict
 *                and gates the simulated checkout on it. Never signs a payload,
 *                never loads a keypair. This is the shape every external agent
 *                can copy with a plain HTTP client and zero wallet.
 *   --mode=live  Quote first; only a 200 deliverable quote proceeds to one paid
 *                POST /witness through @x402/fetch with the SVM keypair named by
 *                --keypair (the wallet pays; the facilitator's feePayer posts).
 *                The receipt gates checkout ONLY if its signature verifies
 *                against GET /pubkey. Any other outcome is an abort.
 *
 * Every run appends one line to data/preapproval.ndjson with the payer identity,
 * so operator runs are always distinguishable from external demand.
 *
 * No retries, no loops, no self-payment beyond the single settlement a run asks
 * for. The ledger — not this file — is the demand record.
 */
import { createRequire } from "node:module";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");

/** The exact design-partner card method. Tests pin this byte-for-byte. */
export const GATE_METHOD = Object.freeze({
  url: "https://dummyjson.com/products/1",
  retrieval: "scrape",
  extract: Object.freeze({ price: "number" }),
  assertion: "price < 100",
  replicas: 1,
});

/** Downstream decision rule. Only a supported claim approves the checkout;
 *  contradicted, incomplete, stale, and unable_to_verify are answers that block.
 *  Unknown/missing verdicts block (fail-closed), always. */
export function decideGate(receipt) {
  const verdict = receipt && typeof receipt === "object" ? receipt.verdict : undefined;
  if (verdict === "supported") return { approve: true, reason: "verdict_supported" };
  if (typeof verdict === "string" && verdict.length > 0) return { approve: false, reason: `verdict_${verdict}` };
  return { approve: false, reason: "verdict_missing" };
}

/** One run. mode: "dry" | "live". Returns a step record; never throws on remote failure. */
export async function runOnce({ base, mode, keypairPath, log = () => {} }) {
  const run = { ts: new Date().toISOString(), mode, base, step: null, status: null, paid: false, payer: null };

  // Step 1: free quote. Both modes stop here unless the quote is deliverable.
  const quoteRes = await fetch(`${base}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(GATE_METHOD),
  });
  run.step = "quote";
  run.status = quoteRes.status;
  const quote = await quoteRes.json().catch(() => ({}));
  run.body = quote;
  log(`quote ${quoteRes.status} can_deliver=${quote.can_deliver} verdict=${quote.verdict}`);

  const gateOnQuote = decideGate(quoteRes.status === 200 ? quote : null);
  if (mode === "dry") return { ...run, decision: gateOnQuote, approve: gateOnQuote.approve };

  if (mode !== "live") throw new Error(`unknown mode ${mode}`);
  if (quoteRes.status !== 200 || quote.can_deliver !== true) {
    return { ...run, decision: { approve: false, reason: "quote_not_deliverable" }, approve: false };
  }

  // Step 2: one paid POST /witness. The wallet is loaded only after a deliverable quote.
  const { wrapFetchWithPayment } = require("@x402/fetch");
  const { x402Client } = require("@x402/fetch");
  const { ExactSvmScheme } = require("@x402/svm/exact/client");
  const { createKeyPairSignerFromBytes } = require("@solana/kit");

  const raw = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")));
  const signer = await createKeyPairSignerFromBytes(raw);
  run.payer = signer.address;
  run.paid = true;

  const client = new x402Client().register(
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    new ExactSvmScheme(signer, { rpcUrl: "https://api.mainnet-beta.solana.com" })
  );
  const pay = wrapFetchWithPayment(globalThis.fetch, client);
  log(`witness POST as ${signer.address}`);
  const witRes = await pay(`${base}/witness`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(GATE_METHOD),
  });
  run.step = "witness";
  run.status = witRes.status;
  const receipt = await witRes.json().catch(() => ({}));
  run.body = receipt;

  if (witRes.status !== 200) {
    return { ...run, decision: { approve: false, reason: `witness_http_${witRes.status}` }, approve: false };
  }

  // Step 3: the checkout gates only on a signature-verifiable receipt.
  const pubRes = await fetch(`${base}/pubkey`);
  const { publicKeyFromB64 } = require("../src/receipt.js");
  const verifyReceipt = (doc, key) => {
    try {
      return publicKeyFromB64 !== undefined && require("../src/receipt.js").verifyReceipt(doc, key);
    } catch {
      return false;
    }
  };
  let pub;
  try {
    pub = createPublicKeyFromB64((await pubRes.json()).publicKey);
  } catch {
    return { ...run, decision: { approve: false, reason: "pubkey_unreadable" }, approve: false };
  }
  const verified = verifyReceipt(receipt, pub);
  const gate = verified ? decideGate(receipt) : { approve: false, reason: "signature_invalid" };
  return { ...run, receipt_verified: verified, decision: gate, approve: gate.approve };
}

import { createPublicKey } from "node:crypto";
function createPublicKeyFromB64(b64) {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

/** Append one ledger line. The payer identity (or its absence for dry runs) is the point. */
export function logRun({ base, mode, payer, step, status, decision }) {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(
    path.join(DATA_DIR, "preapproval.ndjson"),
    `${JSON.stringify({ ts: new Date().toISOString(), mode, base, payer: payer ?? null, step, status, approve: decision.approve, reason: decision.reason })}\n`
  );
}

// CLI: --base=... --mode=dry|live --keypair=... (required for live)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const base = arg("base", "https://witness.outbid.sh");
  const mode = arg("mode", "dry");
  const keypairPath = arg("keypair", null);
  if (mode === "live" && !keypairPath) {
    console.error("live mode requires --keypair=<path to solana keypair json>");
    process.exit(2);
  }
  const run = await runOnce({ base, mode, keypairPath, log: (m) => console.error(m) });
  logRun({ base, mode, payer: run.payer, step: run.step, status: run.status, decision: run.decision });
  console.log(JSON.stringify(run, null, 2));
  process.exit(run.approve ? 0 : 1);
}
