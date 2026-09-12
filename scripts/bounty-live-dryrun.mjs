// Live-mode dry run: real out-of-process seller HTTP + real TWZRD preflight, no fixture.
// Proves the dependency wiring and the gate's refusal path. Never pays, never invents an allow.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBountyApp } from '../src/bounty-board.js';
import { listen } from './lib/bounty-fixture.mjs';

const output = path.resolve(process.argv[2] ?? 'artifacts/bounty-live-dryrun');
const sellerUrl = process.env.BOUNTY_SELLER_URL ?? 'http://127.0.0.1:4042/seller/offer/validate';
const preflightUrl = process.env.BOUNTY_PREFLIGHT_URL ?? 'https://intel.twzrd.xyz/v1/intel/preflight';
const actorsFile = process.env.BOUNTY_ACTORS_FILE;

// Operator-supplied actors when enrolled; otherwise documented placeholders that MUST NOT pass the gate.
const placeholder = !actorsFile;
const actors = actorsFile
  ? JSON.parse(readFileSync(actorsFile, 'utf8'))
  : ['poster', 'claimer', 'operator'].map((role, i) => ({ id: `placeholder-${role}`, role, token: randomBytes(32).toString('hex'), network: 'base', wallet: `0x${String(i + 1).padStart(40, '0')}` }));

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Twzrd-Caller': 'witness-bounty-dryrun' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
const offerFor = (actor, price) => ({ schema_version: 'seller-offer/v1', seller_id: actor.id, payout_wallet: actor.wallet, network: actor.network, currency: 'USDC', price_minor: price, sla_minutes: 60, capability: 'TWZRD backlog work', deliverable: { description: 'Reviewed Markdown artifact', mime_type: 'text/markdown' } });

const reward = 500000;
const poster = actors.find(a => a.role === 'poster');
const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-bounty-dryrun-'));
const app = createBountyApp({
  dbPath: path.join(dir, 'board.sqlite'), keyPath: path.join(dir, 'key.pem'), actors,
  sellerUrl, preflightUrl, fixtureMode: false, allowLoopbackSeller: true,
});
const board = await listen(app);
const evidence = { mode: 'live_coordinator', placeholder_wallets: placeholder, funded: false, transfers: 0, seller_url: sellerUrl, preflight_url: preflightUrl, checked_at: new Date().toISOString() };
try {
  // 1. Raw dependency probes — recorded separately so the board's verdict can be read against them.
  const sellerRaw = await post(sellerUrl, { offer: offerFor(poster, reward), outcomes: [] });
  const sellerBody = await sellerRaw.json().catch(() => null);
  evidence.seller_probe = { status: sellerRaw.status, seller_card: sellerBody?.data?.seller_card ?? null, success: sellerBody?.success ?? null };

  const gateRaw = await post(preflightUrl, { resource_name: 'bounty:dryrun', seller_wallet: poster.wallet, price_usdc: reward / 1e6, chain: poster.network, agent_intent: 'bounty board payout gate dry run' });
  const gateBody = await gateRaw.json().catch(() => null);
  const card = gateBody?.readiness_card ?? gateBody;
  evidence.preflight_probe = { status: gateRaw.status, decision: card?.decision ?? null, can_spend: card?.can_spend ?? null, reason_codes: card?.reason_codes ?? null, recommended_action: card?.recommended_action ?? null, maximum_recommended_spend_usdc: card?.maximum_recommended_spend_usdc ?? null, expires_at: card?.expires_at ?? null, echo: { seller_wallet: card?.seller_wallet ?? null, chain: card?.chain ?? null, price_usdc: card?.price_usdc ?? null } };
  evidence.binding_check = {
    seller_wallet_echoed: card?.seller_wallet === undefined ? 'absent' : card.seller_wallet === poster.wallet,
    chain_echoed: card?.chain === undefined ? 'absent' : card.chain === poster.network,
    price_usdc_echoed: card?.price_usdc === undefined ? 'absent' : card.price_usdc === reward / 1e6,
    expires_at_future: card?.expires_at === undefined ? 'absent' : Date.parse(card.expires_at) > Date.now(),
  };

  // 2. The board's own decision through its real HTTP surface.
  const response = await fetch(`${board.url}/bounties`, { method: 'POST', headers: { authorization: `Bearer ${poster.token}`, 'content-type': 'application/json', 'idempotency-key': 'live-dryrun-1' }, body: JSON.stringify({ poster: offerFor(poster, reward), task: { description: 'Document the seller HTTP error taxonomy, including malformed JSON versus wrong-shape offers.' } }) });
  const body = await response.json();
  evidence.board_post = { status: response.status, reason: body?.error?.reason ?? null, listed: body?.success === true };
  evidence.policy = 'decision in {allow,warn} AND can_spend=true AND reward <= maximum_recommended_spend_usdc';
  evidence.verdict = body?.success === true
    ? `listed: live preflight returned ${evidence.preflight_probe.decision}+can_spend within cap ${evidence.preflight_probe.maximum_recommended_spend_usdc}`
    : `refused: ${body?.error?.reason} (policy: ${evidence.policy})`;
} finally {
  await board.close(); app.locals.close(); rmSync(dir, { recursive: true, force: true });
}
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'live-dryrun.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output, seller: evidence.seller_probe.status, preflight_decision: evidence.preflight_probe.decision, can_spend: evidence.preflight_probe.can_spend, board_status: evidence.board_post.status, board_reason: evidence.board_post.reason, placeholder_wallets: placeholder }));
