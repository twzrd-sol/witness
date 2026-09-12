/** Seller-side offer and outcome primitives.
 *
 * These functions are deliberately pure. They make an agent's service
 * discoverable and its observed performance legible; they never authorize a
 * payment, calculate a trust score from missing data, or claim delivery.
 */

export const SELLER_OFFER_SCHEMA_VERSION = "seller-offer/v1";
const NETWORKS = new Set(["base", "solana"]);

function error(field, reason) { return { field, reason }; }

/** Validate the public portion of an agent service offer. */
export function validateSellerOffer(offer) {
  const errors = [];
  if (!offer || typeof offer !== "object" || Array.isArray(offer))
    return { valid: false, errors: [error("offer", "object_required")] };
  if (offer.schema_version !== SELLER_OFFER_SCHEMA_VERSION)
    errors.push(error("schema_version", "unsupported"));
  for (const field of ["seller_id", "capability", "currency", "network", "payout_wallet"])
    if (typeof offer[field] !== "string" || offer[field].trim() === "") errors.push(error(field, "required"));
  if (offer.currency !== "USDC") errors.push(error("currency", "must_be_USDC"));
  if (typeof offer.network === "string" && !NETWORKS.has(offer.network)) errors.push(error("network", "unsupported"));
  if (!Number.isSafeInteger(offer.price_minor) || offer.price_minor <= 0)
    errors.push(error("price_minor", "positive_integer_required"));
  if (!Number.isSafeInteger(offer.sla_minutes) || offer.sla_minutes <= 0)
    errors.push(error("sla_minutes", "positive_integer_required"));
  if (!offer.deliverable || typeof offer.deliverable !== "object" || Array.isArray(offer.deliverable))
    errors.push(error("deliverable", "object_required"));
  else {
    if (typeof offer.deliverable.description !== "string" || offer.deliverable.description.trim() === "")
      errors.push(error("deliverable.description", "required"));
    if (typeof offer.deliverable.mime_type !== "string" || offer.deliverable.mime_type.trim() === "")
      errors.push(error("deliverable.mime_type", "required"));
  }
  if (offer.evidence_url !== undefined) {
    try {
      const u = new URL(offer.evidence_url);
      if (u.protocol !== "https:") errors.push(error("evidence_url", "https_required"));
    } catch { errors.push(error("evidence_url", "https_required")); }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Build a seller card from explicit outcome rows. Unknown/empty history stays
 * unknown; it is never converted into a positive trust claim.
 */
export function buildSellerCard(offer, outcomes = []) {
  const checked = validateSellerOffer(offer);
  if (!checked.valid) throw new TypeError(`invalid seller offer: ${checked.errors.map((e) => `${e.field}:${e.reason}`).join(",")}`);
  if (!Array.isArray(outcomes)) throw new TypeError("outcomes must be an array");
  const completed = outcomes.filter((o) => o && (o.status === "accepted" || o.status === "rejected"));
  const accepted = completed.filter((o) => o.status === "accepted");
  const refunded = outcomes.filter((o) => o && o.status === "refunded");
  const delivered = accepted.map((o) => o.delivery_minutes).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const median = delivered.length ? delivered[Math.floor((delivered.length - 1) / 2)] : null;
  return {
    schema_version: "seller-card/v1",
    seller_id: offer.seller_id,
    payout_wallet: offer.payout_wallet,
    capability: offer.capability,
    price_usdc: (offer.price_minor / 1_000_000).toFixed(6),
    currency: offer.currency,
    network: offer.network,
    sla_minutes: offer.sla_minutes,
    deliverable: offer.deliverable,
    outcomes: {
      completed_jobs: completed.length,
      accepted_jobs: accepted.length,
      approval_rate: completed.length ? accepted.length / completed.length : null,
      refunded_jobs: refunded.length,
      refund_rate: outcomes.length ? refunded.length / outcomes.length : null,
      median_delivery_minutes: median,
    },
    evidence_url: offer.evidence_url ?? null,
    evidence_status: offer.evidence_url ? "operator_supplied" : "none",
  };
}
