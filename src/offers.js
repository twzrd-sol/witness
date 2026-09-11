/**
 * Consumer offers — catalog, cart, and a gated checkout handoff.
 *
 * Shape follows the Claude Commerce Agents blueprint (anthropics/commerce-agents):
 * the agent reads the catalog, builds a cart, and a checkout step returns what
 * the host needs to complete payment. Two rails:
 *
 *  - merchant_checkout: payment happens at the merchant's own checkout. The
 *    quote returns a cart and the merchant checkout URL — but only after
 *    Witness has observed the merchant's live product record and the price
 *    the catalog promised is what the merchant still says. A contradicted,
 *    incomplete, or unverifiable observation withholds the URL (409).
 *  - x402: the product is an agent-payable resource. The quote probes the
 *    live 402 challenge and returns the accepts[] the agent can settle
 *    against — only if the payee and amount still match the catalog.
 *
 * Witness never pays, reserves, or creates order state on either rail.
 * See docs/consumer/claude-commerce-agents.md for the mapping.
 */

export const OFFERS = Object.freeze({
  "pixel-surplus-vintage-polaroid": Object.freeze({
    id: "pixel-surplus-vintage-polaroid",
    rail: "merchant_checkout",
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
    // Witness method run before the checkout URL is handed over: the merchant's
    // public product record must still carry the catalog price (cents).
    verify: Object.freeze({
      url: "https://pixelsurplus.com/products/vintage-polaroid-photo-frames.js",
      retrieval: "scrape",
      extract: Object.freeze({ price: "number", handle: "string" }),
      assertion: "price == 600",
      replicas: 1,
    }),
  }),
  "outbid-reader-scrape": Object.freeze({
    id: "outbid-reader-scrape",
    rail: "x402",
    merchant: "outbid",
    product: "Reader",
    variant: "scrape — HTML to markdown",
    outcome: "Read any public page as clean markdown.",
    deliverable: "JSON {title, content, markdown, word_count} for one public URL.",
    price_usdc: "0.005",
    amount_atomic: "5000",
    asset: "USDC",
    product_url: "https://outbid.sh",
    resource: Object.freeze({
      method: "GET",
      url_template: "https://reader.outbid.sh/scrape?url={url}",
      input: Object.freeze({ url: "public http(s) URL to read" }),
    }),
    // Payees the catalog vouches for. The live 402 must still name one of
    // these at this amount, or the quote withholds — a changed payee never
    // inherits prior approval.
    accepts: Object.freeze([
      Object.freeze({ scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x14df772BD496bBb7f49Bc3E992Ce13B2c441177F" }),
      Object.freeze({ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "5000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "F1AbWuXJcBT9arW9wc6Xr2vom5NBtngWsz6Ht16jRBLM" }),
    ]),
    // What a delivery attestation would grade this call against. Buyer-authored:
    // outbid publishes no machine-readable output schema for its own Reader, so
    // this spec is ours and a receipt built on it says so.
    delivery: Object.freeze({
      deliverable_class: "data_json",
      spec_origin: "buyer_authored",
      spec: Object.freeze({ required_fields: Object.freeze({ title: "string", markdown: "string", word_count: "number" }) }),
    }),
  }),
  // The first listing that is not ours. It is here because the catalog analysis
  // found it among the resources with PROVABLE repeat demand - more calls than
  // payers, not a keepalive or a listing ping - and because its deliverable is
  // one of the few that can be checked by someone who is not the seller: the
  // response is a URL, and either it serves the page you sent or it does not.
  //
  // A listing is not an endorsement. It asserts exactly what the gate can
  // re-observe: this resource answered 402 with this payee at this amount when
  // we looked, and the handoff withholds the moment that stops being true.
  "stacktree-publish": Object.freeze({
    id: "stacktree-publish",
    rail: "x402",
    merchant: "Stacktree",
    product: "Publish",
    variant: "HTML to a permanent private link",
    outcome: "Publish an HTML page an agent produced and get back a link it can share.",
    deliverable: "JSON {url, claim_token} for one HTML document; the URL serves the page.",
    price_usdc: "0.50",
    amount_atomic: "500000",
    asset: "USDC",
    product_url: "https://stacktr.ee",
    resource: Object.freeze({
      method: "POST",
      url_template: "https://api.stacktr.ee/publish",
      input: Object.freeze({ html: "the full HTML document to host (JSON body)" }),
      // The input travels in the request body, so there is nothing to interpolate
      // into the URL and nothing for a caller to supply before the gate can probe.
      input_in: "body",
    }),
    // Payees the catalog vouches for, read from the live challenge on
    // 2026-09-11. Unpaid, this endpoint answers 402 on POST - the same method
    // and the same challenge as GET - so the gate probes with the method the
    // buyer actually pays on, and an unpaid probe cannot publish anything.
    accepts: Object.freeze([
      Object.freeze({ scheme: "exact", network: "eip155:8453", amount: "500000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xcc985ba6934d134feec4824ba40258608f3a4333" }),
      Object.freeze({ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "500000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: "Gr8z3Dh74y4nJJAW25r2WSmzm3ZQr2n5GU5qjavFG49c" }),
    ]),
    // seller_published: these field names are the seller's own, taken from the
    // output schema it publishes in its 402 challenge, not paraphrased by us.
    // That is the provenance a delivery receipt can carry without discount.
    delivery: Object.freeze({
      deliverable_class: "data_json",
      spec_origin: "seller_published",
      spec: Object.freeze({ required_fields: Object.freeze({ url: "string", claim_token: "string" }) }),
    }),
  }),
});

/** Every offer as structured data, in catalog order. */
export function listOffers(catalog = OFFERS) {
  return Object.values(catalog).map(buildOfferJson);
}

export function getOffer(id, catalog = OFFERS) {
  return typeof id === "string" ? catalog[id] ?? null : null;
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (minor, currency) => `${currency} ${(minor / 100).toFixed(2)}`;

const priceLine = (offer) =>
  offer.rail === "x402"
    ? `${offer.asset} ${offer.price_usdc} per call, paid over x402 by the agent`
    : `${money(offer.price_minor, offer.currency)} (observed, not a final quote — total shown at merchant checkout)`;

/** Offer page: outcome, deliverable, price, license, buy link, agent task. */
export function renderOfferHtml(offer) {
  const buy = offer.rail === "x402"
    ? `<a href="${esc(offer.product_url)}">About ${esc(offer.merchant)}</a>`
    : `<a href="${esc(offer.cart_url)}">Buy now</a> · <a href="${esc(offer.product_url)}">View at ${esc(offer.merchant)}</a>`;
  const license = offer.license_url
    ? `<dt>License</dt><dd><a href="${esc(offer.license_url)}">${esc(offer.license_url)}</a></dd>\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(offer.product)} — ${esc(offer.merchant)}</title></head>
<body>
<h1>${esc(offer.outcome)}</h1>
<p>You get: ${esc(offer.deliverable)}</p>
<dl>
<dt>Merchant</dt><dd>${esc(offer.merchant)}</dd>
<dt>Product</dt><dd>${esc(offer.product)} — ${esc(offer.variant)}</dd>
<dt>Rail</dt><dd>${esc(offer.rail)}</dd>
<dt>Price</dt><dd>${esc(priceLine(offer))}</dd>
${license}</dl>
<p>${buy} · <a href="/api/offers/${esc(offer.id)}/task.json">Agent task (JSON)</a></p>
<p>No partnership with the merchant. Price and fulfillment are the merchant's, not TWZRD's.</p>
</body>
</html>
`;
}

/** Same offer as structured data — the catalog record an agent searches. */
export function buildOfferJson(offer) {
  const common = {
    id: offer.id,
    rail: offer.rail,
    merchant: offer.merchant,
    product: offer.product,
    variant: offer.variant,
    outcome: offer.outcome,
    deliverable: offer.deliverable,
    product_url: offer.product_url,
  };
  if (offer.rail === "x402") {
    return {
      ...common,
      checkout: "x402",
      price: { amount_atomic: offer.amount_atomic, asset: offer.asset, usd: offer.price_usdc },
      resource: { method: offer.resource.method, url_template: offer.resource.url_template, input: offer.resource.input },
      accepts: offer.accepts,
      // What POST /delivery/attest should grade the response against once this
      // call is paid, and who wrote that spec. Carrying it here is what lets the
      // after-settlement stage run without the buyer inventing a contract.
      delivery: offer.delivery ?? null,
    };
  }
  return {
    ...common,
    variant_id: offer.variant_id,
    price_minor: offer.price_minor,
    currency: offer.currency,
    price_kind: offer.price_kind,
    checkout: "merchant_hosted",
    verified_by: offer.verify ? { source: offer.verify.url, assertion: offer.verify.assertion } : null,
    cart_url: offer.cart_url,
    license_url: offer.license_url,
  };
}

/** Copyable agent task: intent and requirements for this offer. */
export function buildOfferTask(offer) {
  if (offer.rail === "x402") {
    return {
      offer_id: offer.id,
      authorization: null,
      intent: `${offer.outcome} Pay ${offer.asset} ${offer.price_usdc} to ${offer.merchant} ${offer.product} over x402 and return ${offer.deliverable}`,
      requirements: [
        `POST /api/quotes with {offer_id${offer.resource.input_in === "body" ? "" : ", input: {url}"}} first; pay only against the accepts[] the quote returns.`,
        `Pay exactly amount ${offer.amount_atomic} atomic ${offer.asset} to the quoted payTo on the quoted network; a different payee or amount is a stop.`,
        "One call, one payment; no retries that pay twice.",
      ],
      resource: { method: offer.resource.method, url_template: offer.resource.url_template, input: offer.resource.input },
      price: { amount_atomic: offer.amount_atomic, asset: offer.asset, usd: offer.price_usdc },
      delivery: offer.delivery ?? null,
    };
  }
  return {
    offer_id: offer.id,
    // The recipient supplies fresh authority and budget; no mandate,
    // signature, wallet, or credentials travel in this template.
    authorization: null,
    intent: `Buy the ${offer.product} (${offer.variant}) from ${offer.merchant}, use it in a flattened photo composition, and return the finished output plus the order confirmation.`,
    requirements: [
      "POST /api/quotes with {offer_id, quantity} first; use only the checkout_url it returns. A 409 means the merchant's live price no longer matches — stop.",
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
 * Gate for the merchant rail. Runs the offer's Witness method through the
 * free quote path (no signing, no billing, no observation written) and
 * decides on the announced verdict. Only `supported` passes; every other
 * outcome — contradicted, incomplete, unable_to_verify, retrieve failure,
 * malformed method — withholds. Fail-closed, like decideGate in the
 * shopping-preapproval harness.
 */
export async function verifyMerchantOffer(offer, { quote, now = () => new Date().toISOString() }) {
  if (!offer.verify) return { status: "withheld", reason: "verify_method_missing", verdict: null, source: null };
  const source = offer.verify.url;
  let out;
  try {
    out = await quote(offer.verify);
  } catch {
    return { status: "withheld", reason: "verify_failed", verdict: null, source };
  }
  if (!out || out.status !== 200) {
    return { status: "withheld", reason: `verify_${out?.json?.reason ?? "unavailable"}`, verdict: null, source };
  }
  const verdict = out.json.verdict ?? null;
  const observed = out.values ?? {};
  if (verdict === "supported") return { status: "passed", reason: "verdict_supported", verdict, observed, observed_at: now(), source };
  return { status: "withheld", reason: `verdict_${verdict ?? "missing"}`, verdict, observed, observed_at: now(), source };
}

const X402_V1_NETWORKS = Object.freeze({ base: "eip155:8453", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });

/** Parse a live 402 into a v2-shaped {x402Version, accepts[]}; null when unreadable. */
export function parseX402Challenge(headerValue, body) {
  if (typeof headerValue === "string" && headerValue) {
    try {
      const json = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
      if (Array.isArray(json?.accepts)) return { x402Version: json.x402Version ?? 2, accepts: json.accepts };
    } catch { /* fall through to body */ }
  }
  if (body && typeof body === "object" && Array.isArray(body.accepts)) {
    return {
      x402Version: body.x402Version ?? 1,
      accepts: body.accepts.map((a) => ({
        scheme: a.scheme,
        network: X402_V1_NETWORKS[a.network] ?? a.network,
        amount: a.amount ?? a.maxAmountRequired,
        asset: a.asset,
        payTo: a.payTo,
      })),
    };
  }
  return null;
}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Resolve the resource URL for an x402 offer from agent input. Throws on bad input. */
export function resolveResourceUrl(offer, input) {
  // Offers whose input travels in the request body have a fixed resource URL:
  // there is nothing to interpolate, and demanding an input.url would make the
  // quote unreachable for every offer that is not the Reader.
  if (offer.resource.input_in === "body") return offer.resource.url_template;
  const url = input && typeof input === "object" && !Array.isArray(input) ? input.url : undefined;
  if (typeof url !== "string" || url.length > 2048) throw new Error("bad_input_url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("bad_input_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("bad_input_url");
  return offer.resource.url_template.replace("{url}", encodeURIComponent(url));
}

/**
 * Gate for the x402 rail. Probes the live resource unpaid, expects a 402,
 * and keeps only the live accepts[] entries whose network, payee, and amount
 * match what the catalog vouches for. No match withholds: the agent is never
 * pointed at a payee the catalog did not name.
 */
export async function probeX402Offer(offer, resourceUrl, { fetch: doFetch, now = () => new Date().toISOString(), timeoutMs = 10000 }) {
  let res;
  try {
    res = await doFetch(resourceUrl, { method: offer.resource.method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: "withheld", reason: "probe_failed", live: null };
  }
  if (res.status !== 402) return { status: "withheld", reason: "resource_not_402", live: { status: res.status } };
  let body = null;
  try {
    body = await res.json();
  } catch { /* header may still carry the challenge */ }
  const challenge = parseX402Challenge(res.headers?.get?.("payment-required"), body);
  if (!challenge) return { status: "withheld", reason: "challenge_unreadable", live: null };
  const summarize = (a) => ({ scheme: a.scheme, network: a.network, amount: a.amount, asset: a.asset, payTo: a.payTo });
  const matched = challenge.accepts.filter((live) =>
    offer.accepts.some((c) => same(c.network, live.network) && same(c.payTo, live.payTo) && c.amount === String(live.amount) && same(c.asset, live.asset)),
  );
  if (!matched.length) {
    return { status: "withheld", reason: "payee_or_price_changed", live: challenge.accepts.map(summarize), probed_at: now() };
  }
  return { status: "passed", reason: "challenge_matches_catalog", x402Version: challenge.x402Version, accepts: matched.map(summarize), probed_at: now() };
}

/**
 * Build a cart for an offer and return what the agent needs to check out —
 * the blueprint's prepare_checkout(cart) step, gated. deps.verifyMerchant and
 * deps.probeX402 are supplied by the router (cache + rate limit live there).
 * Without them the quote withholds: an ungated handoff is never issued here.
 */
export async function handleOfferQuote(body, deps = {}) {
  const catalog = deps.catalog ?? OFFERS;
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const offerId = b.offer_id;
  if (typeof offerId !== "string" || !offerId) {
    return { status: 400, json: { reason: "bad_offer_quote", expected: { offer_id: "<offer id>", quantity: 1, input: { url: "<x402 offers only>" } }, example: { offer_id: "pixel-surplus-vintage-polaroid" } } };
  }
  const offer = getOffer(offerId, catalog);
  if (!offer) return { status: 404, json: { reason: "offer_not_found", offer_id: offerId } };

  if (offer.rail === "x402") {
    let resourceUrl;
    try {
      resourceUrl = resolveResourceUrl(offer, b.input);
    } catch (e) {
      return { status: 400, json: { reason: e.message, offer_id: offer.id, expected: { input: offer.resource.input } } };
    }
    if (typeof deps.probeX402 !== "function") return { status: 503, json: { reason: "gate_not_wired", offer_id: offer.id } };
    const gate = await deps.probeX402(offer, resourceUrl);
    if (gate.limited) return { status: 429, json: { reason: "quote_rate_limited", offer_id: offer.id } };
    const base = {
      offer_id: offer.id,
      rail: "x402",
      merchant: offer.merchant,
      request: { method: offer.resource.method, url: resourceUrl },
      price: { amount_atomic: offer.amount_atomic, asset: offer.asset, usd: offer.price_usdc },
      checkout: "x402",
    };
    if (gate.status !== "passed") {
      return { status: 409, json: { ...base, accepts: null, gate: { status: "withheld", reason: gate.reason, live: gate.live ?? null, probed_at: gate.probed_at ?? null } } };
    }
    return { status: 200, json: { ...base, accepts: gate.accepts, gate: { status: "passed", reason: gate.reason, x402Version: gate.x402Version, probed_at: gate.probed_at, cached: gate.cached === true } } };
  }

  const quantity = b.quantity === undefined ? 1 : b.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
    return { status: 400, json: { reason: "bad_quantity", offer_id: offerId, expected: "integer 1..99" } };
  }
  if (typeof deps.verifyMerchant !== "function") return { status: 503, json: { reason: "gate_not_wired", offer_id: offer.id } };
  const gate = await deps.verifyMerchant(offer);
  if (gate.limited) return { status: 429, json: { reason: "quote_rate_limited", offer_id: offer.id } };
  const base = {
    offer_id: offer.id,
    rail: "merchant_checkout",
    merchant: offer.merchant,
    cart: {
      items: [{ variant_id: offer.variant_id, product: offer.product, variant: offer.variant, quantity, unit_price_minor: offer.price_minor }],
      subtotal_minor: offer.price_minor * quantity,
      currency: offer.currency,
      price_kind: offer.price_kind,
      price_note: "Observed item price, not a final quote — tax and fees set the total at merchant checkout.",
    },
    checkout: "merchant_hosted",
    product_url: offer.product_url,
  };
  const gateJson = {
    status: gate.status,
    reason: gate.reason,
    verdict: gate.verdict ?? null,
    observed: gate.observed ?? null,
    observed_at: gate.observed_at ?? null,
    source: gate.source ?? null,
    cached: gate.cached === true,
  };
  if (gate.status !== "passed") {
    return { status: 409, json: { ...base, checkout_url: null, gate: gateJson } };
  }
  return { status: 200, json: { ...base, checkout_url: buildCheckoutUrl(offer, quantity), gate: gateJson } };
}
