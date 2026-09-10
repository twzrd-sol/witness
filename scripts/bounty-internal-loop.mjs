import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fixture, offerFor } from './lib/bounty-fixture.mjs';
import { sourceHash, verifyReceipt } from '../src/receipt.js';

const output = path.resolve(process.argv[2] ?? 'artifacts/bounty-internal-loop');
const tasks = [
  { description: 'Document the seller HTTP error taxonomy, including malformed JSON versus wrong-shape offers.', reward_minor: 500000, source: 'src/routes/seller.js; src/server.js; test/seller-route.test.js' },
  { description: 'Verify an Ed25519 Witness receipt offline and demonstrate that nested-field tampering fails verification.', reward_minor: 1000000, source: 'src/receipt.js; test/server.test.js' },
  { description: 'Write a quote-then-witness client guide covering refused quotes, 402 challenges, failed retrieval and receipt verification.', reward_minor: 2000000, source: 'README.md; src/server.js; docs/operator-trial.md' },
];
const artifact = `# Seller HTTP error contract\n\nPOST /seller/offer/validate accepts a bare seller-offer/v1 offer or {offer,outcomes?}. Success returns {success:true,data:{seller_card},request_metadata}.\n\n- Unparseable JSON returns HTTP 400 with bad_json.\n- Parseable JSON with an invalid offer shape returns HTTP 400 with bad_seller_offer.\n- A supplied outcomes value that is not an array returns HTTP 400 with bad_outcomes (checked before offer validation).\n- Missing/empty history keeps approval_rate, refund_rate and median_delivery_minutes null. It is not evidence of trustworthiness.\n\nThe route is pure over caller-supplied input. A board must supply its own persisted outcome rows over HTTP and authenticate who may record outcomes. A seller card alone does not prove delivery or payment.\n\nSource: src/routes/seller.js, src/seller.js and the host JSON error handler in src/server.js.\n`;
// BOUNTY_SELLER_URL points the card lookups at a real out-of-process witness instance.
const f = await fixture({ externalSellerUrl: process.env.BOUNTY_SELLER_URL ?? null });
try {
  mkdirSync(output, { recursive: true });
  const posted = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]; const r = await f.api('/bounties', { poster: offerFor(f.actors[0], task.reward_minor), task: { description: task.description } }, f.actors[0], `seed-${i}`);
    assert.equal(r.status, 201); posted.push(r.body.data.bounty);
  }
  const id = posted[0].id;
  const claim = await f.api(`/bounties/${id}/claim`, { claimer: offerFor(f.actors[1]) }, f.actors[1], 'internal-claim');
  assert.equal(claim.status, 200);
  writeFileSync(path.join(output, 'seller-error-contract.md'), artifact);
  const complete = await f.api(`/bounties/${id}/complete`, { outcome: { decision: 'accepted' }, artifact: { sha256: sourceHash(artifact), description: 'seller-error-contract.md' } }, f.actors[0], 'internal-complete');
  assert.equal(complete.status, 200);
  const receipt = complete.body.data.bounty.completion_receipt;
  assert.ok(verifyReceipt(receipt, createPublicKey(f.publicKey)));
  assert.equal(receipt.artifact.sha256, sourceHash(artifact));
  const retry = await f.api(`/bounties/${id}/complete`, { outcome: { decision: 'accepted' }, artifact: { sha256: sourceHash(artifact), description: 'seller-error-contract.md' } }, f.actors[0], 'internal-complete');
  assert.deepEqual(retry, complete);
  await f.restart();
  const reread = await f.api(`/bounties/${id}`); assert.deepEqual(reread.body.data.bounty, complete.body.data.bounty);
  const next = await f.api(`/bounties/${posted[1].id}/claim`, { claimer: offerFor(f.actors[1]) }, f.actors[1], 'followup-card');
  assert.equal(next.body.data.bounty.claim.claimer_card.outcomes.accepted_jobs, 1);
  const dump = (name, value) => writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  dump('seeds.json', { mode: 'internal_fixture', funded: false, tasks, posted });
  dump('completion-receipt.json', receipt);
  writeFileSync(path.join(output, 'public-key.pem'), f.publicKey);
  dump('http-evidence.json', { mode: 'internal_fixture', external_agent_evidence: false, transfers: 0, seller_url: f.sellerUrl, seller_out_of_process: f.externalSeller, preflight: 'local allow fixture; not live TWZRD approval', requests: f.calls, claim: claim.body, complete: complete.body, next_claim: next.body, signature_verified: true, artifact_hash_verified: true, restart_verified: true, idempotent_retry_verified: true });
  writeFileSync(path.join(output, 'README.md'), '# Internal bounty loop evidence\n\nLocal HTTP seller route and explicitly simulated preflight. Three unfunded TWZRD backlog seeds; one accepted Markdown artifact, a signed completion receipt, and a subsequent claim showing one accepted delivery. No transfer, external agent, or live TWZRD approval. Verify with `node scripts/verify-bounty-receipt.mjs artifacts/bounty-internal-loop` from the worktree. Pin the included key independently before treating it as a trusted issuer.\n');
  console.log(JSON.stringify({ output, mode: 'internal_fixture', seller_out_of_process: f.externalSeller, seeded: 3, completed: 1, accepted_jobs_on_next_card: 1, receipt_verified: true, settlement: 'not_paid' }));
} finally { await f.close(); }
