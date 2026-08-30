import { test } from "node:test";
import assert from "node:assert";
import { makeRetrieve } from "../src/retrieve.js";
import { createHostApp } from "../src/listen.js";

const ok = (text) => async () => ({ ok: true, status: 200, text: async () => text });

test("reader adapter is fail-closed: refuse, error, non-200, empty all throw", async () => {
  await assert.rejects(makeRetrieve({ fetch: async () => { throw new Error("reader down"); } })("https://example.com"), /reader down/);
  await assert.rejects(makeRetrieve({ fetch: async () => ({ ok: false, status: 502, text: async () => "" }) })("https://example.com"), /reader_502/);
  await assert.rejects(makeRetrieve({ fetch: ok("   ") })("https://example.com"), /reader_empty/);
  await assert.rejects(makeRetrieve({ fetch: ok("x") })("http://example.com"), /retrieve_refused/);
  await assert.rejects(makeRetrieve({ fetch: ok("x") })("not-a-url"), /retrieve_refused/);
  assert.equal(await makeRetrieve({ fetch: ok("hello") })("https://example.com/top"), "hello");
});

test("quote 200 with fixture retrieve — reader URL carries the encoded target", async () => {
  let seen;
  const readerFetch = async (url) => {
    seen = url;
    return { ok: true, status: 200, text: async () => "rank: 1\nbid_usdc: 5" };
  };
  const server = createHostApp({}, { readerFetch }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/quote`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/top", extract: { rank: "number" } }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).can_deliver, true);
    assert.equal(seen, "https://reader.outbid.sh/scrape?url=https%3A%2F%2Fexample.com%2Ftop");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
