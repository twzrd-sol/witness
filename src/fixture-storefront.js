/**
 * Local-only fixture storefront for the x402 digital-product pilot.
 *
 * Catalog and quotes are in-process. Bind is loopback only. No remote
 * storefront, Catalog, UCP, reader, or 402 probe. No wallet. No payment.
 * Schema: docs/consumer/schemas/fixture-storefront-v1.json
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

export const KIND = "witness.fixture_storefront.v1";
export const ORIGIN = "local";
export const READER_OFFER_ID = "outbid-reader-scrape";
export const NOTE_OFFER_ID = "fixture-digital-note";

export const FIXTURE_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL("../docs/consumer/schemas/fixture-storefront-v1.json", import.meta.url), "utf8"),
);

const CATALOG_URL = new URL("../fixtures/storefront/catalog.json", import.meta.url);
const FORBIDDEN_FIELDS = Object.freeze([
  "store_url", "cart_url", "checkout_url", "variant_id", "cart_base",
]);
const FORBIDDEN_HOST_NEEDLES = Object.freeze([
  ".my" + "shop" + "ify.",
  "shop" + "ify.com",
  "pixel" + "surplus",
]);

const fail = (reason) => ({ ok: false, reason });
const own = (o, k) => o != null && Object.hasOwn(o, k);

function hasForbiddenHostText(value) {
  const text = typeof value === "string" ? value.toLowerCase() : JSON.stringify(value).toLowerCase();
  return FORBIDDEN_HOST_NEEDLES.some((n) => text.includes(n));
}

/** Structural + host-text check. Does not fetch. */
export function inspectCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return fail("bad_catalog");
  if (catalog.kind !== KIND) return fail("kind_mismatch");
  if (catalog.live_shopify !== false) return fail("live_flag");
  if (catalog.origin !== ORIGIN) return fail("origin_not_local");
  if (!Array.isArray(catalog.products) || catalog.products.length < 1) return fail("empty_catalog");
  if (hasForbiddenHostText(catalog)) return fail("forbidden_host");
  for (const k of FORBIDDEN_FIELDS) {
    if (own(catalog, k)) return fail("forbidden_field");
  }
  for (const product of catalog.products) {
    if (!product || typeof product !== "object" || Array.isArray(product)) return fail("bad_product");
    for (const k of FORBIDDEN_FIELDS) {
      if (own(product, k)) return fail("forbidden_field");
    }
    if (product.rail !== "x402" || product.checkout !== "x402") return fail("rail_not_x402");
    if (hasForbiddenHostText(product)) return fail("forbidden_host");
  }
  return { ok: true, catalog };
}

export function loadCatalog() {
  const catalog = JSON.parse(readFileSync(CATALOG_URL, "utf8"));
  const inspected = inspectCatalog(catalog);
  if (!inspected.ok) throw new Error(inspected.reason);
  return inspected.catalog;
}

export function listProducts(catalog = loadCatalog()) {
  const inspected = inspectCatalog(catalog);
  if (!inspected.ok) return [];
  return inspected.catalog.products.map((p) => ({ ...p }));
}

export function getProduct(id, catalog = loadCatalog()) {
  if (typeof id !== "string" || !id) return null;
  const inspected = inspectCatalog(catalog);
  if (!inspected.ok) return null;
  return inspected.catalog.products.find((p) => p.id === id) ?? null;
}

function resolveFixtureResource(product, input) {
  if (product.resource?.input_in === "body") return product.resource.url_template;
  const url = input && typeof input === "object" && typeof input.url === "string"
    ? input.url
    : "https://example.com";
  if (url.length > 2048) throw new Error("bad_input_url");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("bad_input_url");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("bad_input_url");
  return product.resource.url_template.replace("{url}", encodeURIComponent(url));
}

/**
 * Build a quote from catalog bytes. Never probes a live 402.
 * Quantity is 1 (one digital call). Unknown ids 404. Human-rail ids 400.
 */
export function quoteProduct(offerId, opts = {}) {
  const catalog = opts.catalog ?? loadCatalog();
  const inspected = inspectCatalog(catalog);
  if (!inspected.ok) return { status: 400, body: { reason: "bad_catalog" } };
  if (typeof offerId !== "string" || !offerId) {
    return { status: 400, body: { reason: "bad_offer_quote" } };
  }
  const quantity = opts.quantity === undefined ? 1 : opts.quantity;
  if (!Number.isInteger(quantity) || quantity !== 1) {
    return { status: 400, body: { reason: "bad_quantity" } };
  }
  const product = inspected.catalog.products.find((p) => p.id === offerId);
  if (!product) return { status: 404, body: { reason: "offer_not_found", offer_id: offerId } };
  if (product.rail !== "x402" || product.checkout !== "x402") {
    return { status: 400, body: { reason: "rail_not_fixture", offer_id: offerId } };
  }
  let resourceUrl;
  try {
    resourceUrl = resolveFixtureResource(product, opts.input);
  } catch (e) {
    return { status: 400, body: { reason: e.message, offer_id: offerId } };
  }
  return {
    status: 200,
    body: {
      offer_id: product.id,
      rail: "x402",
      merchant: product.merchant,
      product: product.product,
      purpose: product.purpose,
      request: { method: product.resource.method, url: resourceUrl },
      price: { amount_atomic: product.amount_atomic, asset: product.asset, usd: product.price_usdc },
      checkout: "x402",
      accepts: product.accepts.map((a) => ({ ...a })),
      gate: { status: "passed", reason: "fixture_catalog" },
      source: "fixture_catalog",
      probed: false,
      live_shopify: false,
    },
  };
}

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Local HTML. Banner states fixture / no payment. Not mounted on the live host. */
export function renderFixtureHtml(catalog = loadCatalog()) {
  const rows = listProducts(catalog).map((p) =>
    `<li><strong>${esc(p.product)}</strong> — ${esc(p.merchant)} · ${esc(p.rail)} · ${esc(p.asset)} ${esc(p.price_usdc)} · <a href="/api/products/${esc(p.id)}">${esc(p.id)}</a></li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture storefront (local only)</title></head>
<body>
<p><strong>FIXTURE</strong> — local only — not a live store — no payment — live_shopify=false</p>
<h1>Digital-product fixture catalog</h1>
<p>Quotes are built from in-repo catalog bytes. This process does not call a remote storefront, Catalog, or UCP.</p>
<ul>
${rows}
</ul>
<p><a href="/api/products">GET /api/products</a> · <a href="/health">GET /health</a></p>
</body>
</html>
`;
}

function localHostHeader(header) {
  if (typeof header !== "string" || !header) return false;
  const raw = header.trim().toLowerCase();
  if (hasForbiddenHostText(raw)) return false;
  if (raw.startsWith("[::1]")) return raw === "[::1]" || raw.startsWith("[::1]:");
  const host = raw.split(":")[0];
  return host === "127.0.0.1" || host === "localhost";
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-fixture-storefront": KIND,
  });
  res.end(json);
}

function readJsonBody(req, cb) {
  const chunks = [];
  let n = 0;
  req.on("data", (c) => {
    n += c.length;
    if (n > 65536) {
      req.destroy();
      cb(new Error("body_too_large"));
      return;
    }
    chunks.push(c);
  });
  req.on("error", () => cb(new Error("bad_json")));
  req.on("end", () => {
    if (n === 0) {
      cb(null, {});
      return;
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        cb(new Error("bad_json"));
        return;
      }
      cb(null, parsed);
    } catch {
      cb(new Error("bad_json"));
    }
  });
}

/** HTTP handler. Caller supplies a catalog that already passed inspectCatalog. */
export function handleFixtureRequest(req, res, catalog) {
  if (!localHostHeader(req.headers.host)) {
    send(res, 400, { reason: "fixture_host_not_local" });
    return;
  }
  let url;
  try {
    url = new URL(req.url ?? "/", "http://127.0.0.1");
  } catch {
    send(res, 400, { reason: "bad_path" });
    return;
  }
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") {
    send(res, 200, { kind: KIND, live_shopify: false, origin: ORIGIN });
    return;
  }
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(renderFixtureHtml(catalog));
    return;
  }
  if (req.method === "GET" && path === "/api/products") {
    send(res, 200, { kind: KIND, live_shopify: false, origin: ORIGIN, products: listProducts(catalog) });
    return;
  }
  const productMatch = /^\/api\/products\/([^/]+)$/.exec(path);
  if (req.method === "GET" && productMatch) {
    const product = getProduct(decodeURIComponent(productMatch[1]), catalog);
    if (!product) {
      send(res, 404, { reason: "offer_not_found" });
      return;
    }
    send(res, 200, product);
    return;
  }
  if (req.method === "POST" && path === "/api/quotes") {
    readJsonBody(req, (err, body) => {
      if (err) {
        send(res, 400, { reason: err.message });
        return;
      }
      const out = quoteProduct(body.offer_id, { catalog, input: body.input, quantity: body.quantity });
      send(res, out.status, out.body);
    });
    return;
  }
  send(res, 404, { reason: "fixture_route_missing" });
}

export function createFixtureServer(catalog = loadCatalog()) {
  const inspected = inspectCatalog(catalog);
  if (!inspected.ok) throw new Error(inspected.reason);
  return createServer((req, res) => handleFixtureRequest(req, res, inspected.catalog));
}

/** Loopback only. `0.0.0.0` / public binds throw before listen. */
export function listenFixture(opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("fixture_bind_not_loopback");
  }
  const server = createFixtureServer(opts.catalog ?? loadCatalog());
  server.listen(opts.port ?? 0, host);
  return server;
}
