import { test } from "node:test";
import assert from "node:assert";
import { fillExtract } from "../src/extract.js";
import { unwrapReader } from "../src/retrieve.js";

// The exact envelope the reader returns, captured from a stored production
// observation: the document arrives JSON-escaped inside `content`.
const envelope = (doc) => JSON.stringify({ ok: true, title: "", content: doc });
const TODO = '{ "userId": 1, "id": 1, "title": "delectus aut autem", "completed": false }';

test("extraction reads the document, not the reader's transport envelope", () => {
  // Escaped, every field reads `\"key\": \"value\"` and the backslash sits where
  // the string matcher needs [:=]. Strings could never match a JSON document.
  const raw = envelope(TODO);
  assert.deepEqual(fillExtract(raw, { title: "string" }).missing, ["title"]);

  const doc = unwrapReader(raw);
  assert.deepEqual(fillExtract(doc, { title: "string" }).values, { title: "delectus aut autem" });
  // Mixed specs are all-or-nothing, so one unmatched string key refused the whole claim.
  assert.deepEqual(fillExtract(doc, { userId: "number", title: "string" }).values,
    { userId: 1, title: "delectus aut autem" });
});

test("unwrap passes through non-envelope bodies and fails closed on reader errors", () => {
  for (const body of ["<html><p>price: 42</p></html>", "plain text, rank = 7", "[1,2,3]", "not json"])
    assert.equal(unwrapReader(body), body);
  assert.throws(() => unwrapReader(JSON.stringify({ ok: false, error: "blocked" })), /reader_not_ok/);
  // An envelope with no usable content is the envelope itself, never an empty document.
  assert.equal(unwrapReader(envelope("")), envelope(""));
});

test("a quoted field beats a bare key= elsewhere in the document", () => {
  // Live regression: `version` on pypi.org matched `?version=latest` inside a
  // README badge URL, and a signed receipt asserted markdown as the version.
  const doc = JSON.stringify({ info: {
    description: "[![Docs](https://readthedocs.org/projects/requests/badge/?version=latest)](https://rtd.io)",
    version: "2.32.5" } });
  assert.deepEqual(fillExtract(doc, { version: "string" }).values, { version: "2.32.5" });
  // With no quoted field to prefer, the loose form still serves HTML and prose.
  assert.deepEqual(fillExtract("<p>status = operational</p>", { status: "string" }).values, { status: "operational" });
});

test("the number matcher stays inside the field it named", () => {
  // Crossing a comma signed the next field's value for a field holding null.
  assert.deepEqual(fillExtract('{"pricing":null,"tax":20}', { pricing: "number" }).missing, ["pricing"]);
  assert.deepEqual(fillExtract('{"pricing":"n/a","tax":20}', { pricing: "number" }).missing, ["pricing"]);
  assert.deepEqual(fillExtract('{"price":9.99,"tax":20}', { price: "number" }).values, { price: 9.99 });
});

test("a number needs a digit, so a lone comma cannot read as zero", () => {
  // `[\d,]+` matched "," and Number("") is 0, which Number.isFinite accepts:
  // a null field signed a confident 0. A real zero must still extract.
  assert.deepEqual(fillExtract('{"qty":0,"tax":20}', { qty: "number" }).values, { qty: 0 });
  assert.deepEqual(fillExtract('{"total":-42.5}', { total: "number" }).values, { total: -42.5 });
  assert.deepEqual(fillExtract('{"amount":"$78,462.81"}', { amount: "number" }).values, { amount: 78462.81 });
});

test("a number's quote is the number, not the delimiter after it", () => {
  // The quote is what a receipt binds as evidence, so `3893,` would claim source
  // bytes for the value that are not part of it. The value was always right.
  const doc = '{"stargazers_count":3893,"x":1}';
  const r = fillExtract(doc, { stargazers_count: "number" });
  assert.deepEqual(r.values, { stargazers_count: 3893 });
  assert.equal(doc.slice(r.spans.stargazers_count.start, r.spans.stargazers_count.end), "3893");
  // Grouping commas inside a number are still part of it.
  const g = fillExtract('{"n":"1,234,567"}', { n: "number" });
  assert.equal('{"n":"1,234,567"}'.slice(g.spans.n.start, g.spans.n.end), "1,234,567");
});
