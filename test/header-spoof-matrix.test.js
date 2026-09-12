/**
 * Wave18 NNN — Header spoof X-Forwarded-For / Forwarded / X-Real-IP full matrix.
 *
 * Pins the paywall IP-bucket identity after #34 / #39 / #40 / #51. Limiter
 * keys are Express `req.ip` with `trust proxy = "loopback"`. Fail-closed:
 * untrusted headers never mint a bucket, a leftmost XFF hop cannot steal
 * another client's budget, empty identity stays on the socket, and a flood
 * of minted XFF identities still hits the global /quote cap.
 *
 * Loopback fixtures only. No live reader. No live facilitator. No deploy.
 *
 * Run this file: `node --test test/header-spoof-matrix.test.js`
 * CI-equivalent: `npm test`
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/tmpdir.js";

import { createApp } from "../src/server.js";
import { listenExclusive } from "../src/listen.js";
import { generateProcessKey } from "../src/receipt.js";
import { EXAMPLE_BODY } from "../src/routes/delivery.js";
import {
  DOC_IPS,
  IDENTITY_HEADERS,
  PRESENCE_BITS,
  ROUTES,
  SPOOF_CELLS,
  UNTRUSTED_CLIENT_IP_HEADERS,
  expectedBucket,
  presenceCells,
  presenceHeaders,
} from "./header-spoof-matrix.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_SRC = readFileSync(path.join(ROOT, "test", "header-spoof-matrix.test.js"), "utf8");
const CELLS_SRC = readFileSync(path.join(ROOT, "test", "header-spoof-matrix.js"), "utf8");

const OFFER_ID = "pixel-surplus-vintage-polaroid";
const OFFER_FIXTURE = JSON.stringify({
  id: 1,
  handle: "vintage-polaroid-photo-frames",
  price: 600,
  variants: [{ id: 46117070209071, price: 600 }],
});

const CELLS = presenceCells();

function countingAttest() {
  const calls = [];
  const attest = async (input) => {
    calls.push(input);
    return {
      schema: "delivery-attestation/v0",
      offer_hash: "o".repeat(64),
      request_hash: "r".repeat(64),
      artifact_hash: "a".repeat(64),
      delivery_verdict: "delivered",
      reasons: [],
      evidence_mode: input.observation.mode,
      declared_mode: input.observation.mode,
      this_receipt_proves: ["fixture"],
      this_receipt_does_not_prove: ["fixture"],
    };
  };
  return { attest, calls };
}

async function serve(app, fn) {
  const server = await new Promise((resolve, reject) => {
    const s = listenExclusive(app, { port: 0 }, {
      onListening: () => resolve(s),
      onError: (e) => reject(new Error(`host listen failed (${e.code}): ${e.message}`, { cause: e })),
    });
  });
  const addr = server.address();
  assert.equal(addr.address, "127.0.0.1", "Wave18 NNN fixtures bind loopback only");
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function host(extra = {}) {
  const fake = extra.attest ? { attest: extra.attest, calls: extra.attestCalls ?? [] } : countingAttest();
  return {
    app: createApp({
      key: extra.key ?? generateProcessKey(),
      retrieve: extra.retrieve ?? (async () => ({ text: OFFER_FIXTURE })),
      observationsDir: extra.observationsDir ?? tempDir("wit-xff-"),
      funnelDir: null,
      paywall: extra.paywall === undefined ? {} : extra.paywall,
      publicBaseUrl: "https://witness.example.net",
      quoteRateLimit: extra.quoteRateLimit ?? 1,
      quoteGlobalRateLimit: extra.quoteGlobalRateLimit ?? 60,
      attestRateLimit: extra.attestRateLimit ?? 1,
      payoutQuoteRateLimit: extra.payoutQuoteRateLimit ?? 1,
      gateTtlMs: extra.gateTtlMs ?? 0,
      attest: fake.attest,
      fetchIntel: extra.fetchIntel ?? (async () => { throw new Error("intel unused on this fixture"); }),
    }),
    attestCalls: fake.calls,
  };
}

function bodyFor(route) {
  if (route.id === "attest") return structuredClone(EXAMPLE_BODY);
  if (route.id === "offers") return { offer_id: OFFER_ID };
  return {};
}

async function post(base, route, headers = {}, body) {
  const res = await fetch(`${base}${route.path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? bodyFor(route)),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, reason: json && json.reason };
}

function assertSpent(hit, label) {
  assert.notEqual(hit.status, 429, `${label}: first hit from this identity must spend the bucket, not 429 (${hit.reason ?? hit.status})`);
  assert.ok(hit.status < 500, `${label}: first hit was a server error (${hit.status})`);
}

function assertLimited(hit, route, label) {
  assert.equal(hit.status, 429, `${label}: wanted 429, got ${hit.status} ${hit.reason ?? ""}`);
  assert.equal(hit.reason, route.reason, `${label}: reason`);
}

async function postRaw(base, route, { forwardedFor, body } = {}) {
  const u = new URL(base);
  const payload = JSON.stringify(body ?? bodyFor(route));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: route.path,
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let json;
        try { json = JSON.parse(raw); } catch { json = {}; }
        resolve({ status: res.statusCode, json, reason: json && json.reason });
      });
    });
    if (forwardedFor !== undefined) req.setHeader("x-forwarded-for", forwardedFor);
    req.on("error", reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Generated matrix completeness
// ---------------------------------------------------------------------------

test("generated matrix: 8-way XFF × Forwarded × Real-IP presence on every IP-bucketed route", () => {
  assert.deepEqual([...IDENTITY_HEADERS], ["x-forwarded-for", "forwarded", "x-real-ip"]);
  assert.deepEqual([...PRESENCE_BITS], ["xff", "forwarded", "realIp"]);
  assert.equal(CELLS.length, 8 * ROUTES.length, `expected ${8 * ROUTES.length} presence cells, got ${CELLS.length}`);
  assert.equal(new Set(CELLS.map((c) => c.id)).size, CELLS.length, "presence cell ids must be unique");
  assert.equal(new Set(SPOOF_CELLS.map((c) => c.id)).size, SPOOF_CELLS.length, "spoof cell ids must be unique");
  assert.ok(SPOOF_CELLS.length >= 24, `expected a real spoof matrix, got ${SPOOF_CELLS.length} cells`);

  for (const route of ROUTES) {
    const slice = CELLS.filter((c) => c.route.id === route.id);
    assert.equal(slice.length, 8, `${route.id} must have all 8 presence combos`);
    assert.equal(slice.filter((c) => c.mintsFromXff).length, 4, `${route.id}: exactly the four XFF-present combos mint`);
    assert.equal(slice.filter((c) => c.staysOnSocket).length, 4, `${route.id}: the four XFF-absent combos stay on the socket`);
    for (const c of slice) {
      assert.equal(c.mintsFromXff, c.xff, `${c.id}: only X-Forwarded-For is trusted`);
      assert.equal(c.staysOnSocket, !c.xff, `${c.id}: Forwarded / X-Real-IP never move the bucket`);
    }
  }

  for (const cell of SPOOF_CELLS) {
    const escaped = cell.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(SUITE_SRC, new RegExp(`"${escaped}"`), `runtime suite must name ${cell.id}`);
  }
});

test("expectedBucket: rightmost XFF hop; empty / whitespace / absent stay on the socket; Forwarded and Real-IP are not inputs", () => {
  assert.equal(expectedBucket({}), DOC_IPS.socket);
  assert.equal(expectedBucket({ xff: "" }), DOC_IPS.socket);
  assert.equal(expectedBucket({ xff: "   " }), DOC_IPS.socket);
  assert.equal(expectedBucket({ xff: DOC_IPS.victim }), DOC_IPS.victim);
  assert.equal(expectedBucket({ xff: `${DOC_IPS.attacker}, ${DOC_IPS.victim}` }), DOC_IPS.victim);
  assert.equal(expectedBucket({ xff: `${DOC_IPS.victim}, ${DOC_IPS.attacker}` }), DOC_IPS.attacker);
  assert.equal(expectedBucket({ xff: `${DOC_IPS.attacker},` }), DOC_IPS.attacker);
  assert.equal(expectedBucket({ xff: DOC_IPS.ipv6a }), DOC_IPS.ipv6a);
  assert.equal(expectedBucket({ forwarded: `for=${DOC_IPS.forwarded}`, realIp: DOC_IPS.realIp }), DOC_IPS.socket);
});

test("loopback fixtures only: the suite never defaults to the public host", () => {
  assert.match(CELLS_SRC, /loopback/);
  assert.doesNotMatch(SUITE_SRC, /https:\/\/witness\.outbid\.sh/);
  assert.doesNotMatch(CELLS_SRC, /https:\/\/witness\.outbid\.sh/);
});

// ---------------------------------------------------------------------------
// Presence matrix (runtime)
// ---------------------------------------------------------------------------

test("presence matrix: untrusted-only combos stay on the socket; XFF combos mint the rightmost hop — every IP-bucketed route", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const families = [...new Set(ROUTES.map((r) => r.family))];
    for (const family of families) {
      const routes = ROUTES.filter((r) => r.family === family);
      const socketSpend = await post(base, routes[0]);
      assertSpent(socketSpend, `${family} socket spend via ${routes[0].path}`);

      const socketCells = CELLS.filter((c) => c.route.family === family && c.staysOnSocket);
      for (const cell of socketCells) {
        const hit = await post(base, cell.route, presenceHeaders(cell, {
          forwarded: "192.0.2.200",
          realIp: "192.0.2.201",
        }));
        assertLimited(hit, cell.route, cell.id);
      }

      const xffCells = CELLS.filter((c) => c.route.family === family && c.mintsFromXff);
      let n = 0;
      for (const cell of xffCells) {
        const xff = `203.0.113.${20 + n}`;
        n += 1;
        const first = await post(base, cell.route, presenceHeaders(cell, {
          xff,
          forwarded: "192.0.2.210",
          realIp: "192.0.2.211",
        }));
        assertSpent(first, cell.id);
        const again = await post(base, cell.route, presenceHeaders(cell, {
          xff,
          forwarded: "192.0.2.212",
          realIp: "192.0.2.213",
        }));
        assertLimited(again, cell.route, `${cell.id} same XFF, rotated untrusted spoofs`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Spoof cells
// ---------------------------------------------------------------------------

test("spoof.leftmost_xff_cannot_steal", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    for (const route of [ROUTES[0], ROUTES[2]]) {
      const victim = { "x-forwarded-for": DOC_IPS.victim };
      const steal = { "x-forwarded-for": `${DOC_IPS.attacker}, ${DOC_IPS.victim}` };
      const other = { "x-forwarded-for": `${DOC_IPS.victim}, ${DOC_IPS.attacker}` };
      assertSpent(await post(base, route, victim), `${route.id} victim`);
      assertLimited(await post(base, route, steal), route, `${route.id} leftmost spoof`);
      assertSpent(await post(base, route, other), `${route.id} rightmost other client`);
    }
  });
});

test("spoof.leftmost_xff_port_cannot_steal", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    assertSpent(await post(base, route, { "x-forwarded-for": DOC_IPS.victim }), "victim");
    assertLimited(
      await post(base, route, { "x-forwarded-for": `${DOC_IPS.attacker}:9, ${DOC_IPS.victim}` }),
      route,
      "port decoration on the left hop",
    );
  });
});

test("spoof.duplicate_xff_headers_rightmost_wins", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    assertSpent(await post(base, route, { "x-forwarded-for": DOC_IPS.victim }), "victim");
    const steal = await postRaw(base, route, { forwardedFor: [DOC_IPS.attacker, DOC_IPS.victim] });
    assertLimited(steal, route, "duplicate X-Forwarded-For: rightmost hop is the victim");
    const other = await postRaw(base, route, { forwardedFor: [DOC_IPS.victim, DOC_IPS.attacker] });
    assertSpent(other, "duplicate X-Forwarded-For: rightmost hop is a different client");
  });
});

test("spoof.xff_wins_over_forwarded_and_realip", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    const xff = DOC_IPS.other;
    assertSpent(await post(base, route, {
      "x-forwarded-for": xff,
      forwarded: `for=${DOC_IPS.forwarded}`,
      "x-real-ip": DOC_IPS.realIp,
    }), "all three");
    assertLimited(await post(base, route, {
      "x-forwarded-for": xff,
      forwarded: `for=${DOC_IPS.attacker}`,
      "x-real-ip": DOC_IPS.attacker,
    }), route, "rotating Forwarded / X-Real-IP cannot escape the XFF bucket");
    assert.equal(expectedBucket({ xff }), xff);
  });
});

test("spoof.empty_xff_stays_socket", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    assertSpent(await post(base, route), "socket");
    assertLimited(await postRaw(base, route, { forwardedFor: "" }), route, "empty XFF");
    assert.equal(expectedBucket({ xff: "" }), DOC_IPS.socket);
  });
});

test("spoof.whitespace_xff_stays_socket", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    assertSpent(await post(base, route), "socket");
    assertLimited(await postRaw(base, route, { forwardedFor: "   \t" }), route, "whitespace XFF");
  });
});

test("spoof.garbage_xff_still_limited", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    const garbage = { "x-forwarded-for": "not-an-ip" };
    assertSpent(await post(base, route, garbage), "garbage XFF first hit");
    assertLimited(await post(base, route, garbage), route, "same garbage XFF is still a limiter key");
  });
});

test("spoof.unknown_xff_still_limited", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    const unknown = { "x-forwarded-for": "unknown" };
    assertSpent(await post(base, route, unknown), "unknown XFF first hit");
    assertLimited(await post(base, route, unknown), route, "unknown XFF still binds");
  });
});

test("spoof.ipv6_xff_distinct_buckets", async () => {
  const { app } = host();
  await serve(app, async (base) => {
    const route = ROUTES[0];
    assertSpent(await post(base, route, { "x-forwarded-for": DOC_IPS.ipv6a }), "ipv6 a");
    assertLimited(await post(base, route, { "x-forwarded-for": DOC_IPS.ipv6a }), route, "same ipv6");
    assertSpent(await post(base, route, { "x-forwarded-for": DOC_IPS.ipv6b }), "ipv6 b is a different bucket");
  });
});

const FORWARDED_SPOOFS = [
  ["spoof.forwarded_rfc7239_for_ipv4_ignored", `for=${DOC_IPS.forwarded}`],
  ["spoof.forwarded_rfc7239_for_ipv6_ignored", `for="[${DOC_IPS.ipv6a}]"`],
  ["spoof.forwarded_hidden_ignored", "for=_hidden"],
  ["spoof.forwarded_unknown_ignored", "for=unknown"],
  ["spoof.forwarded_with_params_ignored", `for=${DOC_IPS.forwarded};proto=https;by=192.0.2.1;host=witness.example.net`],
  ["spoof.forwarded_multi_hop_ignored", `for=${DOC_IPS.attacker}, for=${DOC_IPS.forwarded}`],
];

for (const [id, value] of FORWARDED_SPOOFS) {
  test(id, async () => {
    const { app } = host();
    await serve(app, async (base) => {
      const route = ROUTES[0];
      assertSpent(await post(base, route), `${id} socket`);
      assertLimited(await post(base, route, { forwarded: value }), route, id);
    });
  });
}

const REALIP_SPOOFS = [
  ["spoof.realip_ipv4_ignored", DOC_IPS.realIp],
  ["spoof.realip_ipv6_ignored", DOC_IPS.ipv6a],
  ["spoof.realip_with_port_ignored", `${DOC_IPS.realIp}:8080`],
];

for (const [id, value] of REALIP_SPOOFS) {
  test(id, async () => {
    const { app } = host();
    await serve(app, async (base) => {
      const route = ROUTES[0];
      assertSpent(await post(base, route), `${id} socket`);
      assertLimited(await post(base, route, { "x-real-ip": value }), route, id);
    });
  });
}

const CDN_SPOOFS = [
  ["spoof.cdn_cf_connecting_ip_ignored", "cf-connecting-ip"],
  ["spoof.cdn_true_client_ip_ignored", "true-client-ip"],
  ["spoof.cdn_x_client_ip_ignored", "x-client-ip"],
  ["spoof.cdn_fastly_client_ip_ignored", "fastly-client-ip"],
  ["spoof.cdn_x_originating_ip_ignored", "x-originating-ip"],
  ["spoof.cdn_x_cluster_client_ip_ignored", "x-cluster-client-ip"],
  ["spoof.forwarded_for_alias_ignored", "forwarded-for"],
];

for (const [id, header] of CDN_SPOOFS) {
  test(id, async () => {
    assert.ok(UNTRUSTED_CLIENT_IP_HEADERS.includes(header), `${header} must stay on the untrusted list`);
    const { app } = host();
    await serve(app, async (base) => {
      const route = ROUTES[0];
      assertSpent(await post(base, route), `${id} socket`);
      assertLimited(await post(base, route, { [header]: DOC_IPS.attacker }), route, id);
    });
  });
}

test("spoof.global_cap_binds_xff_flood", async () => {
  const { app } = host({ quoteRateLimit: 1, quoteGlobalRateLimit: 2 });
  await serve(app, async (base) => {
    const route = ROUTES[0];
    assertSpent(await post(base, route, { "x-forwarded-for": "203.0.113.51" }), "global slot 1");
    assertSpent(await post(base, route, { "x-forwarded-for": "203.0.113.52" }), "global slot 2");
    const third = await post(base, route, { "x-forwarded-for": "203.0.113.53" });
    assertLimited(third, route, "minting a third XFF identity cannot unbounded-spend the reader");
  });
});
