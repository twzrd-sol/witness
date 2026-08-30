import { witnessAccepts } from "./server.js";

const body = (schema, example) => ({ required: true, content: { "application/json": { schema, ...(example ? { example } : {}) } } });
const out = (description, schema = {}) => ({ description, content: { "application/json": { schema } } });
const textOut = (description, type) => ({ description, content: { [type]: { schema: { type: "string" } } } });
const pub = (summary, response) => ({ get: { summary, security: [], responses: { "200": response } } });

const quoteRequest = {
  type: "object",
  required: ["url", "extract"],
  properties: {
    url: { type: "string", format: "uri", description: "Public https URL to observe." },
    extract: { type: "object", minProperties: 1, additionalProperties: { type: "string" }, description: "Field name -> expected type (number|string) the page must contain." },
    retrieval: { type: "string", description: 'Retrieval the host performs (currently "scrape"). Optional; defaults to "scrape".' },
    assertion: { type: "string", description: 'Optional post-condition checked against extracted values, grammar "key < number" (e.g. "rank < 100"). A failed assertion is 422 and nothing is billed.' },
    replicas: { type: "integer", enum: [1] },
  },
};

const EXAMPLE = { url: "https://outbid.sh/top", extract: { rank: "number" }, retrieval: "scrape", assertion: "rank < 100", replicas: 1 };

const receiptSchema = {
  type: "object",
  required: ["value", "assertion", "observed_at", "source_hash", "evidence", "agreement", "method", "spec_hash", "valid_until", "vantage", "receipt"],
  properties: {
    value: { type: "object" },
    assertion: { type: "string" },
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
      description: "Paid, attributable, perishable observation of public web facts. Run POST /quote first (free): a 200 means the experiment can be performed; only then pay POST /witness ($0.01 USDC via x402, Base or Solana) for a signed receipt. Receipts bind their full method, expire in 1h, and are rendered with contradictions and expiry visible at GET /observatory. Agent docs: /llms.txt and /skill.md. Signing key: GET /pubkey. Payment descriptor: GET /.well-known/x402. robots.txt disallows /witness for crawlers.",
      "x-guidance": "Two-step flow: (1) POST /quote with {url, extract} — free deliverability probe; a 200 with can_deliver:true means the observation can be performed now. (2) Only then POST /witness with the same body and an x402 payment of $0.01 USDC (Base or Solana) — the response is a signed, perishable receipt bound to the full method. A 422 means not deliverable and nothing is billed. Docs: /llms.txt and /skill.md; receipt log: /observatory; signing key: /pubkey.",
    },
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
        post: {
          summary: "Paid observation — signed receipt",
          description: "Quote-first: an unpaid deliverable request gets an x402 402 challenge; after payment settles the observation runs and a receipt is signed. A 422 never bills.",
          "x-payment": { protocol: "x402", x402Version: 2, price_usdc: "0.01", accepts: witnessAccepts({ evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS }) },
          "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "0.010000" }, descriptor: "GET /.well-known/x402" },
          security: [{ x402: [] }],
          requestBody: body(quoteRequest, EXAMPLE),
          responses: {
            "200": out("Signed receipt", receiptSchema),
            "402": out("x402 payment required", { type: "object", properties: { x402Version: { type: "integer" }, accepts: { type: "array", items: { type: "object", properties: { scheme: { const: "exact" }, network: { type: "string" }, price: { const: "$0.01" }, payTo: { type: "string" } } } } } }),
            "400": out("Malformed body or extract"),
            "422": out("Not deliverable or assertion failed — nothing billed"),
          },
        },
      },
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
