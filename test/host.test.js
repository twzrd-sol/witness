import { test } from "node:test";
import assert from "node:assert";
import { createHostApp, readerPayment } from "../src/listen.js";

async function withServer(env, fn, opts = {}) {
  const server = createHostApp(env, opts).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test("discovery GETs: robots, llms, skill, well-knowns (200, no pay)", async () => {
  await withServer({ EVM_ADDRESS: "0xabc0000000000000000000000000000000000001", SVM_ADDRESS: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" }, async (base) => {
    const robots = await fetch(`${base}/robots.txt`);
    assert.equal(robots.status, 200);
    const rb = await robots.text();
    assert.ok(/Disallow: \/witness/.test(rb) && /Allow: \/quote/.test(rb), "robots allows discovery, disallows /witness");

    for (const p of ["/llms.txt", "/skill.md"]) {
      const doc = await fetch(`${base}${p}`);
      assert.equal(doc.status, 200);
      const body = await doc.text();
      assert.match(body, /https:\/\/outbid\.sh\/top/, `${p} documents the observed URL`);
      assert.match(body, /0\.01/, `${p} states the price`);
    }

    const x402 = await (await fetch(`${base}/.well-known/x402`)).json();
    assert.equal(x402.resource, "https://witness.outbid.sh/witness", "well-known resource is the canonical https URL");
    assert.equal(x402.price_usdc, "0.01");
    assert.deepEqual(x402.accepts.map((a) => a.network).sort(), ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]);
    assert.ok(x402.accepts.every((a) => a.payTo));

    const card = await (await fetch(`${base}/.well-known/agent.json`)).json();
    assert.equal(card.url, "https://witness.outbid.sh");
    assert.ok(card.skills.length);
  });
});

test("default documented method extract is rank-only (llms.txt METHOD_DOC)", async () => {
  await withServer({}, async (base) => {
    const body = await (await fetch(`${base}/llms.txt`)).text();
    const block = body.match(/```json\n([\s\S]*?)```/);
    assert.ok(block, "llms.txt carries the METHOD_DOC json block");
    const method = JSON.parse(block[1]);
    assert.equal(method.url, "https://outbid.sh/top");
    assert.equal(method.retrieval, "scrape");
    assert.equal(method.assertion, "rank < 100");
    assert.deepEqual(method.extract, { rank: "number" }, "extract is rank-only — no bid_usdc/url required keys");
  });
});

test("reader payment wiring: payFetch only when enabled AND valid wallet key", async () => {
  const underlying = async () => new Response("ok");
  assert.deepEqual(readerPayment({}, underlying), {});
  assert.deepEqual(readerPayment({ X402_READER_PAYMENTS_ENABLED: "1" }, underlying), {}, "flag without wallet stays unpaid");
  assert.deepEqual(readerPayment({ X402_READER_PAYMENTS_ENABLED: "1", X402_READER_WALLET_KEY: "0x1234" }, underlying), {}, "invalid key stays unpaid");
  const pay = readerPayment({ X402_READER_PAYMENTS_ENABLED: "1", X402_READER_WALLET_KEY: "0x" + "11".repeat(32) }, underlying);
  assert.equal(pay.paymentsEnabled, true);
  assert.equal(typeof pay.payFetch, "function");
  const res = await pay.payFetch("https://reader.outbid.sh/scrape?url=https%3A%2F%2Fexample.com%2Ftop");
  assert.equal(res.ok, true, "a 200 passes through the paying wrapper untouched, no payment made");
});

test("x402 descriptor empty without payTo env; quote 200 + unpaid witness 402 via mocked reader", async () => {
  const readerFetch = async () => ({ ok: true, status: 200, text: async () => "a: ok" });
  await withServer({}, async (base) => {
    const x402 = await (await fetch(`${base}/.well-known/x402`)).json();
    assert.deepEqual(x402.accepts, [], "no payTo env -> no accepts");

    const body = JSON.stringify({ url: "https://example.com/top", extract: { a: "string" } });
    const quote = await fetch(`${base}/quote`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(quote.status, 200);
    assert.equal((await quote.json()).can_deliver, true);

    const witness = await fetch(`${base}/witness`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(witness.status, 402, "unpaid witness 402s only after a deliverable quote");
  }, { readerFetch });
});
