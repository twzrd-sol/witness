// Build the board's actors file, refusing to write a wallet that cannot clear the board's own
// gate. An actors file that 403s on every transition is worse than no file: it looks enrolled.
//
//   node scripts/make-actors-file.mjs --out /private/bounty-actors.json --max-reward 1 \
//     --actor poster:base:0xabc... --actor claimer:base:0xdef... --actor operator:base:0xabc...
//
// --dry-run reports each wallet's live decision and cap without writing anything.
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { wallet } from '../src/bounty-board.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const out = flag('out'), dryRun = args.includes('--dry-run');
const maxReward = Number(flag('max-reward', '1'));
const preflightUrl = flag('preflight-url', 'https://intel.twzrd.xyz/v1/intel/preflight');
const specs = args.filter((a, i) => args[i - 1] === '--actor');

if (!specs.length || (!out && !dryRun)) {
  console.error('usage: --actor <role>:<network>:<wallet> [...] (--out <path> | --dry-run) [--max-reward 1]');
  process.exit(2);
}
if (!Number.isFinite(maxReward) || maxReward < 0.5 || maxReward > 2) {
  console.error(`--max-reward must be 0.5..2 USDC (the board's own reward range); got ${maxReward}`);
  process.exit(2);
}

const actors = specs.map(spec => {
  const [role, network, address] = spec.split(':');
  if (!['poster', 'claimer', 'operator'].includes(role)) throw new Error(`bad role in "${spec}"`);
  return { id: `${role}-${network}-${address.slice(0, 8).toLowerCase()}`, role, network, wallet: wallet(network, address) };
});

/** The board's gate, applied here so enrollment is checked before the file exists, not after. */
async function check(actor) {
  const response = await fetch(preflightUrl, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', 'X-Twzrd-Caller': 'witness-bounty-enrollment' },
    body: JSON.stringify({ resource_name: 'bounty:enrollment', seller_wallet: actor.wallet, price_usdc: maxReward, chain: actor.network, agent_intent: 'bounty board enrollment check' }),
  });
  if (!response.ok) return { ok: false, why: `preflight HTTP ${response.status}` };
  const body = await response.json();
  const c = body?.readiness_card ?? body;
  const cap = c?.maximum_recommended_spend_usdc ?? c?.recommended_cap_usdc ?? null;
  const detail = { decision: c?.decision ?? null, can_spend: c?.can_spend ?? null, cap, trust_score: c?.trust_score ?? null };
  if (!['allow', 'warn'].includes(detail.decision)) return { ...detail, ok: false, why: `decision=${detail.decision}` };
  if (detail.can_spend !== true) return { ...detail, ok: false, why: `can_spend=false at ${maxReward} USDC` };
  if (cap !== null && !(Number.isFinite(cap) && maxReward <= cap)) return { ...detail, ok: false, why: `cap ${cap} < reward ${maxReward}` };
  return { ...detail, ok: true, why: null };
}

const results = [];
for (const actor of actors) results.push({ actor, check: await check(actor) });
for (const { actor, check: c } of results) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${actor.role.padEnd(8)} ${actor.network.padEnd(6)} ${actor.wallet.slice(0, 14)}…  decision=${c.decision} can_spend=${c.can_spend} cap=${c.cap} score=${c.trust_score}${c.ok ? '' : `  -> ${c.why}`}`);
}

const failed = results.filter(r => !r.check.ok);
if (failed.length) {
  console.error(`\nRefusing to write: ${failed.length} of ${results.length} wallets cannot clear the board's gate at ${maxReward} USDC.`);
  console.error('A wallet earns a usable cap through observed x402 settlement history. Nothing here can shortcut that.');
  process.exit(1);
}
if (dryRun) { console.log('\nAll wallets clear the gate. Re-run with --out <path> to write the file.'); process.exit(0); }

const file = actors.map(a => ({ ...a, token: randomBytes(32).toString('hex') }));
writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(`\nWrote ${out} (mode 0600, ${file.length} actors). Tokens are bearer credentials: never commit, never log.`);
