#!/usr/bin/env node
/**
 * Wave21 ZZZ — LIVE witness host probes (post-AGI, no mocks).
 *
 * Real HTTP against https://witness.outbid.sh: quote / witness / attest / Done-gate
 * on the documented paywall. Unpaid and 402 first. Micro-pay only if --pay is set,
 * a documented payer already exists, TWZRD preflight allows it, and wash is
 * evaluated clean. Never invents a wallet. Never deploys.
 *
 *   node scripts/wave21-live-host-probes.mjs --live \
 *     --out=docs/operator/evidence/wave21-zzz-2026-09-12
 *
 * Exit 0 = live unpaid/402 contract held (or an allowed documented micro-pay
 * was logged). Exit 1 = host mismatch / unbound / unreachable. Exit 2 = usage.
 */
import { mkdirSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import { GATE_METHOD, runOnce, decideGate } from "./shopping-preapproval.mjs";

export const LIVE_HOST = "https://witness.outbid.sh";
export const INTEL_ORIGIN = "https://intel.twzrd.xyz";
export const PRICE_USDC = "0.01";
export const AMOUNT_ATOMIC = "10000";
export const NETWORKS = Object.freeze([
  "eip155:8453",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
]);

/** Issue #1 / llms.txt default method. */
export const DOCUMENTED_METHOD = Object.freeze({
  url: "https://outbid.sh/top",
  retrieval: "scrape",
  extract: Object.freeze({ rank: "number" }),
  assertion: "rank < 100",
  replicas: 1,
});

export { GATE_METHOD };

/** Same shape as src/routes/delivery.js EXAMPLE_BODY, inlined so this CLI
 *  does not load express / the host just to POST an unpaid attest. */
export const ATTEST_BODY = Object.freeze({
  offer: {
    resource_url: "https://stableenrich.dev/api/pdl/people-enrich",
    deliverable_class: "data_json",
    price_usdc: 0.28,
    spec: { required_fields: { query: "string", results: "array", result_count: "number" } },
  },
  request: {
    request_body: { query: "acme corp" },
    settlement_ref: "<settlement tx signature, or null when unknown>",
    requested_at: "2026-09-11T04:00:00Z",
  },
  observation: {
    artifact: { query: "acme corp", results: [{ name: "A" }], result_count: 1 },
    observed_at: "2026-09-11T04:00:20Z",
    mode: "buyer_attested",
    http_status: 200,
    seller_signature: null,
  },
});

/** Operator-documented payer locations only. This process never writes these. */
export const DOCUMENTED_PAYER_PATHS = Object.freeze([
  "/home/twzrd/security/wallets/outbid/receiver.evm.json",
]);

export const CHECK_NAMES = Object.freeze([
  "live_host_allowed",
  "discovery_pubkey",
  "discovery_well_known",
  "discovery_llms",
  "discovery_openapi",
  "get_witness_402",
  "quote_never_402",
  "quote_documented_deliverable_or_honest",
  "quote_gate_method_deliverable_or_honest",
  "quote_bad_extract_400",
  "witness_unpaid_paywall_or_quote_first",
  "witness_challenge_names_resource",
  "witness_challenge_price",
  "witness_challenge_both_rails",
  "witness_bad_extract_never_402",
  "witness_forged_does_not_unlock",
  "witness_unpaid_no_receipt",
  "attest_unpaid_402",
  "attest_challenge_names_resource",
  "attest_challenge_price",
  "attest_challenge_both_rails",
  "attest_shape_never_402",
  "attest_forged_does_not_unlock",
  "attest_unpaid_no_receipt",
  "done_gate_dry_not_complete",
  "done_gate_unpaid_not_approved",
  "preflight_ran",
  "wash_fail_closed",
  "no_invented_payer",
  "spend_logged",
]);

const FORBIDDEN_LOG_KEYS = Object.freeze([
  "privateKey", "private_key", "secret", "secretKey", "PAYMENT-SIGNATURE",
  "payment-signature", "X-PAYMENT", "x-payment", "PAYMENT-RESPONSE",
]);

const UA = "Witness-Wave21-ZZZ/1.0 (+https://github.com/twzrd-sol/witness; live-unpaid-probe)";

export function allowedLiveBase(base) {
  try {
    const u = new URL(base);
    return u.protocol === "https:" && u.origin === LIVE_HOST;
  } catch {
    return false;
  }
}

export function parseChallenge(res) {
  if (!res || typeof res.headers?.get !== "function") return null;
  const raw = res.headers.get("payment-required") || res.headers.get("PAYMENT-REQUIRED");
  if (!raw || typeof raw !== "string") return null;
  for (const decode of [
    () => JSON.parse(raw),
    () => JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    () => JSON.parse(Buffer.from(raw, "base64").toString("utf8")),
  ]) {
    try {
      const v = decode();
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch { /* next encoding */ }
  }
  return null;
}

export function challengeResourceUrl(challenge) {
  if (!challenge || typeof challenge !== "object") return null;
  if (typeof challenge.resource === "string") return challenge.resource;
  if (challenge.resource && typeof challenge.resource.url === "string") return challenge.resource.url;
  return null;
}

export function acceptAmount(a) {
  return a?.amount ?? a?.maxAmountRequired ?? null;
}

export function sanitizeChallenge(challenge) {
  if (!challenge || typeof challenge !== "object") return null;
  const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
  return {
    x402Version: challenge.x402Version ?? null,
    resource: challengeResourceUrl(challenge),
    accepts: accepts.map((a) => ({
      scheme: a?.scheme ?? null,
      network: a?.network ?? null,
      amount: acceptAmount(a),
      asset: typeof a?.asset === "string" ? a.asset : a?.asset?.address ?? null,
      payTo: typeof a?.payTo === "string" ? a.payTo : null,
    })),
  };
}

export function hasSignedReceipt(json) {
  return Boolean(json && typeof json === "object" && typeof json.receipt === "string" && json.receipt.length);
}

export function summarizeBody(json) {
  if (json == null) return null;
  if (typeof json !== "object" || Array.isArray(json)) return { type: typeof json };
  const out = {};
  for (const k of [
    "reason", "can_deliver", "price_usdc", "retrieval", "verdict", "verdict_reason",
    "x402Version", "error", "schema", "delivery_verdict", "pubkey",
    "wash_flagged", "decision", "recommendation", "confidence",
    "classification", "is_circular", "recommended_action",
    "recommended_cap_usdc", "maximum_recommended_spend_usdc", "merchant",
  ]) {
    if (k in json) out[k] = json[k];
  }
  out.has_receipt = hasSignedReceipt(json);
  return out;
}

/** Fail-closed spend gate. Unevaluated wash is not clean. */
export function decideSpend({
  payRequested = false,
  payerPath = null,
  preflight = null,
  merchant = null,
  wash = null,
} = {}) {
  const washFlagged = merchant?.wash_flagged === true
    || wash?.is_circular === true
    || ["self_pay", "reciprocal", "self+reciprocal"].includes(wash?.classification);
  if (washFlagged) return { spend: false, reason: "wash_flagged" };
  if (preflight?.decision === "block" || preflight?.recommended_action === "do_not_pay") {
    return { spend: false, reason: "preflight_block" };
  }
  if (merchant?.decision === "refuse") return { spend: false, reason: "merchant_refuse" };

  const washClean = merchant?.wash_flagged === false
    && wash?.classification === "clean"
    && wash?.is_circular === false;
  if (!washClean) return { spend: false, reason: "wash_unevaluated" };

  if (!payRequested) return { spend: false, reason: "unpaid_preferred" };
  if (!payerPath) return { spend: false, reason: "no_documented_payer" };

  const price = Number(preflight?.price_usdc ?? PRICE_USDC);
  const cap = Number(
    preflight?.maximum_recommended_spend_usdc
    ?? preflight?.recommended_cap_usdc
    ?? 0,
  );
  if (!Number.isFinite(price) || price <= 0) return { spend: false, reason: "price_unknown" };
  if (preflight?.decision === "warn" && (!Number.isFinite(cap) || price > cap)) {
    return { spend: false, reason: "over_cap" };
  }
  return { spend: true, reason: "preflight_allows_micro", price, cap };
}

/**
 * Only an already-on-disk documented path. Never creates files. Env/CLI
 * values must resolve to DOCUMENTED_PAYER_PATHS (or an operator env that
 * already exists and was not minted this run — still must be one of the
 * documented paths so a stranger key cannot sneak in via --keypair).
 */
export function resolveDocumentedPayer({ env = process.env, argv = [], createdThisRun = new Set() } = {}) {
  const fromArg = argv.find((a) => a.startsWith("--keypair="))?.slice(10);
  const fromEnv = env.WITNESS_PAYER_KEYPAIR || env.X402_READER_WALLET_KEY || "";
  const candidates = [fromArg, fromEnv, ...DOCUMENTED_PAYER_PATHS].filter(Boolean);
  for (const p of candidates) {
    const resolved = path.resolve(p);
    if (createdThisRun.has(resolved)) continue;
    const documented = DOCUMENTED_PAYER_PATHS.some((d) => path.resolve(d) === resolved);
    if (!documented) continue;
    if (!existsSync(resolved)) continue;
    return resolved;
  }
  return null;
}

export function assertNoSecrets(value, trail = "$") {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_LOG_KEYS.includes(k)) throw new Error(`forbidden log key ${trail}.${k}`);
      assertNoSecrets(v, `${trail}.${k}`);
    }
  }
}

function check(checks, name, pass, detail, code = null) {
  checks.push({ name, pass: Boolean(pass), detail: detail ?? null, code: pass ? null : (code || "probe_failed") });
}

function finishChecks(checks) {
  const byName = new Map(checks.map((c) => [c.name, c]));
  for (const name of CHECK_NAMES) {
    if (!byName.has(name)) checks.push({ name, pass: false, code: "probe_incomplete", detail: "check did not run" });
  }
  const ordered = CHECK_NAMES.map((name) => checks.find((c) => c.name === name));
  const failed = ordered.filter((c) => !c.pass).map((c) => c.name);
  return { ok: failed.length === 0, checks: ordered, failed };
}

async function timedFetch(doFetch, url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: ac.signal, headers: { "user-agent": UA, ...(init?.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

async function hit(doFetch, url, { method = "GET", body, headers = {}, timeoutMs } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = init.headers["content-type"] || "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await timedFetch(doFetch, url, init, timeoutMs);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  const challenge = parseChallenge(res);
  return {
    url,
    method,
    status: res.status,
    challenge: sanitizeChallenge(challenge),
    body: summarizeBody(json),
    text_len: text.length,
    header_names: [...res.headers.keys()].sort(),
    has_payment_required: Boolean(challenge),
    has_receipt: hasSignedReceipt(json),
  };
}

function svmPayTos(challenges) {
  const out = new Set();
  for (const ch of challenges) {
    for (const a of ch?.accepts || []) {
      if (typeof a.payTo === "string" && a.network && String(a.network).startsWith("solana:")) out.add(a.payTo);
    }
  }
  return [...out];
}

async function livePreflight(doFetch, payTos, timeoutMs, intent) {
  const merchant_cards = [];
  const preflights = [];
  for (const wallet of payTos) {
    const cardHit = await hit(doFetch, `${INTEL_ORIGIN}/v1/intel/merchant_card/${encodeURIComponent(wallet)}`, { timeoutMs });
    merchant_cards.push({ wallet, status: cardHit.status, body: cardHit.body, raw_keys: cardHit.body });
    try {
      const pf = await hit(doFetch, `${INTEL_ORIGIN}/v1/intel/preflight`, {
        method: "POST",
        timeoutMs,
        body: { seller_wallet: wallet, price_usdc: Number(PRICE_USDC), agent_intent: intent },
      });
      preflights.push({ wallet, status: pf.status, body: pf.body });
    } catch (e) {
      preflights.push({ wallet, status: null, error: e.message || String(e) });
    }
  }
  const firstCard = merchant_cards[0];
  const firstPf = preflights[0];
  return {
    fetched_at: new Date().toISOString(),
    intel_origin: INTEL_ORIGIN,
    payTos,
    merchant_cards,
    preflights,
    merchant: {
      wash_flagged: firstCard?.body?.wash_flagged ?? null,
      decision: firstCard?.body?.decision ?? firstCard?.body?.reason ?? null,
    },
    preflight: {
      decision: firstPf?.body?.decision ?? null,
      recommended_action: firstPf?.body?.recommended_action ?? null,
      recommended_cap_usdc: firstPf?.body?.recommended_cap_usdc ?? firstPf?.body?.maximum_recommended_spend_usdc ?? null,
      maximum_recommended_spend_usdc: firstPf?.body?.maximum_recommended_spend_usdc ?? null,
      price_usdc: Number(PRICE_USDC),
    },
    wash: {
      classification: firstCard?.body?.classification ?? (firstCard?.body?.wash_flagged === false ? "clean" : "unknown"),
      is_circular: firstCard?.body?.is_circular ?? false,
    },
  };
}

function quoteOk(hitRow) {
  if (hitRow.status === 402 || hitRow.has_payment_required) return false;
  if (hitRow.has_receipt) return false;
  if (hitRow.status === 200) return hitRow.body?.can_deliver === true;
  if (hitRow.status === 422) return typeof hitRow.body?.reason === "string";
  return false;
}

export async function runLiveProbes(opts = {}) {
  const checks = [];
  const probes = [];
  const base = String(opts.base || LIVE_HOST).replace(/\/$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const payRequested = Boolean(opts.pay);
  const createdThisRun = opts.createdThisRun ?? new Set();
  const payerPath = resolveDocumentedPayer({ env: opts.env ?? process.env, argv: opts.argv ?? [], createdThisRun });

  if (!allowedLiveBase(base)) {
    for (const name of CHECK_NAMES) check(checks, name, false, `refusing non-live host ${base}`, "host_not_allowlisted");
    return { ...finishChecks(checks), probes, spend: { spend: false, reason: "host_not_allowlisted" }, preflight: null, payerPath: null };
  }
  check(checks, "live_host_allowed", true, base);

  const intent = "Wave21 ZZZ live unpaid/402 probe of documented TWZRD witness paywall";

  try {
    const pubkey = await hit(doFetch, `${base}/pubkey`, { timeoutMs });
    probes.push({ name: "GET /pubkey", ...pubkey });
    check(checks, "discovery_pubkey", pubkey.status === 200 && typeof pubkey.body === "object", `status ${pubkey.status}`);

    const wellKnown = await hit(doFetch, `${base}/.well-known/x402`, { timeoutMs });
    probes.push({ name: "GET /.well-known/x402", ...wellKnown });
    check(checks, "discovery_well_known", wellKnown.status === 200, `status ${wellKnown.status}`);

    const llms = await hit(doFetch, `${base}/llms.txt`, { timeoutMs });
    probes.push({ name: "GET /llms.txt", ...llms, body: { text_len: llms.text_len } });
    check(checks, "discovery_llms", llms.status === 200 && llms.text_len > 0, `status ${llms.status} bytes=${llms.text_len}`);

    const openapi = await hit(doFetch, `${base}/openapi.json`, { timeoutMs });
    probes.push({ name: "GET /openapi.json", ...openapi, body: { text_len: openapi.text_len } });
    check(checks, "discovery_openapi", openapi.status === 200, `status ${openapi.status}`);

    const getWitness = await hit(doFetch, `${base}/witness`, { timeoutMs });
    probes.push({ name: "GET /witness", ...getWitness });
    check(checks, "get_witness_402", getWitness.status === 402 && getWitness.has_payment_required, `status ${getWitness.status}`);

    const quoteDoc = await hit(doFetch, `${base}/quote`, { method: "POST", body: DOCUMENTED_METHOD, timeoutMs });
    probes.push({ name: "POST /quote documented", ...quoteDoc });
    const quoteGate = await hit(doFetch, `${base}/quote`, { method: "POST", body: GATE_METHOD, timeoutMs });
    probes.push({ name: "POST /quote GATE_METHOD", ...quoteGate });
    const quoteBad = await hit(doFetch, `${base}/quote`, { method: "POST", body: { url: "https://outbid.sh/top", extract: {} }, timeoutMs });
    probes.push({ name: "POST /quote bad_extract", ...quoteBad });

    const quote402 = [quoteDoc, quoteGate, quoteBad].some((h) => h.status === 402 || h.has_payment_required);
    check(checks, "quote_never_402", !quote402, quote402 ? "quote carried a payment challenge" : "no quote 402");
    check(checks, "quote_documented_deliverable_or_honest", quoteOk(quoteDoc), `status ${quoteDoc.status} ${JSON.stringify(quoteDoc.body)}`);
    check(checks, "quote_gate_method_deliverable_or_honest", quoteOk(quoteGate), `status ${quoteGate.status} ${JSON.stringify(quoteGate.body)}`);
    check(checks, "quote_bad_extract_400", quoteBad.status === 400 && !quoteBad.has_payment_required && quoteBad.body?.reason === "bad_extract", `status ${quoteBad.status} ${quoteBad.body?.reason}`);

    const witDoc = await hit(doFetch, `${base}/witness`, { method: "POST", body: DOCUMENTED_METHOD, timeoutMs });
    probes.push({ name: "POST /witness unpaid documented", ...witDoc });
    const witGate = await hit(doFetch, `${base}/witness`, { method: "POST", body: GATE_METHOD, timeoutMs });
    probes.push({ name: "POST /witness unpaid GATE_METHOD", ...witGate });
    const witBad = await hit(doFetch, `${base}/witness`, { method: "POST", body: { url: "https://outbid.sh/top", extract: {} }, timeoutMs });
    probes.push({ name: "POST /witness bad_extract", ...witBad });
    const witForged = await hit(doFetch, `${base}/witness`, {
      method: "POST",
      body: DOCUMENTED_METHOD,
      headers: { "payment-signature": "forged" },
      timeoutMs,
    });
    probes.push({ name: "POST /witness forged payment-signature", ...witForged });

    const witPaywalled = (h, quote) => {
      if (h.has_receipt || h.status === 200) return false;
      if (quote.status === 200 && quote.body?.can_deliver === true) return h.status === 402 && h.has_payment_required;
      if (quote.status === 422) return h.status === 422 || (h.status === 402 && h.has_payment_required);
      return h.status === 402 && h.has_payment_required;
    };
    check(
      checks,
      "witness_unpaid_paywall_or_quote_first",
      witPaywalled(witDoc, quoteDoc) && witPaywalled(witGate, quoteGate),
      `doc ${witDoc.status} gate ${witGate.status}`,
    );

    const witCh = witDoc.challenge || witGate.challenge || getWitness.challenge;
    const witResource = challengeResourceUrl(witCh) || witCh?.resource;
    check(checks, "witness_challenge_names_resource", witResource === `${base}/witness`, `resource ${witResource ?? "<none>"}`);
    const witAccepts = witCh?.accepts || [];
    check(checks, "witness_challenge_price", witAccepts.length > 0 && witAccepts.every((a) => acceptAmount(a) === AMOUNT_ATOMIC), JSON.stringify(witAccepts.map(acceptAmount)));
    const witNets = [...new Set(witAccepts.map((a) => a.network))].sort();
    check(
      checks,
      "witness_challenge_both_rails",
      witCh?.x402Version === 2 && JSON.stringify(witNets) === JSON.stringify([...NETWORKS].sort()) && witAccepts.every((a) => a.payTo),
      `v=${witCh?.x402Version} nets=${JSON.stringify(witNets)}`,
    );
    check(checks, "witness_bad_extract_never_402", witBad.status === 400 && !witBad.has_payment_required, `status ${witBad.status}`);
    check(checks, "witness_forged_does_not_unlock", witForged.status !== 200 && !witForged.has_receipt, `status ${witForged.status}`);
    check(
      checks,
      "witness_unpaid_no_receipt",
      ![witDoc, witGate, witBad, witForged].some((h) => h.has_receipt),
      "no signed receipt on unpaid/forged witness",
    );

    const attestUnpaid = await hit(doFetch, `${base}/delivery/attest`, { method: "POST", body: ATTEST_BODY, timeoutMs });
    probes.push({ name: "POST /delivery/attest unpaid", ...attestUnpaid });
    const attestShape = await hit(doFetch, `${base}/delivery/attest`, { method: "POST", body: { ...ATTEST_BODY, offer: {} }, timeoutMs });
    probes.push({ name: "POST /delivery/attest off-shape", ...attestShape });
    const attestForged = await hit(doFetch, `${base}/delivery/attest`, {
      method: "POST",
      body: ATTEST_BODY,
      headers: { "payment-signature": "forged" },
      timeoutMs,
    });
    probes.push({ name: "POST /delivery/attest forged payment-signature", ...attestForged });
    const attestGet = await hit(doFetch, `${base}/delivery/attest`, { timeoutMs });
    probes.push({ name: "GET /delivery/attest (expect 404; POST-only)", ...attestGet });

    check(checks, "attest_unpaid_402", attestUnpaid.status === 402 && attestUnpaid.has_payment_required && !attestUnpaid.has_receipt, `status ${attestUnpaid.status}`);
    const attCh = attestUnpaid.challenge;
    const attResource = attCh?.resource;
    check(checks, "attest_challenge_names_resource", attResource === `${base}/delivery/attest`, `resource ${attResource ?? "<none>"}`);
    const attAccepts = attCh?.accepts || [];
    check(checks, "attest_challenge_price", attAccepts.length > 0 && attAccepts.every((a) => acceptAmount(a) === AMOUNT_ATOMIC), JSON.stringify(attAccepts.map(acceptAmount)));
    const attNets = [...new Set(attAccepts.map((a) => a.network))].sort();
    check(
      checks,
      "attest_challenge_both_rails",
      attCh?.x402Version === 2 && JSON.stringify(attNets) === JSON.stringify([...NETWORKS].sort()) && attAccepts.every((a) => a.payTo),
      `v=${attCh?.x402Version} nets=${JSON.stringify(attNets)}`,
    );
    check(checks, "attest_shape_never_402", attestShape.status === 400 && !attestShape.has_payment_required, `status ${attestShape.status} ${attestShape.body?.reason}`);
    check(checks, "attest_forged_does_not_unlock", attestForged.status !== 200 && !attestForged.has_receipt, `status ${attestForged.status}`);
    check(checks, "attest_unpaid_no_receipt", ![attestUnpaid, attestShape, attestForged].some((h) => h.has_receipt), "no signed receipt on unpaid/forged attest");

    const dry = await runOnce({
      base,
      mode: "dry",
      log: () => {},
    });
    probes.push({
      name: "Done-gate runOnce dry",
      status: dry.status,
      body: {
        mode: dry.mode,
        completion: dry.completion,
        checkout_approved: dry.checkout_approved,
        paid: dry.paid,
        payment_attempted: dry.payment_attempted,
        decision: dry.decision,
        quote_can_deliver: dry.body?.can_deliver ?? null,
        quote_verdict: dry.body?.verdict ?? null,
      },
    });
    const dryGate = decideGate(dry.status === 200 ? dry.body : null);
    check(
      checks,
      "done_gate_dry_not_complete",
      dry.completion === "incomplete" && dry.checkout_approved === false && dry.paid === false && dry.payment_attempted !== true,
      `completion=${dry.completion} checkout=${dry.checkout_approved} sim_approve=${dryGate.approve}`,
    );
    check(
      checks,
      "done_gate_unpaid_not_approved",
      witGate.status !== 200 && dry.checkout_approved === false,
      `unpaid GATE_METHOD witness ${witGate.status}; checkout_approved=${dry.checkout_approved}`,
    );

    const payTos = svmPayTos([getWitness.challenge, witDoc.challenge, witGate.challenge, attestUnpaid.challenge]);
    let preflight;
    try {
      preflight = await livePreflight(doFetch, payTos, timeoutMs, intent);
    } catch (e) {
      preflight = {
        fetched_at: new Date().toISOString(),
        intel_origin: INTEL_ORIGIN,
        payTos,
        merchant_cards: [],
        preflights: [],
        merchant: { wash_flagged: null, decision: "intel_unreachable" },
        preflight: { decision: null, recommended_action: null, price_usdc: Number(PRICE_USDC) },
        wash: { classification: "unknown", is_circular: false },
        error: e.message || String(e),
      };
    }
    probes.push({ name: "TWZRD intel merchant_card+preflight", status: preflight.error ? 0 : 200, body: { payTos, merchant: preflight.merchant, preflight: preflight.preflight, error: preflight.error ?? null } });
    check(checks, "preflight_ran", payTos.length > 0, `payTos=${payTos.length}${preflight.error ? ` intel=${preflight.error}` : ""}`);

    const spend = decideSpend({
      payRequested,
      payerPath,
      preflight: preflight.preflight,
      merchant: preflight.merchant,
      wash: preflight.wash,
    });
    const washClosed = spend.spend === false && (spend.reason === "wash_flagged" || spend.reason === "wash_unevaluated" || spend.reason === "merchant_refuse" || spend.reason === "unpaid_preferred" || spend.reason === "no_documented_payer" || spend.reason === "preflight_block" || spend.reason === "over_cap");
    check(checks, "wash_fail_closed", washClosed && spend.spend === false, spend.reason);
    check(checks, "no_invented_payer", payerPath === null || DOCUMENTED_PAYER_PATHS.includes(payerPath), payerPath ?? "none");
    check(checks, "spend_logged", spend.spend === false, `no USDC moved; ${spend.reason}`);

    return { ...finishChecks(checks), probes, spend, preflight, payerPath, payTos };
  } catch (e) {
    const detail = e && (e.message || String(e));
    const ran = new Set(checks.map((c) => c.name));
    for (const name of CHECK_NAMES) {
      if (!ran.has(name)) check(checks, name, false, detail, "host_unreachable");
    }
    return { ...finishChecks(checks), probes, spend: { spend: false, reason: "host_unreachable" }, preflight: null, payerPath, error: detail };
  }
}

export function writeEvidence(dir, result) {
  mkdirSync(dir, { recursive: true });
  const spendLine = {
    ts: new Date().toISOString(),
    resource: `${LIVE_HOST}/witness`,
    amount_usdc: 0,
    rail: null,
    payer: null,
    status: "not_attempted",
    tx: null,
    reason: result.spend?.reason ?? "unpaid_preferred",
  };
  assertNoSecrets(result);
  assertNoSecrets(spendLine);
  writeFileSync(path.join(dir, "probes.json"), `${JSON.stringify({
    wave: "21-ZZZ",
    host: LIVE_HOST,
    ran_at: new Date().toISOString(),
    ok: result.ok,
    failed: result.failed,
    spend: result.spend,
    payerPath: result.payerPath,
    payTos: result.payTos ?? [],
    checks: result.checks,
    probes: result.probes,
  }, null, 2)}\n`);
  writeFileSync(path.join(dir, "preflight.json"), `${JSON.stringify(result.preflight, null, 2)}\n`);
  writeFileSync(path.join(dir, "spend-log.ndjson"), `${JSON.stringify(spendLine)}\n`);
  const lines = result.checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(42)} ${c.detail ?? ""}`);
  lines.push(result.ok ? "LIVE_OK" : `LIVE_FAIL  (${result.failed.join(", ")})`);
  lines.push(`SPEND  ${spendLine.status}  ${spendLine.reason}  amount_usdc=${spendLine.amount_usdc}`);
  writeFileSync(path.join(dir, "CHECK.txt"), `${lines.join("\n")}\n`);
  appendFileSync(path.join(dir, "spend-log.ndjson"), "");
  return spendLine;
}

const argOf = (argv, name, dflt = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

export async function main(argv = process.argv, io = { log: console.log, err: console.error, fetch: globalThis.fetch }) {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.err("usage: wave21-live-host-probes --live [--out=<dir>] [--pay]");
    io.err("Hits https://witness.outbid.sh only. Unpaid/402 first. --pay still fail-closes without a documented payer.");
    return 2;
  }
  if (!argv.includes("--live")) {
    io.err("refusing to guess: pass --live to probe https://witness.outbid.sh (no default fetch, no mocks)");
    return 2;
  }
  const base = argOf(argv, "base", LIVE_HOST);
  if (!allowedLiveBase(base)) {
    io.err(`refusing --base=${base}; only ${LIVE_HOST} is the documented live witness host`);
    return 2;
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const out = argOf(argv, "out", path.join(root, "docs/operator/evidence/wave21-zzz-live"));
  const result = await runLiveProbes({
    base,
    fetch: io.fetch,
    pay: argv.includes("--pay"),
    argv,
    env: process.env,
  });
  const spendLine = writeEvidence(out, result);
  for (const c of result.checks) io.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(42)} ${c.detail ?? ""}`);
  io.log(result.ok ? "LIVE_OK" : `LIVE_FAIL  (${result.failed.join(", ")})`);
  io.log(`SPEND  ${spendLine.status}  ${spendLine.reason}  amount_usdc=${spendLine.amount_usdc}`);
  io.log(`EVIDENCE  ${out}`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
