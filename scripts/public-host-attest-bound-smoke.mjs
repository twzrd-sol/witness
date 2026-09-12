#!/usr/bin/env node
/**
 * Wave11 LL — public-host attest bound smoke (post-#34 / #40).
 *
 * After #34 the public host must not sign POST /delivery/attest unpaid, and
 * the 402 challenge must name this route at the /witness price. #40 pinned
 * that adversarially in-process. This checker is the HTTP smoke: it talks
 * only to a host you name, prefers loopback, and fail-closes when the route
 * is unbound (200 / receipt without a valid payment) or mismatched (wrong
 * resource, price, or rails).
 *
 * Three probes, no settle, no wallet, no reader:
 *   1. well-formed unpaid → 402 + PAYMENT-REQUIRED
 *   2. off-shape body     → 400, no challenge
 *   3. forged payment     → not 200, no receipt
 *
 * Usage (no default host — never hits prod unless you pass --allow-remote):
 *   node scripts/public-host-attest-bound-smoke.mjs --base=<url> --public-base=<canonical>
 *   node scripts/public-host-attest-bound-smoke.mjs --base=http://127.0.0.1:4032 --public-base=https://witness.example.net
 *
 * Exit 0 = bound. Exit 1 = unbound / mismatched / unreachable. Exit 2 = usage.
 */
import { pathToFileURL } from "node:url";

import { EXAMPLE_BODY, ROUTE } from "../src/routes/delivery.js";

export const ATTEST_ROUTE = ROUTE;
/** Same tariff as POST /witness (src/server.js PRICE_USDC). Duplicated so this smoke does not load the host. */
export const ATTEST_PRICE_USDC = "0.01";
export const ATTEST_AMOUNT_ATOMIC = "10000";
export const ATTEST_NETWORKS = Object.freeze([
  "eip155:8453",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
]);

/** Named checks. Adding/renaming one without updating tests fails on purpose. */
export const CHECK_NAMES = Object.freeze([
  "unpaid_well_formed_is_402",
  "challenge_names_attest_resource",
  "challenge_price_matches_witness",
  "challenge_has_both_rails",
  "shape_error_never_402",
  "forged_payment_does_not_unlock",
  "refusal_carries_no_receipt",
]);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return LOOPBACK.has(host);
  } catch {
    return false;
  }
}

export function resolvePublicBaseUrl(base, { publicBaseUrl, allowRemote } = {}) {
  if (typeof publicBaseUrl === "string" && publicBaseUrl) return publicBaseUrl.replace(/\/$/, "");
  if (allowRemote && !isLoopbackHost(base)) {
    try {
      const u = new URL(base);
      if (u.protocol === "https:") return u.origin;
    } catch { /* fall through */ }
  }
  return null;
}

export function expectedAttestResource(publicBaseUrl) {
  if (!publicBaseUrl) return null;
  return `${String(publicBaseUrl).replace(/\/$/, "")}${ATTEST_ROUTE}`;
}

/** Challenge travels in PAYMENT-REQUIRED as JSON, base64, or base64url. */
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

function acceptAmount(a) {
  return a?.amount ?? a?.maxAmountRequired ?? null;
}

function hasSignedReceipt(json) {
  return Boolean(json && typeof json === "object" && typeof json.receipt === "string" && json.receipt.length);
}

function summary(checks) {
  const byName = new Map(checks.map((c) => [c.name, c]));
  for (const name of CHECK_NAMES) {
    if (!byName.has(name)) checks.push({ name, pass: false, code: "attest_incomplete", detail: "check did not run" });
  }
  const ordered = CHECK_NAMES.map((name) => checks.find((c) => c.name === name));
  const failed = ordered.filter((c) => !c.pass).map((c) => c.name);
  const codes = [...new Set(ordered.filter((c) => !c.pass && c.code).map((c) => c.code))];
  return { bound: failed.length === 0, checks: ordered, failed, codes };
}

async function timedFetch(doFetch, url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function postAttest(doFetch, base, body, headers, timeoutMs) {
  const res = await timedFetch(doFetch, `${String(base).replace(/\/$/, "")}${ATTEST_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }, timeoutMs);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { res, json };
}

/**
 * Probe a host. Fail-closed: unknown, unreachable, remote-without-opt-in,
 * unbound, or mismatched all set bound=false. Fetch is injectable.
 */
export async function checkPublicHostAttestBound(base, opts = {}) {
  const checks = [];
  const fail = (name, code, detail) => { checks.push({ name, pass: false, code, detail }); };
  const pass = (name, detail = null) => { checks.push({ name, pass: true, code: null, detail }); };

  if (!base || typeof base !== "string") {
    for (const name of CHECK_NAMES) fail(name, "attest_incomplete", "no base URL");
    return summary(checks);
  }
  if (!isLoopbackHost(base) && !opts.allowRemote) {
    for (const name of CHECK_NAMES) fail(name, "remote_host_refused", "non-loopback host refused; pass allowRemote / --allow-remote");
    return summary(checks);
  }

  const publicBase = resolvePublicBaseUrl(base, opts);
  const expectedResource = expectedAttestResource(publicBase);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const wellFormed = opts.body ?? structuredClone(EXAMPLE_BODY);
  const offShape = { ...structuredClone(wellFormed), offer: {} };

  try {
    const unpaid = await postAttest(doFetch, base, wellFormed, {}, timeoutMs);
    const challenge = unpaid.res.status === 402 ? parseChallenge(unpaid.res) : null;
    if (unpaid.res.status === 200 || hasSignedReceipt(unpaid.json)) {
      fail("unpaid_well_formed_is_402", "attest_unbound", `unpaid well-formed POST signed or 200 (status ${unpaid.res.status})`);
    } else if (unpaid.res.status !== 402 || !challenge) {
      fail("unpaid_well_formed_is_402", "attest_unexpected", `wanted 402 + PAYMENT-REQUIRED, got ${unpaid.res.status}`);
    } else {
      pass("unpaid_well_formed_is_402", "402 challenge");
    }

    if (!challenge) {
      const code = unpaid.res.status === 200 || hasSignedReceipt(unpaid.json) ? "attest_unbound" : "attest_unexpected";
      fail("challenge_names_attest_resource", code, "no challenge to compare");
      fail("challenge_price_matches_witness", code, "no challenge to compare");
      fail("challenge_has_both_rails", code, "no challenge to compare");
    } else {
      const resource = challengeResourceUrl(challenge);
      if (!expectedResource) {
        fail("challenge_names_attest_resource", "public_base_required", "loopback/canonical PUBLIC_BASE_URL not given");
      } else if (resource !== expectedResource) {
        fail("challenge_names_attest_resource", "attest_mismatch", `wanted ${expectedResource}, got ${resource ?? "<missing>"}`);
      } else {
        pass("challenge_names_attest_resource", resource);
      }

      const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
      const amounts = accepts.map(acceptAmount);
      if (!accepts.length || amounts.some((a) => a !== ATTEST_AMOUNT_ATOMIC)) {
        fail("challenge_price_matches_witness", "attest_mismatch", `wanted ${ATTEST_AMOUNT_ATOMIC} (${ATTEST_PRICE_USDC} USDC) on every rail, got ${JSON.stringify(amounts)}`);
      } else {
        pass("challenge_price_matches_witness", ATTEST_AMOUNT_ATOMIC);
      }

      const nets = [...new Set(accepts.map((a) => a.network))].sort();
      const wantNets = [...ATTEST_NETWORKS].sort();
      const payees = accepts.every((a) => typeof a.payTo === "string" && a.payTo.length);
      const versionOk = challenge.x402Version === 2;
      if (!versionOk || !payees || JSON.stringify(nets) !== JSON.stringify(wantNets)) {
        fail("challenge_has_both_rails", "attest_mismatch", `version=${challenge.x402Version} nets=${JSON.stringify(nets)} payTo=${payees}`);
      } else {
        pass("challenge_has_both_rails", nets.join(","));
      }
    }

    const shape = await postAttest(doFetch, base, offShape, {}, timeoutMs);
    const shapeChallenge = parseChallenge(shape.res);
    if (shape.res.status === 402 || shapeChallenge) {
      fail("shape_error_never_402", "attest_shape_reached_paywall", `off-shape reached the paywall (status ${shape.res.status})`);
    } else if (shape.res.status !== 400) {
      fail("shape_error_never_402", "attest_unexpected", `wanted 400, got ${shape.res.status}`);
    } else {
      pass("shape_error_never_402", shape.json?.reason ?? "400");
    }

    const forged = await postAttest(doFetch, base, wellFormed, { "payment-signature": "forged" }, timeoutMs);
    if (forged.res.status === 200 || hasSignedReceipt(forged.json)) {
      fail("forged_payment_does_not_unlock", "attest_forged_unlocked", `forged payment-signature unlocked status ${forged.res.status}`);
    } else {
      pass("forged_payment_does_not_unlock", `status ${forged.res.status}`);
    }

    const leaked = [
      ["unpaid", unpaid],
      ["shape", shape],
      ["forged", forged],
    ].filter(([, hit]) => hasSignedReceipt(hit.json)).map(([label]) => label);
    if (leaked.length) {
      fail("refusal_carries_no_receipt", leaked.includes("unpaid") ? "attest_unbound" : "attest_forged_unlocked", `signed receipt on ${leaked.join(",")}`);
    } else {
      pass("refusal_carries_no_receipt");
    }
  } catch (e) {
    const ran = new Set(checks.map((c) => c.name));
    const detail = e && (e.message || String(e));
    for (const name of CHECK_NAMES) {
      if (!ran.has(name)) fail(name, "attest_unreachable", detail);
    }
  }

  return summary(checks);
}

const argOf = (argv, name, dflt = undefined) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

export async function main(argv = process.argv, io = { log: console.log, err: console.error, fetch: globalThis.fetch }) {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.err("usage: public-host-attest-bound-smoke --base=<url> --public-base=<canonical> [--allow-remote]");
    io.err("No default host. Loopback fixtures only unless --allow-remote.");
    return 2;
  }
  const base = argOf(argv, "base");
  if (!base) {
    io.err("usage: public-host-attest-bound-smoke --base=<url> [--public-base=<canonical>] [--allow-remote]");
    io.err("refusing to guess a host: no default, not WITNESS_BASE, not the public production URL");
    return 2;
  }
  const allowRemote = argv.includes("--allow-remote");
  if (!isLoopbackHost(base) && !allowRemote) {
    io.err("refusing non-loopback --base; pass --allow-remote to opt in (this smoke prefers loopback fixtures)");
    return 2;
  }
  const publicBaseUrl = argOf(argv, "public-base");
  if (isLoopbackHost(base) && !publicBaseUrl) {
    io.err("loopback --base requires --public-base=<canonical PUBLIC_BASE_URL the host advertises>");
    return 2;
  }
  const result = await checkPublicHostAttestBound(base, {
    publicBaseUrl,
    allowRemote,
    fetch: io.fetch,
  });
  for (const c of result.checks) {
    io.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name.padEnd(34)} ${c.detail ?? ""}`);
  }
  io.log(result.bound ? "BOUND" : `UNBOUND  (${result.failed.join(", ")})`);
  return result.bound ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
