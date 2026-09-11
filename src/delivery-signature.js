// Seller signature verification for delivery attestation.
//
// The strongest evidence mode, seller_integrated, claims "the seller signed this
// artifact at emit time for this request". That claim is only worth something
// if the signature (a) verifies cryptographically and (b) is bound to the
// identity the buyer actually paid. In x402 that identity is the `payTo` of the
// accepts[] entry the buyer settled against. The chain this module closes:
//
//   payTo  ->  seller public key  ->  signature over {offer_hash, request_hash, artifact_hash}
//
// Anything that does not close that chain refuses. Every refusal is a
// structured result, never a thrown error and never a bare false, so the
// caller can record WHY the strong mode was withheld.
//
// Rails:
//   solana  payTo is the base58 ed25519 public key itself. The signature is
//           verified directly against it with node:crypto. No dependency.
//   evm     payTo is keccak(pubkey)[12:], not a key. The signer is recovered
//           from the 65-byte ECDSA signature over the EIP-191 personal-message
//           hash (viem, already resolved via @x402/evm) and compared to payTo.
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { getAddress, recoverMessageAddress } from "viem";

import { canonical } from "./receipt.js";

export const SIGNING_DOMAIN = "witness.delivery-attestation.v0";
export const RAILS = Object.freeze({ solana: "solana", evm: "evm" });

// Refusal reasons. A verifier that records these can tell "the seller never
// opted in" from "the seller presented a signature that did not check out",
// which are very different reputation signals.
export const REASONS = Object.freeze({
  ok: "seller_signature_verified",
  unknownNetwork: "unknown_network",
  unsupportedRail: "unsupported_rail",
  missingBinding: "missing_binding",
  payToShape: "payto_shape_mismatch",
  malformedSignature: "malformed_signature",
  keyUnparseable: "key_unparseable",
  signatureInvalid: "signature_invalid",
  signerMismatch: "signer_mismatch",
});

// ---------------------------------------------------------------------------
// base58 (Bitcoin/Solana alphabet). Written here rather than pulled in: the
// decode is thirty lines and a dependency is thirty lines we cannot audit.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map([...B58].map((c, i) => [c, i]));

export function decodeBase58(s) {
  if (typeof s !== "string" || s.length === 0) throw new TypeError("base58: empty input");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = []; // little-endian base-256 accumulator
  for (let i = 0; i < s.length; i++) {
    const d = B58_INDEX.get(s[i]);
    if (d === undefined) throw new TypeError(`base58: invalid character at offset ${i}`);
    let carry = d;
    for (let j = 0; j < out.length; j++) {
      carry += out[j] * 58;
      out[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      out.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Buffer.from([...new Array(zeros).fill(0), ...out.reverse()]);
}

export function encodeBase58(bytes) {
  const buf = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros++;
  const digits = []; // little-endian base-58 accumulator
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

// ---------------------------------------------------------------------------
// What the seller signs. Domain-separated so a signature over these bytes can
// never be replayed as a signature over anything else the seller's key signs
// (a payment authorization, a login challenge, another receipt schema).
const HASH_HEX = /^[0-9a-f]{64}$/;

export function signingMessage({ offer_hash, request_hash, artifact_hash }) {
  for (const [k, v] of Object.entries({ offer_hash, request_hash, artifact_hash })) {
    if (typeof v !== "string" || !HASH_HEX.test(v)) {
      throw new TypeError(`${k}: expected lowercase sha256 hex`);
    }
  }
  const body = canonical({ offer_hash, request_hash, artifact_hash });
  return Buffer.from(`${SIGNING_DOMAIN}\n${body}`, "utf8");
}

// ---------------------------------------------------------------------------
// Network -> rail. x402 v2 uses CAIP-2 (`eip155:8453`, `solana:5eykt4...`);
// v1 used bare names. The rail is decided by the namespace, because that is
// what fixes the key type and address encoding; the chain id changes nothing
// about how a signature verifies. Anything outside these shapes refuses.
const V1_NETWORKS = Object.freeze({
  base: RAILS.evm,
  "base-sepolia": RAILS.evm,
  solana: RAILS.solana,
  "solana-devnet": RAILS.solana,
});

export function railForNetwork(network) {
  if (typeof network !== "string" || network.length === 0) return null;
  if (Object.hasOwn(V1_NETWORKS, network)) return V1_NETWORKS[network];
  if (/^eip155:[1-9][0-9]{0,15}$/.test(network)) return RAILS.evm;
  if (/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(network)) return RAILS.solana;
  return null;
}

// ---------------------------------------------------------------------------
// Solana: payTo IS the ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifySolana(message, payTo, signature, checked) {
  let keyBytes;
  try {
    keyBytes = decodeBase58(payTo);
  } catch (e) {
    return refuse(REASONS.payToShape, RAILS.solana, checked, `payTo is not base58: ${e.message}`);
  }
  if (keyBytes.length !== 32) {
    return refuse(REASONS.payToShape, RAILS.solana, checked, `payTo decodes to ${keyBytes.length} bytes, ed25519 key is 32`);
  }
  checked.push("payto_shape");

  let sigBytes;
  try {
    sigBytes = decodeBase58(signature);
  } catch (e) {
    return refuse(REASONS.malformedSignature, RAILS.solana, checked, `signature is not base58: ${e.message}`);
  }
  if (sigBytes.length !== 64) {
    return refuse(REASONS.malformedSignature, RAILS.solana, checked, `signature decodes to ${sigBytes.length} bytes, ed25519 signature is 64`);
  }
  checked.push("signature_shape");

  let key;
  try {
    key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`imported as ${key.asymmetricKeyType}`);
  } catch (e) {
    return refuse(REASONS.keyUnparseable, RAILS.solana, checked, `payTo did not import as an ed25519 key: ${e.message}`);
  }
  checked.push("key_import");

  let ok = false;
  try {
    ok = cryptoVerify(null, message, key, sigBytes);
  } catch (e) {
    return refuse(REASONS.signatureInvalid, RAILS.solana, checked, `ed25519 verify threw: ${e.message}`);
  }
  if (!ok) return refuse(REASONS.signatureInvalid, RAILS.solana, checked, "ed25519 signature does not verify against payTo");
  checked.push("signature_valid");
  // On this rail the key is the address, so signer == payTo by construction.
  checked.push("signer_matches_payto");
  return { verified: true, reason: REASONS.ok, rail: RAILS.solana, signer: payTo, checked };
}

// ---------------------------------------------------------------------------
// EVM: payTo is a hash of the key; recover the signer and compare.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

function normaliseEvmAddress(payTo) {
  if (typeof payTo !== "string" || !EVM_ADDRESS.test(payTo)) return null;
  const hex = payTo.slice(2);
  const mixed = /[a-f]/.test(hex) && /[A-F]/.test(hex);
  let checksummed;
  try {
    checksummed = getAddress(payTo);
  } catch {
    return null;
  }
  // Mixed case is a checksum claim; a wrong claim is a wrong address.
  if (mixed && checksummed !== payTo) return null;
  return checksummed;
}

async function verifyEvm(message, payTo, signature, checked) {
  const address = normaliseEvmAddress(payTo);
  if (!address) return refuse(REASONS.payToShape, RAILS.evm, checked, "payTo is not a 20-byte EVM address with a valid checksum");
  checked.push("payto_shape");

  if (typeof signature !== "string" || !EVM_SIGNATURE.test(signature)) {
    return refuse(REASONS.malformedSignature, RAILS.evm, checked, "signature is not 65 bytes of 0x-hex (r||s||v)");
  }
  const r = BigInt("0x" + signature.slice(2, 66));
  const s = BigInt("0x" + signature.slice(66, 130));
  const v = parseInt(signature.slice(130, 132), 16);
  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_HALF_N) {
    return refuse(REASONS.malformedSignature, RAILS.evm, checked, "signature r/s out of range or non-canonical (high s)");
  }
  if (![0, 1, 27, 28].includes(v)) {
    return refuse(REASONS.malformedSignature, RAILS.evm, checked, `signature recovery byte ${v} is not 0/1/27/28`);
  }
  checked.push("signature_shape");

  let recovered;
  try {
    recovered = getAddress(await recoverMessageAddress({ message: { raw: message }, signature }));
  } catch (e) {
    return refuse(REASONS.signatureInvalid, RAILS.evm, checked, `secp256k1 recovery failed: ${e.message}`);
  }
  checked.push("signature_valid");

  if (recovered !== address) {
    return refuse(REASONS.signerMismatch, RAILS.evm, checked, "recovered signer is not the payTo the buyer paid");
  }
  checked.push("signer_matches_payto");
  return { verified: true, reason: REASONS.ok, rail: RAILS.evm, signer: address, checked };
}

// ---------------------------------------------------------------------------
function refuse(reason, rail, checked, detail) {
  return { verified: false, reason, rail, checked, detail };
}

/**
 * Verify a seller's signature over a delivered artifact and bind it to payTo.
 *
 * @param {object} p
 * @param {string} p.network   x402 network of the accepts[] entry that was paid
 * @param {string} p.payTo     payTo of that entry: the identity the buyer paid
 * @param {string} p.signature seller signature (base58 on solana, 0x-hex on evm)
 * @param {string} p.offer_hash
 * @param {string} p.request_hash
 * @param {string} p.artifact_hash
 * @returns {Promise<{verified:boolean, reason:string, rail:string|null, checked:string[], signer?:string, detail?:string}>}
 *   Async because viem's secp256k1 recovery is; the solana path has no await.
 */
export async function verifySellerSignature({ network, payTo, signature, offer_hash, request_hash, artifact_hash } = {}) {
  const checked = [];

  const rail = railForNetwork(network);
  if (!rail) return refuse(REASONS.unknownNetwork, null, checked, `network ${JSON.stringify(network ?? null)} is not a known x402 network`);
  checked.push("network");

  let message;
  try {
    message = signingMessage({ offer_hash, request_hash, artifact_hash });
  } catch (e) {
    return refuse(REASONS.missingBinding, rail, checked, e.message);
  }
  checked.push("binding");

  if (typeof signature !== "string" || signature.length === 0) {
    return refuse(REASONS.malformedSignature, rail, checked, "no signature presented");
  }

  if (rail === RAILS.solana) return verifySolana(message, payTo, signature, checked);
  if (rail === RAILS.evm) return verifyEvm(message, payTo, signature, checked);
  return refuse(REASONS.unsupportedRail, rail, checked, `no verifier for rail ${rail}`);
}

/**
 * The mode a receipt may carry. seller_integrated is only available when the
 * signature positively verified; every other outcome is buyer attestation
 * wearing a stronger label, and gets the weaker one.
 */
export function effectiveEvidenceMode(declaredMode, verification) {
  if (declaredMode !== "seller_integrated") return declaredMode;
  return verification && verification.verified === true ? "seller_integrated" : "buyer_attested";
}
