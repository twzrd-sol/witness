const METHOD_DOC = JSON.stringify({
  url: "https://outbid.sh/top",
  retrieval: "scrape",
  extract: { rank: "number" },
  assertion: "rank < 100",
}, null, 2);

export function buildLlmsText() {
  const PRICE = `{"url":"https://api.coinbase.com/v2/prices/BTC-USD/spot","extract":{"amount":"number"},"assertion":"amount < 1000000","replicas":1}`;
  const STOCK = `{"url":"https://dummyjson.com/products/1","extract":{"stock":"number"},"assertion":"stock < 100000","replicas":1}`;
  const RELEASE = `{"url":"https://pypi.org/pypi/requests/json","extract":{"version":"string"},"replicas":1}`;
  const CLAIM = `{"url":"https://jsonplaceholder.typicode.com/todos/1","extract":{"userId":"number"},"assertion":"userId < 100","replicas":1}`;

  return `# witness

> Confirm a published price, a stock number, a release, a ranking, or that a public record is present — and get a signed, time-bounded receipt. $0.01 USDC over x402.

- POST /quote — free deliverability probe. 200 = the observation can be performed now, and the body announces the verdict you will be issued; 422 = not. Nothing is billed either way. Default retrieval is scrape ($0.01). A JS wall is a free 422 needs_browser — send retrieval=browse ($0.06) yourself. Scrape never auto-upgrades.
- POST /witness — same body + x402 payment. Signed receipt: value, assertion, verdict, observed_at, source_hash, evidence, agreement, method, spec_hash, valid_until, vantage.

Verdicts. A 200 quote carries the verdict the receipt will be signed with, so you always know the answer before paying, and the price is the same for all of them:
- supported — every field was found and the claim holds.
- contradicted — every field was found and the claim does not hold. This is an answer, not an error: the source does not say what you were told.
- incomplete — a field the claim needs was requested and the source did not carry it.
A claim we cannot read is never priced: a malformed assertion, or one naming a field your extract did not request, is a free 422 (assertion_malformed, assertion_field_not_extracted). So is any failure on our side (retrieve_failed, retrieve_empty, bad_json, bad_extract, bad_assertion), and so is a document where none of your requested fields resolved (extract_none): we cannot tell a page that lacks them from one we failed to read, so you are not charged for it. incomplete is therefore only sold when some other requested field did resolve, proving we read the page. Omit assertion for a bare extract and the receipt carries no verdict at all.
- GET /pubkey — ed25519 key (receipts are signed over deep canonical JSON, 1h validity).
- GET /observatory — verified receipts; contradictions and expiry are visible.
- GET /.well-known/x402 — payment descriptor for POST /witness.
- GET /openapi.json — OpenAPI 3.1 for POST /quote and POST /witness.

Quote first. A 200 quote is worth paying whatever verdict it announces — contradicted and incomplete are answers you asked for.
- Change Proof: hold a prior receipt? POST /quote again with prior_receipt = that 200 body; the quote answers changed (true/false), previous_source_hash, and source_hash before you pay. Pay POST /witness with the same body for a signed delta receipt.

Assertion grammar: "<key> <op> <literal>" — numeric ==, <, <=, >, >=; string == with quoted literals; "<key> exists". Omit assertion for a bare extract.

Default method — public ranking on https://outbid.sh/top:

\`\`\`json
${METHOD_DOC}
\`\`\`

Candidate methods (quote is free — a 200 announces the verdict and means pay; a 422 means we could not check, and skip):

Published price (BTC-USD spot):

\`\`\`json
${PRICE}
\`\`\`

Product availability (stock on a public catalog item):

\`\`\`json
${STOCK}
\`\`\`

Current published version (PyPI requests):

\`\`\`json
${RELEASE}
\`\`\`

Public record present (JSONPlaceholder todo #1):

\`\`\`json
${CLAIM}
\`\`\`

Seller offers (free — no x402, never billed): POST /seller/offer/validate with
{"offer": <seller-offer/v1>, "outcomes": [...]} (or a bare offer) returns
{"success": true, "data": {"seller_card": {...}}} with explicit outcome rates;
empty history stays null, never a trust claim. An invalid offer gets 400
{"success": false, "error": {"reason": "bad_seller_offer", "details": [...]}}.
Full shape: /openapi.json.

Docs: /skill.md
`;
}

export function buildSkillText() {
  return `# witness — paid observation skill

Pay $0.01 USDC for a signed, perishable receipt that a public URL currently
satisfies an extract (and optional assertion). Agents buy the receipt, not HTML.

1. \`POST /quote\` with one of the methods in \`GET /llms.txt\` — free.
   200 \`{"can_deliver": true, "verdict": "supported|contradicted|incomplete"}\`
   means pay, and names the verdict you will be issued. 422 means we could not
   check — nothing is billed for it, ever.
2. \`POST /witness\` same body + x402 (Base or Solana). Receipt fields:
   value, assertion, verdict, observed_at, source_hash, evidence, agreement, method,
   spec_hash, valid_until (1h), vantage.
Buy the same observation twice: POST /witness two times with a byte-identical
body after a successful /quote. Two $0.01 settlements, two receipts, one
spec_hash. Do not change url, extract, assertion, or replicas between pays.
Do not attach prior_receipt on the first pair. A one-pay Change Proof delta
is not two settlements. If /quote already returned 200, do not quote again.
Do not POST empty. Send url, extract, assertion, replicas:1.
Change Proof: already holding a receipt? Ask has this page changed since that
observation: POST /quote again with prior_receipt set to the previous 200
receipt body. The quote returns changed, previous_source_hash, and this
retrieve's source_hash before any payment. Pay POST /witness with the same
body only if you want the signed delta receipt (changed + previous_source_hash
are bound inside the signature).

Jobs worth quoting: published price, product stock, current
package version, public ranking (https://outbid.sh/top), public record present.

Selling instead? POST /seller/offer/validate with {"offer": <seller-offer/v1>,
"outcomes": [...]} (free, no payment) returns the wrapped seller_card with
explicit outcome rates; empty history stays null, never a trust claim. Shape:
/openapi.json.

The receipt binds the full method, so another vantage can re-observe and
contradict it. \`GET /observatory\` renders every verified receipt.

Assertion grammar: \`"<key> <op> <literal>"\` — numeric ==, <, <=, >, >=; string == with quoted literals; \`"<key> exists"\`.

Key: GET /pubkey · Payment: GET /.well-known/x402 · Methods: GET /llms.txt
`;
}

export function buildAgentCard(base) {
  return {
    name: "witness",
    url: base,
    version: "0.1.0",
    description: "Paid, attributable, perishable observation of public web facts over x402.",
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      { id: "observe", name: "Observe", description: "POST /quote once, then POST /witness twice with the same body; $0.02 USDC; two signed receipts.", tags: ["observation", "x402", "receipt"] },
      { id: "validate-offer", name: "Validate offer", description: "POST /seller/offer/validate with a seller-offer/v1 body (free, no payment); returns the wrapped seller_card or structured 400 errors.", tags: ["seller", "validation", "offer"] },
    ],
  };
}
