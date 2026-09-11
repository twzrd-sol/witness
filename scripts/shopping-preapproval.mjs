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
 *                in a separate offline process against an independently pinned
 *                --trusted-pubkey, expected method, freshness and supported verdict.
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
import { canonical, sourceHash, verifyReceipt } from "../src/receipt.js";
import childProcess from "node:child_process";
import { methodFromRequest } from "../src/observatory.js";

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

/** DRY simulation only; NOT a completion or live checkout predicate.
 *  Only a supported claim approves the simulated checkout;
 *  contradicted, incomplete, stale, and unable_to_verify are answers that block.
 *  Unknown/missing verdicts block (fail-closed), always. */
export function decideGate(receipt) {
  const verdict = receipt && typeof receipt === "object" ? receipt.verdict : undefined;
  if (verdict === "supported") return { approve: true, reason: "verdict_supported" };
  if (typeof verdict === "string" && verdict.length > 0) return { approve: false, reason: `verdict_${verdict}` };
  return { approve: false, reason: "verdict_missing" };
}

/** Verify a receipt against the b64 pubkey exactly as /pubkey serves it.
 *  Returns false on any malformed input — never throws. */
export function verifyAgainstPubkeyB64(receipt, pubkeyB64) {
  try {
    return verifyReceipt(receipt, createPublicKeyFromB64(pubkeyB64)) === true;
  } catch {
    return false;
  }
}

/** One run. mode: "dry" | "live". Returns a step record; never throws on remote failure. */
export async function runOnce({ base, mode, keypairPath, trustedPubkeyB64, paymentTransport = createPaymentTransport, log = () => {} }) {
  const run = { ts: new Date().toISOString(), mode, base, step: null, status: null,
    paid: false, payment_attempted: false, payment_status: "not_attempted", payer: null,
    completion: "incomplete", checkout_approved: false, check: { approve: false, reason: "not_run" } };
  if (mode === "live") {
    try {
      if (createPublicKeyFromB64(trustedPubkeyB64).asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    } catch {
      return { ...run, approve: false, decision: { approve: false, reason: "trusted_key_invalid" } };
    }
  }

  try {
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
  const { pay, payer } = await paymentTransport(keypairPath);
  run.payer = payer;
  run.payment_status = "unknown";
  run.payment_attempted = true;
  log(`witness POST as ${payer}`);
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

  // A fixed offline program, not actor narration, decides the live gate.
  let check = { approve: false, reason: "verifier_failed" };
  try {
    const child = childProcess.spawnSync(process.execPath, [path.join(ROOT, "scripts/verify-shopping-receipt.mjs")], {
      input: JSON.stringify({ receipt, trustedPubkeyB64, expectedMethod: methodFromRequest(GATE_METHOD) }),
      encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH },
    });
    const parsed = JSON.parse(child.stdout);
    if (!child.error && !child.signal && [0, 1].includes(child.status)
        && parsed.verifier_pid === child.pid && typeof parsed.approve === "boolean"
        && typeof parsed.reason === "string" && (child.status === 0) === parsed.approve
        && (!parsed.approve || (parsed.receipt_verified === true && parsed.reason === "receipt_supported"
          && parsed.receipt_hash === sourceHash(canonical(receipt))
          && parsed.trusted_key_hash === sourceHash(Buffer.from(trustedPubkeyB64, "base64"))
          && canonical(parsed.expected_method) === canonical(methodFromRequest(GATE_METHOD))
          && Number.isFinite(Date.parse(parsed.checked_at))))) check = parsed;
  } catch { /* Fail closed on launch, timeout, crash, or malformed output. */ }
  const gate = { approve: check.approve === true, reason: check.reason };
  return { ...run, receipt_verified: check.receipt_verified === true, check,
    completion: gate.approve ? "complete" : "incomplete", checkout_approved: gate.approve,
    decision: gate, approve: gate.approve };
  } catch {
    return { ...run, approve: false, decision: { approve: false, reason: "run_failed" } };
  }
}

async function createPaymentTransport(keypairPath) {
  const { wrapFetchWithPayment } = require("@x402/fetch");
  const { x402Client } = require("@x402/fetch");
  const { ExactSvmScheme } = require("@x402/svm/exact/client");
  const { createKeyPairSignerFromBytes } = require("@solana/kit");

  const raw = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8")));
  const signer = await createKeyPairSignerFromBytes(raw);


  const client = new x402Client().register(
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    new ExactSvmScheme(signer, { rpcUrl: "https://api.mainnet-beta.solana.com" })
  );
  const pay = wrapFetchWithPayment(globalThis.fetch, client);
  return { pay, payer: signer.address };
}

import { createPublicKey } from "node:crypto";
function createPublicKeyFromB64(b64) {
  if (typeof b64 !== "string" || !b64.length || Buffer.from(b64, "base64").toString("base64") !== b64) throw new Error("invalid public key encoding");
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

/** Append one ledger line. The payer identity (or its absence for dry runs) is the point. */
export function logRun({ base, mode, payer, step, status, decision, completion, checkout_approved, check, payment_status, payment_attempted }, { dataDir = DATA_DIR } = {}) {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(
    path.join(dataDir, "preapproval.ndjson"),
    `${JSON.stringify({ ts: new Date().toISOString(), mode, base, payer: payer ?? null, step, status, approve: decision.approve, reason: decision.reason, completion: completion ?? "incomplete", checkout_approved: checkout_approved === true, check: check ?? { approve: false, reason: "not_run" }, payment_status, payment_attempted })}\n`
  );
}

// CLI: --base=... --mode=dry|live --keypair=... --trusted-pubkey=<SPKI base64>
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const base = arg("base", "https://witness.outbid.sh");
  const mode = arg("mode", "dry");
  const keypairPath = arg("keypair", null);
  const trustedPubkeyB64 = arg("trusted-pubkey", null);
  if (mode === "live" && !keypairPath) {
    console.error("live mode requires --keypair=<path to solana keypair json>");
    process.exit(2);
  }
  const run = await runOnce({ base, mode, keypairPath, trustedPubkeyB64, log: (m) => console.error(m) });
  logRun(run);
  console.log(JSON.stringify(run, null, 2));
  process.exit(run.checkout_approved ? 0 : 1);
}
