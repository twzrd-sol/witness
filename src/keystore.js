// data/keystore: the ed25519 process key, persisted 0600, survives restarts.
// deps.key (injected) still wins — tests never touch disk.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import path from "node:path";

export function loadOrCreateKeystore(dir = "data") {
  const file = path.join(dir, "keystore");
  if (existsSync(file)) {
    const privateKey = createPrivateKey({ key: readFileSync(file), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  const kp = generateKeyPairSync("ed25519");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, kp.privateKey.export({ type: "pkcs8", format: "der" }), { mode: 0o600 });
  return kp;
}
