/**
 * The reference integrations are executable, so run them.
 *
 * Nothing did. Both examples/delivery-seller.mjs and examples/delivery-buyer.mjs
 * drifted into describing a protocol POST /delivery/attest had never accepted -
 * the seller signed {schema, pay_to, request_hash, artifact_hash, emitted_at}
 * into an x-delivery-signature envelope while the route wanted {network, payTo,
 * signature} over witness.delivery-attestation.v0, and the buyer still spoke the
 * {success, data, error} envelope that had been removed from the route. The
 * buyer example CRASHED against its own server. Both suites were green
 * throughout, because an example nothing executes is documentation that compiles.
 *
 * Each example self-checks and exits non-zero on any mismatch; this test is the
 * thing that notices.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");
const run = promisify(execFile);

for (const name of ["delivery-seller.mjs", "delivery-buyer.mjs"]) {
  test(`examples/${name} runs green against the code it documents`, async () => {
    let result;
    try {
      result = await run(process.execPath, [path.join(EXAMPLES, name)], { timeout: 60_000 });
    } catch (e) {
      assert.fail(`examples/${name} exited ${e.code ?? "non-zero"}:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`);
    }
    // Exit 0 is the assertion; the tail is what a reader needs when it is not.
    assert.match(result.stdout, /\nok: /, `examples/${name} did not report ok:\n${result.stdout.slice(-800)}`);
  });
}
