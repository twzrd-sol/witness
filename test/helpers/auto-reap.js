import fs from "node:fs";

const created = [];
const original = fs.mkdtempSync.bind(fs);

fs.mkdtempSync = function patchedMkdtempSync(...args) {
  const dir = original(...args);
  created.push(dir);
  return dir;
};

process.on("exit", () => {
  for (const dir of created) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // still-open handles keep the inode until close
    }
  }
});
