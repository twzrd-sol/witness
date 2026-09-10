#!/usr/bin/env node
// Offline checker for the issue #1 "twice-pay" operator proof.
//
// Usage:
//   node scripts/verify-proof.mjs <evidence.json> [--pubkey <base64>]
//
// The evidence bundle is the sanitized artifact an independent operator
// returns after paying POST /witness twice with a byte-identical body.
// This script NEVER sees a private key or a payment header; it only checks
// public receipts, the shared spec_hash, and the two settlement IDs.
//
// Exit 0 = every invariant holds. Exit 1 = at least one failed (printed).

import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

// --- Canonicalization: must match src/observatory.js (spec_hash) ---
function canonicalSpec(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSpec).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalSpec(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const specHash = (spec) => createHash("sha256").update(canonicalSpec(spec)).digest("hex");

// --- Canonicalization: must match src/receipt.js (ed25519 signature) ---
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
const canonicalReceipt = (rest) => JSON.stringify(sortDeep(rest));

function verifyReceiptDoc(doc, publicKey) {
  const { receipt, ...rest } = doc;
  if (!receipt || typeof receipt !== "string") return false;
  try {
    return verify(null, Buffer.from(canonicalReceipt(rest)), publicKey, Buffer.from(receipt, "base64"));
  } catch {
    return false;
  }
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function verifyProof(bundle, pubkeyB64) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const check = (c, m) => { if (!c) fail(m); };

  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return ["bundle_not_an_object"];

  // A sanitized bundle must never carry secrets or payment headers.
  const banned = ["private_key", "privatekey", "secret", "x-payment", "payment-signature", "payment_header", "paymentheader", "authorization"];
  for (const k of Object.keys(bundle)) {
    if (banned.includes(k.toLowerCase())) fail(`forbidden_field:${k}`);
  }

  const { method, payer, receipts, settlements, observatory } = bundle;

  // Method
  check(method && typeof method === "object" && !Array.isArray(method), "method_missing");
  let expectedSpecHash = null;
  if (method && typeof method === "object" && !Array.isArray(method)) {
    check(typeof method.url === "string" && method.url.startsWith("https://"), "method_url_not_https");
    check(method.extract && typeof method.extract === "object" && Object.keys(method.extract).length > 0, "method_extract_empty");
    check(method.retrieval === "scrape" || method.retrieval === "browse", "method_retrieval_invalid");
    try {
      expectedSpecHash = specHash({ url: method.url, retrieval: method.retrieval ?? "scrape", extract: method.extract, assertion: method.assertion ?? null });
    } catch { fail("method_unhashable"); }
  }

  // Payer (public address only)
  check(typeof payer === "string" && payer.length >= 8, "payer_missing");

  // Receipts: exactly two
  check(Array.isArray(receipts) && receipts.length === 2, "receipts_not_two");
  let publicKey = null;
  if (pubkeyB64) {
    try { publicKey = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" }); }
    catch { fail("pubkey_invalid"); }
  }
  const seenSig = new Set();
  if (Array.isArray(receipts)) {
    receipts.forEach((r, i) => {
      const tag = `receipt[${i}]`;
      if (!r || typeof r !== "object") return fail(`${tag}_not_an_object`);
      if (expectedSpecHash) check(r.spec_hash === expectedSpecHash, `${tag}_spec_hash_mismatch`);
      check(r.agreement === "1-of-1", `${tag}_agreement_not_1_of_1`);
      check(r.method && typeof r.method === "object", `${tag}_method_missing`);
      if (r.method && r.spec_hash) {
        try { check(specHash(r.method) === r.spec_hash, `${tag}_method_does_not_bind_spec_hash`); }
        catch { fail(`${tag}_method_unhashable`); }
      }
      check(typeof r.source_hash === "string" && HEX64.test(r.source_hash), `${tag}_source_hash_invalid`);
      check(typeof r.observed_at === "string" && Number.isFinite(Date.parse(r.observed_at)), `${tag}_observed_at_invalid`);
      check(typeof r.valid_until === "string" && Number.isFinite(Date.parse(r.valid_until)), `${tag}_valid_until_invalid`);
      if (Number.isFinite(Date.parse(r.observed_at)) && Number.isFinite(Date.parse(r.valid_until))) {
        check(Date.parse(r.valid_until) > Date.parse(r.observed_at), `${tag}_expired_before_observed`);
      }
      if (publicKey) check(verifyReceiptDoc(r, publicKey), `${tag}_signature_invalid`);
      if (typeof r.receipt === "string") {
        const h = createHash("sha256").update(r.receipt).digest("hex");
        check(!seenSig.has(h), `${tag}_duplicate_receipt_signature`);
        seenSig.add(h);
      }
    });
    if (receipts.length === 2 && receipts[0]?.spec_hash && receipts[1]?.spec_hash) {
      check(receipts[0].spec_hash === receipts[1].spec_hash, "receipts_spec_hash_differ");
    }
    // Byte-identical body: both receipts must bind the same canonical method.
    if (receipts[0]?.method && receipts[1]?.method) {
      try { check(specHash(receipts[0].method) === specHash(receipts[1].method), "method_drift_between_pays"); }
      catch { fail("method_drift_unhashable"); }
    }
  }

  // Settlements: two distinct identifiers, no payment payload.
  check(Array.isArray(settlements) && settlements.length === 2, "settlements_not_two");
  if (Array.isArray(settlements)) {
    settlements.forEach((s, i) => {
      const tag = `settlement[${i}]`;
      if (typeof s === "string") {
        check(s.length >= 8, `${tag}_too_short`);
      } else if (s && typeof s === "object") {
        check(typeof s.id === "string" && s.id.length >= 8, `${tag}_id_missing`);
        for (const k of Object.keys(s)) {
          if (banned.includes(k.toLowerCase())) fail(`${tag}_forbidden_field:${k}`);
        }
      } else {
        fail(`${tag}_invalid`);
      }
    });
    if (settlements.length === 2) {
      const id0 = typeof settlements[0] === "string" ? settlements[0] : settlements[0]?.id;
      const id1 = typeof settlements[1] === "string" ? settlements[1] : settlements[1]?.id;
      if (id0 && id1) check(id0 !== id1, "settlements_not_distinct");
    }
  }

  // Observatory cross-check (operator-reported)
  if (observatory !== undefined) {
    check(observatory && typeof observatory === "object", "observatory_invalid");
    if (observatory && typeof observatory === "object") {
      if (expectedSpecHash) check(observatory.spec_hash === expectedSpecHash, "observatory_spec_hash_mismatch");
      check(Number.isInteger(observatory.total) && observatory.total >= 2, "observatory_total_below_2");
    }
  }

  return failures;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const pkIdx = args.indexOf("--pubkey");
  const pubkey = pkIdx >= 0 ? args[pkIdx + 1] : process.env.WITNESS_PUBKEY;
  const file = args.find((a, i) => !a.startsWith("--") && (pkIdx < 0 || (i !== pkIdx && i !== pkIdx + 1)));
  if (!file) {
    console.error("usage: node scripts/verify-proof.mjs <evidence.json> [--pubkey <base64>]");
    process.exit(2);
  }
  let bundle;
  try { bundle = JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { console.error(`cannot read/parse ${file}: ${e.message}`); process.exit(2); }
  const failures = verifyProof(bundle, pubkey);
  if (failures.length) {
    console.error(`PROOF INVALID — ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("PROOF VALID — two distinct settlements, two signed receipts, one spec_hash.");
}
