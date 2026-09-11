#!/usr/bin/env node
/**
 * Reference SELLER integration for delivery attestation.
 *
 * Settlement proves money moved. A seller that signs its response AT EMIT TIME
 * lets any buyer later obtain a seller_integrated receipt from
 * POST /delivery/attest: a verdict whose evidence mode proves "this seller
 * emitted THIS artifact for THIS paid request", instead of only "the buyer says
 * so". Without it the strongest receipt a buyer can get is buyer_attested,
 * which is a complaint, not proof of fault.
 *
 * WHAT THE SELLER SIGNS
 *   "witness.delivery-attestation.v0\n" + canonical({artifact_hash, offer_hash, request_hash})
 * Domain-separated, so a signature over these bytes can never be replayed as a
 * signature over anything else the same key signs - a payment authorization, a
 * login challenge, another receipt schema.
 *
 * THE KEY IS THE PAYEE. There is no separate seller keypair to publish and no
 * key-to-payTo binding to trust: the signature is verified against the `payTo`
 * of the accepts[] entry the buyer settled against.
 *   solana  payTo IS the base58 ed25519 public key. Sign with that keypair.
 *   evm     payTo is keccak(pubkey)[12:]. Sign the EIP-191 personal message with
 *           the account's key; the verifier recovers the signer and compares.
 * A seller that can receive payment at payTo can already sign for it. That is
 * the whole integration.
 *
 * HOW IT TRAVELS: one response header carrying the object the route accepts.
 * The JSON body is untouched, so its bytes hash the same on both ends.
 *   x-delivery-signature: {"network":"...","payTo":"...","signature":"..."}
 * The buyer JSON.parses that header into observation.seller_signature verbatim.
 *
 * THE OFFER MUST BE PUBLISHED, NOT PARAPHRASED. offer_hash covers
 * {resource_url, deliverable_class, price_usdc, spec} exactly. The seller signs
 * over the offer it published; the buyer submits what it read. If the buyer
 * rewrites the spec - even to something reasonable - the hashes diverge and the
 * signature refuses, which is correct: the seller never promised that. Publish
 * the offer where buyers already look for payTo and have them declare
 * spec_origin "seller_published".
 *
 * Runnable, no network:  node examples/delivery-seller.mjs
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

export const SIGNATURE_HEADER = "x-delivery-signature";
export const SIGNING_DOMAIN = "witness.delivery-attestation.v0";

// ---------------------------------------------------------------------------
// SELLER SIDE. Everything below this line is what a seller reimplements in its
// own stack; it imports nothing from Witness on purpose. The PROOF section at
// the bottom checks this half against Witness's real verifier, so a drift
// between the two fails this file rather than shipping as a broken example.

/** Deep-canonical JSON: sorted keys, no whitespace. Same bytes on every side. */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
}
export const canonical = (v) => JSON.stringify(sortDeep(v));
export const sha256 = (v) => createHash("sha256").update(canonical(v)).digest("hex");

/** The four fields offer_hash covers - no more, no less. */
export const offerHash = ({ resource_url, deliverable_class, price_usdc, spec }) =>
  sha256({ resource_url, deliverable_class, price_usdc, spec });
/** settlement_ref unknown normalises to null, so "unknown" hashes one way. */
export const requestHash = ({ request_body, settlement_ref = null, requested_at }) =>
  sha256({ request_body, settlement_ref, requested_at });
export const artifactHash = (artifact) => sha256(artifact);

/** The exact bytes to sign. Not JSON - a domain line, then the canonical body. */
export function signingMessage({ offer_hash, request_hash, artifact_hash }) {
  return Buffer.from(`${SIGNING_DOMAIN}\n${canonical({ offer_hash, request_hash, artifact_hash })}`, "utf8");
}

// base58 (Bitcoin/Solana alphabet). A seller already holding a Solana keypair
// almost certainly has bs58 or @solana/web3.js; this is here so the file runs
// with no dependency at all.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function encodeBase58(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = [];
  for (const byte of buf) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

const ED25519_SPKI_PREFIX_LEN = 12; // the raw 32-byte key follows it

/**
 * A Solana seller. payTo is derived from the keypair rather than chosen,
 * because on this rail they are the same thing.
 */
export function solanaSeller(network = "solana") {
  const kp = generateKeyPairSync("ed25519");
  const raw = kp.publicKey.export({ type: "spki", format: "der" }).subarray(ED25519_SPKI_PREFIX_LEN);
  const payTo = encodeBase58(raw);
  return {
    network,
    payTo,
    sign: (message) => encodeBase58(sign(null, message, kp.privateKey)),
  };
}

/**
 * An EVM seller. `privateKey` is the key behind payTo; in production it is the
 * receiving account's key, held wherever that key already lives.
 */
export function evmSeller(privateKey, network = "eip155:8453") {
  const account = privateKeyToAccount(privateKey);
  return {
    network,
    payTo: account.address,
    // EIP-191 personal_sign over the RAW message bytes, not a hex string of them.
    sign: (message) => account.signMessage({ message: { raw: message } }),
  };
}

/**
 * Sign at emit time and produce the object POST /delivery/attest accepts
 * verbatim as observation.seller_signature.
 */
export async function signAtEmit(seller, { offer, request, artifact }) {
  const message = signingMessage({
    offer_hash: offerHash(offer),
    request_hash: requestHash(request),
    artifact_hash: artifactHash(artifact),
  });
  return { network: seller.network, payTo: seller.payTo, signature: await seller.sign(message) };
}

/** The seller's HTTP response for a paid call: artifact as the body, signature as a header. */
export async function emitResponse(seller, { offer, request, artifact }) {
  return {
    status: 200,
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: JSON.stringify(await signAtEmit(seller, { offer, request, artifact })),
    },
    body: JSON.stringify(artifact),
  };
}

// ---------------------------------------------------------------------------
/** A real catalog subject (data_json, USDC 0.28/call; 61 payers, 1584 calls in the 2026-09-10 snapshot). No request is sent to it. */
export const SUBJECT = Object.freeze({
  resource_url: "https://stableenrich.dev/api/pdl/people-enrich",
  deliverable_class: "data_json",
  price_usdc: 0.28,
  spec: { required_fields: { query: "string", results: "array", result_count: "number" } },
});
export const EXAMPLE_REQUEST = Object.freeze({
  request_body: { query: "acme corp" },
  settlement_ref: "5tGsKx8n3v2Q1w9E7r6T5y4U3i2O1p0A9s8D7f6G5h4J3k2L1z0X9c8V7b6N5m4",
  requested_at: "2026-09-11T04:00:00Z",
});
export const EXAMPLE_ARTIFACT = Object.freeze({
  query: "acme corp",
  results: [{ name: "Acme Corp", domain: "acme.example" }],
  result_count: 1,
});

// ---------------------------------------------------------------------------
// PROOF. Witness's own verifier, not a second implementation of it. If the
// seller-side code above ever stops producing what the route accepts, this
// section fails - which is the check that was missing when this file documented
// a signing scheme the route had never accepted.
async function main() {
  const say = (...a) => console.log(...a);
  const { verifySellerSignature, encodeBase58: witnessBase58 } = await import("../src/delivery-signature.js");

  const offer = { ...SUBJECT };
  const request = { ...EXAMPLE_REQUEST };
  const artifact = { ...EXAMPLE_ARTIFACT };
  const binding = {
    offer_hash: offerHash(offer),
    request_hash: requestHash(request),
    artifact_hash: artifactHash(artifact),
  };

  say("what the seller signs");
  say("  offer_hash    :", binding.offer_hash, "(resource_url, deliverable_class, price_usdc, spec)");
  say("  request_hash  :", binding.request_hash, "(request_body, settlement_ref, requested_at)");
  say("  artifact_hash :", binding.artifact_hash, "(the response body, canonicalised)");
  say("  message bytes :", JSON.stringify(signingMessage(binding).toString("utf8")));

  // The base58 above is copy-pasteable seller-side code; it must agree with the
  // one the verifier uses, or a valid signature would read as malformed.
  const probe = Buffer.from("00ff10203040506070809000", "hex");
  const base58Agrees = encodeBase58(probe) === witnessBase58(probe);

  const rails = [
    { name: "solana", seller: solanaSeller("solana"), otherPayee: solanaSeller().payTo, otherNetwork: "eip155:8453" },
    { name: "evm", seller: evmSeller(`0x${"11".repeat(32)}`, "eip155:8453"), otherPayee: evmSeller(`0x${"22".repeat(32)}`).payTo, otherNetwork: "solana" },
  ];

  let allOk = base58Agrees;
  for (const { name, seller, otherPayee, otherNetwork } of rails) {
    const response = await emitResponse(seller, { offer, request, artifact });
    const carried = JSON.parse(response.headers[SIGNATURE_HEADER]);

    say(`\n[${name}] response the seller emits for that call`);
    say("  status :", response.status);
    say(`  header ${SIGNATURE_HEADER}:`, response.headers[SIGNATURE_HEADER]);
    say("  body   :", response.body);
    say("  -> the buyer copies that parsed object into observation.seller_signature");

    const check = (label, over, sig = carried) =>
      verifySellerSignature({ ...sig, ...binding, ...over }).then((r) => {
        say(`  ${label.padEnd(26)}: ${String(r.verified).padEnd(5)} ${r.reason}`);
        return r.verified;
      });

    say(`\n[${name}] what Witness's verifier makes of it`);
    const good = await check("as emitted", {});
    const bad = [
      await check("artifact edited", { artifact_hash: artifactHash({ ...artifact, result_count: 2 }) }),
      await check("different request", { request_hash: requestHash({ ...request, request_body: { query: "beta llc" } }) }),
      await check("offer spec rewritten", { offer_hash: offerHash({ ...offer, spec: { required_fields: { query: "string" } } }) }),
      await check("presented as another payee", {}, { ...carried, payTo: otherPayee }),
      await check("wrong rail for the key", {}, { ...carried, network: otherNetwork }),
    ];
    // secp256k1 is malleable: (r, N-s) verifies for the same signer. The verifier
    // refuses high-s rather than accepting a second valid form of one signature.
    if (name === "evm") {
      const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const s = BigInt(`0x${carried.signature.slice(66, 130)}`);
      const v = parseInt(carried.signature.slice(130, 132), 16);
      const twin = `${carried.signature.slice(0, 66)}${(N - s).toString(16).padStart(64, "0")}${(v === 27 || v === 0 ? 28 : 27).toString(16)}`;
      bad.push(await check("malleated (high-s) twin", {}, { ...carried, signature: twin }));
    }
    allOk = allOk && good && bad.every((v) => v === false);
  }

  say("\nwhat a seller_integrated receipt built on this proves");
  say("  - this seller emitted this artifact for this request, under the key that receives payment at payTo");
  say("what it does not prove");
  say("  - that the buyer received it, or received it unmodified in transit");
  say("  - that the artifact is correct: correctness is graded against the offer spec by the verifier");
  say("  - anything about sellers that do not sign: absence of a receipt is not evidence of fault");
  say(`\nseller base58 agrees with the verifier's: ${base58Agrees}`);
  say(`${allOk ? "ok" : "FAILED"}: signing at emit time produces material POST /delivery/attest accepts, and every tampered form refuses`);
  return allOk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
