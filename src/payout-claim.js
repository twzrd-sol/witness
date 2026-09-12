import { signReceipt, sourceHash } from "./receipt.js";
import { specHash, VALID_FOR_MS } from "./observatory.js";

/** Payout-claim verification: does a public payout or revenue figure match what
 *  TWZRD's settlement corpus observed for the named wallet? Pure functions only;
 *  retrieval and the intel fetch are injected by the route. Field names below are
 *  pinned to the live intel.twzrd.xyz responses (2026-09-10), never to a checkout
 *  of the intel source. */
export const PAYOUT_SCHEMA = "witness.payout_claim.v1";
export const PAYOUT_PRICE_USDC = "0.05";
export const PAYOUT_AMOUNT_ATOMIC = "50000";
export const PAYOUT_NETWORKS = Object.freeze(["solana", "base"]);
export const PAYOUT_DIRECTIONS = Object.freeze(["inbound", "outbound"]);
export const CLAIM_FIELDS = Object.freeze(["payout_count", "unique_wallets", "paid_usd"]);

/** Billable answers about the claim. `coverage_limited` is an answer -- the
 *  corpus cannot see this wallet, rail, or settlement kind -- and it is never
 *  dressed up as a contradiction. */
export const PAYOUT_VERDICTS = Object.freeze(["supported", "discrepant", "coverage_limited", "incomplete"]);
/** Never billed: "we could not check" plus every defect of our own. */
export const PAYOUT_NEVER_BILLED = Object.freeze([
  "unable_to_verify", "extract_none", "intel_unavailable", "intel_not_wired",
  "retrieve_failed", "retrieve_empty", "retrieve_not_wired",
  "bad_json", "bad_claim_url", "bad_claim", "bad_wallet", "bad_network", "bad_direction",
  "ssrf_refused", "server_error", "quote_rate_limited",
]);
export const isPayoutBillable = (verdict) => PAYOUT_VERDICTS.includes(verdict);

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** A page key the extractor can anchor on: the claim page's own field name. */
const PAGE_KEY = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,63}$/;
const USD_TOLERANCE = 0.01;
const CORPUS_SCOPE = "TWZRD indexes x402 settlements observed from known facilitator hosts: an observed subset, not a universe claim. Direct USDC transfers are not indexed.";

const bad = (reason) => ({ ok: false, status: 400, reason });

/** `claim` maps each verifiable figure to the key the claim page publishes it
 *  under (e.g. payout_count -> "decidedCount"). The extractor anchors on page
 *  keys, so a claim page is read in its own vocabulary and every figure is a
 *  number. */
export function normalizePayoutRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("bad_json");
  const { claim_url, claim, wallet, network, direction } = body;
  if (typeof claim_url !== "string" || !claim_url) return bad("bad_claim_url");
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return bad("bad_claim");
  const fields = Object.keys(claim);
  if (!fields.length || fields.some((f) => !CLAIM_FIELDS.includes(f) || typeof claim[f] !== "string" || !PAGE_KEY.test(claim[f]))) return bad("bad_claim");
  if (!PAYOUT_NETWORKS.includes(network)) return bad("bad_network");
  if (!PAYOUT_DIRECTIONS.includes(direction)) return bad("bad_direction");
  if (typeof wallet !== "string") return bad("bad_wallet");
  if (network === "solana" && !SOLANA_ADDRESS.test(wallet)) return bad("bad_wallet");
  if (network === "base" && !BASE_ADDRESS.test(wallet)) return bad("bad_wallet");
  return { ok: true, request: { claim_url, claim, wallet, network, direction } };
}

/** The extract the page is read with: every mapped page key, as a number. */
export function claimExtract(claim) {
  return Object.fromEntries(Object.values(claim).map((pageKey) => [pageKey, "number"]));
}

/** Fold a page-key extraction back onto claim fields. Two claim fields mapped to
 *  the same page key both read that one figure. */
export function projectClaim(claim, { values, missing }) {
  const out = { values: {}, missing: [] };
  for (const field of CLAIM_FIELDS.filter((f) => Object.hasOwn(claim, f))) {
    const pageKey = claim[field];
    if (Object.hasOwn(values, pageKey)) out.values[field] = values[pageKey];
    else if (missing.includes(pageKey)) out.missing.push(field);
  }
  return out;
}

/** The intel routes a request consumes, in call order. Named in the method so
 *  the receipt states which evidence it was built from. The payer footprint
 *  route answers only for Solana pubkeys, so Base outbound reads the rollup's
 *  paid_calls / total_usdc alone. */
export function intelRoutesFor(direction, network) {
  return direction === "outbound" && network === "solana"
    ? ["score_wallet_for_intel", "merchant_card", "get_facilitator_footprint"]
    : ["score_wallet_for_intel", "merchant_card"];
}

export function payoutMethod(request) {
  return {
    claim_url: request.claim_url,
    retrieval: "scrape",
    claim: request.claim,
    wallet: request.wallet,
    network: request.network,
    direction: request.direction,
    intel: intelRoutesFor(request.direction, request.network),
  };
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reduce the raw intel responses to the figures a claim can be held against.
 *  Inbound reads the wallet as a merchant; outbound reads it as an x402 payer. */
export function observeIntel({ score, card, footprint }, direction) {
  const paidCalls = num(score?.paid_calls) ?? 0;
  const counts = direction === "outbound"
    ? {
        payout_count: footprint?.found ? num(footprint.tx_count) ?? paidCalls : paidCalls,
        unique_wallets: footprint?.found ? num(footprint.unique_merchants) : null,
        paid_usd: num(score?.total_usdc),
      }
    : {
        payout_count: num(score?.payments_received),
        unique_wallets: num(score?.distinct_counterparties),
        paid_usd: num(score?.total_usdc_received),
      };
  const windowDays = num(score?.window_days);
  return {
    in_corpus: score?.first_seen != null,
    chain: score?.chain ?? null,
    network: score?.network ?? null,
    window: windowDays === null ? "all_time" : `${windowDays}d`,
    first_seen: score?.first_seen ?? null,
    last_seen: score?.last_seen ?? null,
    role: score?.role ?? null,
    wash_flagged: typeof card?.wash_flagged === "boolean" ? card.wash_flagged : null,
    card_decision: card?.decision ?? null,
    card_confidence: card?.confidence ?? null,
    card_version: card?.card_version ?? null,
    counts,
    mixed_directions: direction === "inbound" && paidCalls > 0,
    corpus: score?.corpus ?? null,
  };
}

const finding = (field, claimed, observed, relation, note = null) => ({ field, claimed, observed, relation, note });

/** One finding per claimed field. Rules, in order: a wallet the corpus never saw
 *  is coverage_limited everywhere; a figure the corpus does not carry is
 *  coverage_limited; inbound above-observed is discrepant (the corpus is the
 *  witness for inbound x402 demand, scope stated); outbound above-observed is
 *  coverage_limited because plain transfers are invisible to an x402 corpus. */
export function comparePayoutClaim(values, observed, direction) {
  return CLAIM_FIELDS.filter((f) => Object.hasOwn(values ?? {}, f)).map((field) => {
    const claimed = values[field];
    const seen = observed.counts[field];
    if (!observed.in_corpus) return finding(field, claimed, seen, "coverage_limited", "wallet_not_observed");
    if (seen === null || seen === undefined) return finding(field, claimed, null, "coverage_limited", "field_unavailable");
    const tolerance = field === "paid_usd" ? USD_TOLERANCE : 0;
    const within = claimed <= seen + tolerance;
    if (direction === "outbound") {
      return within
        ? finding(field, claimed, seen, "supported")
        : finding(field, claimed, seen, "coverage_limited", `cannot_refute: corpus covers x402 settlements only; ${claimed} claimed vs ${seen} x402 payments observed`);
    }
    if (!within) return finding(field, claimed, seen, "discrepant", `claim exceeds the observed corpus. ${CORPUS_SCOPE}`);
    if (field === "unique_wallets" && observed.mixed_directions) {
      return finding(field, claimed, seen, "coverage_limited", "upper_bound_only: distinct_counterparties mixes payer and payee edges");
    }
    return finding(field, claimed, seen, "supported");
  });
}

/** Verdict precedence: nothing extracted is not an answer (free); a partial
 *  extraction is incomplete; any covered field above observed is discrepant;
 *  any uncovered field is coverage_limited; otherwise supported. */
export function classifyPayoutVerdict(findings, { values, missing }) {
  const extracted = Object.keys(values ?? {}).length;
  if (!extracted) return { verdict: null, reason: "extract_none", missing: [...(missing ?? [])] };
  if (missing && missing.length) return { verdict: "incomplete", reason: "extract_missing", missing: [...missing] };
  const discrepant = findings.filter((f) => f.relation === "discrepant");
  if (discrepant.length) return { verdict: "discrepant", reason: `claim_exceeds_observed:${discrepant.map((f) => f.field).join(",")}` };
  const limited = findings.find((f) => f.relation === "coverage_limited");
  if (limited) return { verdict: "coverage_limited", reason: limited.note.split(":")[0] };
  return { verdict: "supported", reason: null };
}

export function buildPayoutReceipt({
  request, text, values, missing = [], findings, observed, intelSources, verdict, verdict_reason,
  observed_at, key, vantage = "box", valid_for_ms = VALID_FOR_MS,
}) {
  const method = payoutMethod(request);
  const rest = {
    schema: PAYOUT_SCHEMA,
    claim: { url: request.claim_url, source_hash: sourceHash(text), keys: request.claim, values, missing: [...missing], evidence: text.slice(0, 160) },
    wallet: request.wallet,
    network: request.network,
    direction: request.direction,
    evidence: { intel_sources: intelSources, observed },
    findings,
    coverage: {
      corpus: observed.corpus,
      chain: observed.chain,
      window: observed.window,
      note: CORPUS_SCOPE,
    },
    verdict,
    verdict_reason,
    observed_at,
    valid_until: new Date(Date.parse(observed_at) + valid_for_ms).toISOString(),
    method,
    spec_hash: specHash(method),
    vantage,
  };
  return signReceipt(rest, key);
}
