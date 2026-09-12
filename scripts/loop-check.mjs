#!/usr/bin/env node
/**
 * VERIFIER for the agent-rail loop: the Done predicate for one run directory
 * written by scripts/loop-run.mjs. This file shares no code path with the actor.
 * Every hash is recomputed here from the raw files; the receipt's signature is
 * checked against a pubkey fetched fresh from the host (or one pinned with
 * --pubkey); the settlement is read from the chain, not from the actor's notes.
 *
 * INCOMPLETE is the default. A run is DONE only when every predicate holds:
 *
 *   gate_passed          quote.json is 200 with gate.status "passed" and a non-empty accepts[]
 *   request_matches      request.json's url/method equal what the quote said to call
 *   paid_call_ok         response.json status 200, body parses as JSON
 *   settlement_on_chain  settlement tx exists, no error, payer is the run's payer, and
 *                        one vouched payTo received exactly the quoted amount of the asset
 *   receipt_verifies     receipt.json verifies offline (verifyDelivery) against the trusted key
 *   receipt_binds_run    offer_hash, request_hash, artifact_hash in the receipt equal hashes
 *                        recomputed from offer.json, request.json+settlement, response body
 *   settlement_bound     receipt.settlement_ref equals the on-chain tx signature
 *   spec_holds           checkSpec(artifact, offer.spec) passes, computed here
 *   offer_matches_catalog offer.json's spec/price/class equal the live catalog record
 *   verdict_delivered    receipt.delivery_verdict is "delivered"
 *   attest_settled       when the host advertises a paywall (GET /.well-known/x402 accepts[]),
 *                        the attest call's settlement tx exists, the run's payer signed it, and
 *                        the host's own payTo received exactly the advertised amount; on a host
 *                        with no paywall this passes and says so
 *
 * Exit 0 on DONE, 1 on INCOMPLETE, 2 on usage. Appends one line to
 * data/loop-runs/ledger.ndjson either way. `--score` prints the pass rate.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";

import { checkSpec, hashValue, offerHash, requestHash, verifyDelivery } from "../src/delivery.js";

const USDC_SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LEDGER = path.join("data", "loop-runs", "ledger.ndjson");

const arg = (name, dflt = undefined) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const readJson = (dir, name) => {
  const p = path.join(dir, name);
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
};

const keyFromB64 = (b64) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

async function solanaTx(rpc, signature, doFetch) {
  const res = await doFetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }] }),
  });
  const json = await res.json();
  return json?.result ?? null;
}

/** Token received by `owner` for `mint` in this tx, in atomic units, from pre/post balances. */
function receivedAtomic(tx, owner, mint) {
  const sum = (list) => (list ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((n, b) => n + BigInt(b.uiTokenAmount?.amount ?? "0"), 0n);
  return sum(tx?.meta?.postTokenBalances) - sum(tx?.meta?.preTokenBalances);
}

/** The predicate. Pure over the run dir plus two fetches the caller can fake. */
export async function checkRun(dir, { fetch: doFetch = globalThis.fetch, rpc = "https://api.mainnet-beta.solana.com", pubkeyB64 = null, base = null } = {}) {
  const P = [];
  const pass = (name, detail = null) => P.push({ name, pass: true, detail });
  const fail = (name, detail) => P.push({ name, pass: false, detail });

  const quote = readJson(dir, "quote.json");
  const request = readJson(dir, "request.json");
  const response = readJson(dir, "response.json");
  const settlement = readJson(dir, "settlement.json");
  const offer = readJson(dir, "offer.json");
  const receiptFile = readJson(dir, "receipt.json");
  const attestReq = readJson(dir, "attest-request.json");
  const attestSettlement = readJson(dir, "attest-settlement.json");

  // gate_passed
  const q = quote?.body;
  if (quote?.status === 200 && q?.gate?.status === "passed" && Array.isArray(q.accepts) && q.accepts.length) pass("gate_passed", q.gate.reason);
  else fail("gate_passed", quote ? `status ${quote.status}, gate ${q?.gate?.status ?? "absent"}` : "quote.json missing");

  // request_matches
  if (request && q?.request && request.url === q.request.url && request.method === q.request.method) pass("request_matches", request.url);
  else fail("request_matches", request ? "request.json disagrees with quote.request" : "request.json missing");

  // paid_call_ok
  let artifact = null;
  if (response?.status === 200 && typeof response.body_text === "string") {
    try { artifact = JSON.parse(response.body_text); pass("paid_call_ok", `200, ${response.body_text.length} bytes`); }
    catch { fail("paid_call_ok", "200 but body is not JSON"); }
  } else fail("paid_call_ok", response ? `status ${response.status}` : "response.json missing");

  // settlement_on_chain
  const sig = settlement?.decoded?.transaction ?? null;
  let txOk = false;
  if (!sig) fail("settlement_on_chain", "no settlement transaction recorded");
  else {
    let tx = null;
    try { tx = await solanaTx(rpc, sig, doFetch); } catch (e) { tx = null; }
    if (!tx) fail("settlement_on_chain", "transaction not found on chain");
    else if (tx.meta?.err) fail("settlement_on_chain", `transaction errored: ${JSON.stringify(tx.meta.err)}`);
    else {
      const accepts = (q?.accepts ?? []).filter((a) => String(a.network).startsWith("solana:"));
      const hit = accepts.find((a) => receivedAtomic(tx, a.payTo, a.asset ?? USDC_SOL) === BigInt(a.amount));
      const signers = (tx.transaction?.message?.accountKeys ?? []).filter((k) => k.signer).map((k) => k.pubkey);
      if (!hit) fail("settlement_on_chain", "no vouched payTo received exactly the quoted amount");
      else if (settlement.payer && !signers.includes(settlement.payer)) fail("settlement_on_chain", "run payer did not sign the transaction");
      else { txOk = true; pass("settlement_on_chain", `${hit.payTo} +${hit.amount} atomic, tx ${sig.slice(0, 12)}…`); }
    }
  }

  // receipt_verifies
  const receipt = receiptFile?.body;
  let trusted = null;
  if (pubkeyB64) trusted = pubkeyB64;
  else if (base) {
    try { trusted = (await (await doFetch(`${base}/pubkey`)).json()).pubkey; } catch { trusted = null; }
  }
  let verified = null;
  if (!trusted) fail("receipt_verifies", "no trusted pubkey (pass --pubkey or --base)");
  else if (receiptFile?.status !== 200 || !receipt) fail("receipt_verifies", receiptFile ? `attest status ${receiptFile.status}` : "receipt.json missing");
  else {
    verified = verifyDelivery(receipt, keyFromB64(trusted));
    if (verified.valid) pass("receipt_verifies", `${verified.evidence_mode}`);
    else fail("receipt_verifies", verified.reason);
  }

  // receipt_binds_run — recomputed from raw files, never trusted from the receipt
  if (receipt && offer && request && artifact !== null) {
    const expectOffer = offerHash(offer);
    const expectRequest = requestHash({ request_body: attestReq?.request?.request_body ?? null, settlement_ref: sig, requested_at: request.requested_at });
    const expectArtifact = hashValue(artifact);
    const problems = [];
    if (receipt.offer_hash !== expectOffer) problems.push("offer_hash");
    if (receipt.request_hash !== expectRequest) problems.push("request_hash");
    if (receipt.artifact_hash !== expectArtifact) problems.push("artifact_hash");
    if (problems.length) fail("receipt_binds_run", `mismatch: ${problems.join(", ")}`);
    else pass("receipt_binds_run", "offer, request, artifact hashes recomputed and equal");
  } else fail("receipt_binds_run", "inputs missing");

  // settlement_bound
  if (receipt && sig && receipt.settlement_ref === sig) pass("settlement_bound", sig.slice(0, 12) + "…");
  else fail("settlement_bound", receipt ? "receipt.settlement_ref differs from the chain tx" : "receipt missing");

  // spec_holds
  if (offer?.spec && artifact !== null) {
    const spec = checkSpec(artifact, offer.spec);
    if (spec.verdict === "delivered") pass("spec_holds", Object.keys(offer.spec.required_fields ?? {}).join(","));
    else fail("spec_holds", `${spec.verdict}: ${spec.reasons.join("; ")}`.slice(0, 200));
  } else fail("spec_holds", "offer.spec or artifact missing");

  // offer_matches_catalog — against the live record, not the actor's copy
  if (base && q?.offer_id && offer) {
    let cat = null;
    try { cat = await (await doFetch(`${base}/api/offers/${encodeURIComponent(q.offer_id)}`)).json(); } catch { cat = null; }
    const d = cat?.delivery;
    if (d && JSON.stringify(d.spec) === JSON.stringify(offer.spec) && d.deliverable_class === offer.deliverable_class && Number(cat.price?.usd) === offer.price_usdc && d.spec_origin === offer.spec_origin) pass("offer_matches_catalog", q.offer_id);
    else fail("offer_matches_catalog", cat ? "offer.json differs from the live catalog record" : "catalog unreachable");
  } else fail("offer_matches_catalog", base ? "inputs missing" : "no --base to read the catalog from");

  // verdict_delivered
  if (receipt?.delivery_verdict === "delivered") pass("verdict_delivered", receipt.evidence_mode);
  else fail("verdict_delivered", receipt ? `verdict ${receipt.delivery_verdict ?? "absent"}` : "receipt missing");

  // attest_settled — the attestation is a paid call on a paywalled host; the payee is the
  // host's own, read from its well-known descriptor by the verifier, never from the run.
  let hostAccepts = null;
  if (base) {
    try { hostAccepts = (await (await doFetch(`${base}/.well-known/x402`)).json())?.accepts ?? null; } catch { hostAccepts = null; }
  }
  const solHost = (hostAccepts ?? []).filter((a) => String(a.network).startsWith("solana:"));
  if (!base) fail("attest_settled", "no --base to read the host's paywall from");
  else if (hostAccepts === null) fail("attest_settled", "host well-known descriptor unreachable");
  else if (!hostAccepts.length) pass("attest_settled", "host advertises no paywall; attest served unpaid");
  else {
    const asig = attestSettlement?.decoded?.transaction ?? null;
    if (!asig) fail("attest_settled", "host bills attest but no attest settlement was recorded");
    else if (asig === sig) fail("attest_settled", "attest settlement reuses the resource payment transaction");
    else {
      let atx = null;
      try { atx = await solanaTx(rpc, asig, doFetch); } catch { atx = null; }
      const hit = atx && !atx.meta?.err ? solHost.find((a) => receivedAtomic(atx, a.payTo, a.asset ?? USDC_SOL) === BigInt(a.amount)) : null;
      const signers = (atx?.transaction?.message?.accountKeys ?? []).filter((k) => k.signer).map((k) => k.pubkey);
      if (!atx) fail("attest_settled", "attest settlement transaction not found on chain");
      else if (atx.meta?.err) fail("attest_settled", "attest settlement transaction errored");
      else if (!hit) fail("attest_settled", "host payTo did not receive exactly the advertised amount");
      else if (attestSettlement.payer && !signers.includes(attestSettlement.payer)) fail("attest_settled", "run payer did not sign the attest settlement");
      else pass("attest_settled", `${hit.payTo} +${hit.amount} atomic, tx ${asig.slice(0, 12)}…`);
    }
  }

  const done = P.every((p) => p.pass) && txOk && verified?.valid === true;
  return { done, predicates: P, failed: P.filter((p) => !p.pass).map((p) => p.name) };
}

export function record(dir, result, ledger = LEDGER) {
  mkdirSync(path.dirname(ledger), { recursive: true });
  appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), run: dir, done: result.done, failed: result.failed }) + "\n");
}

export function score(ledger = LEDGER) {
  if (!existsSync(ledger)) return { runs: 0, done: 0, pass_rate: null };
  const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const done = rows.filter((r) => r.done).length;
  return { runs: rows.length, done, pass_rate: rows.length ? done / rows.length : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--score")) {
    console.log(JSON.stringify(score(), null, 2));
    process.exit(0);
  }
  const dir = arg("run");
  if (!dir) { console.error("usage: loop-check --run=<dir> [--base=<witness>] [--pubkey=<b64>] [--rpc=<url>] | --score"); process.exit(2); }
  const result = await checkRun(dir, { base: arg("base", process.env.WITNESS_BASE || "https://witness.outbid.sh"), pubkeyB64: arg("pubkey", null), rpc: arg("rpc", "https://api.mainnet-beta.solana.com") });
  record(dir, result);
  for (const p of result.predicates) console.log(`${p.pass ? "PASS" : "FAIL"}  ${p.name.padEnd(22)} ${p.detail ?? ""}`);
  console.log(result.done ? "DONE" : `INCOMPLETE  (${result.failed.join(", ")})`);
  process.exit(result.done ? 0 : 1);
}
