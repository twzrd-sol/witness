import { createHash } from "node:crypto";
import { intelRoutesFor } from "./payout-claim.js";

/** Evidence fetch for payout-claim verification. Reads TWZRD's free intel routes
 *  directly -- machine JSON, not a page, so the reader is not the path -- and
 *  fails closed: any non-answer (HTTP error, non-JSON, data_available:false, an
 *  error field, timeout) throws IntelUnavailable, which the route maps to a 422
 *  that is never billed. Successful bundles are cached briefly because every
 *  witness caller shares one egress IP against a 120/min anonymous door. */
export const INTEL_BASE = "https://intel.twzrd.xyz";
const INTEL_HOST = "intel.twzrd.xyz";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 60_000;

export class IntelUnavailable extends Error {
  constructor(detail) {
    super("intel_unavailable");
    this.reason = "intel_unavailable";
    this.detail = detail;
  }
}

const ROUTE_PATHS = {
  score_wallet_for_intel: (w) => `/v1/intel/score_wallet_for_intel?wallet=${encodeURIComponent(w)}`,
  merchant_card: (w) => `/v1/intel/merchant_card/${encodeURIComponent(w)}`,
  get_facilitator_footprint: (w) => `/v1/intel/get_facilitator_footprint?wallet=${encodeURIComponent(w)}`,
};
const RESULT_KEY = { score_wallet_for_intel: "score", merchant_card: "card", get_facilitator_footprint: "footprint" };

export function intelUrls(base, wallet, direction, network) {
  const root = String(base).replace(/\/+$/, "");
  return intelRoutesFor(direction, network).map((name) => ({ name, url: `${root}${ROUTE_PATHS[name](wallet)}` }));
}

function pinnedBase(intelBase) {
  let u;
  try { u = new URL(intelBase); } catch { throw new TypeError("intel base must be a URL"); }
  if (u.protocol !== "https:" || u.hostname !== INTEL_HOST) throw new TypeError(`intel base must be https://${INTEL_HOST}`);
  return u.origin;
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function makeFetchIntel({
  fetch: doFetch = globalThis.fetch, intelBase = INTEL_BASE, timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = Date.now,
} = {}) {
  const base = pinnedBase(intelBase);
  const cache = new Map();

  async function getJson({ name, url }) {
    let res;
    try {
      res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", "user-agent": "witness/payout-claim" } });
    } catch (e) {
      throw new IntelUnavailable({ name, error: String(e && e.message ? e.message : e) });
    }
    if (!res || !res.ok) throw new IntelUnavailable({ name, status: res ? res.status : null });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new IntelUnavailable({ name, error: "non_json" }); }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new IntelUnavailable({ name, error: "non_object" });
    if (json.data_available === false) throw new IntelUnavailable({ name, error: "data_unavailable" });
    if (json.error != null) throw new IntelUnavailable({ name, error: String(json.error) });
    return { json, source: { name, url, sha256: sha256(text), fetched_at: new Date(now()).toISOString() } };
  }

  return async function fetchIntel(wallet, direction, network) {
    const key = `${network}:${direction}:${wallet}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheTtlMs) return hit.value;
    const value = { sources: [] };
    for (const route of intelUrls(base, wallet, direction, network)) {
      const { json, source } = await getJson(route);
      value[RESULT_KEY[route.name]] = json;
      value.sources.push(source);
    }
    cache.set(key, { at: now(), value });
    return value;
  };
}
