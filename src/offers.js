/**
 * Consumer offers — catalog, cart, and merchant-hosted checkout.
 *
 * Shape follows the Claude Commerce Agents blueprint (anthropics/commerce-agents):
 * the agent searches the catalog, builds a cart, and a checkout step returns
 * a URL the host renders. Payment happens at the merchant's own checkout.
 * See docs/consumer/claude-commerce-agents.md for the mapping.
 */

export const OFFERS = Object.freeze({
  "pixel-surplus-vintage-polaroid": Object.freeze({
    id: "pixel-surplus-vintage-polaroid",
    merchant: "Pixel Surplus",
    product: "Vintage Polaroid Photo Frames",
    variant: "Desktop Commercial Use License",
    variant_id: "46117070209071",
    outcome: "Give your photos a vintage finish.",
    deliverable: "22 PNG frames for rasterized web artwork.",
    price_minor: 600,
    currency: "USD",
    // Discovery data, never a final quote: tax and fees set the total at checkout.
    price_kind: "observed_item_price",
    product_url: "https://pixelsurplus.com/products/vintage-polaroid-photo-frames",
    cart_url: "https://pixel-surplus.myshopify.com/cart/46117070209071:1",
    // Base for per-quantity cart permalinks. The checkout origin lives in the
    // catalog record — never hardcoded in route logic — so a second merchant
    // cannot inherit the first one's origin.
    cart_base: "https://pixel-surplus.myshopify.com/cart",
    license_url: "https://pixelsurplus.com/pages/licensing",
  }),
});

export function getOffer(id, catalog = OFFERS) {
  return typeof id === "string" ? catalog[id] ?? null : null;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`;

/** Offer page: outcome, deliverable, price, license, buy link, agent task. */
export function renderOfferHtml(offer) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(offer.product)} — ${esc(offer.merchant)}</title></head>
<body>
<h1>${esc(offer.outcome)}</h1>
<p>You get: ${esc(offer.deliverable)}</p>
<dl>
<dt>Merchant</dt><dd>${esc(offer.merchant)}</dd>
<dt>Product</dt><dd>${esc(offer.product)} — ${esc(offer.variant)}</dd>
<dt>Price</dt><dd>${esc(money(offer.price_minor, offer.currency))} (observed, not a final quote — total shown at merchant checkout)</dd>
<dt>License</dt><dd><a href="${esc(offer.license_url)}">${esc(offer.license_url)}</a></dd>
</dl>
<p><a href="${esc(offer.cart_url)}">Buy now</a> · <a href="${esc(offer.product_url)}">View at ${esc(offer.merchant)}</a> · <a href="/api/offers/${esc(offer.id)}/task.json">Agent task (JSON)</a></p>
<p>No partnership with the merchant. Price and fulfillment are the merchant's, not TWZRD's.</p>
</body>
</html>
`;
}

/** Same offer as structured data — the catalog record an agent searches. */
export function buildOfferJson(offer) {
  return {
    id: offer.id,
    merchant: offer.merchant,
    product: offer.product,
    variant: offer.variant,
    variant_id: offer.variant_id,
    outcome: offer.outcome,
    deliverable: offer.deliverable,
    price_minor: offer.price_minor,
    currency: offer.currency,
    price_kind: offer.price_kind,
    checkout: "merchant_hosted",
    product_url: offer.product_url,
    cart_url: offer.cart_url,
    license_url: offer.license_url,
  };
}

/** Copyable agent task: intent and requirements for this offer. */
export function buildOfferTask(offer) {
  return {
    offer_id: offer.id,
    // The recipient supplies fresh authority and budget; no mandate,
    // signature, wallet, or credentials travel in this template.
    authorization: null,
    intent: `Buy the ${offer.product} (${offer.variant}) from ${offer.merchant}, use it in a flattened photo composition, and return the finished output plus the order confirmation.`,
    requirements: [
      "Select the license that matches the use (desktop commercial vs extended); read the license page.",
      "One-time licensed pack, no subscription.",
      "Human confirms purchase details and supplies budget/authority before any payment; this task carries none.",
      "Complete payment at the merchant checkout; the all-in total is shown there.",
    ],
    merchant: { name: offer.merchant, product_url: offer.product_url, cart_url: offer.cart_url, license_url: offer.license_url },
    price: { amount_minor: offer.price_minor, currency: offer.currency, kind: offer.price_kind },
  };
}

/**
 * Merchant checkout URL for an offer and quantity, derived from the
 * server-side catalog record. Throws on a record without a usable
 * cart_base so a misconfigured offer fails closed instead of pointing
 * at another merchant's origin.
 */
export function buildCheckoutUrl(offer, quantity) {
  const base = offer?.cart_base;
  if (typeof base !== "string" || !/^https:\/\/[A-Za-z0-9.-]+\/cart$/.test(base)) {
    throw new Error("offer_missing_cart_base");
  }
  if (!/^\d+$/.test(offer.variant_id ?? "")) throw new Error("offer_missing_variant");
  return `${base}/${offer.variant_id}:${quantity}`;
}

/**
 * Build a cart for an offer and return the merchant checkout URL — the
 * blueprint's prepare_checkout(cart) step. quantity defaults to 1.
 */
export function handleOfferQuote(body, catalog = OFFERS) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const offerId = b.offer_id;
  if (typeof offerId !== "string" || !offerId) {
    return { status: 400, json: { reason: "bad_offer_quote", expected: { offer_id: "<offer id>", quantity: 1 }, example: { offer_id: "pixel-surplus-vintage-polaroid" } } };
  }
  const offer = getOffer(offerId, catalog);
  if (!offer) return { status: 404, json: { reason: "offer_not_found", offer_id: offerId } };
  const quantity = b.quantity === undefined ? 1 : b.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return { status: 400, json: { reason: "bad_quantity", offer_id: offerId, expected: "integer 1..99" } };
  }
  const checkoutUrl = buildCheckoutUrl(offer, quantity);
  return {
    status: 200,
    json: {
      offer_id: offer.id,
      merchant: offer.merchant,
      cart: {
        items: [{ variant_id: offer.variant_id, product: offer.product, variant: offer.variant, quantity, unit_price_minor: offer.price_minor }],
        subtotal_minor: offer.price_minor * quantity,
        currency: offer.currency,
        price_kind: offer.price_kind,
        price_note: "Observed item price, not a final quote — tax and fees set the total at merchant checkout.",
      },
      checkout: "merchant_hosted",
      checkout_url: checkoutUrl,
      product_url: offer.product_url,
    },
  };
}
