import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateProcessKey, pubkeyB64 } from "../src/receipt.js";
import { createMandateLedger } from "../src/mandate-ledger.js";
import { evaluateMandate, handleGetPurchase, licenseUrlDigest, loadIssuerPubkeys, merchantPayee, signMandate } from "../src/mandate.js";
import { OFFERS } from "../src/offers.js";
import { createStorefrontBackend } from "../src/storefront-backend.js";
import { createHostApp } from "../src/listen.js";

const ID = "pixel-surplus-vintage-polaroid";
const offer = OFFERS[ID];
const subject = "agent:alice";

function fields(over = {}) {
  return {
    kid: "issuer-1",
    subject,
    mandate_id: over.mandate_id ?? "m-1",
    offer_id: ID,
    merchant: offer.merchant,
    payee: merchantPayee(offer),
    variant_id: offer.variant_id,
    quantity: 1,
    currency: "USD",
    max_total_minor: 1000,
    expires_at: "2026-12-31T00:00:00.000Z",
    recurring: "none",
    license_url: offer.license_url,
    ...over,
  };
}

function setup() {
  const kp = generateProcessKey();
  const issuerKeys = { "issuer-1": kp.publicKey };
  const ledger = createMandateLedger();
  const now = () => new Date("2026-09-11T00:00:00.000Z");
  return { kp, issuerKeys, ledger, now };
}

test("valid mandate is eligible and never payment_authorized", () => {
  const { kp, issuerKeys, ledger, now } = setup();
  const out = evaluateMandate(signMandate(fields(), kp), { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now });
  assert.equal(out.ok, true);
  assert.equal(out.json.eligible, true);
  assert.equal(out.json.payment_authorized, false);
  assert.equal(out.json.order_status, "not_created");
  assert.equal(out.json.enforcement_scope, "eligibility_only");
  assert.match(out.json.purchase_id, /^pur_/);
});

test("attacker-supplied public key is ignored; unknown kid and bad signature fail closed", () => {
  const { kp, issuerKeys, ledger, now } = setup();
  const other = generateProcessKey();
  const signed = signMandate(fields(), kp);
  const forged = { ...signMandate(fields({ kid: "attacker" }), other), publicKey: other.publicKey };
  assert.equal(evaluateMandate(forged, { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now }).json.reason, "unknown_issuer");
  const tampered = { ...signed, max_total_minor: 999999 };
  assert.equal(evaluateMandate(tampered, { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now }).json.reason, "invalid_signature");
});

test("expired, subject mismatch, payee/license/variant changes fail closed", () => {
  const { kp, issuerKeys, ledger } = setup();
  const expired = evaluateMandate(signMandate(fields({ expires_at: "2020-01-01T00:00:00.000Z" }), kp), {
    issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now: () => new Date("2026-09-11T00:00:00.000Z"),
  });
  assert.equal(expired.json.reason, "expired");
  assert.equal(expired.json.payment_authorized, false);

  const wrongSubject = evaluateMandate(signMandate(fields(), kp), {
    issuerKeys, ledger, subject: "agent:bob", offer_id: ID, quantity: 1, now: () => new Date("2026-09-11T00:00:00.000Z"),
  });
  assert.equal(wrongSubject.json.reason, "subject_mismatch");

  for (const [over, reason] of [
    [{ payee: "https://other-merchant.example" }, "payee_mismatch"],
    [{ license_url: "https://other.example/license", license_digest: licenseUrlDigest("https://other.example/license") }, "license_mismatch"],
    [{ variant_id: "1" }, "variant_mismatch"],
  ]) {
    const out = evaluateMandate(signMandate(fields(over), kp), {
      issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now: () => new Date("2026-09-11T00:00:00.000Z"),
    });
    assert.equal(out.json.reason, reason);
    assert.equal(out.json.payment_authorized, false);
  }
});

test("cart over the mandate ceiling is budget_exceeded; two $6 attempts under $10 allow once", () => {
  const { kp, issuerKeys, ledger, now } = setup();
  const over = evaluateMandate(signMandate(fields({ mandate_id: "m-ceil", max_total_minor: 500 }), kp), {
    issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now,
  });
  assert.equal(over.ok, false);
  assert.equal(over.json.reason, "budget_exceeded");
  assert.equal(over.json.payment_authorized, false);

  const doc = signMandate(fields({ mandate_id: "m-cap", max_total_minor: 1000 }), kp);
  const first = evaluateMandate(doc, { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, attempt: "a", now });
  const second = evaluateMandate(doc, { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, attempt: "b", now });
  assert.equal(first.ok, true);
  assert.equal(first.json.replay, false);
  assert.equal(second.ok, false);
  assert.equal(second.json.reason, "budget_exceeded");
  assert.equal(second.json.payment_authorized, false);
});

test("identical retry replays the purchase_id; changed input on same mandate_id conflicts", () => {
  const { kp, issuerKeys, ledger, now } = setup();
  const doc = signMandate(fields({ mandate_id: "m-idem" }), kp);
  const a = evaluateMandate(doc, { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now });
  const b = evaluateMandate(doc, { issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now });
  assert.equal(a.json.purchase_id, b.json.purchase_id);
  assert.equal(b.json.replay, true);

  const changed = signMandate(fields({ mandate_id: "m-idem", quantity: 2, max_total_minor: 2000 }), kp);
  const c = evaluateMandate(changed, { issuerKeys, ledger, subject, offer_id: ID, quantity: 2, now });
  assert.equal(c.json.reason, "idempotency_conflict");
});

test("file ledger survives process restart", () => {
  const { kp, issuerKeys, now } = setup();
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "wit-led-")), "mandates.json");
  const first = evaluateMandate(signMandate(fields({ mandate_id: "m-disk" }), kp), {
    issuerKeys, ledger: createMandateLedger(file), subject, offer_id: ID, quantity: 1, attempt: "a", now,
  });
  const replay = evaluateMandate(signMandate(fields({ mandate_id: "m-disk" }), kp), {
    issuerKeys, ledger: createMandateLedger(file), subject, offer_id: ID, quantity: 1, attempt: "a", now,
  });
  assert.equal(first.json.purchase_id, replay.json.purchase_id);
  assert.equal(replay.json.replay, true);
  const second = evaluateMandate(signMandate(fields({ mandate_id: "m-disk" }), kp), {
    issuerKeys, ledger: createMandateLedger(file), subject, offer_id: ID, quantity: 1, attempt: "b", now,
  });
  assert.equal(second.ok, false);
  assert.equal(second.json.reason, "budget_exceeded");
});

test("missing subject is 401; unconfigured issuer is 503", () => {
  const { kp, now } = setup();
  assert.equal(evaluateMandate(signMandate(fields(), kp), { issuerKeys: { "issuer-1": generateProcessKey().publicKey }, offer_id: ID, quantity: 1, now }).status, 401);
  assert.equal(evaluateMandate(signMandate(fields(), kp), { subject, offer_id: ID, quantity: 1, now }).status, 503);
});

test("prepare_checkout with a bad mandate withholds the URL even if the page is supported", async () => {
  const { kp, issuerKeys, ledger } = setup();
  const backend = createStorefrontBackend({
    issuerKeys,
    ledger,
    observe: async () => ({ verdict: "supported" }),
  });
  const out = await backend.prepare_checkout({
    offer_id: ID,
    subject,
    mandate: signMandate(fields({ payee: "https://evil.example" }), kp),
  });
  assert.equal(out.ok, false);
  assert.equal(out.checkout_url, undefined);
  assert.equal(out.error.reason, "payee_mismatch");
  assert.equal(out.error.payment_authorized, false);
});

test("prepare_checkout with a valid mandate still withholds the URL when the page is contradicted", async () => {
  const { kp, issuerKeys, ledger } = setup();
  const backend = createStorefrontBackend({
    issuerKeys,
    ledger,
    observe: async () => ({ verdict: "contradicted" }),
  });
  const out = await backend.prepare_checkout({
    offer_id: ID,
    subject,
    mandate: signMandate(fields({ mandate_id: "m-contra" }), kp),
  });
  assert.equal(out.ok, false);
  assert.equal(out.checkout_url, undefined);
  assert.equal(out.error.reason, "page_not_supported");
});

test("prepare_checkout with a valid mandate still requires Witness and still does not authorize payment", async () => {
  const { kp, issuerKeys, ledger } = setup();
  const backend = createStorefrontBackend({
    issuerKeys,
    ledger,
    observe: async () => ({ verdict: "supported" }),
  });
  const out = await backend.prepare_checkout({
    offer_id: ID,
    subject,
    mandate: signMandate(fields({ mandate_id: "m-gate" }), kp),
  });
  assert.equal(out.ok, true);
  assert.ok(out.checkout_url.startsWith("https://pixel-surplus.myshopify.com/cart/"));
  assert.equal(out.checkout.mandate.payment_authorized, false);
  assert.equal(out.checkout.mandate.enforcement_scope, "eligibility_only");
  assert.equal(out.checkout.payment_authorized, undefined);
});

test("host app keeps one ledger across requests; pubkey file is the only trust file", async () => {
  const { kp } = setup();
  const dir = mkdtempSync(path.join(os.tmpdir(), "wit-host-"));
  writeFileSync(path.join(dir, "issuers.json"), JSON.stringify({ "issuer-1": pubkeyB64(kp) }));
  const server = createHostApp({
    OBSERVATIONS_DIR: dir,
    MANDATE_ISSUER_PUBKEYS_FILE: path.join(dir, "issuers.json"),
    MANDATE_LEDGER_FILE: path.join(dir, "mandates.json"),
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const body = JSON.stringify({
      subject, offer_id: ID, quantity: 1, attempt: "a",
      mandate: signMandate(fields({ mandate_id: "m-persist" }), kp),
    });
    const first = await fetch(`${base}/authorize-purchase`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const again = await fetch(`${base}/authorize-purchase`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const a = await first.json();
    const b = await again.json();
    assert.equal(first.status, 200);
    assert.equal(a.purchase_id, b.purchase_id);
    assert.equal(b.replay, true);
    assert.equal(a.payment_authorized, false);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.ok(loadIssuerPubkeys(path.join(dir, "issuers.json"))["issuer-1"]);
});

test("POST /authorize-purchase is eligibility-only on the host", async () => {
  const { kp, issuerKeys, ledger } = setup();
  const server = createHostApp({
    OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-auth-")),
    mandateIssuerKeys: issuerKeys,
    mandateLedger: ledger,
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/authorize-purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, offer_id: ID, quantity: 1, mandate: signMandate(fields({ mandate_id: "m-http" }), kp) }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.payment_authorized, false);
    assert.equal(json.order_status, "not_created");
    assert.equal(json.eligible, true);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("same-subject GET retrieves the purchase; never infers paid", () => {
  const { kp, issuerKeys, ledger, now } = setup();
  const created = evaluateMandate(signMandate(fields({ mandate_id: "m-get" }), kp), {
    issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now,
  });
  const got = handleGetPurchase({ purchase_id: created.json.purchase_id, subject }, { ledger });
  assert.equal(got.status, 200);
  assert.equal(got.json.purchase_id, created.json.purchase_id);
  assert.equal(got.json.eligible, true);
  assert.equal(got.json.payment_authorized, false);
  assert.equal(got.json.order_status, "not_created");
  assert.equal(got.json.enforcement_scope, "eligibility_only");

  const row = ledger.get(created.json.purchase_id);
  row.decision.payment_authorized = true;
  row.decision.order_status = "paid";
  const reread = handleGetPurchase({ purchase_id: created.json.purchase_id, subject }, { ledger });
  assert.equal(reread.json.payment_authorized, false);
  assert.equal(reread.json.order_status, "not_created");
});

test("missing subject is 401; other subject and unknown id are 404", () => {
  const { kp, issuerKeys, ledger, now } = setup();
  const created = evaluateMandate(signMandate(fields({ mandate_id: "m-priv" }), kp), {
    issuerKeys, ledger, subject, offer_id: ID, quantity: 1, now,
  });
  const id = created.json.purchase_id;
  assert.equal(handleGetPurchase({ purchase_id: id }, { ledger }).status, 401);
  assert.equal(handleGetPurchase({ purchase_id: id, subject: "agent:bob" }, { ledger }).status, 404);
  assert.equal(handleGetPurchase({ purchase_id: "pur_missing", subject }, { ledger }).json.reason, "purchase_not_found");
  assert.equal(handleGetPurchase({ purchase_id: id, subject: "agent:bob" }, { ledger }).json.reason, "purchase_not_found");
  assert.equal(handleGetPurchase({ purchase_id: id, subject: "agent:bob" }, { ledger }).json.payment_authorized, false);
});

test("GET /api/purchases/:id is header-auth only; query subject is ignored", async () => {
  const { kp, issuerKeys, ledger } = setup();
  const server = createHostApp({
    OBSERVATIONS_DIR: mkdtempSync(path.join(os.tmpdir(), "wit-get-")),
    mandateIssuerKeys: issuerKeys,
    mandateLedger: ledger,
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await fetch(`${base}/authorize-purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, offer_id: ID, quantity: 1, mandate: signMandate(fields({ mandate_id: "m-hdr" }), kp) }),
    });
    const { purchase_id } = await created.json();
    const ok = await fetch(`${base}/api/purchases/${purchase_id}`, { headers: { "x-witness-subject": subject } });
    const json = await ok.json();
    assert.equal(ok.status, 200);
    assert.equal(json.purchase_id, purchase_id);
    assert.equal(json.payment_authorized, false);
    assert.equal(json.order_status, "not_created");

    const leaked = await fetch(`${base}/api/purchases/${purchase_id}?subject=${encodeURIComponent(subject)}`);
    assert.equal(leaked.status, 401);

    const other = await fetch(`${base}/api/purchases/${purchase_id}`, { headers: { "x-witness-subject": "agent:bob" } });
    assert.equal(other.status, 404);

    const restarted = await fetch(`${base}/api/purchases/${purchase_id}`, { headers: { "x-witness-subject": subject } });
    assert.equal(restarted.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("file ledger GET survives a new process", () => {
  const { kp, issuerKeys, now } = setup();
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "wit-getled-")), "mandates.json");
  const created = evaluateMandate(signMandate(fields({ mandate_id: "m-disk-get" }), kp), {
    issuerKeys, ledger: createMandateLedger(file), subject, offer_id: ID, quantity: 1, now,
  });
  const got = handleGetPurchase(
    { purchase_id: created.json.purchase_id, subject },
    { ledger: createMandateLedger(file) },
  );
  assert.equal(got.status, 200);
  assert.equal(got.json.purchase_id, created.json.purchase_id);
  assert.equal(got.json.payment_authorized, false);
});
