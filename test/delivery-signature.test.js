// Seller signature -> payTo binding. Every test below the happy paths is an
// attempt to obtain seller_integrated without holding the payTo key; each
// must refuse with a reason the caller can record.
import { test } from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";

import {
  REASONS,
  decodeBase58,
  effectiveEvidenceMode,
  encodeBase58,
  railForNetwork,
  signingMessage,
  verifySellerSignature,
} from "../src/delivery-signature.js";

const HASHES = {
  offer_hash: "1f".repeat(32),
  request_hash: "2e".repeat(32),
  artifact_hash: "3d".repeat(32),
};
const OTHER_ARTIFACT = { ...HASHES, artifact_hash: "4c".repeat(32) };
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

// --- fixtures ---------------------------------------------------------------
function solanaSeller() {
  const kp = generateKeyPairSync("ed25519");
  const raw = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  return {
    payTo: encodeBase58(raw),
    sign: (hashes) => encodeBase58(ed25519Sign(null, signingMessage(hashes), kp.privateKey)),
  };
}

function evmSeller(seed) {
  const account = privateKeyToAccount(`0x${seed.toString(16).padStart(64, "0")}`);
  return {
    payTo: account.address,
    sign: (hashes) => account.signMessage({ message: { raw: signingMessage(hashes) } }),
  };
}

function refused(result, reason) {
  assert.equal(result.verified, false, `expected refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.reason, reason, `wrong reason: ${JSON.stringify(result)}`);
  assert.ok(Array.isArray(result.checked));
  assert.ok(!result.checked.includes("signer_matches_payto"), "refusal must not claim the chain closed");
}

// --- base58 -----------------------------------------------------------------
test("base58 round-trips, preserves leading zeros, rejects the ambiguous glyphs", () => {
  const bytes = Buffer.from([0, 0, 0, 1, 2, 3, 254, 255]);
  assert.deepEqual([...decodeBase58(encodeBase58(bytes))], [...bytes]);
  assert.equal(encodeBase58(Buffer.alloc(3)), "111");
  assert.equal(decodeBase58("111").length, 3);
  for (const bad of ["0", "O", "I", "l", "abc+", " ", ""]) {
    assert.throws(() => decodeBase58(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
  }
  // A known Solana pubkey decodes to exactly 32 bytes.
  assert.equal(decodeBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").length, 32);
});

// --- network -> rail -------------------------------------------------------
test("rail resolution accepts x402 v1 and CAIP-2 names, refuses everything else", () => {
  assert.equal(railForNetwork("solana"), "solana");
  assert.equal(railForNetwork("solana-devnet"), "solana");
  assert.equal(railForNetwork("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "solana");
  assert.equal(railForNetwork("base"), "evm");
  assert.equal(railForNetwork("base-sepolia"), "evm");
  assert.equal(railForNetwork("eip155:8453"), "evm");
  assert.equal(railForNetwork("eip155:84532"), "evm");
  for (const bad of ["", "polygon", "tron:mainnet", "eip155:", "eip155:0x2105", "solana:", "SOLANA", null, undefined, 8453, {}]) {
    assert.equal(railForNetwork(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
});

// --- solana: happy path -----------------------------------------------------
test("solana: a signature from the payTo key over these exact hashes verifies", async () => {
  const seller = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana",
    payTo: seller.payTo,
    signature: seller.sign(HASHES),
    ...HASHES,
  });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.reason, REASONS.ok);
  assert.equal(result.rail, "solana");
  assert.equal(result.signer, seller.payTo);
  assert.deepEqual(result.checked, [
    "network", "binding", "payto_shape", "signature_shape", "key_import", "signature_valid", "signer_matches_payto",
  ]);
});

test("solana: the same signature verifies under the CAIP-2 network name", async () => {
  const seller = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    payTo: seller.payTo,
    signature: seller.sign(HASHES),
    ...HASHES,
  });
  assert.equal(result.verified, true, JSON.stringify(result));
});

// --- solana: adversarial ---------------------------------------------------
test("solana: a valid signature over a DIFFERENT artifact refuses", async () => {
  const seller = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana",
    payTo: seller.payTo,
    signature: seller.sign(OTHER_ARTIFACT),
    ...HASHES,
  });
  refused(result, REASONS.signatureInvalid);
});

test("solana: a valid signature over the same artifact for a DIFFERENT request refuses", async () => {
  const seller = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana",
    payTo: seller.payTo,
    signature: seller.sign({ ...HASHES, request_hash: "ee".repeat(32) }),
    ...HASHES,
  });
  refused(result, REASONS.signatureInvalid);
});

test("solana: a signature from a different keypair refuses", async () => {
  const paid = solanaSeller();
  const impostor = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana",
    payTo: paid.payTo,
    signature: impostor.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.signatureInvalid);
});

test("solana: payTo that is valid base58 and 32 bytes but not a curve point refuses", async () => {
  const seller = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana",
    payTo: encodeBase58(Buffer.alloc(32, 0xff)),
    signature: seller.sign(HASHES),
    ...HASHES,
  });
  assert.equal(result.verified, false);
  assert.ok([REASONS.keyUnparseable, REASONS.signatureInvalid].includes(result.reason), result.reason);
  assert.ok(!result.checked.includes("signer_matches_payto"));
});

test("solana: truncated key (31 bytes) and a 20-byte key both refuse on shape", async () => {
  const seller = solanaSeller();
  const sig = seller.sign(HASHES);
  const short = await verifySellerSignature({
    network: "solana",
    payTo: encodeBase58(decodeBase58(seller.payTo).subarray(0, 31)),
    signature: sig,
    ...HASHES,
  });
  refused(short, REASONS.payToShape);
  const evmSized = await verifySellerSignature({
    network: "solana",
    payTo: encodeBase58(Buffer.alloc(20, 7)),
    signature: sig,
    ...HASHES,
  });
  refused(evmSized, REASONS.payToShape);
});

test("solana: an EVM-shaped payTo under a solana network refuses on shape", async () => {
  const seller = solanaSeller();
  const result = await verifySellerSignature({
    network: "solana",
    payTo: "0x000000000000000000000000000000000000dEaD",
    signature: seller.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.payToShape);
});

test("solana: an EVM (0x, 65-byte) signature against a solana payTo refuses", async () => {
  const sol = solanaSeller();
  const evm = evmSeller(0x1234n);
  const result = await verifySellerSignature({
    network: "solana",
    payTo: sol.payTo,
    signature: await evm.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.malformedSignature);
});

test("solana: empty, missing, and non-string signatures refuse", async () => {
  const seller = solanaSeller();
  for (const signature of ["", undefined, null, 42, {}]) {
    const result = await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature, ...HASHES });
    refused(result, REASONS.malformedSignature);
  }
});

test("solana: a signature with trailing bytes refuses even though its prefix is valid", async () => {
  const seller = solanaSeller();
  const raw = decodeBase58(seller.sign(HASHES));
  const padded = encodeBase58(Buffer.concat([raw, Buffer.from([0x00])]));
  const result = await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature: padded, ...HASHES });
  refused(result, REASONS.malformedSignature);
  const truncated = encodeBase58(raw.subarray(0, 63));
  refused(
    await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature: truncated, ...HASHES }),
    REASONS.malformedSignature,
  );
});

test("solana: a single flipped bit in a valid signature refuses", async () => {
  const seller = solanaSeller();
  const raw = decodeBase58(seller.sign(HASHES));
  raw[10] ^= 0x01;
  const result = await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature: encodeBase58(raw), ...HASHES });
  refused(result, REASONS.signatureInvalid);
});

// --- evm: happy path -------------------------------------------------------
test("evm: a personal_sign signature from the payTo key over these hashes verifies", async () => {
  const seller = evmSeller(0xabcdn);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: seller.payTo,
    signature: await seller.sign(HASHES),
    ...HASHES,
  });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.reason, REASONS.ok);
  assert.equal(result.rail, "evm");
  assert.equal(result.signer, seller.payTo);
  assert.deepEqual(result.checked, [
    "network", "binding", "payto_shape", "signature_shape", "signature_valid", "signer_matches_payto",
  ]);
});

test("evm: a lowercase (unchecksummed) payTo still binds to the same signer", async () => {
  const seller = evmSeller(0xabcdn);
  const result = await verifySellerSignature({
    network: "base",
    payTo: seller.payTo.toLowerCase(),
    signature: await seller.sign(HASHES),
    ...HASHES,
  });
  assert.equal(result.verified, true, JSON.stringify(result));
  assert.equal(result.signer, seller.payTo);
});

// --- evm: adversarial ------------------------------------------------------
test("evm: a valid signature over a DIFFERENT artifact recovers a stranger and refuses", async () => {
  const seller = evmSeller(0xabcdn);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: seller.payTo,
    signature: await seller.sign(OTHER_ARTIFACT),
    ...HASHES,
  });
  refused(result, REASONS.signerMismatch);
});

test("evm: a signature from a different key refuses", async () => {
  const paid = evmSeller(0xabcdn);
  const impostor = evmSeller(0xef01n);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: paid.payTo,
    signature: await impostor.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.signerMismatch);
});

test("evm: a solana (base58) signature against an EVM payTo refuses", async () => {
  const sol = solanaSeller();
  const evm = evmSeller(0xabcdn);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: evm.payTo,
    signature: sol.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.malformedSignature);
});

test("evm: a solana-shaped payTo under an EVM network refuses on shape", async () => {
  const sol = solanaSeller();
  const evm = evmSeller(0xabcdn);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: sol.payTo,
    signature: await evm.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.payToShape);
});

test("evm: a mixed-case payTo with a wrong checksum refuses", async () => {
  const seller = evmSeller(0xabcdn);
  const addr = seller.payTo;
  // Flip the case of the first alphabetic hex digit: still 20 bytes, checksum now lies.
  const i = [...addr].findIndex((c, idx) => idx >= 2 && /[a-fA-F]/.test(c));
  const flipped = addr.slice(0, i) + (addr[i] === addr[i].toUpperCase() ? addr[i].toLowerCase() : addr[i].toUpperCase()) + addr.slice(i + 1);
  assert.notEqual(flipped, addr);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: flipped,
    signature: await seller.sign(HASHES),
    ...HASHES,
  });
  refused(result, REASONS.payToShape);
});

test("evm: truncated (19-byte) and over-long (21-byte) payTo refuse on shape", async () => {
  const seller = evmSeller(0xabcdn);
  const sig = await seller.sign(HASHES);
  refused(
    await verifySellerSignature({ network: "eip155:8453", payTo: seller.payTo.slice(0, -2), signature: sig, ...HASHES }),
    REASONS.payToShape,
  );
  refused(
    await verifySellerSignature({ network: "eip155:8453", payTo: `${seller.payTo}00`, signature: sig, ...HASHES }),
    REASONS.payToShape,
  );
});

test("evm: a signature with trailing bytes or a missing recovery byte refuses", async () => {
  const seller = evmSeller(0xabcdn);
  const sig = await seller.sign(HASHES);
  refused(
    await verifySellerSignature({ network: "eip155:8453", payTo: seller.payTo, signature: `${sig}00`, ...HASHES }),
    REASONS.malformedSignature,
  );
  refused(
    await verifySellerSignature({ network: "eip155:8453", payTo: seller.payTo, signature: sig.slice(0, -2), ...HASHES }),
    REASONS.malformedSignature,
  );
  refused(
    await verifySellerSignature({ network: "eip155:8453", payTo: seller.payTo, signature: "", ...HASHES }),
    REASONS.malformedSignature,
  );
});

test("evm: the high-s malleated twin of a valid signature refuses as non-canonical", async () => {
  const seller = evmSeller(0xabcdn);
  const sig = await seller.sign(HASHES);
  const r = sig.slice(2, 66);
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130, 132), 16);
  const sPrime = (SECP256K1_N - s).toString(16).padStart(64, "0");
  const vPrime = (v === 27 ? 28 : 27).toString(16).padStart(2, "0");
  const malleated = `0x${r}${sPrime}${vPrime}`;
  const result = await verifySellerSignature({ network: "eip155:8453", payTo: seller.payTo, signature: malleated, ...HASHES });
  refused(result, REASONS.malformedSignature);
});

test("evm: a recovery byte outside 0/1/27/28 refuses", async () => {
  const seller = evmSeller(0xabcdn);
  const sig = await seller.sign(HASHES);
  const result = await verifySellerSignature({
    network: "eip155:8453",
    payTo: seller.payTo,
    signature: `${sig.slice(0, 130)}05`,
    ...HASHES,
  });
  refused(result, REASONS.malformedSignature);
});

// --- common pre-checks ------------------------------------------------------
test("unknown network refuses before touching the key or signature", async () => {
  const seller = solanaSeller();
  const sig = seller.sign(HASHES);
  for (const network of ["polygon", "", undefined, "eip155:", "SOLANA"]) {
    const result = await verifySellerSignature({ network, payTo: seller.payTo, signature: sig, ...HASHES });
    refused(result, REASONS.unknownNetwork);
    assert.equal(result.rail, null);
    assert.deepEqual(result.checked, []);
  }
});

test("a missing or malformed binding hash refuses: nothing to have signed over", async () => {
  const seller = solanaSeller();
  const sig = seller.sign(HASHES);
  for (const patch of [
    { artifact_hash: null },
    { artifact_hash: undefined },
    { artifact_hash: "" },
    { artifact_hash: "3D".repeat(32) },
    { artifact_hash: "3d".repeat(31) },
    { offer_hash: 12345 },
    { request_hash: "not-a-hash" },
  ]) {
    const result = await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature: sig, ...HASHES, ...patch });
    refused(result, REASONS.missingBinding);
  }
});

test("signing message is domain-separated and order-stable", () => {
  const a = signingMessage(HASHES).toString("utf8");
  const b = signingMessage({ artifact_hash: HASHES.artifact_hash, request_hash: HASHES.request_hash, offer_hash: HASHES.offer_hash }).toString("utf8");
  assert.equal(a, b);
  assert.ok(a.startsWith("witness.delivery-attestation.v0\n"));
  assert.notEqual(signingMessage(OTHER_ARTIFACT).toString("utf8"), a);
});

test("effectiveEvidenceMode only grants seller_integrated on a positive verification", async () => {
  const seller = solanaSeller();
  const good = await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature: seller.sign(HASHES), ...HASHES });
  const bad = await verifySellerSignature({ network: "solana", payTo: seller.payTo, signature: seller.sign(OTHER_ARTIFACT), ...HASHES });
  assert.equal(effectiveEvidenceMode("seller_integrated", good), "seller_integrated");
  assert.equal(effectiveEvidenceMode("seller_integrated", bad), "buyer_attested");
  assert.equal(effectiveEvidenceMode("seller_integrated", undefined), "buyer_attested");
  assert.equal(effectiveEvidenceMode("seller_integrated", { verified: "true" }), "buyer_attested");
  assert.equal(effectiveEvidenceMode("verifier_observed", bad), "verifier_observed");
  assert.equal(effectiveEvidenceMode("buyer_attested", good), "buyer_attested");
});
