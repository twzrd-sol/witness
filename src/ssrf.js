import { BlockList } from "node:net";
import { lookup } from "node:dns/promises";

export class SsrfError extends Error {}

const PRIVATE = [
  /^localhost$/i, /\.localhost$/i, /^127\./, /^10\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?(::1|f[cd][0-9a-f]{2}:|fe80:)/i,
];
const bl = new BlockList();
for (const [n, p, t] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"], ["::1", 128, "ipv6"], ["::", 128, "ipv6"],
  ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
]) bl.addSubnet(n, p, t);

export function ipBlocked(addr) {
  const a = String(addr).toLowerCase().replace(/^\[|\]$/g, "");
  if (a.startsWith("::ffff:")) return ipBlocked(a.slice(7));
  return bl.check(a);
}

/** https-only public URL, then resolved and re-checked (DNS rebinding shape). */
export async function assertPublicHttps(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new SsrfError("invalid_url"); }
  if (u.protocol !== "https:") throw new SsrfError("https_only");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (PRIVATE.some((re) => re.test(host))) throw new SsrfError("blocked_host");
  let recs;
  try { recs = await lookup(host, { all: true }); } catch { throw new SsrfError("blocked_host"); }
  if (!recs.length || recs.some((r) => ipBlocked(r.address))) throw new SsrfError("blocked_host");
  return u;
}
