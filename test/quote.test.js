import { test } from "node:test";
import assert from "node:assert";
import { assertPublicHttps, SsrfError } from "../src/ssrf.js";
import { generateProcessKey } from "../src/receipt.js";
import { createApp, handleQuote } from "../src/server.js";

const FIXTURE = `<p>starter_price: $49/mo</p><p>currency: USD</p>`;
const EXTRACT = { starter_price: "number", currency: "string" };
const BODY = { url: "https://example.com/pricing", extract: EXTRACT };

test("SSRF refuse http://127.0.0.1/", async () => {
  for (const bad of ["http://127.0.0.1/", "https://127.0.0.1/x", "file:///etc/passwd"]) {
    await assert.rejects(() => assertPublicHttps(bad), SsrfError);
  }
  await assert.rejects(() => assertPublicHttps("https://witness-dns-refuse.invalid/"), SsrfError);
});

test("quote 422 when extract keys missing from fixture html", async () => {
  let n = 0;
  const out = await handleQuote(BODY, { retrieve: async () => (n++, { text: "<p>hi</p>" }) });
  assert.equal(out.status, 422);
  assert.equal(out.json.reason, "extract_missing");
  assert.equal(n, 1);
});

test("quote 200 when fixture html fills extract", async () => {
  const out = await handleQuote(BODY, { retrieve: async () => ({ text: FIXTURE }) });
  assert.deepEqual(out.json, { price_usdc: "0.01", replicas: 1, can_deliver: true });
});

test("quote 422s assertion failures before payment", async () => {
  const out = await handleQuote({ ...BODY, assertion: "starter_price < 10" }, { retrieve: async () => ({ text: FIXTURE }) });
  assert.equal(out.status, 422);
  assert.equal(out.json.reason, "assertion_failed");
});

test("scrape 422 does not call browse", async () => {
  let scrape = 0, browse = 0;
  const out = await handleQuote(BODY, {
    retrieve: async () => { scrape++; throw new Error("needs_browser"); },
  });
  assert.equal(out.status, 422);
  assert.equal(scrape, 1);
  assert.equal(browse, 0);
});

test("POST /quote SSRF does not retrieve", async () => {
  let n = 0;
  const app = createApp({ key: generateProcessKey(), retrieve: async () => (n++, { text: FIXTURE }) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "http://127.0.0.1/", extract: EXTRACT }),
  });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).reason, "https_only");
  assert.equal(n, 0);
  await new Promise((r) => server.close(r));
});
