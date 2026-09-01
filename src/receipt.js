import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

export function generateProcessKey() {
  return generateKeyPairSync("ed25519");
}

export function pubkeyB64(kp) {
  return kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

export function sourceHash(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** Deep, order-stable canonical JSON: every nested field is signed. */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  }
  return v;
}

export function canonical(rest) {
  return JSON.stringify(sortDeep(rest));
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

const OPS = {
  "==": (a, b) => a === b,
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
};

/** Strict assertion grammar v1 (reject-by-default):
 *  "<key> <op> <literal>" — numeric ==, <, <=, >, >= against number values;
 *  string == against quoted literals ("x" or 'x');
 *  "<key> exists" — any value except undefined/null.
 *  Malformed assertions or type mismatches are false, never true. */
export function evalAssertion(value, assertion) {
  if (!assertion) return true;
  const s = String(assertion).trim();
  const exists = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+exists$/);
  if (exists) {
    const v = value[exists[1]];
    return v !== undefined && v !== null;
  }
  const m = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|<=|>=|<|>)\s*(.*)$/);
  if (!m) return false;
  const [, key, op, raw] = m;
  const rhs = raw.trim();
  const v = value[key];
  if (v === undefined || v === null) return false;
  const num = rhs.match(/^(-?\d+(?:\.\d+)?)$/);
  if (num) {
    if (typeof v !== "number" || Number.isNaN(v)) return false;
    return OPS[op](v, Number(num[1]));
  }
  const str = rhs.match(/^(?:"([^"]*)"|'([^']*)')$/);
  if (str) {
    if (op !== "==" || typeof v !== "string") return false;
    return v === (str[1] ?? str[2]);
  }
  return false;
}
