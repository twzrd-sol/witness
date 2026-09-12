import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "./helpers/tmpdir.js";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { createApp } from "../src/server.js";
import { createMcpServer } from "../src/mcp.js";
import { generateProcessKey, pubkeyB64 } from "../src/receipt.js";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const mcpScript = path.join(repoRoot, "src/mcp.js");

function makeKeyDir(kp) {
  const dir = tempDir("wit-mcp-key-");
  writeFileSync(path.join(dir, "keystore"), kp.privateKey.export({ type: "pkcs8", format: "der" }), { mode: 0o600 });
  return dir;
}

function parseToolText(result) {
  assert.ok(result.content && result.content.length, "tool returned content");
  assert.equal(result.content[0].type, "text");
  return result.content[0].text;
}

async function withStdioClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript],
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "witness-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    if (typeof client.close === "function") await client.close();
    await transport.close();
  }
}

async function withMemoryClient(deps, fn) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(deps);
  const client = new Client({ name: "witness-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    if (typeof client.close === "function") await client.close();
    await clientTransport.close();
  }
}

function createHttpAppWithKey(key) {
  return createApp({
    key,
    retrieve: async () => ({ text: "<p>ok</p>" }),
    observationsDir: tempDir("wit-http-"),
  });
}

test("stdio MCP lists the three free tools and three discovery resources", async () => {
  const kp = generateProcessKey();
  const keyDir = makeKeyDir(kp);
  await withStdioClient({ KEYSTORE_DIR: keyDir, QUOTE_RATE_LIMIT_PER_MINUTE: "10" }, async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["witness_pubkey", "witness_quote", "witness_validate_offer"]);
    assert.ok(tools.every((t) => !t.name.includes("witness_pay") && !t.name.includes("witness_observe")), "paid tool stays absent");

    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => r.uri).sort(), ["witness:///llms.txt", "witness:///openapi.json", "witness:///skill.md"]);

    const pubkey = await client.callTool({ name: "witness_pubkey", arguments: {} });
    const body = JSON.parse(parseToolText(pubkey));
    assert.equal(body.pubkey, pubkeyB64(kp));
  });
});

test("MCP quote and seller tools behave like the HTTP handlers", async () => {
  const kp = generateProcessKey();
  const fetchCalls = [];
  const fakeFetch = async (url) => {
    fetchCalls.push(url);
    return new Response("<p>price: 5.99</p>", { status: 200, headers: { "content-type": "text/html" } });
  };
  await withMemoryClient({ key: kp, fetch: fakeFetch }, async (client) => {
    const goodQuote = await client.callTool({
      name: "witness_quote",
      arguments: { url: "https://127.0.0.1/page", extract: { price: "number" }, assertion: "price < 10", replicas: 1 },
    });
    const good = parseToolText(goodQuote);
    assert.match(good, /SUPPORTED/);
    assert.match(good, /probe_ok: true/);
    assert.match(good, /not reader\.outbid\.sh/);
    assert.equal(fetchCalls.length, 1, "quote tool fetches once per call");

    const missQuote = await client.callTool({
      name: "witness_quote",
      arguments: { url: "https://127.0.0.1/page", extract: { missing: "number" }, replicas: 1 },
    });
    const miss = parseToolText(missQuote);
    assert.equal(missQuote.isError, true);
    assert.match(miss, /"reason":/);
    assert.equal(fetchCalls.length, 2, "quote tool still fetches once per call on miss");

    const validOffer = await client.callTool({
      name: "witness_validate_offer",
      arguments: {
        offer: {
          schema_version: "seller-offer/v1",
          seller_id: "agent:research-1",
          capability: "cited research pack",
          price_minor: 10000,
          currency: "USDC",
          network: "base",
          payout_wallet: "0xabc0000000000000000000000000000000000001",
          sla_minutes: 15,
          deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
        },
        outcomes: [{ status: "accepted", delivery_minutes: 12 }],
      },
    });
    const valid = JSON.parse(parseToolText(validOffer));
    assert.equal(valid.success, true);
    assert.equal(valid.data.seller_card.payout_wallet, "0xabc0000000000000000000000000000000000001");
    assert.equal(valid.data.seller_card.outcomes.completed_jobs, 1);

    const badOffer = await client.callTool({
      name: "witness_validate_offer",
      arguments: {
        offer: {
          schema_version: "seller-offer/v1",
          seller_id: "agent:research-1",
          capability: "cited research pack",
          price_minor: 0,
          currency: "VIRTUAL",
          network: "base",
          payout_wallet: "0xabc0000000000000000000000000000000000001",
          sla_minutes: 15,
          deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
        },
      },
    });
    const bad = JSON.parse(parseToolText(badOffer));
    assert.equal(bad.success, false);
    assert.equal(bad.error.reason, "bad_seller_offer");
    assert.ok(bad.error.details.some((d) => d.field === "currency"));
    assert.ok(bad.error.details.some((d) => d.field === "price_minor"));

    const badOutcomes = await client.callTool({
      name: "witness_validate_offer",
      arguments: {
        offer: {
          schema_version: "seller-offer/v1",
          seller_id: "agent:research-1",
          capability: "cited research pack",
          price_minor: 10000,
          currency: "USDC",
          network: "base",
          payout_wallet: "0xabc0000000000000000000000000000000000001",
          sla_minutes: 15,
          deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
        },
        outcomes: { status: "accepted" },
      },
    });
    const badOut = JSON.parse(parseToolText(badOutcomes));
    assert.equal(badOut.success, false);
    assert.equal(badOut.error.reason, "bad_outcomes");
  });
});

test("witness_pubkey matches the HTTP pubkey for the same key pair", async () => {
  const kp = generateProcessKey();
  const app = createHttpAppWithKey(kp);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const http = await (await fetch(`http://127.0.0.1:${server.address().port}/pubkey`)).json();
    await withMemoryClient({ key: kp }, async (client) => {
      const out = await client.callTool({ name: "witness_pubkey", arguments: {} });
      const tool = JSON.parse(parseToolText(out));
      assert.equal(tool.pubkey, http.pubkey);
      assert.equal(tool.pubkey, pubkeyB64(kp));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
