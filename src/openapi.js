import { witnessAccepts } from "./server.js";

const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const out = (description, schema = {}) => ({ description, content: { "application/json": { schema } } });

const quoteRequest = {
  type: "object",
  required: ["url", "extract"],
  properties: {
    url: { type: "string", format: "uri", description: "Public https URL to observe." },
    extract: { type: "object", minProperties: 1, additionalProperties: { type: "string" }, description: "Field name -> expected type (number|string) the page must contain." },
    replicas: { type: "integer", enum: [1] },
  },
};

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
    },
    servers: [{ url: base }],
    paths: {
      "/quote": {
        post: {
          summary: "Free deliverability probe",
          description: "200 means the observation can be performed now; 422 means it cannot (ssrf refusal, retrieve failure, empty page, or extract fields missing). Never bills.",
          requestBody: body(quoteRequest),
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
          security: [{ x402: [] }],
          requestBody: body(quoteRequest),
          responses: {
            "200": out("Signed receipt", receiptSchema),
            "402": out("x402 payment required", { type: "object", properties: { x402Version: { type: "integer" }, accepts: { type: "array", items: { type: "object", properties: { scheme: { const: "exact" }, network: { type: "string" }, price: { const: "$0.01" }, payTo: { type: "string" } } } } } }),
            "400": out("Malformed body or extract"),
            "422": out("Not deliverable or assertion failed — nothing billed"),
          },
        },
      },
    },
    components: { securitySchemes: { x402: { type: "http", description: "x402 exact scheme, $0.01 USDC; see GET /.well-known/x402." } } },
  };
}
