/**
 * Wave18 NNN — Header spoof X-Forwarded-For / Forwarded / X-Real-IP cells.
 *
 * Identity policy the host must keep (fail-closed, loopback fixtures):
 *   - `trust proxy = "loopback"` is the only hop the process trusts.
 *   - `X-Forwarded-For`: the rightmost hop is the client (the tunnel appends
 *     the real address last). A client-supplied left hop cannot pick the bucket.
 *   - RFC 7239 `Forwarded` is never consulted.
 *   - `X-Real-IP` is never consulted.
 *   - Other client-IP headers (CF-Connecting-IP, True-Client-IP, …) are never
 *     consulted.
 *   - Empty / whitespace `X-Forwarded-For` is the socket (`127.0.0.1`).
 *   - Missing identity never skips a limiter: the socket bucket still binds.
 *
 * Cells are the source of truth for the suite. Runtime probes live in
 * `test/header-spoof-matrix.test.js`. Tests-only. No host, no spend, no deploy.
 */

export const IDENTITY_HEADERS = Object.freeze(["x-forwarded-for", "forwarded", "x-real-ip"]);

/** Headers an attacker can send that must not mint a limiter bucket. */
export const UNTRUSTED_CLIENT_IP_HEADERS = Object.freeze([
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "fastly-client-ip",
  "x-originating-ip",
  "x-cluster-client-ip",
  "forwarded-for",
]);

/** Documentation / TEST-NET addresses. Not routable; loopback fixtures only. */
export const DOC_IPS = Object.freeze({
  socket: "127.0.0.1",
  victim: "203.0.113.1",
  attacker: "198.51.100.7",
  other: "203.0.113.9",
  realIp: "192.0.2.1",
  forwarded: "192.0.2.80",
  ipv6a: "2001:db8::1",
  ipv6b: "2001:db8::2",
});

/**
 * Routes whose limiter key is Express `req.ip` after trust-proxy loopback.
 * `family` is the limiter map: quote and witness share one; attest and payout
 * each have their own.
 */
export const ROUTES = Object.freeze([
  { id: "quote", path: "/quote", family: "quote", reason: "quote_rate_limited" },
  { id: "witness", path: "/witness", family: "quote", reason: "quote_rate_limited" },
  { id: "attest", path: "/delivery/attest", family: "attest", reason: "attest_rate_limited" },
  { id: "offers", path: "/api/quotes", family: "quote", reason: "quote_rate_limited" },
  { id: "payout", path: "/verify/payout/quote", family: "payout", reason: "quote_rate_limited" },
]);

export const PRESENCE_BITS = Object.freeze(["xff", "forwarded", "realIp"]);

/** Every combination of the three identity headers, per IP-bucketed route (8 × N). */
export function presenceCells(routes = ROUTES) {
  const cells = [];
  for (const route of routes) {
    for (const xff of [false, true]) {
      for (const forwarded of [false, true]) {
        for (const realIp of [false, true]) {
          const bits = [
            xff ? "xff" : "no-xff",
            forwarded ? "fwd" : "no-fwd",
            realIp ? "real" : "no-real",
          ];
          cells.push({
            id: `presence.${route.id}.${bits.join(".")}`,
            route,
            xff,
            forwarded,
            realIp,
            mintsFromXff: xff,
            staysOnSocket: !xff,
          });
        }
      }
    }
  }
  return Object.freeze(cells);
}

/**
 * Named spoof / fail-closed variants on top of the 8-way presence matrix.
 * Each `id` is a `test()` in the runtime file; renaming one without updating
 * tests fails on purpose.
 */
export const SPOOF_CELLS = Object.freeze([
  { id: "spoof.leftmost_xff_cannot_steal", kind: "steal", header: "x-forwarded-for" },
  { id: "spoof.leftmost_xff_port_cannot_steal", kind: "steal", header: "x-forwarded-for" },
  { id: "spoof.duplicate_xff_headers_rightmost_wins", kind: "steal", header: "x-forwarded-for" },
  { id: "spoof.xff_wins_over_forwarded_and_realip", kind: "precedence", header: "x-forwarded-for" },
  { id: "spoof.empty_xff_stays_socket", kind: "socket", header: "x-forwarded-for" },
  { id: "spoof.whitespace_xff_stays_socket", kind: "socket", header: "x-forwarded-for" },
  { id: "spoof.garbage_xff_still_limited", kind: "limited", header: "x-forwarded-for" },
  { id: "spoof.unknown_xff_still_limited", kind: "limited", header: "x-forwarded-for" },
  { id: "spoof.ipv6_xff_distinct_buckets", kind: "distinct", header: "x-forwarded-for" },
  { id: "spoof.forwarded_rfc7239_for_ipv4_ignored", kind: "untrusted", header: "forwarded" },
  { id: "spoof.forwarded_rfc7239_for_ipv6_ignored", kind: "untrusted", header: "forwarded" },
  { id: "spoof.forwarded_hidden_ignored", kind: "untrusted", header: "forwarded" },
  { id: "spoof.forwarded_unknown_ignored", kind: "untrusted", header: "forwarded" },
  { id: "spoof.forwarded_with_params_ignored", kind: "untrusted", header: "forwarded" },
  { id: "spoof.forwarded_multi_hop_ignored", kind: "untrusted", header: "forwarded" },
  { id: "spoof.realip_ipv4_ignored", kind: "untrusted", header: "x-real-ip" },
  { id: "spoof.realip_ipv6_ignored", kind: "untrusted", header: "x-real-ip" },
  { id: "spoof.realip_with_port_ignored", kind: "untrusted", header: "x-real-ip" },
  { id: "spoof.cdn_cf_connecting_ip_ignored", kind: "untrusted", header: "cf-connecting-ip" },
  { id: "spoof.cdn_true_client_ip_ignored", kind: "untrusted", header: "true-client-ip" },
  { id: "spoof.cdn_x_client_ip_ignored", kind: "untrusted", header: "x-client-ip" },
  { id: "spoof.cdn_fastly_client_ip_ignored", kind: "untrusted", header: "fastly-client-ip" },
  { id: "spoof.cdn_x_originating_ip_ignored", kind: "untrusted", header: "x-originating-ip" },
  { id: "spoof.cdn_x_cluster_client_ip_ignored", kind: "untrusted", header: "x-cluster-client-ip" },
  { id: "spoof.forwarded_for_alias_ignored", kind: "untrusted", header: "forwarded-for" },
  { id: "spoof.global_cap_binds_xff_flood", kind: "global", header: "x-forwarded-for" },
]);

export function cellKey({ id }) {
  return id;
}

export function unique(xs) {
  return [...new Set(xs)];
}

/**
 * Expected limiter bucket on a loopback fixture.
 * Only `X-Forwarded-For` can move the key off the socket; the rightmost
 * non-empty hop wins, matching `forwarded` + `proxy-addr` after trust-loopback.
 */
export function expectedBucket({ xff } = {}, socket = DOC_IPS.socket) {
  if (typeof xff !== "string") return socket;
  const hops = [];
  for (const part of xff.split(",")) {
    const hop = part.trim();
    if (hop) hops.push(hop);
  }
  return hops.length ? hops[hops.length - 1] : socket;
}

/** Headers for one presence cell. Untrusted values are TEST-NET spoofs. */
export function presenceHeaders(cell, { xff, forwarded, realIp } = {}) {
  const headers = {};
  if (cell.xff) headers["x-forwarded-for"] = xff ?? DOC_IPS.other;
  if (cell.forwarded) headers.forwarded = `for=${forwarded ?? DOC_IPS.forwarded}`;
  if (cell.realIp) headers["x-real-ip"] = realIp ?? DOC_IPS.realIp;
  return headers;
}
