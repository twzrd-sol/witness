import { test } from "node:test";
import assert from "node:assert";
import { generateProcessKey, signReceipt, verifyReceipt } from "../src/receipt.js";
import {
  renderReceipt,
  renderReceiptHtml,
  renderReceiptJson,
  renderReceiptMcp,
} from "../src/render.js";

function makeReceipt(overrides = {}) {
  const key = generateProcessKey();
  const rest = {
    value: { price: 49.99, currency: "USD" },
    assertion: "price < 100",
    observed_at: "2026-09-08T20:00:00.000Z",
    valid_until: "2026-09-08T21:00:00.000Z",
    source_hash: "sha256:abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
    requested_url: "https://example.com/item",
    final_url: null,
    origin_status: null,
    origin_content_type: null,
    representation: { kind: "reader_plaintext", sha256: "sha256:abcd1234", retrieved_at: "2026-09-08T20:00:00.000Z" },
    evidence: "price: $49.99/mo currency: USD",
    evidence_spans: { price: { start: 7, end: 12 }, currency: { start: 23, end: 26 } },
    verdict: "supported",
    verdict_reason: null,
    agreement: "1-of-1",
    method: { url: "https://example.com/item", extract: { price: "number", currency: "string" }, assertion: "price < 100", retrieval: "scrape" },
    spec_hash: "sha256:spec1234spec1234",
    vantage: "box",
    ...overrides,
  };
  return { receipt: signReceipt(rest, key), key };
}

test("renderReceiptJson: serializes signed receipt and preserves offline verifiability", () => {
  const { receipt, key } = makeReceipt();
  const jsonStr = renderReceiptJson(receipt);
  const parsed = JSON.parse(jsonStr);

  assert.equal(parsed.verdict, "supported");
  assert.equal(parsed.requested_url, "https://example.com/item");
  assert.ok(verifyReceipt(parsed, key.publicKey), "parsed json must verify against public key");

  const canonicalJson = renderReceiptJson(receipt, { pretty: false });
  assert.equal(typeof canonicalJson, "string");
  assert.ok(verifyReceipt(JSON.parse(canonicalJson), key.publicKey));
});

test("renderReceiptHtml: renders all four reachable receipt states", () => {
  const states = [
    { verdict: "supported", reason: null, badge: "SUPPORTED" },
    { verdict: "contradicted", reason: "assertion_false", badge: "CONTRADICTED" },
    { verdict: "incomplete", reason: "assertion_field_absent", badge: "INCOMPLETE", missing: ["stock"] },
    { verdict: null, reason: null, badge: "OBSERVED", assertion: null },
  ];

  for (const st of states) {
    const { receipt } = makeReceipt({
      verdict: st.verdict,
      verdict_reason: st.reason,
      assertion: st.assertion !== undefined ? st.assertion : "price < 100",
      ...(st.missing ? { missing: st.missing } : {}),
    });

    const html = renderReceiptHtml(receipt);
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes(st.badge), `HTML should include badge text ${st.badge}`);
    assert.ok(html.includes("https://example.com/item"));
    assert.ok(html.includes(receipt.source_hash));
    assert.ok(html.includes(receipt.receipt));
    if (st.reason) {
      assert.ok(html.includes(st.reason));
    }
  }
});

test("renderReceiptHtml: escapes dynamic inputs to prevent XSS", () => {
  const xssUrl = "https://example.com/<script>alert('xss')</script>";
  const xssSnippet = `<img src=x onerror=alert('xss')>`;
  const { receipt } = makeReceipt({
    requested_url: xssUrl,
    evidence: xssSnippet,
  });

  const html = renderReceiptHtml(receipt);
  assert.ok(!html.includes("<script>alert('xss')</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"));
  assert.ok(!html.includes("<img src=x onerror=alert('xss')>"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(&#39;xss&#39;)&gt;"));
});

test("renderReceiptHtml: handles v2 evidence array", () => {
  const { receipt } = makeReceipt({
    evidence: [
      { field: "price", quote: "$49.99", location: { encoding: "utf16", start: 7, end: 12 } },
      { field: "currency", quote: "USD", location: { encoding: "utf16", start: 23, end: 26 } },
    ],
  });

  const html = renderReceiptHtml(receipt);
  assert.ok(html.includes("&ldquo;$49.99&rdquo;"));
  assert.ok(html.includes("offsets [7:12]"));
});

test("renderReceiptMcp: formats MCP tool response compliant with model-context-protocol", () => {
  const { receipt } = makeReceipt({
    verdict: "contradicted",
    verdict_reason: "assertion_false",
  });

  const mcp = renderReceiptMcp(receipt);
  assert.equal(mcp.isError, false);
  assert.ok(Array.isArray(mcp.content));
  assert.equal(mcp.content.length, 1);
  assert.equal(mcp.content[0].type, "text");

  const text = mcp.content[0].text;
  assert.ok(text.includes("# Witness Observation Receipt"));
  assert.ok(text.includes("- **Verdict**: CONTRADICTED (assertion_false)"));
  assert.ok(text.includes("- **Target URL**: https://example.com/item"));
  assert.ok(text.includes("- **price**: `49.99`"));
  assert.ok(text.includes("## Signature"));
  assert.ok(text.includes(receipt.receipt));
});

test("verdict classification: mixed is recognized, absent is OBSERVED, unrecognized renders UNKNOWN", () => {
  // 1. mixed (from compareReceipts / multi-vantage disagreement)
  const { receipt: mixedReceipt } = makeReceipt({ verdict: "mixed" });
  const mixedHtml = renderReceiptHtml(mixedReceipt);
  assert.ok(mixedHtml.includes("MIXED"));
  assert.ok(!mixedHtml.includes("OBSERVED"));
  const mixedMcp = renderReceiptMcp(mixedReceipt);
  assert.ok(mixedMcp.content[0].text.includes("- **Verdict**: MIXED"));
  assert.equal(mixedMcp.isError, false);

  // 2. null and absent (undefined) both render as OBSERVED (unasserted)
  const { receipt: nullReceipt } = makeReceipt({ verdict: null, assertion: null });
  const nullHtml = renderReceiptHtml(nullReceipt);
  assert.ok(nullHtml.includes("OBSERVED"));
  assert.ok(nullHtml.includes("No assertion stated; fact observation only"));
  assert.equal(renderReceiptMcp(nullReceipt).isError, false);

  const { receipt: absentReceipt } = makeReceipt({ verdict: undefined, assertion: null });
  delete absentReceipt.verdict;
  const absentHtml = renderReceiptHtml(absentReceipt);
  assert.ok(absentHtml.includes("OBSERVED"));
  assert.ok(absentHtml.includes("No assertion stated; fact observation only"));
  assert.equal(renderReceiptMcp(absentReceipt).isError, false);

  // 3. Unrecognized verdicts (corrupted string, number) must render UNKNOWN, never OBSERVED
  for (const bad of ["corrupted", 42, "unexpected_status"]) {
    const { receipt: badReceipt } = makeReceipt({ verdict: bad });
    const badHtml = renderReceiptHtml(badReceipt);
    assert.ok(badHtml.includes("UNKNOWN"), `verdict ${bad} must render UNKNOWN badge`);
    assert.ok(!badHtml.includes("OBSERVED"), `verdict ${bad} must not render OBSERVED`);
    assert.ok(!badHtml.includes("No assertion stated"), `verdict ${bad} must not imply benign unasserted state`);
    assert.ok(badHtml.includes(`unrecognized: ${bad}`));

    const badMcp = renderReceiptMcp(badReceipt);
    assert.ok(badMcp.content[0].text.includes(`- **Verdict**: UNKNOWN (unrecognized: ${bad})`));
    assert.equal(badMcp.isError, true, `MCP response for invalid verdict ${bad} must set isError: true`);
  }
});

test("renderReceipt: universal dispatcher routes across all three renderings", () => {
  const { receipt } = makeReceipt();

  const json = renderReceipt(receipt, "json");
  assert.equal(typeof json, "string");
  assert.ok(JSON.parse(json).receipt);

  const html = renderReceipt(receipt, "html");
  assert.ok(html.startsWith("<!doctype html>"));

  const mcp = renderReceipt(receipt, "mcp");
  assert.equal(mcp.isError, false);
  assert.equal(mcp.content[0].type, "text");

  assert.throws(() => renderReceipt(receipt, "unknown_format"), /unsupported_render_format/);
  assert.throws(() => renderReceipt(null, "json"), /invalid_receipt/);
});
