import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tmpdir.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("tempDir creates a real directory", () => {
  const dir = tempDir("wit-helper-");
  assert.equal(existsSync(dir), true);
  assert.match(path.basename(dir), /^wit-helper-/);
});

test("test files do not call mkdtempSync directly", () => {
  const offenders = [];
  for (const name of readdirSync(here)) {
    if (!name.endsWith(".test.js") || name === "tmpdir-cleanup.test.js") continue;
    const src = readFileSync(path.join(here, name), "utf8");
    if (src.includes("mkdtempSync(")) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "use tempDir() from ./helpers/tmpdir.js so /tmp is reaped");
});
