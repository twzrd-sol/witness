# Affordable agent inventory

Snapshot date: 2026-09-10. The first consumer catalog should target outputs an agent can buy with a balance of roughly $2–3. Prices below are per request unless stated otherwise. A `live 402` label means the endpoint returned a payment challenge during a read-only probe; it does not prove that a paid response is correct or that delivery is reliable. `advertised` means directory or provider documentation only. The broader 794-row read-only join is retained in [`affordable-x402-resources-2026-09-10.json`](../../exa-results/affordable-x402-resources-2026-09-10.json); this page is the curated seed set.

## Seed catalog

| Offer | Endpoint | Price | Output | Quote status | Network / asset |
|---|---|---:|---|---|---|
| Python / Node sandbox (AutEng) | `https://x402.auteng.ai/api/x402/compute` | $0.002 base | Code execution result | live 402 | Base / USDC |
| Sandbox (Shizu) | `https://x402.shizu.me/sandbox` | $0.018 | Code execution result | live 402 | Base / USDC |
| Code run (Agent402) | `https://agent402.tools/api/code-run` | $0.020 | Code execution result | live 402 | Base and other accepts |
| Embeddings (Shizu) | `https://x402.shizu.me/v1/embeddings` | $0.002 | Vector JSON | live 402 | Base / USDC |
| Embeddings (Spraay) | `https://gateway.spraay.app/api/v1/embeddings` | $0.005 | Vector JSON | live 402 | Base / Solana accepts |
| Small text model (Spraay catalog) | `https://gateway.spraay.app/api/v1/compute/models` | from $0.003 | Text / JSON | advertised + live gateway 402 | Base / USDC |
| Image generation (Spraay) | `https://gateway.spraay.app/api/v1/image/generate` | $0.030 | Image output | live 402 | Base / Solana accepts |
| Image generation (Agent402) | `https://agent402.tools/api/image-gen` | $0.030 | Image output | live 402 | Base and other accepts |
| Speech to text (Spraay) | `https://gateway.spraay.app/api/v1/audio/transcribe` | $0.020 | Transcript JSON | live 402 | Base / Solana accepts |
| PDF utility (Shizu) | `https://x402.shizu.me/pdf` | $0.005 | PDF-derived output | live 402 | Base / USDC |
| PDF info / merge / extract (Agent402) | `https://agent402.tools/tools` | $0.002–$0.014 | Downloadable PDF | advertised | Verify exact route and quote |
| QR generator (x402tools) | `https://x402tools.xyz` | $0.010 | PNG/SVG | advertised | Base / USDC |
| Document parse (x402tools) | `https://x402tools.xyz` | $0.010 | Structured document data | advertised | Base / USDC |
| Web search JSON (Agentstools) | `https://api.agentstools.dev/search` | $0.001 | Ranked results | live 402 | Base / USDC |
| DNS lookup (AgentReader) | `https://agentreader.dev/dns` | $0.001 | DNS JSON | live 402 | Base / USDC |
| URL to Markdown (AgentData) | `https://agentdata-api.sander-van-aard.workers.dev/web/contents` | $0.0015 | Markdown text | live 402 | Base / USDC |
| Product detail/status lookup (Bitrefill) | `https://api.bitrefill.com/x402/products/detail` | $0.001 | Product/status JSON | live 402 | Solana / USDC |
| Calldata decoder (Anchor) | `https://api.anchor-x402.com/v1/decode/calldata` | $0.001 | Decoded JSON | live 402 | Base / USDC |
| Web search / page extraction (402.com.tr) | `https://402.com.tr/api/x402/web-search` | $0.010 | Search JSON | advertised | Verify current 402 quote |
| Code review / API docs (SearchX402) | provider endpoint | $0.040 | Report / OpenAPI text | advertised | Verify route and delivery |
| Signed price/economic data (Mycelia Signal) | `https://api.myceliasignal.com` | from $0.010 | Signed JSON evidence | advertised | Base / USDC |
| Bounded scraper run (Apify) | `https://api.apify.com` | about $1.00 | Scraped dataset | advertised | Base / USDC |
| File/static-site delivery (StableUpload) | `https://stableupload.dev` | $0.005–$2.00 | Download URL / site | advertised | Quote determines tier |

The first three offers to expose are AutEng compute, Shizu embeddings, and Agent402 code run. They are cheap, deterministic enough to demonstrate a useful result, and have live payment challenges. Add one visible artifact (image or PDF) after validating paid delivery.

## Selection and enforcement

Inventory records should include `resource_url`, task description, current quoted amount, network, asset, expiry, output MIME/schema, `last_live_quote`, and evidence status. Do not treat a directory price as authorization. Before signing:

```text
GET /v1/intel/resources (filter price <= 3 and useful output)
→ evaluate_x402_resource(resource_url)
→ enforce mandate and TWZRD decision
→ sign once through the existing x402 client hook
→ record payment, artifact, and order/status result
```

The hosted MCP already exposes `evaluate_x402_resource`; adding another gate tool in Witness would duplicate it. `safeFetch` / `installTwzrdAutoGate` remain the final pre-sign boundary. A blocked or changed quote is an enforcement result, never a checkout conversion.

## Exclusions

Do not seed the first catalog with placeholder generators that an agent can run locally for free, prepaid compute deposits, physical goods, or $6+ Shopify assets. Email, gift cards, uploads, and other side effects need an explicit mandate scope. All third-party delivery and quality claims remain `not_verified` until a paid pilot records the returned artifact.

Sources: [AutEng](https://x402.auteng.ai/), [x402.shizu](https://x402.shizu.me/), [Agent402](https://agent402.tools/tools), [Spraay](https://gateway.spraay.app/.well-known/x402.json), [x402tools](https://x402tools.xyz/skill.md), [TWZRD resource catalog](https://intel.twzrd.xyz/v1/intel/resources), and [x402 List](https://x402-list.com/).
