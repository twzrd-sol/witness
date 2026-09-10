# Seller-side agent models

Research date: 2026-09-10. The useful question is not whether an agent has a token. It is whether an agent can advertise a deliverable, receive a small payment, and leave evidence that the work was accepted.

## 1. Bounty hunter: pay to compete, earn on acceptance

The [`webmilmind1/bounty-hunter`](https://github.com/webmilmind1/bounty-hunter) project is a working reference implementation. A worker agent reads `deskcrew.io/api/arena/contests`, buys ticket context, drafts a support answer, and pays an attempt fee over x402. A human approval releases 85% of the bounty to the submitting wallet. The README reports a historical snapshot of 67 decisions, 21% approval, 12 paid attempts, and $5.56 settled; those figures are time-bound board telemetry, not a guaranteed yield.

The economic discipline is unusually clear:

- `--max-price` caps one attempt before signing; `--max-spend` caps the run.
- The board publishes reward, entrants, payout network, approval history, and payment receipts.
- The worker chooses the least-contested eligible bounty and skips work payable on a different chain.
- At a $0.06 attempt fee and 85% worker share, a $0.25 bounty needs roughly 28% approval to break even. Most attempts do not pay.

This is the seller model to study: the agent is a worker, the board is demand, x402 is the input-cost rail, and human approval is the quality gate. The “seller” is not selling a token; it is selling an accepted answer.

## 2. ACP / AgentFi: service jobs with escrow and routing

Virtuals’ official ACP documentation describes a provider catalog of purchasable jobs. A job declares a name, description, requirements, price, SLA, and deliverable. Service-only jobs settle in USDC after evaluation and approval; fund-transfer jobs additionally handle a buyer’s principal and require stronger controls. The ACP concepts page documents an 80/20 provider/protocol split for successfully completed jobs, while other Virtuals pages describe later fee schedules and treasury allocations. Treat the split as protocol-version-specific and read the live job terms before relying on it.

ACP therefore supplies three useful primitives:

1. A machine-readable seller listing with an explicit deliverable.
2. A job lifecycle and escrow-like settlement instead of an immediate blind transfer.
3. A provider payout and performance history that can be ranked.

The tokenized-agent layer is a separate capital-formation mechanism. Official material describes agent tokens, bonding curves, creator fees, and protocol treasury flows; it does not make token ownership equivalent to ownership of revenue or service quality. The often-repeated “18,000 agents / $480M Agentic GDP / $4M revenue” figures are dashboard or promotional claims and should not be used as evidence of durable seller demand without a dated, independently reproducible export.

## What TWZRD should add

TWZRD can become the trust and evidence layer for seller agents without becoming the marketplace or token issuer:

```text
Seller publishes offer (task, price, SLA, deliverable schema, payout wallet)
        ↓
Buyer discovers offer and receives a quote
        ↓
TWZRD checks seller identity, quote, budget, chain, and prior outcomes
        ↓
Buyer signs once; escrow/x402 settles
        ↓
Seller returns artifact + signed receipt
        ↓
TWZRD records accepted, rejected, refunded, and expired outcomes
```

For bounty work, the first product should be a **worker preflight**: verify the board’s current reward, attempt fee, contest size, payout network, approval history, and latest settlement receipt; calculate expected value; refuse when the ceiling or chain does not match. A payout receipt proves settlement, not answer quality.

For ACP-style sellers, the first product should be a **seller card** containing:

```text
seller_id, capability, price, currency, chain, SLA, deliverable_schema,
completed_jobs, approval_rate, median_delivery, refund_rate, evidence_links
```

All performance fields need denominators, time windows, and links to receipts. A new seller should be marked “no history,” not scored as trustworthy by default. Fund-transfer jobs should be excluded from the initial consumer catalog.

## Pilot recommendation

Run one two-sided experiment around a visible digital outcome, such as “resolve a support ticket” or “produce a cited research pack.” Recruit a seller agent, a buyer agent with a $2 wallet, and an independent evaluator. Measure:

- buyer cost and seller payout;
- accepted-output rate and time to acceptance;
- retries, refunds, and policy refusals;
- whether a second buyer repeats the offer.

Do not launch an agent token, buyback loop, or ownership claim for this test. First prove that an agent can earn repeatedly for an accepted deliverable and that TWZRD’s receipts let another buyer distinguish a productive seller from an untested listing.

Sources: [bounty-hunter README](https://github.com/webmilmind1/bounty-hunter), [ACP concepts and architecture](https://whitepaper.virtuals.io/acp-product-resources/acp-concepts-terminologies-and-architecture), [ACP resource schema](https://whitepaper.virtuals.io/acp-product-resources/acp-dev-onboarding-guide/set-up-agent-profile/add-resource/import-and-export-agent-job-resource), [ACP glossary](https://whitepaper.virtuals.io/acp-product-resources/acp-glossary), and [ACP payments](https://whitepaper.virtuals.io/acp-product-resources/acp-dev-onboarding-guide/tips-and-troubleshooting/payments-pricing-and-wallets).
