/**
 * Consumer pilot offers — static handoff data, no persistence, never billed.
 *
 * One offer per the implementation contract
 * (docs/consumer/implementation-contract.md): a public page that leads with
 * the outcome, links directly to the merchant, and hands an agent a copyable
 * task. There is no merchant adapter yet, so POST /api/quotes always answers
 * handoff_required — the buyer completes checkout at the merchant, and TWZRD
 * cannot enforce the final card charge in that path.
 *
 * Observed prices are discovery data, never final quotes.
 */

export const OFFERS = Object.freeze({
  "pixel-surplus-vintage-polaroid": Object.freeze({
    id: "pixel-surplus-vintage-polaroid",
    merchant: "Pixel Surplus",
    product: "Vintage Polaroid Photo Frames",
    variant: "Desktop Commercial Use License",
    variant_id: "46117070209071",
    outcome: "Give your photos a vintage finish.",
    deliverable: "22 PNG frames for rasterized web artwork (application embedding restricted — select the correct use/license).",
    observed_price_minor: 600,
    observed_currency: "USD",
    price_kind: "observed_item_price",
    product_url: "https://pixelsurplus.com/products/vintage-polaroid-photo-frames",
    cart_url: "https://pixel-surplus.myshopify.com/cart/46117070209071:1",
    license_url: "https://pixelsurplus.com/pages/licensing",
    agent_execution: "handoff_only",
  }),
});

export function getOffer(id) {
  return typeof id === "string" ? OFFERS[id] ?? null : null;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Public read-only HTML. No checkout creation, reservation, or paid observation. */
export function renderOfferHtml(offer) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(offer.product)} — ${esc(offer.merchant)}</title></head>
<body>
<h1>${esc(offer.outcome)}</h1>
<p>Buyer receives: ${esc(offer.deliverable)}</p>
<dl>
<dt>Merchant</dt><dd>${esc(offer.merchant)}</dd>
<dt>Product</dt><dd>${esc(offer.product)} — ${esc(offer.variant)}</dd>
<dt>Observed item price</dt><dd>${esc(offer.observed_currency)} ${(offer.observed_price_minor / 100).toFixed(2)} (observed, not a final quote)</dd>
<dt>License</dt><dd><a href="${esc(offer.license_url)}">${esc(offer.license_url)}</a> — confirm coverage before use</dd>
</dl>
<p><a href="${esc(offer.product_url)}">Buy at the merchant</a> · <a href="/api/offers/${esc(offer.id)}/task.json">Agent task (JSON)</a></p>
<p>No partnership with the merchant. Price and fulfillment are the merchant's, not TWZRD's.</p>
</body>
</html>
`;
}

/** Same public offer as structured data. */
export function buildOfferJson(offer) {
  return {
    id: offer.id,
    merchant: offer.merchant,
    product: offer.product,
    variant: offer.variant,
    variant_id: offer.variant_id,
    outcome: offer.outcome,
    deliverable: offer.deliverable,
    observed_price_minor: offer.observed_price_minor,
    observed_currency: offer.observed_currency,
    price_kind: offer.price_kind,
    agent_execution: offer.agent_execution,
    product_url: offer.product_url,
    cart_url: offer.cart_url,
    license_url: offer.license_url,
  };
}

/**
 * Reusable intent and requirements. authorization:null — the recipient
 * supplies fresh authority and an all-in budget; no mandate, signature,
 * wallet, email, or private order data enters this template.
 */
export function buildOfferTask(offer) {
  return {
    offer_id: offer.id,
    authorization: null,
    intent: `Obtain the correctly licensed ${offer.product} (${offer.variant}) from ${offer.merchant}, use it in a flattened photo composition, and return the finished output plus private order evidence.`,
    requirements: [
      "Correct license for the use (desktop commercial vs extended) — read the license page, do not guess.",
      "No subscription; one-time licensed pack only.",
      "Fresh all-in total including tax/fees, confirmed at the merchant before paying.",
      "Recipient supplies fresh authority and budget; this task carries none.",
    ],
    merchant: { name: offer.merchant, product_url: offer.product_url, cart_url: offer.cart_url, license_url: offer.license_url },
    observed_price: { amount_minor: offer.observed_price_minor, currency: offer.observed_currency, kind: offer.price_kind },
  };
}

/**
 * Quote stub. Without a configured authenticated merchant adapter every
 * request answers handoff_required — a public merchant link, never a price
 * commitment, reservation, or checkout session.
 */
export function handleOfferQuote(body) {
  const offerId = body && typeof body === "object" && !Array.isArray(body) ? body.offer_id : undefined;
  if (typeof offerId !== "string" || !offerId) {
    return { status: 400, json: { reason: "bad_offer_quote", expected: { offer_id: "<offer id>" }, example: { offer_id: "pixel-surplus-vintage-polaroid" } } };
  }
  const offer = getOffer(offerId);
  if (!offer) return { status: 404, json: { reason: "offer_not_found", offer_id: offerId } };
  return {
    status: 200,
    json: {
      decision: "handoff_required",
      reason: "final_quote_required",
      offer_id: offer.id,
      merchant: offer.merchant,
      cart_url: offer.cart_url,
      product_url: offer.product_url,
      observed_price: { amount_minor: offer.observed_price_minor, currency: offer.observed_currency, kind: offer.price_kind },
      payment_authorized: false,
      order_status: "not_created",
      enforcement_scope: "eligibility_only",
    },
  };
}
