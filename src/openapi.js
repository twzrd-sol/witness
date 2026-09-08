import { EXTRACT_SCHEMA } from "./extract.js";
import { ASSERTION_SCHEMA, witnessAccepts } from "./server.js";

const body = (schema, example) => ({ required: true, content: { "application/json": { schema, ...(example ? { example } : {}) } } });
const out = (description, schema = {}) => ({ description, content: { "application/json": { schema } } });
const textOut = (description, type) => ({ description, content: { [type]: { schema: { type: "string" } } } });
const pub = (summary, response) => ({ get: { summary, security: [], responses: { "200": response } } });

const quoteRequest = {
  type: "object",
  required: ["url", "extract"],
  properties: {
    url: { type: "string", format: "uri", description: "Public https URL to observe.", example: "https://outbid.sh/top" },
    extract: { ...EXTRACT_SCHEMA, description: 'Field name -> expected type the page must contain. Per key either the canonical "number" | "string", or the JSON-Schema spelling {"type": "number"|"string"|"integer"} (integer is read as number). Both spellings name the same method and share one spec_hash. Key-count and key-length bounds are in this schema; any other shape is 400 bad_extract.', example: { rank: "number" } },
    retrieval: { type: "string", enum: ["scrape"], description: 'Retrieval the host performs — "scrape" is the only mode. Optional; the canonical method always records "scrape".', example: "scrape" },
    assertion: { ...ASSERTION_SCHEMA, description: 'Optional post-condition checked against extracted values, grammar "<key> <op> <literal>": numeric ==, <, <=, >, >= (e.g. "rank < 100"); string == with quoted literals (e.g. \'currency == "USD"\'); "<key> exists". A claim that does not hold is not an error — it is answered as verdict "contradicted" and priced like any other. Free 422s, never billed: a malformed assertion (assertion_malformed) and one naming a field the extract did not request (assertion_field_not_extracted), because neither can be checked. null (or omitted) means no assertion — the receipt then carries no verdict, and the method echoes null so it round-trips as the next request body; any other non-string, or a string over maxLength, is 400 bad_assertion.', example: "rank < 100" },
    replicas: { type: "integer", enum: [1] },
    prior_receipt: { type: "object", description: "Optional Change Proof prior: a previous Witness 200 receipt body. Fail-closed checks (signature, source_hash, method, spec_hash) run before any retrieve; 422 prior_invalid/prior_method_mismatch never bills." },
  },
};

const EXAMPLE = { url: "https://outbid.sh/top", extract: { rank: "number" }, retrieval: "scrape", assertion: "rank < 100", replicas: 1 };

/** Every 400 is a request-shape error: nothing is retrieved or billed, and the body teaches the fix. One contract for /quote and /witness. */
const badRequest = out('Malformed request — never billed. reason: "bad_json" (unparseable body); "bad_extract" (extract is not the shape above: wrong dialect, empty, over the key-count or key-length bound, or a typename outside number|string); "bad_assertion" (assertion is neither null nor a string within maxLength). bad_extract and bad_assertion also carry expected (the accepted shape) and example (a value to copy).', {
  type: "object",
  required: ["reason"],
  properties: {
    reason: { type: "string", enum: ["bad_json", "bad_extract", "bad_assertion"] },
    expected: { description: "The accepted shape: a template object for extract, the grammar for assertion.", example: { "<key>": "number|string" } },
    example: { description: "A minimal valid request or value to copy.", example: { url: "https://outbid.sh/top", extract: { rank: "number" } } },
  },
});

    const receiptSchema = {
  type: "object",
  required: ["value", "assertion", "observed_at", "source_hash", "evidence", "agreement", "method", "spec_hash", "valid_until", "vantage", "receipt"],
  properties: {
    value: { type: "object" },
    assertion: { type: ["string", "null"], description: "Echoed post-condition; null when the request omitted it." },
    verdict: { type: ["string", "null"], enum: ["supported", "contradicted", "incomplete", null], description: 'What the observation found. "supported": every field was found and the claim holds. "contradicted": every field was found and the claim does not hold — the source does not say what you were told. "incomplete": a field the claim needs was requested and the source did not carry it, while some other requested field did resolve, proving the page was read. If nothing resolved, the observation is not sold at all. null: the request stated no assertion, so no claim was checked; a receipt with no assertion never reads as supported. Inside the signature, and the same $0.01 whichever it is.' },
    verdict_reason: { type: ["string", "null"], description: "Fixed-vocabulary detail behind a non-supported verdict (e.g. assertion_false, extract_missing); null when supported or when no claim was made." },
    observed_at: { type: "string", format: "date-time" },
    source_hash: { type: "string", description: "sha256 of the retrieved source text." },
    evidence: { type: "string", description: "Short cited snippet(s) around the extracted value(s), up to 160 characters." },
    agreement: { type: "string" },
    method: { type: "object", description: "Full canonical method {url, retrieval, extract, assertion} — signed inside the receipt, so a second vantage can re-observe." },
    spec_hash: { type: "string", description: "sha256 of the deep-canonical method; same method => same spec_hash." },
    valid_until: { type: "string", format: "date-time", description: "observed_at + 1h; receipts perish." },
    vantage: { type: "string" },
    changed: { type: "boolean", description: "Change Proof — true when source bytes differ from the attached prior receipt; present only when prior_receipt was attached." },
    previous_source_hash: { type: "string", description: "Change Proof — the prior receipt source_hash; present only when prior_receipt was attached." },
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
      description: "Paid, attributable, perishable observation of public web facts. witness is an independent oracle: it observes one stated fact (e.g. a page rank) and returns a signed observation. Quote-first — run POST /quote with {url, extract, assertion, replicas:1} (free). Do not POST empty. A 200 means the experiment can be performed; only then pay POST /witness twice with the same body ($0.02 USDC via x402, Base or Solana) for two signed receipts. Do not attach prior_receipt on the first pair. Receipts bind their full method, expire in 1h, and are rendered with contradictions and expiry visible at GET /observatory. Agent docs: /llms.txt and /skill.md. Change Proof: attach a prior_receipt (a previous 200 receipt body) to ask has this page changed since that observation — the quote answers changed/previous_source_hash/source_hash before any payment; the paid receipt binds them inside the signature. Signing key: GET /pubkey. Payment descriptor: GET /.well-known/x402. robots.txt disallows /witness for crawlers.",
      "x-guidance": "Two-step flow: (1) POST /quote with {url, extract} — free deliverability probe; a 200 with can_deliver:true means the observation can be performed now. (2) Then POST /witness twice with the same body ($0.02 USDC; two receipts, one spec_hash). A 422 means not deliverable and nothing is billed. Docs: /llms.txt and /skill.md; receipt log: /observatory; signing key: /pubkey.",
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
          description: "200 means the observation can be performed now, and the body announces the verdict (supported | contradicted | incomplete) the paid receipt will be signed with, so the answer is known before paying — all three cost the same. 422 means it cannot be checked at all and is never billed: ssrf refusal, retrieve failure, empty page, a malformed assertion, an assertion naming a field the extract did not request, a document where none of the requested fields resolved (extract_none, indistinguishable from a page we failed to read, so never charged), or (with no assertion stated) missing extract fields. Never bills either way. Probes are rate-limited per client.",
          security: [],
          requestBody: body(quoteRequest, EXAMPLE),
          responses: {
            "200": out("Deliverable now", { type: "object", properties: { price_usdc: { const: "0.01" }, replicas: { type: "integer" }, can_deliver: { const: true }, changed: { type: "boolean", description: "Change Proof — present only when prior_receipt was attached: retrieved bytes differ from the prior source_hash." }, previous_source_hash: { type: "string", description: "Change Proof — the prior receipt source_hash; present only with prior_receipt." }, source_hash: { type: "string", description: "Change Proof — sha256 of this retrieve; present only with prior_receipt." } } }),
            "400": badRequest,
            "422": out("Could not be checked — nothing billed, ever. ssrf refusal, retrieve failure, empty page, a malformed assertion, an assertion naming a field the extract did not request, a document where none of the requested fields resolved, or (with no assertion stated) missing extract fields. A claim that simply does not hold is a 200 with verdict contradicted, not a 422."),
            "429": out("Quote probe rate limit exceeded — nothing billed"),
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
            "400": badRequest,
            "422": out("Could not be checked — nothing billed. A claim that simply does not hold is a 200 with verdict contradicted, not a 422."),
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
