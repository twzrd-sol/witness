import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateProcessKey } from "../src/receipt.js";
import { createMcpServer, handleMcpQuote, renderMcpQuote } from "../src/mcp.js";
import { SELLER_OFFER_SCHEMA_VERSION } from "../src/seller.js";

const OFFER = {
  schema_version: SELLER_OFFER_SCHEMA_VERSION,
  seller_id: "agent:research-1",
  capability: "cited research pack",
  price_minor: 10000,
  currency: "USDC",
  network: "base",
  payout_wallet: "0xabc0000000000000000000000000000000000001",
  sla_minutes: 15,
  deliverable: { description: "Markdown report with source links", mime_type: "text/markdown" },
};

async function withClient(deps, fn) {
  const server = createMcpServer({ key: generateProcessKey(), funnelDir: null, ...deps });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "witness-probe-test", version: "0.0.0" });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

test("probe refuses cloud-metadata and RFC1918 without fetching", async () => {
  let fetched = 0;
  const fetch = async () => (fetched++, { ok: true, text: async () => "<p>a: 1</p>" });
  for (const [url, reason] of [
    ["https://169.254.169.254/latest/meta-data/", "blocked_host"],
    ["https://10.0.0.5/x", "blocked_host"],
    ["https://192.168.1.1/x", "blocked_host"],
    ["http://169.254.169.254/latest/meta-data/", "https_only"],
  ]) {
    const out = await handleMcpQuote({ url, extract: { a: "number" } }, { fetch });
    assert.equal(out.status, 422, url);
    assert.equal(out.json.reason, reason, url);
  }
  assert.equal(fetched, 0, "refused before any fetch");
});

test("probe allows loopback http for local dev", async () => {
  const out = await handleMcpQuote(
    { url: "http://127.0.0.1:9/page", extract: { price: "number" } },
    { fetch: async () => ({ ok: true, text: async () => "<p>price: 5.99</p>" }) },
  );
  assert.equal(out.status, 200);
  const rendered = renderMcpQuote(out, { assertion: undefined });
  assert.equal(rendered.isError, false);
});

test("bare offer form passes through the validate tool untouched", async () => {
  await withClient({}, async (client) => {
    const res = await client.callTool({ name: "witness_validate_offer", arguments: { ...OFFER } });
    assert.equal(res.isError, false);
    const json = JSON.parse(res.content[0].text);
    assert.equal(json.success, true);
    assert.equal(json.data.seller_card.seller_id, OFFER.seller_id);
  });
});

test("mcp quotes record under route mcp only when a funnel dir is configured", async () => {
  const funnelDir = mkdtempSync(path.join(os.tmpdir(), "wit-mcp-probe-"));
  const fetch = async () => ({ ok: true, text: async () => "<p>price: 5.99</p>" });
  await withClient({ funnelDir, fetch }, async (client) => {
    await client.callTool({
      name: "witness_quote",
      arguments: { url: "http://127.0.0.1:9/page", extract: { price: "number" }, assertion: "price < 10" },
    });
  });
  const rows = readFileSync(path.join(funnelDir, "funnel.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].route, "mcp");
  assert.equal(rows[0].outcome, "mcp_quote_deliverable");
  assert.equal(rows[0].verdict, "supported");
});
