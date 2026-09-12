import { SPEC_ORIGINS } from "./delivery.js";
import { EXTRACT_SCHEMA } from "./extract.js";
import { ASSERTION_SCHEMA, railAccepts, witnessAccepts } from "./server.js";
import { DELIVERY_VERDICTS, EXAMPLE_BODY as DELIVERY_EXAMPLE, MAX_BODY as DELIVERY_MAX_BODY, MODES, SPEC_TYPES } from "./routes/delivery.js";
import { PAYOUT_QUOTE_ROUTE, PAYOUT_ROUTE } from "./routes/payout-claim.js";
import { SELLER_OFFER_SCHEMA_VERSION } from "./seller.js";

const sellerOfferSchema = {
  type: "object",
  required: ["schema_version", "seller_id", "capability", "price_minor", "currency", "network", "payout_wallet", "sla_minutes", "deliverable"],
  properties: {
    schema_version: { const: SELLER_OFFER_SCHEMA_VERSION },
    seller_id: { type: "string" },
    capability: { type: "string" },
    price_minor: { type: "integer", minimum: 1 },
    currency: { const: "USDC" },
    network: { enum: ["base", "solana"] },
    payout_wallet: { type: "string" },
    sla_minutes: { type: "integer", minimum: 1 },
    deliverable: {
      type: "object",
      required: ["description", "mime_type"],
      properties: {
        description: { type: "string" },
        mime_type: { type: "string" },
      },
    },
    evidence_url: { type: "string", format: "uri" },
    outcomes: { type: "array", items: { type: "object" } },
  },
};

const sellerCardSchema = {
  type: "object",
  required: ["schema_version", "seller_id", "payout_wallet", "capability", "price_usdc", "currency", "network", "sla_minutes", "deliverable", "outcomes", "evidence_url", "evidence_status"],
  properties: {
    schema_version: { const: "seller-card/v1" },
    seller_id: { type: "string" },
    payout_wallet: { type: "string" },
    capability: { type: "string" },
    price_usdc: { type: "string" },
    currency: { const: "USDC" },
    network: { enum: ["base", "solana"] },
    sla_minutes: { type: "integer" },
    deliverable: sellerOfferSchema.properties.deliverable,
    outcomes: {
      type: "object",
      required: ["completed_jobs", "accepted_jobs", "approval_rate", "refunded_jobs", "refund_rate", "median_delivery_minutes"],
      properties: {
        completed_jobs: { type: "integer" },
        accepted_jobs: { type: "integer" },
        approval_rate: { type: ["number", "null"] },
        refunded_jobs: { type: "integer" },
        refund_rate: { type: ["number", "null"] },
        median_delivery_minutes: { type: ["number", "null"] },
      },
    },
    evidence_url: { type: ["string", "null"], format: "uri" },
    evidence_status: { type: "string" },
  },
};

const sellerValidationRequest = {
  type: "object",
  properties: {
    offer: sellerOfferSchema,
    outcomes: { type: "array", items: { type: "object" } },
  },
  additionalProperties: true,
};

const sellerValidationResponse = {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { const: true },
    data: {
      type: "object",
      required: ["seller_card"],
      properties: { seller_card: sellerCardSchema },
    },
    request_metadata: {
      type: "object",
      properties: {
        received_at: { type: "string", format: "date-time" },
        seller_id: { type: ["string", "null"] },
        has_wrapped_offer: { type: "boolean" },
        outcome_count: { type: "integer" },
      },
    },
  },
};

const sellerValidationError = {
  type: "object",
  required: ["success", "error", "data"],
  properties: {
    success: { const: false },
    data: { const: null },
    error: {
      type: "object",
      required: ["reason", "details"],
      properties: {
        reason: { enum: ["bad_json", "bad_seller_offer", "bad_outcomes"] },
        details: { type: "array", items: { type: "object" } },
      },
    },
    request_metadata: { type: "object" },
  },
};

const bountyRecordSchema = {
  type: "object",
  required: ["id", "status", "task", "poster_card", "claim", "outcome", "created_at", "updated_at"],
  properties: {
    id: { type: "string" },
    status: { enum: ["open", "claimed", "complete"] },
    task: { type: "object", required: ["description"], properties: { description: { type: "string" } } },
    poster_card: sellerCardSchema,
    claim: { type: ["object", "null"], description: "Null until claimed; then {claimer_card, claimed_at}." },
    outcome: { type: ["object", "null"], description: "Null until completed; then {decision: accepted|rejected, delivery_minutes, completed_at}." },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
};

const postBountyRequest = {
  type: "object",
  required: ["poster", "task"],
  properties: {
    poster: sellerOfferSchema,
    task: { type: "object", required: ["description"], properties: { description: { type: "string" } } },
  },
};

const claimBountyRequest = {
  type: "object",
  required: ["claimer"],
  properties: { claimer: sellerOfferSchema },
};

const completeBountyRequest = {
  type: "object",
  required: ["outcome"],
  properties: {
    outcome: {
      type: "object",
      required: ["decision"],
      properties: {
        decision: { enum: ["accepted", "rejected"] },
        delivery_minutes: { type: "number", minimum: 0 },
      },
    },
  },
};

const body = (schema, example) => ({ required: true, content: { "application/json": { schema, ...(example ? { example } : {}) } } });
const out = (description, schema = {}) => ({ description, content: { "application/json": { schema } } });
const textOut = (description, type) => ({ description, content: { [type]: { schema: { type: "string" } } } });
const pub = (summary, response) => ({ get: { summary, security: [], responses: { "200": response } } });

const bountyOk = out("Bounty record", {
  type: "object",
  required: ["success", "data"],
  properties: {
    success: { const: true },
    data: { type: "object", required: ["bounty"], properties: { bounty: bountyRecordSchema } },
  },
});

const bountyErr = (reasons) => out("Bounty request failed — nothing moves, nothing bills, ever.", {
  type: "object",
  required: ["success", "error", "data"],
  properties: {
    success: { const: false },
    data: { const: null },
    error: {
      type: "object",
      required: ["reason", "details"],
      properties: {
        reason: { enum: reasons },
        details: { type: "array", items: { type: "object" } },
      },
    },
  },
});

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


/** POST /delivery/attest — the three things a delivery receipt binds, as the buyer submits them. */
const deliveryRequest = {
  type: "object",
  required: ["offer", "request", "observation"],
  properties: {
    offer: {
      type: "object",
      required: ["resource_url", "deliverable_class", "price_usdc", "spec"],
      description: "What was promised. Hashed into offer_hash, which is what makes a verdict about it meaningful.",
      properties: {
        resource_url: { type: "string", format: "uri", example: DELIVERY_EXAMPLE.offer.resource_url },
        deliverable_class: { type: "string", description: "e.g. data_json, compute_result, issued_credential, verification_result, financial_action.", example: "data_json" },
        price_usdc: { type: "number", minimum: 0, example: 0.28 },
        spec: { type: "object", description: "The delivery contract: required_fields (field -> type) the artifact must carry, and must_equal (field -> literal) it must match.", properties: { required_fields: { type: "object", additionalProperties: { type: "string", enum: [...SPEC_TYPES] } }, must_equal: { type: "object" } } },
        spec_origin: { type: "string", enum: [...SPEC_ORIGINS], default: "buyer_authored", description: "Who wrote the spec this verdict is graded against. Optional; absent means buyer_authored, because silence about provenance is not a claim of seller backing. An unknown value is refused rather than quietly downgraded, so a typo cannot read as a deliberate admission. seller_published is what a seller-signed offer earns: offer_hash covers the spec, so a signature refuses if the buyer rewrote it." },
      },
    },
    request: {
      type: "object",
      required: ["request_body", "requested_at"],
      description: "The specific paid call. Hashed into request_hash. settlement_ref is the on-chain payment when known; null is recorded as null, not as proof.",
      properties: {
        request_body: { type: "object" },
        settlement_ref: { type: ["string", "null"], description: "Settlement tx signature / hash, or null when unknown." },
        requested_at: { type: "string", format: "date-time" },
      },
    },
    observation: {
      type: "object",
      required: ["artifact", "observed_at", "mode"],
      description: "What the verifier is shown or saw. The evidence mode is required and its limits ride along in every receipt.",
      properties: {
        artifact: { description: "The artifact as received. The key is required; null means nothing came back and grades unable_to_verify — it is not refused." },
        observed_at: { type: "string", format: "date-time" },
        mode: { type: "string", enum: [...MODES], description: "buyer_attested: the buyer presents what it received (a complaint, not proof of fault). seller_integrated: the seller signed the artifact at emit time (proves emission, not receipt; downgraded to buyer_attested when no signature is carried). verifier_observed: the verifier paid and called itself (proves delivery to the verifier, for no other buyer)." },
        http_status: { type: ["integer", "null"] },
        seller_signature: {
          type: ["object", "null"],
          required: ["network", "payTo", "signature"],
          description: "The seller's emit-time signature when it provided one, as the x-delivery-signature header carries it. Not a bare string: verifying it means binding it to the payee the buyer actually paid, so the network and payTo travel with it - a signature with nothing to bind it to proves nothing. Over the bytes 'witness.delivery-attestation.v0' + \\n + canonical({artifact_hash, offer_hash, request_hash}); see examples/delivery-seller.mjs. Declaring seller_integrated does not grant it: this is verified here and the RESULT is signed into seller_verification, so a signature that does not check out comes back as evidence_mode buyer_attested rather than failing the request.",
          properties: {
            network: { type: "string", description: "x402 network of the accepts[] entry that was paid. CAIP-2 (eip155:8453, solana:<genesis>) or the v1 names base, base-sepolia, solana, solana-devnet. The namespace picks the rail; the chain id changes nothing about how a signature verifies.", example: "solana" },
            payTo: { type: "string", description: "payTo of that entry: the identity the buyer paid. On solana this IS the base58 ed25519 public key the signature is checked against; on evm it is the 20-byte address the signer is recovered and compared to (a mixed-case value is treated as a checksum claim and must be correct).", example: "9wRQHGS8qUwagaX3fYVqqdco3QkzqfajFz3ob6xN7LNi" },
            signature: { type: "string", description: "base58-encoded 64-byte ed25519 signature on solana; 0x-hex 65-byte r||s||v EIP-191 personal-message signature on evm. High-s (malleated) evm signatures are refused rather than accepted as a second valid form of one signature.", example: "3ykr7RdF6Ksm8RzNW4c6vCM8m1kaZBN3BVeuXdnVHhyYkedY2ceRrfdcYYwr2mYXhBuvifVUbMS5Lg1T1q5bsnAw" },
          },
        },
        notes: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const deliveryReceiptSchema = {
  type: "object",
  required: ["schema", "offer_hash", "request_hash", "artifact_hash", "delivery_verdict", "reasons", "evidence_mode", "declared_mode", "spec_origin", "observed_at", "requested_at", "verifier", "this_receipt_proves", "this_receipt_does_not_prove", "attested_at", "signer", "receipt"],
  properties: {
    schema: { type: "string", example: "delivery-attestation/v0" },
    offer_hash: { type: "string", description: "sha256 of the deep-canonical offer." },
    request_hash: { type: "string", description: "sha256 of the deep-canonical paid request." },
    artifact_hash: { type: ["string", "null"], description: "sha256 of the deep-canonical artifact; null when nothing came back." },
    delivery_verdict: { type: "string", enum: [...DELIVERY_VERDICTS], description: 'Four, deliberately: "delivered" (artifact satisfies the offer spec), "contradicted" (a field is present and wrong, or a must_equal fails), "incomplete" (a required field is absent), "unable_to_verify" (nothing came back, timestamps unparseable, or the artifact was observed outside the freshness window). "did not deliver" and "cannot tell" never collapse into each other, and unable_to_verify is a 200 like the rest.' },
    reasons: { type: "array", items: { type: "string" }, description: "Why the verdict is what it is; empty only for a clean delivered." },
    evidence_mode: { type: "string", enum: [...MODES], description: "The mode the receipt actually earns. A seller_integrated claim with no seller_signature is signed as buyer_attested." },
    declared_mode: { type: "string", enum: [...MODES], description: "The mode the caller declared; differs from evidence_mode only on a downgrade." },
    observed_at: { type: "string", format: "date-time" },
    requested_at: { type: "string", format: "date-time" },
    settlement_ref: { type: ["string", "null"] },
    http_status: { type: ["integer", "null"] },
    verifier: { type: "string", description: "Who signed: this host." },
    resource_url: { type: "string" },
    deliverable_class: { type: "string" },
    price_usdc: { type: "number" },
    spec_origin: { type: "string", enum: [...SPEC_ORIGINS], description: "Who authored the spec the artifact was graded against. buyer_authored is the default and the weakest: the accuser wrote the half of the comparison that decides the verdict. Under seller_integrated the seller signs offer_hash, so the spec is bound." },
    seller_verification: { type: ["object", "null"], description: "What was CHECKED, not that a signature was present. null means no verification was performed. { verified, reason, rail, checked[], signer }." },
    seller_signature_covers: { type: "array", items: { type: "string" }, description: "The fields the SELLER signature covers. The receipt binds more than this; everything outside is covered by the Witness key alone." },
    max_staleness_seconds: { type: "integer", description: "Signed, so a verdict cannot be re-read under a different window than the one that produced it." },
    observation_gap_seconds: { type: ["number", "null"], description: "Seconds between requested_at and observed_at. Negative means observed before the request. null when timestamps were unparseable." },
    within_freshness_window: { type: ["boolean", "null"], description: "Whether the observation is attributable to this call. Staleness caps every verdict, not only delivered." },
    this_receipt_proves: { type: "array", items: { type: "string" }, description: "The limits of the evidence mode, verbatim from the model and inside the signature. Read them before acting on the verdict." },
    this_receipt_does_not_prove: { type: "array", items: { type: "string" }, description: "What no delivery receipt establishes: funds recoverable, seller honest in general, buyer received it, order fulfilled end to end, dispute outcome. Inside the signature." },
    attested_at: { type: "string", format: "date-time", description: "When this host signed; observed_at is the caller's clock in buyer_attested mode, this one is ours." },
    signer: { type: "string", description: "SPKI DER base64 of the ed25519 key that signed, identical to GET /pubkey. Part of the signed body: verifyDelivery refuses a receipt whose signer is not the key you trust." },
    receipt: { type: "string", description: "ed25519 signature over deep canonical JSON of every other field; verify with GET /pubkey." },
  },
};

// The route returns the signed receipt BARE, as /witness returns its own. An
// earlier draft wrapped it in {success, data, request_metadata}; this document
// kept describing that wrapper after the route dropped it, and neither test
// noticed because the OpenAPI test asserted the envelope while the HTTP tests
// asserted the bare body. A documented contract that disagrees with the served
// one is worse than an undocumented route: it is a lie a client will code against.
// test/delivery-contract.test.js now binds these two together.
const deliveryOk = (data) => data;
const deliveryFailure = (reasons) => ({
  type: "object",
  required: ["reason", "details", "verifier", "served_at"],
  properties: {
    reason: { type: "string", enum: reasons },
    details: { type: "object", required: ["problems"], properties: { problems: { type: "array", items: { type: "string" } }, expected: { description: "The accepted shape (shape errors only)." }, example: { description: "A value to copy (shape errors only)." } } },
    verifier: { type: "string", description: "The host that refused; its /pubkey signs receipts it does issue." },
    served_at: { type: "string", format: "date-time" },
  },
});

/** The x402 challenge every paid route answers unpaid; `resourceUrl` is the canonical resource the challenge names. */
const paymentRequired = (resourceUrl) => ({
  description: "x402 payment required. The challenge is base64-JSON in the PAYMENT-REQUIRED response header ({x402Version:2, resource{url,...}, accepts[], extensions}); SDK clients (@x402/fetch et al) read that header — do not parse the body, which may be {}.",
  headers: { "payment-required": { required: true, description: "Base64-encoded x402 v2 payment challenge.", schema: { type: "string" } } },
  content: { "application/json": { schema: {
    type: "object",
    properties: {
      x402Version: { type: "integer", const: 2 },
      error: { type: "string" },
      resource: { type: "object", properties: { url: { const: resourceUrl }, description: { type: "string" }, mimeType: { type: "string" }, serviceName: { type: "string" }, tags: { type: "array", items: { type: "string" } } } },
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
});

const payoutRequest = {
  type: "object",
  required: ["claim_url", "claim", "wallet", "network", "direction"],
  properties: {
    claim_url: { type: "string", format: "uri", description: "Public https page or JSON document that publishes the figure being claimed.", example: "https://deskcrew.io/api/arena/contests" },
    claim: {
      type: "object", minProperties: 1, additionalProperties: false,
      description: "Claim field -> the page's own key for that figure. Every figure is read as a number. Inbound: payout_count is settlements received, unique_wallets is distinct counterparties, paid_usd is USDC received. Outbound: the same three read the wallet as an x402 payer.",
      properties: { payout_count: { type: "string" }, unique_wallets: { type: "string" }, paid_usd: { type: "string" } },
      example: { payout_count: "decidedCount", unique_wallets: "uniqueWallets", paid_usd: "sentUsd" },
    },
    wallet: { type: "string", description: "The wallet the claim is about: Solana base58 or Base 0x address, matching `network`.", example: "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8" },
    network: { type: "string", enum: ["solana", "base"], example: "base" },
    direction: { type: "string", enum: ["inbound", "outbound"], description: "inbound: the wallet receives x402 settlements (a seller). outbound: the wallet pays them. The corpus indexes x402 settlements only, so an outbound figure above what was observed is coverage_limited, never discrepant: plain USDC transfers are invisible to it.", example: "inbound" },
  },
};
const PAYOUT_EXAMPLE = { claim_url: "https://deskcrew.io/api/arena/contests", claim: { payout_count: "decidedCount", unique_wallets: "uniqueWallets", paid_usd: "sentUsd" }, wallet: "0xB075aA8206D6De88EDEeD0eE4015a1a33D3659D8", network: "base", direction: "inbound" };
const finding = { type: "object", required: ["field", "claimed", "observed", "relation", "note"], properties: { field: { enum: ["payout_count", "unique_wallets", "paid_usd"] }, claimed: { type: "number" }, observed: { type: ["number", "null"] }, relation: { enum: ["supported", "discrepant", "coverage_limited"] }, note: { type: ["string", "null"] } } };
const payoutQuoteOut = { type: "object", required: ["price_usdc", "can_deliver", "verdict", "findings", "coverage"], properties: { price_usdc: { const: "0.05" }, can_deliver: { const: true }, verdict: { enum: ["supported", "discrepant", "coverage_limited", "incomplete"] }, verdict_reason: { type: ["string", "null"] }, findings: { type: "array", items: finding }, missing: { type: "array", items: { type: "string" } }, coverage: { type: "object" } } };
const payoutReceiptSchema = {
  type: "object",
  required: ["schema", "claim", "wallet", "network", "direction", "evidence", "findings", "coverage", "verdict", "verdict_reason", "observed_at", "valid_until", "method", "spec_hash", "vantage", "receipt"],
  properties: {
    schema: { const: "witness.payout_claim.v1" },
    claim: { type: "object", description: "url, source_hash of the retrieved claim page, keys (the claim -> page key map), values read, missing fields, and a 160-char evidence snippet." },
    wallet: { type: "string" },
    network: { enum: ["solana", "base"] },
    direction: { enum: ["inbound", "outbound"] },
    evidence: { type: "object", description: "intel_sources (URL, sha256 of the raw response, fetched_at) and the observed figures reduced from them." },
    findings: { type: "array", items: finding },
    coverage: { type: "object", description: "corpus, chain, window (all_time on Solana, 90d on Base) and the scope note: an observed subset of x402 settlements, not a universe claim." },
    verdict: { enum: ["supported", "discrepant", "coverage_limited", "incomplete"], description: "coverage_limited is an answer about the corpus, never a contradiction. Billable verdicts only; extract_none and every own defect are 422 and free." },
    verdict_reason: { type: ["string", "null"] },
    observed_at: { type: "string", format: "date-time" },
    valid_until: { type: "string", format: "date-time", description: "observed_at + 1h; receipts perish." },
    method: { type: "object", description: "Full canonical method {claim_url, retrieval, claim, wallet, network, direction, intel} — signed inside the receipt." },
    spec_hash: { type: "string" },
    vantage: { type: "string" },
    receipt: { type: "string", description: "ed25519 signature over deep canonical JSON; verify with GET /pubkey." },
  },
};

export function openapiDoc(env = process.env) {
  const base = env.PUBLIC_BASE_URL || "https://witness.outbid.sh";
  const payoutAccepts = railAccepts("$0.05", { evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS });
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
            "200": out("Deliverable now", { type: "object", properties: { price_usdc: { const: "0.01" }, replicas: { type: "integer" }, can_deliver: { const: true }, verdict: { type: "string", enum: ["supported", "contradicted", "incomplete"], description: "Present when the request stated an assertion: the verdict the paid receipt will be signed with." }, verdict_reason: { type: ["string", "null"], description: "Present with verdict. null when the claim holds." }, missing: { type: "array", items: { type: "string" }, description: "Present when verdict is incomplete: extract keys the source did not carry." }, changed: { type: "boolean", description: "Change Proof — present only when prior_receipt was attached: retrieved bytes differ from the prior source_hash." }, previous_source_hash: { type: "string", description: "Change Proof — the prior receipt source_hash; present only with prior_receipt." }, source_hash: { type: "string", description: "Change Proof — sha256 of this retrieve; present only with prior_receipt." } } }),
            "400": badRequest,
            "422": out("Could not be checked — nothing billed, ever. ssrf refusal, retrieve failure, empty page, a malformed assertion, an assertion naming a field the extract did not request, a document where none of the requested fields resolved, or (with no assertion stated) missing extract fields. A claim that simply does not hold is a 200 with verdict contradicted, not a 422."),
            "429": out("Quote probe rate limit exceeded — nothing billed. Per client (QUOTE_RATE_LIMIT_PER_MINUTE, default 30) and across all clients (QUOTE_RATE_LIMIT_GLOBAL_PER_MINUTE, default 60), because every probe can cost the operator a paid reader call."),
          },
        },
      },
      "/seller/offer/validate": {
        post: {
          summary: "Validate a seller offer and return a seller card",
          description: "Public seller-side contract: validate the offer payload, then return a seller_card wrapper with evidence-backed metadata. 400 returns structured validation errors for bad seller offers or malformed outcomes. No payment, no checkout, no trust claim from missing history.",
          security: [],
          requestBody: body(sellerValidationRequest),
          responses: {
            "200": out("Validated seller card", sellerValidationResponse),
            "400": out("Validation failed", sellerValidationError),
          },
        },
      },
      "/offers/{id}": {
        get: {
          summary: "Consumer offer page",
          description: "HTML for one offer: outcome, deliverable, rail, price, license, buy link (merchant rail) and the agent task link. Unknown id is 404.",
          security: [],
          responses: {
            "200": textOut("Offer HTML page.", "text/html"),
            "404": textOut("Unknown offer id.", "text/plain"),
          },
        },
      },
      "/api/offers": {
        get: {
          summary: "Consumer offer catalog",
          description: "Every offer as structured data, {offers: [...]}, in catalog order — the record set a shopping agent's search_products reads. Same per-offer shape as GET /api/offers/{id}.",
          security: [],
          responses: { "200": out("Offer catalog", { type: "object" }) },
        },
      },
      "/api/offers/{id}": {
        get: {
          summary: "Consumer offer as structured data",
          description: "The catalog record for one offer. rail:merchant_checkout records carry checkout:merchant_hosted, price_minor/currency/price_kind, cart_url and the Witness method they are verified_by; rail:x402 records carry checkout:x402, price {amount_atomic, asset, usd}, the resource template and the accepts[] the catalog vouches for. Unknown id is 404 {reason: offer_not_found}.",
          security: [],
          responses: {
            "200": out("Offer", { type: "object" }),
            "404": out("Unknown offer", { type: "object" }),
          },
        },
      },
      "/api/offers/{id}/task.json": {
        get: {
          summary: "Copyable agent task for one offer",
          description: "Intent, requirements, merchant/resource, and price for an agent to execute the purchase; authorization:null. Unknown id is 404.",
          security: [],
          responses: {
            "200": out("Agent task", { type: "object" }),
            "404": out("Unknown offer", { type: "object" }),
          },
        },
      },
      "/api/quotes": {
        post: {
          summary: "Build a cart and get the gated checkout",
          description: "prepare_checkout for one offer. merchant_checkout: Witness observes the merchant's live product record through the free quote path; only a supported verdict returns cart + checkout_url (200). contradicted, incomplete, or unverifiable withholds the URL (409, gate.reason). x402: {input:{url}} resolves the resource, the live 402 is probed, and only accepts[] whose network/payee/amount match the catalog are returned (200); a changed payee withholds (409). Gate results are cached per offer for 5 minutes; a cache miss is subject to the POST /quote per-IP limiter (429). Never pays, reserves, signs, or writes an observation. Unknown id is 404; missing id, bad quantity, or bad input.url is 400.",
          security: [],
          requestBody: body({ type: "object", required: ["offer_id"], properties: { offer_id: { type: "string", example: "pixel-surplus-vintage-polaroid" }, quantity: { type: "integer", minimum: 1, maximum: 99, default: 1, description: "merchant_checkout offers only" }, input: { type: "object", description: "x402 offers only", properties: { url: { type: "string", format: "uri" } } } } }, { offer_id: "pixel-surplus-vintage-polaroid", quantity: 1 }),
          responses: {
            "200": out("Gate passed: cart and checkout_url, or request and live accepts[]", { type: "object" }),
            "400": out("Missing offer_id, bad quantity, or bad input.url", { type: "object" }),
            "404": out("Unknown offer", { type: "object" }),
            "409": out("Gate withheld: live source contradicts the catalog or could not be verified", { type: "object" }),
            "429": out("Gate rate limited (shares the POST /quote per-IP limiter)", { type: "object" }),
            "503": out("Gate not wired (no retrieve/probe configured)", { type: "object" }),
          },
        },
      },
      "/bounties": {
        post: {
          summary: "Post a bounty with a validated poster offer",
          description: "Coordination pilot (operator override 2026-09-10): records the poster card and task. No money movement, no token, no checkout — settlement is out of band. 400 carries structured validation details.",
          security: [],
          requestBody: body(postBountyRequest),
          responses: {
            "200": bountyOk,
            "400": bountyErr(["bad_poster_offer", "bad_task"]),
          },
        },
      },
      "/bounties/{id}": {
        get: {
          summary: "Read a bounty record",
          description: "Public read of one bounty: status, poster card, claim, and explicit outcome rows. No payment, never billed.",
          security: [],
          responses: {
            "200": bountyOk,
            "404": bountyErr(["bounty_not_found"]),
          },
        },
      },
      "/bounties/{id}/claim": {
        post: {
          summary: "Claim an open bounty with a validated claimer offer",
          description: "One active claim per bounty: claiming a non-open bounty is 409 and changes nothing. Self-claim is refused. 400 carries structured validation details for the claimer offer.",
          security: [],
          requestBody: body(claimBountyRequest),
          responses: {
            "200": bountyOk,
            "400": bountyErr(["bad_claimer_offer"]),
            "404": bountyErr(["bounty_not_found"]),
            "409": bountyErr(["bounty_not_open", "self_claim_refused"]),
          },
        },
      },
      "/bounties/{id}/complete": {
        post: {
          summary: "Complete a claimed bounty with an explicit outcome row",
          description: "Records {decision: accepted|rejected, delivery_minutes} — the explicit rows future seller cards are built from. Only a claimed bounty can complete. No money movement.",
          security: [],
          requestBody: body(completeBountyRequest),
          responses: {
            "200": bountyOk,
            "400": bountyErr(["bad_outcome"]),
            "404": bountyErr(["bounty_not_found"]),
            "409": bountyErr(["bounty_not_claimed"]),
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
            "402": paymentRequired(`${base}/witness`),
            "400": badRequest,
            "422": out("Could not be checked — nothing billed. A claim that simply does not hold is a 200 with verdict contradicted, not a 422."),
          },
        },
      },
      "/delivery/attest": {
        post: {
          summary: "Delivery attestation — signed receipt for one paid call",
          tags: ["receipt", "x402"],
          description: `Settlement proves money moved; it proves nothing about what came back. This route grades one specific paid call — {offer, request, observation} — and signs a delivery receipt bound to offer_hash, request_hash, artifact_hash, the evidence mode, this verifier, and time. A page check is not a delivery receipt; the binding is the product. Paid over x402 at the /witness price ($0.01 USDC, Base or Solana) when the host has a paywall, and the reference deployment does: a well-formed unpaid request gets the 402 challenge in the PAYMENT-REQUIRED header, and a request this route cannot read is refused 400 before it sees a 402 or spends a rate-limit slot. Requests are per-IP rate limited after the shape check (429 attest_rate_limited; ATTEST_RATE_LIMIT_PER_MINUTE, default 30 a minute per client); with the paywall in front only requests that carry a payment count, so the unpaid challenge fetch is as free as a 400. If the payment layer itself cannot be reached the answer is 502 paywall_unavailable in the same envelope. No buyer identity is checked or recorded, and the fee is not written into the receipt: the receipt binds the call it grades. Every receipt carries its own limits (this_receipt_proves / this_receipt_does_not_prove) inside the signature; nothing here strips or summarises them. A request that cannot be graded — nothing came back, artifact observed outside the freshness window, unparseable timestamps — is a 200 with delivery_verdict unable_to_verify, not an error: inability to verify is a result. Only requests this route cannot read are refused, as 400 in the same envelope with a distinct reason. Verify the receipt offline: drop the receipt field, deep-canonical JSON (sorted keys, no whitespace), ed25519 against GET /pubkey. Body limit ${DELIVERY_MAX_BODY}. Reference integrations: examples/delivery-seller.mjs (sign at emit time) and examples/delivery-buyer.mjs (obtain and verify against an in-process host).`,
          "x-payment": { protocol: "x402", x402Version: 2, price_usdc: "0.01", accepts: witnessAccepts({ evmAddress: env.EVM_ADDRESS, svmAddress: env.SVM_ADDRESS }) },
          "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "0.010000" }, descriptor: "PAYMENT-REQUIRED header on an unpaid POST /delivery/attest" },
          security: [{ x402: [] }],
          requestBody: body(deliveryRequest, DELIVERY_EXAMPLE),
          responses: {
            "200": out("The signed delivery receipt, bare, exactly as /witness returns its own. Any verdict, including unable_to_verify, is a 200: inability to verify is a result, not a failure.", deliveryOk(deliveryReceiptSchema)),
            "400": out('Request could not be read — nothing graded, signed, or billed; a 400 never sees a 402. reason: "bad_json" (unparseable, bare primitive, or not application/json); "bad_body" (JSON but not an object); "bad_offer", "bad_paid_request", "bad_observation" (that member is missing or off-shape; details.problems names each field, expected and example show the shape); "bad_mode" (observation.mode outside the three evidence modes). observation.artifact must be present — null means nothing came back and is graded, not refused.', deliveryFailure(["bad_json", "bad_body", "bad_offer", "bad_paid_request", "bad_observation", "bad_mode"])),
            "402": paymentRequired(`${base}/delivery/attest`),
            "413": out(`Body over ${DELIVERY_MAX_BODY} — reason body_too_large.`, deliveryFailure(["body_too_large"])),
            "429": out("Per-IP attestation budget exceeded — reason attest_rate_limited (ATTEST_RATE_LIMIT_PER_MINUTE, default 30 a minute per client). Nothing graded, signed, or billed. The limiter runs after the shape check, so a 400 never consumes a slot, and with the paywall in front only requests that carry a payment count, so the unpaid challenge fetch is free too. Separate from the POST /quote limiter.", deliveryFailure(["attest_rate_limited"])),
            "500": out('Our defect, never a verdict and never billed: "attest_failed" (the model threw), "attest_invalid" (the model returned a receipt without a verdict or its limits, which this route refuses to sign rather than patch), "internal_error".', deliveryFailure(["attest_failed", "attest_invalid", "internal_error"])),
            "502": out("The payment layer could not be reached or answered badly (facilitator) — reason paywall_unavailable, details.problems carries its message. Nothing graded, signed, or billed.", deliveryFailure(["paywall_unavailable"])),
            "503": out("No evidence model in this process — reason attest_not_wired.", deliveryFailure(["attest_not_wired"])),
          },
        },
      },
      [PAYOUT_QUOTE_ROUTE]: {
        post: {
          summary: "Free deliverability probe for a payout-claim verification",
          tags: ["observation", "receipt", "x402"],
          description: "Does a public payout or revenue figure match what TWZRD's settlement corpus observed for the named wallet? 200 announces the verdict (supported, discrepant, coverage_limited, incomplete) and the price; 400 is a malformed request; 422 means not deliverable (ssrf refusal, reader failure, intel unavailable, or no mapped key on the page). Never bills.",
          security: [],
          requestBody: body(payoutRequest, PAYOUT_EXAMPLE),
          responses: {
            "200": out("Deliverable now — verdict announced", payoutQuoteOut),
            "400": out("Malformed request: bad_claim_url, bad_claim, bad_wallet, bad_network, bad_direction"),
            "422": out("Not deliverable now — nothing billed"),
            "429": out("Quote rate limited per IP — retry after a minute"),
          },
        },
      },
      [PAYOUT_ROUTE]: {
        get: {
          summary: "Crawlable discovery — 402 payment challenge",
          tags: ["observation", "receipt", "x402"],
          description: "Discovery endpoint: always answers 402 with a payment-required challenge header. No quote, no retrieve, never bills. The paid deliverable is POST /verify/payout.",
          security: [],
          responses: {
            "402": out("x402 payment required — challenge is base64-JSON in the PAYMENT-REQUIRED header", { type: "object" }),
            "405": out("GET with payment headers is refused — verify via POST /verify/payout"),
          },
        },
        post: {
          summary: "Paid payout-claim verification — signed receipt",
          tags: ["observation", "receipt", "x402"],
          description: "Quote-first: an unpaid deliverable request gets an x402 402 challenge; after payment settles the claim page is read once, held against the intel corpus, and a receipt is signed. The receipt names its evidence (claim page hash, intel response hashes) and its coverage. A 422 never bills.",
          "x-payment": { protocol: "x402", x402Version: 2, price_usdc: "0.05", accepts: payoutAccepts },
          "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "0.050000" }, descriptor: "GET /.well-known/x402" },
          security: [{ x402: [] }],
          requestBody: body(payoutRequest, PAYOUT_EXAMPLE),
          responses: {
            "200": out("Signed receipt", payoutReceiptSchema),
            "402": paymentRequired(`${base}${PAYOUT_ROUTE}`),
            "400": out("Malformed request"),
            "422": out("Not deliverable — nothing billed"),
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
