import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

const CANON = ["value", "assertion", "observed_at", "source_hash", "evidence", "agreement"];

export function generateProcessKey() {
  return generateKeyPairSync("ed25519");
}

export function pubkeyB64(kp) {
  return kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

export function sourceHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function canonical(rest) {
  return JSON.stringify(rest, CANON);
}

export function signReceipt(rest, kp) {
  const sig = sign(null, Buffer.from(canonical(rest)), kp.privateKey);
  return { ...rest, receipt: sig.toString("base64") };
}

export function verifyReceipt(doc, publicKey) {
  const { receipt, ...rest } = doc;
  if (!receipt) return false;
  return verify(null, Buffer.from(canonical(rest)), publicKey, Buffer.from(receipt, "base64"));
}

export function evalAssertion(value, assertion) {
  if (!assertion) return true;
  const m = String(assertion).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*<\s*(\d+(?:\.\d+)?)$/);
  if (!m || typeof value[m[1]] !== "number") return false;
  return value[m[1]] < Number(m[2]);
}
