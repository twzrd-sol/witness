import { test } from "node:test";
import assert from "node:assert";
import { createHostApp } from "../src/listen.js";

async function withServer(env, fn) {
  const server = createHostApp(env).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test("discovery GETs: robots, llms, skill, well-knowns (200, no pay)", async () => {
  await withServer({ EVM_ADDRESS: "0xabc0000000000000000000000000000000000001", SVM_ADDRESS: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" }, async (base) => {
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    const rb = await robots.text();
    assert.match(rb, /Disallow: \/witness/);
    assert.match(rb, /Allow: \/quote/);

    for (const p of ["/llms.txt", "/skill.md"]) {
      const doc = await fetch(`${base}${p}`);
      assert.equal(doc.status, 200);
      const body = await doc.text();
      assert.match(body, /https:\/\/outbid\.sh\/top/, `${p} documents the observed URL`);
      assert.match(body, /0\.01/, `${p} states the price`);
    }

    const x402 = await (await fetch(`${base}/.well-known/x402`)).json();
    assert.equal(x402.price_usdc, "0.01");
    assert.deepEqual(x402.accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    assert.ok(x402.accepts.every((a) => a.payTo));

    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(card.url, "https://witness.outbid.sh");
    assert.ok(card.skills.length);
  });
});

test("x402 descriptor is empty without payTo env; quote 503s unwired; witness 402s inline", async () => {
  await withServer({}, async (base) => {
    const x402 = await (await fetch(`${base}/.well-known/x402`)).json();
    assert.deepEqual(x402.accepts, [], "no payTo env -> no accepts");

    const quote = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", extract: { a: "string" } }) });
    assert.equal(quote.status, 503);
    assert.equal((await quote.json()).reason, "retrieve_not_wired");

    const witness = await fetch(`${base}/witness`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.com", extract: { a: "string" } }) });
    assert.equal(witness.status, 503, "deliverability-first: unpaid witness cannot pass the quote without a retrieve adapter");
  });
});
