import { test } from "node:test";
import assert from "node:assert";
import { fillExtract } from "../src/extract.js";

test("string extract: label syntax (bounds unchanged)", () => {
  assert.deepEqual(fillExtract("currency: USD", { currency: "string" }), { values: { currency: "USD" }, missing: [] });
  assert.deepEqual(fillExtract("currency = USD", { currency: "string" }), { values: { currency: "USD" }, missing: [] });
  assert.deepEqual(fillExtract("currency: USD EUR", { currency: "string" }).values.currency, "USD", "bare value stops at whitespace");
});

test("string extract: quoted JSON keys and values", () => {
  const pypi = JSON.stringify({ info: { version: "2.32.5" } });
  assert.deepEqual(fillExtract(pypi, { version: "string" }).values.version, "2.32.5", "quoted key + quoted value (PyPI shape)");
  const withSpaces = JSON.stringify({ title: "Essence Mascara Lash" });
  assert.deepEqual(fillExtract(withSpaces, { title: "string" }).values.title, "Essence Mascara Lash", "quoted value keeps interior spaces, bounded by closing quote");
});

test("string extract: missing and empty cases", () => {
  assert.deepEqual(fillExtract("{}", { version: "string" }).missing, ["version"]);
  assert.deepEqual(fillExtract('{"version":""}', { version: "string" }).missing, ["version"], "empty quoted value is missing, not an empty answer");
  assert.deepEqual(fillExtract("different: text", { version: "string" }).missing, ["version"]);
});

test("number extract: quoted JSON keys/values still parse", () => {
  assert.deepEqual(fillExtract('{"stock":43}', { stock: "number" }).values.stock, 43);
  assert.deepEqual(fillExtract(JSON.stringify({ data: { amount: "43125.67" } }), { amount: "number" }).values.amount, 43125.67);
  assert.deepEqual(fillExtract("no numbers here", { stock: "number" }).missing, ["stock"]);
});
