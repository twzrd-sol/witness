import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

/** Isolated test directory under os.tmpdir(); reaped after the importing file's tests. */
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
