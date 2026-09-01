import { test } from "node:test";
import assert from "node:assert";
import { evalAssertion } from "../src/receipt.js";

test("assertion v1: numeric ==, <, <=, >, >=", () => {
  const v = { rank: 1, price: 49, temp: -2.5 };
  assert.equal(evalAssertion(v, "rank < 100"), true);
  assert.equal(evalAssertion(v, "rank <= 1"), true);
  assert.equal(evalAssertion(v, "rank == 1"), true);
  assert.equal(evalAssertion(v, "rank == 2"), false);
  assert.equal(evalAssertion(v, "price >= 49"), true);
  assert.equal(evalAssertion(v, "price > 49"), false);
  assert.equal(evalAssertion(v, "temp == -2.5"), true);
  assert.equal(evalAssertion(v, "rank < 1"), false);
});

test("assertion v1: string == with quoted literals", () => {
  const v = { currency: "USD", side: "ask" };
  assert.equal(evalAssertion(v, 'currency == "USD"'), true);
  assert.equal(evalAssertion(v, "currency == 'USD'"), true);
  assert.equal(evalAssertion(v, 'currency == "EUR"'), false);
  assert.equal(evalAssertion(v, 'side == "ask"'), true);
});

test("assertion v1: exists", () => {
  const v = { rank: 1, note: "", maybe: null };
  assert.equal(evalAssertion(v, "rank exists"), true);
  assert.equal(evalAssertion(v, "note exists"), true);
  assert.equal(evalAssertion(v, "missing exists"), false);
  assert.equal(evalAssertion(v, "maybe exists"), false);
});

test("assertion v1: type mismatches are false, never coerced", () => {
  assert.equal(evalAssertion({ rank: "1" }, "rank < 100"), false, "string value vs numeric literal");
  assert.equal(evalAssertion({ rank: "1" }, "rank == 1"), false, "numeric == requires number type");
  assert.equal(evalAssertion({ rank: 1 }, 'rank == "1"'), false, "string == requires string type");
  assert.equal(evalAssertion({ rank: 1 }, "rank < '5'"), false, "ordering ops are numeric-only");
  assert.equal(evalAssertion({ rank: 1 }, "missing < 5"), false, "missing key");
});

test("assertion v1: malformed assertions are false (reject-by-default)", () => {
  for (const bad of ["rank !!= 5", "rank <", "< 5", "rank >=", "rank = 5", "rank === 5", "rank <", "rank <> 5", "rank < 5 6", "drop table", "rank =< 5", "5 < rank"]) {
    assert.equal(evalAssertion({ rank: 1 }, bad), false, `malformed: ${bad}`);
  }
  assert.equal(evalAssertion({ rank: 1 }, "rank == unquoted"), false, "unquoted non-numeric RHS");
  assert.equal(evalAssertion({ rank: 1 }, ""), true, "empty assertion -> unconstrained");
  assert.equal(evalAssertion({ rank: 1 }, null), true, "null assertion -> unconstrained");
  assert.equal(evalAssertion({ rank: 1 }, undefined), true, "undefined assertion -> unconstrained");
});
