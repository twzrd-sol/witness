// Keystore: generate-once, persist 0600, reload same key. deps.key wins.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKeystore } from "../src/keystore.js";
import { pubkeyB64, generateProcessKey } from "../src/receipt.js";

test("keystore persists one process key across reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "witness-ks-"));
  try {
    const first = loadOrCreateKeystore(dir);
    const file = join(dir, "keystore");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const second = loadOrCreateKeystore(dir);
    assert.equal(pubkeyB64(second), pubkeyB64(first));
    assert.notEqual(pubkeyB64(second), pubkeyB64(generateProcessKey()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
