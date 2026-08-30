export class SsrfError extends Error {}

const PRIVATE = [
  /^localhost$/i, /\.localhost$/i, /^127\./, /^10\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?(::1|f[cd][0-9a-f]{2}:|fe80:)/i,
];

/** https-only public URL. No loopback, RFC1918, link-local, or file:. */
export function assertPublicHttps(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new SsrfError("invalid_url"); }
  if (u.protocol !== "https:") throw new SsrfError("https_only");
  if (PRIVATE.some((re) => re.test(u.hostname))) throw new SsrfError("blocked_host");
  return u;
}
