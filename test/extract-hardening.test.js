import { test } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_EXTRACT_KEY_LENGTH, MAX_EXTRACT_KEYS, normalizeExtract } from "../src/extract.js";
import { generateProcessKey } from "../src/receipt.js";
import { methodFromRequest, specHash } from "../src/observatory.js";
import { createApp, handleQuote, handleWitness } from "../src/server.js";
import { installCrashGuard } from "../src/listen.js";

const PAGE_URL = "https://example.com/pricing";
const FIXTURE = `<p>starter_price: $49/mo</p><p>rank: 7</p>`;
const PINNED = "f1123b280c37d47ed2e6049c95fab4c121b121d3b83b4e4083c8c859f8de5b76";
const BAD_EXTRACT = { reason: "bad_extract", expected: { "<key>": "number|string" }, example: { url: "https://outbid.sh/top", extract: { rank: "number" } } };
const retrieve = async () => ({ text: FIXTURE });
// Wire-accurate: JSON.parse makes "__proto__" a real own key. An object literal would only set the prototype.
const PROTO = JSON.parse('{"__proto__":"number"}');
const PARTIAL = JSON.parse('{"__proto__":"number","rank":"number"}');
const keys = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "number"]));

async function withServer(deps, fn) {
  const server = createApp({ key: generateProcessKey(), retrieve, ...deps }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const post = (base, route, body) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("__proto__ key: refused, not swallowed — 400 bad_extract, never a 200, a 402, or a receipt", async () => {
  assert.ok(Object.hasOwn(PROTO, "__proto__") && Object.hasOwn(PARTIAL, "__proto__"), "precondition: own property, not a prototype");
  assert.equal(normalizeExtract(PROTO), null);
  assert.equal(normalizeExtract(PARTIAL), null, "partial drop fails closed instead of narrowing the method");
  let n = 0;
  const spy = async () => (n++, { text: FIXTURE });
  for (const extract of [PROTO, PARTIAL]) {
    const q = await handleQuote({ url: PAGE_URL, extract }, { retrieve: spy });
    assert.deepEqual([q.status, q.json], [400, BAD_EXTRACT]);
    const w = await handleWitness({ url: PAGE_URL, extract }, { retrieve: spy, paid: true, key: generateProcessKey() });
    assert.equal(w.status, 400, "the paid path mints nothing");
    assert.equal(w.json.receipt, undefined);
  }
  assert.equal(n, 0, "retrieve never called");
  await withServer({}, async (base) => {
    for (const route of ["/quote", "/witness"]) {
      const res = await post(base, route, `{"url":"${PAGE_URL}","extract":{"__proto__":"number","rank":"number"}}`);
      assert.equal(res.status, 400, `${route} answers 400, not 200/402`);
      assert.deepEqual(await res.json(), BAD_EXTRACT);
    }
  });
});

test("bounds: key length and key count are refused with the same 400, and the server keeps answering", async () => {
  assert.ok(normalizeExtract({ ["k".repeat(MAX_EXTRACT_KEY_LENGTH)]: "number" }), "at the bound: accepted");
  assert.equal(normalizeExtract({ ["k".repeat(MAX_EXTRACT_KEY_LENGTH + 1)]: "number" }), null);
  assert.equal(normalizeExtract({ "": "number" }), null, "an empty key names nothing");
  assert.ok(normalizeExtract(keys(MAX_EXTRACT_KEYS)), "at the bound: accepted");
  assert.equal(normalizeExtract(keys(MAX_EXTRACT_KEYS + 1)), null);
  await withServer({}, async (base) => {
    const res = await post(base, "/quote", { url: PAGE_URL, extract: { ["k".repeat(60000)]: "number" } });
    assert.deepEqual([res.status, await res.json()], [400, BAD_EXTRACT], "60k-char key: 400, not a RegExp throw");
    assert.equal((await post(base, "/quote", { url: PAGE_URL, extract: keys(MAX_EXTRACT_KEYS + 1) })).status, 400);
    assert.equal((await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" } })).status, 200, "process still serving");
  });
});

test("assertion must be grammar text: non-string is 400 bad_assertion, null/undefined stay fine, no stack overflow", async () => {
  let n = 0;
  const spy = async () => (n++, { text: FIXTURE });
  for (const assertion of [7, true, ["rank < 100"], { rank: 100 }, "x".repeat(513)]) {
    const q = await handleQuote({ url: PAGE_URL, extract: { rank: "number" }, assertion }, { retrieve: spy });
    assert.equal(q.status, 400, JSON.stringify(assertion).slice(0, 40));
    assert.equal(q.json.reason, "bad_assertion");
  }
  assert.equal(n, 0, "a shape error is answered before any retrieve");
  for (const assertion of [undefined, null, "rank < 100"]) {
    assert.equal((await handleQuote({ url: PAGE_URL, extract: { rank: "number" }, assertion }, { retrieve })).status, 200);
  }
  let deep = []; for (let i = 0; i < 4000; i++) deep = [deep];
  await withServer({}, async (base) => {
    const res = await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" }, assertion: deep });
    assert.equal(res.status, 400, "4000-deep array: 400, not a RangeError");
    assert.equal((await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" } })).status, 200, "process still serving");
  });
});

test("a handler that throws answers 500 internal_error and the process keeps serving (express 4 async rejection)", async () => {
  let calls = 0;
  // A retrieve that breaks its own contract makes fillExtract throw inside the async route.
  await withServer({ retrieve: async () => (calls++ ? { text: FIXTURE } : { text: 42 }) }, async (base) => {
    const res = await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" } });
    assert.deepEqual([res.status, await res.json()], [500, { reason: "internal_error" }]);
    assert.equal((await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" } })).status, 200, "answered again, not hung");
  });
});

test("'constructor exists' never signs: an inherited name is a failed assertion (422), not a receipt", async () => {
  for (const assertion of ["constructor exists", "toString exists", "valueOf exists"]) {
    const w = await handleWitness({ url: PAGE_URL, extract: { rank: "number" }, assertion }, { retrieve, paid: true, key: generateProcessKey() });
    assert.deepEqual([w.status, w.json.reason, w.json.receipt], [422, "assertion_failed", undefined], assertion);
  }
  assert.equal((await handleWitness({ url: PAGE_URL, extract: { rank: "number" }, assertion: "rank exists" }, { retrieve, paid: true, key: generateProcessKey() })).status, 200);
});

test("crash guard: fatal before listen, tolerant of rejections after, always fatal on an uncaught exception", () => {
  const proc = new EventEmitter();
  const exits = []; proc.exit = (code) => exits.push(code);
  const lines = [];
  const guard = installCrashGuard(proc, (...a) => lines.push(a.join(" ")));
  proc.emit("unhandledRejection", new Error("early"));
  assert.deepEqual(exits, [1], "a rejection before the server is up is a failed start: exit 1 so systemd retries");
  guard.listening();
  proc.emit("unhandledRejection", new Error("boom"));
  assert.deepEqual(exits, [1], "after listen a stray rejection is logged and the process keeps serving");
  proc.emit("uncaughtException", new Error("bang"));
  assert.deepEqual(exits, [1, 1], "an uncaught exception exits 1 even while serving: unknown state, systemd restarts in 3s");
  assert.match(lines[0], /unhandled rejection[\s\S]*early/);
  assert.match(lines[1], /unhandled rejection[\s\S]*boom/);
  assert.match(lines[2], /uncaught exception[\s\S]*bang/);
});

const ENTRY = fileURLToPath(new URL("../src/listen.js", import.meta.url));
const SRC = (f) => JSON.stringify(new URL(`../src/${f}`, import.meta.url).href);
const spawnNode = (args, cwd, env) => spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });

test("entrypoint: a fatal before listen (port already bound) exits non-zero, so systemd Restart=on-failure fires", async () => {
  const blocker = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "wit-entry-")); // data/keystore lands here, never in the repo
  try {
    const child = spawnNode([ENTRY], cwd, { HOST: "127.0.0.1", PORT: String(blocker.address().port) });
    let err = ""; child.stderr.on("data", (d) => { err += d; });
    const code = await new Promise((r) => child.once("exit", r));
    assert.notEqual(code, 0, `exit ${code}; stderr: ${err.slice(0, 200)}`);
    assert.match(err, /EADDRINUSE/); assert.match(err, /exiting 1/);
  } finally { await new Promise((r) => blocker.close(r)); }
});

test("entrypoint guard armed after listen: a stray rejection is logged, the request answers 500, the next one 200", async () => {
  const script = `import { createApp } from ${SRC("server.js")}; import { installCrashGuard } from ${SRC("listen.js")}; import { generateProcessKey } from ${SRC("receipt.js")};
    const guard = installCrashGuard(); let n = 0;
    const retrieve = async () => { if (n++) return { text: ${JSON.stringify(FIXTURE)} }; setTimeout(() => Promise.reject(new Error("stray")), 0); return { text: 42 }; };
    const s = createApp({ key: generateProcessKey(), retrieve, funnelDir: null }).listen(0, "127.0.0.1", () => { guard.listening(); console.log(s.address().port); });`;
  const child = spawnNode(["--input-type=module", "-e", script], os.tmpdir(), {});
  let err = ""; child.stderr.on("data", (d) => { err += d; });
  try {
    const port = await new Promise((res, rej) => { child.stdout.once("data", (d) => res(String(d).trim())); child.once("exit", (c) => rej(new Error(`exited ${c}: ${err}`))); });
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" } })).status, 500);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await post(base, "/quote", { url: PAGE_URL, extract: { rank: "number" } })).status, 200, "still serving after an unhandled rejection");
    assert.match(err, /unhandled rejection[\s\S]*stray/, "the process-level guard saw it and did not exit");
    assert.equal(child.exitCode, null, "process alive");
  } finally { child.kill(); }
});

test("spec_hash pin: the canonical dialect still hashes byte-identically through normalizeExtract", () => {
  assert.equal(specHash(methodFromRequest({ url: PAGE_URL, extract: normalizeExtract({ starter_price: "number", currency: "string" }) })), PINNED);
});
