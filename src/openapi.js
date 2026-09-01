import { witnessAccepts } from "./server.js";

const body = (schema, example) => ({ required: true, content: { "application/json": { schema, ...(example ? { example } : {}) } } });
const out = (description, schema = {}) => ({ description, content: { "application/json": { schema } } });
const textOut = (description, type) => ({ description, content: { [type]: { schema: { type: "string" } } } });
const pub = (summary, response) => ({ get: { summary, security: [], responses: { "200": response } } });

const quoteRequest = {
  type: "object",
  required: ["url", "extract"],
  properties: {
    url: { type: "string", format: "uri", description: "Public https URL to observe.", example: "https://outbid.sh/top" },
    extract: { type: "object", minProperties: 1, additionalProperties: { type: "string" }, description: "Field name -> expected type (number|string) the page must contain.", example: { rank: "number" } },
    retrieval: { type: "string", description: 'Retrieval the host performs (currently "scrape"). Optional; defaults to "scrape".' },
    assertion: { type: "string", description: 'Optional post-condition checked against extracted values, grammar "<key> <op> <literal>": numeric ==, <, <=, >, >= (e.g. "rank < 100"); string == with quoted literals (e.g. \'currency == "USD"\'); "<key> exists". Malformed or type-mismatched assertions fail (422) and nothing is billed.' },
    replicas: { type: "integer", enum: [1] },
  },
};

const EXAMPLE = { url: "https://outbid.sh/top", extract: { rank: "number" }, retrieval: "scrape", assertion: "rank < 100", replicas: 1 };

    const receiptSchema = {
  type: "object",
  required: ["value", "assertion", "observed_at", "source_hash", "evidence", "agreement", "method", "spec_hash", "valid_until", "vantage", "receipt"],
  properties: {
    value: { type: "object" },
    assertion: { type: ["string", "null"], description: "Echoed post-condition; null when the request omitted it." },
    observed_at: { type: "string", format: "date-time" },
    source_hash: { type: "string", description: "sha256 of the retrieved source text." },
    evidence: { type: "string", description: "First 160 chars of the retrieved source." },
    agreement: { type: "string" },
    method: { type: "object", description: "Full canonical method {url, retrieval, extract, assertion} — signed inside the receipt, so a second vantage can re-observe." },
    spec_hash: { type: "string", description: "sha256 of the deep-canonical method; same method => same spec_hash." },
    valid_until: { type: "string", format: "date-time", description: "observed_at + 1h; receipts perish." },
    vantage: { type: "string" },
    receipt: { type: "string", description: "ed25519 signature over deep canonical JSON; verify with GET /pubkey." },
  },
};

export function openapiDoc(env = process.env) {
  const base = env.PUBLIC_BASE_URL || "https://witness.outbid.sh";
  return {
    openapi: "3.1.0",
    info: {
      title: "witness",
      version: "0.1.0",
      description: "Paid, attributable, perishable observation of public web facts. witness is an independent oracle: it observes one stated fact (e.g. a page rank) and returns a signed observation. Quote-first — run POST /quote (free): a 200 means the experiment can be performed; only then pay POST /witness ($0.01 USDC via x402, Base or Solana) for a signed receipt. Receipts bind their full method, expire in 1h, and are rendered with contradictions and expiry visible at GET /observatory. Agent docs: /llms.txt and /skill.md. Signing key: GET /pubkey. Payment descriptor: GET /.well-known/x402. robots.txt disallows /witness for crawlers.",
      "x-guidance": "Two-step flow: (1) POST /quote with {url, extract} — free deliverability probe; a 200 with can_deliver:true means the observation can be performed now. (2) Only then POST /witness with the same body and an x402 payment of $0.01 USDC (Base or Solana) — the response is a signed, perishable receipt bound to the full method. A 422 means not deliverable and nothing is billed. Docs: /llms.txt and /skill.md; receipt log: /observatory; signing key: /pubkey.",
    },
    tags: [
      { name: "observation", description: "A single paid observation of a public web fact at a point in time." },
      { name: "receipt", description: "The signed, verifiable, perishable result of an observation." },
      { name: "oracle", description: "Independent oracle semantics: the same method is re-observable by a second vantage." },
      { name: "fact", description: "The stated fact to observe, bound inside the method and receipt." },
      { name: "rank", description: "Default documented observation: outbid.sh/top rank." },
      { name: "x402", description: "Payment protocol: $0.01 USDC, Base or Solana." },
      { name: "empiricism", description: "Claims are settled by observation, not assertion." },
    ],
    servers: [{ url: base }],
    paths: {
      "/quote": {
        post: {
          summary: "Free deliverability probe",
          description: "200 means the observation can be performed now; 422 means it cannot (ssrf refusal, retrieve failure, empty page, or extract fields missing). Never bills.",
          security: [],
          requestBody: body(quoteRequest, EXAMPLE),
          responses: {
            "200": out("Deliverable now", { type: "object", properties: { price_usdc: { const: "0.01" }, replicas: { type: "integer" }, can_deliver: { const: true } } }),
            "400": out("Malformed body or extract"),
            "422": out("Not deliverable now — nothing billed"),
          },
        },
      },
      "/witness": {
        get: {
          summary: "Crawlable discovery — 402 payment challenge",
          tags: ["observation", "receipt", "x402"],
          description: "Discovery endpoint: always answers 402 with a payment-required challenge header (x402Version 2, canonical resource, both rails). No quote, no retrieve, never bills. The paid deliverable is POST /witness.",
          security: [],
          responses: {
            "402": out("x402 payment required — challenge is base64-JSON in the PAYMENT-REQUIRED header", { type: "object" }),
            "405": out("GET with payment headers is refused — observe via POST /witness"),
          },
        },
        post: {
          summary: "Paid observation — signed receipt",
          tags: ["observation", "receipt", "x402"],
          description: "Quote-first: an unpaid deliverable request gets an x402 402 challenge; after payment settles the observation runs and a receipt is signed. A 422 never bills.",
          "x-payment": { protocol: "x402", x402Version: 2, price_usdc: "0.01", accepts: witnessAccepts({ evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS }) },
          "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "0.010000" }, descriptor: "GET /.well-known/x402" },
          security: [{ x402: [] }],
          requestBody: body(quoteRequest, EXAMPLE),
          responses: {
            "200": out("Signed receipt", receiptSchema),
            "402": {
              description: "x402 payment required. The challenge is base64-JSON in the PAYMENT-REQUIRED response header ({x402Version:2, resource{url,...}, accepts[], extensions}); SDK clients (@x402/fetch et al) read that header — do not parse the body, which may be {}.",
              headers: { "payment-required": { required: true, description: "Base64-encoded x402 v2 payment challenge.", schema: { type: "string" } } },
              content: { "application/json": { schema: {
                type: "object",
                properties: {
                  x402Version: { type: "integer", const: 2 },
                  error: { type: "string" },
                  resource: { type: "object", properties: { url: { const: `${base}/witness` }, description: { type: "string" }, mimeType: { type: "string" }, serviceName: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
                  accepts: { type: "array", items: { type: "object", required: ["scheme", "network", "amount", "asset", "payTo"], properties: {
                    scheme: { const: "exact" },
                    network: { enum: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] },
                    amount: { type: "string", description: 'Atomic units — "10000" = 0.01 USDC (6 decimals). Not "price".' },
                    asset: { type: "string", description: "USDC contract (Base) / mint (Solana) for the network." },
                    payTo: { type: "string" },
                    maxTimeoutSeconds: { type: "integer" },
                    extra: { type: "object", description: "Scheme metadata: name, version; feePayer on Solana." },
                  } } },
                  extensions: { type: "object", description: "Declared extensions (bazaar discovery) when applicable." },
                },
              } } },
            },
            "400": out("Malformed body or extract"),
            "422": out("Not deliverable or assertion failed — nothing billed"),
          },
        },
      },
      "/openapi.json": pub("This contract — machine-readable", out("This OpenAPI 3.1 document, served at this path.", { type: "object" })),
      "/pubkey": pub("Signing key — verify receipts", out("ed25519 public key (base64 SPKI)", {
        type: "object",
        required: ["pubkey"],
        properties: { pubkey: { type: "string", description: "Verify receipt signatures over deep canonical JSON." } },
      })),
      "/observatory": pub("Receipt log — every verified observation", textOut("Rendered star map; contradictions and expiry visible.", "text/html")),
      "/llms.txt": pub("Agent docs — plain text", textOut("Markdown: endpoints, default documented method, price.", "text/markdown")),
      "/skill.md": pub("Agent skill — paid observation", textOut("Markdown: quote-first flow and receipt fields.", "text/markdown")),
      "/.well-known/x402": pub("Payment descriptor for POST /witness", out("x402 v2 descriptor: resource, price, both rails.", {
        type: "object",
        required: ["resource", "x402Version", "price_usdc", "accepts"],
        properties: {
          resource: { const: `${base}/witness`, description: "The protected resource this descriptor pays for." },
          x402Version: { const: 2 },
          price_usdc: { const: "0.01" },
          accepts: {
            type: "array",
            items: {
              type: "object",
              required: ["scheme", "network", "price", "payTo"],
              properties: {
                scheme: { const: "exact" },
                network: { enum: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"] },
                price: { const: "$0.01" },
                payTo: { type: "string" },
              },
            },
          },
        },
      })),
      "/.well-known/agent.json": pub("Agent card", out("Discovery card for crawlers.", {
        type: "object",
        required: ["name", "url", "skills"],
        properties: {
          name: { const: "witness" },
          url: { const: base },
          skills: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "name"],
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
      })),
    },
    components: { securitySchemes: { x402: { type: "http", description: "x402 exact scheme, $0.01 USDC; see GET /.well-known/x402." } } },
  };
}
