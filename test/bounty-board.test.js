import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { createBountyApp, wallet } from '../src/bounty-board.js';
import { verifyReceipt, sourceHash } from '../src/receipt.js';
import express from 'express';
import { createSellerRouter } from '../src/routes/seller.js';
import { fixture, offerFor, listen } from '../scripts/lib/bounty-fixture.mjs';
const post = f => ({ poster: offerFor(f.actors[0]), task: { description: 'Document seller error taxonomy' } });
const completion = { outcome: { decision: 'accepted' }, artifact: { sha256: sourceHash('actual artifact'), description: 'Contract documentation' } };
async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }
async function claimed(f) { const p = await f.api('/bounties', post(f)); assert.equal(p.status, 201); const id = p.body.data.bounty.id; assert.equal((await f.api(`/bounties/${id}/claim`, { claimer: offerFor(f.actors[1]) }, f.actors[1])).status, 200); return id; }

test('post and claim consume actual seller HTTP with server-owned histories; completion signs and grows later card', async t => {
  const f = await setup(t), id = await claimed(f);
  assert.equal(f.calls.filter(c => c.kind === 'card').length, 2);
  assert.deepEqual(f.calls[0].body.outcomes, []);
  const r = await f.api(`/bounties/${id}/complete`, completion);
  assert.equal(r.status, 200);
  const b = r.body.data.bounty;
  assert.equal(b.completion_receipt.settlement.status, 'not_paid');
  assert.equal(b.payment_history.payment_rate, null);
  assert.equal(b.completion_receipt.mode, 'internal_fixture');
  assert.ok(verifyReceipt(b.completion_receipt, createPublicKey(f.publicKey)));
  assert.equal(f.calls.at(-1).body.seller_wallet, f.actors[1].wallet);
  const next = await f.api('/bounties', post(f));
  const claim = await f.api(`/bounties/${next.body.data.bounty.id}/claim`, { claimer: offerFor(f.actors[1]), outcomes: [{ status: 'accepted' }, { status: 'accepted' }] }, f.actors[1]);
  assert.equal(claim.body.data.bounty.claim.claimer_card.outcomes.accepted_jobs, 1);
  assert.equal(f.calls.at(-1).body.outcomes.length, 1);
});
for (const decision of ['block', 'unknown']) test(`${decision} preflight cannot list or complete`, async t => {
  const f = await setup(t), id = await claimed(f); f.state.decision = decision;
  assert.equal((await f.api('/bounties', post(f))).status, 403);
  assert.equal((await f.api(`/bounties/${id}/complete`, completion)).status, 403);
  assert.equal((await f.api(`/bounties/${id}`)).body.data.bounty.status, 'claimed');
});
test('warn proceeds only when the gate says can_spend, and only under the cap it returns', async t => {
  const f = await setup(t);
  f.state.decision = 'warn';
  // warn + can_spend is the enrolled case: intel's own semantics are "proceed up to the cap".
  const listed = await f.api('/bounties', post(f));
  assert.equal(listed.status, 201);
  assert.equal(listed.body.data.bounty.preflight.decision, 'warn');
  // A cautious card that refuses the amount outright still refuses.
  f.state.canSpend = false;
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_denied');
  // can_spend alone does not authorize: a stated cap below the reward refuses.
  f.state.canSpend = true; f.state.cap = 0.25;
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_cap_exceeded');
  // A cap that covers the reward proceeds, and is recorded rather than inferred.
  f.state.cap = 0.5;
  const under = await f.api('/bounties', post(f));
  assert.equal(under.status, 201);
  assert.equal(under.body.data.bounty.preflight.cap, 0.5);
  // A non-numeric cap is not a licence to spend.
  f.state.cap = 'unlimited';
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_cap_exceeded');
});
test('dependency outage and malformed or mismatched preflight fail closed', async t => {
  const f = await setup(t); f.state.sellerStatus = 404;
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'seller_unavailable');
  f.state.sellerStatus = 200; f.state.gateStatus = 503;
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_unavailable');
  f.state.gateStatus = 200; f.state.canSpend = false;
  assert.equal((await f.api('/bounties', post(f))).status, 403);
  f.state.canSpend = true; f.state.gateExtras = { seller_wallet: f.actors[1].wallet };
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_binding_mismatch');
  f.state.gateExtras = { expires_at: '2020-01-01T00:00:00Z' };
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_expired');
});
test('untrusted actor and offer identity changes cannot authorize transitions', async t => {
  const f = await setup(t);
  assert.equal((await f.api('/bounties', post(f), { token: 'invalid' })).status, 401);
  const spoof = post(f); spoof.poster.payout_wallet = f.actors[1].wallet;
  assert.equal((await f.api('/bounties', spoof)).status, 403);
  const id = await claimed(f);
  assert.equal((await f.api(`/bounties/${id}/complete`, completion, f.actors[1])).status, 403);
  assert.equal((await f.api(`/bounties/${id}/complete`, completion, f.actors[3])).status, 200);
});
test('amount and wallet validation rejects invalid listings before HTTP dependencies', async t => {
  const f = await setup(t);
  for (const amount of [499999, 2000001, 1.5, -1]) { const b = post(f); b.poster.price_minor = amount; assert.equal((await f.api('/bounties', b)).status, 400); }
  const b = post(f); b.poster.payout_wallet = 'not-wallet'; assert.equal((await f.api('/bounties', b)).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(wallet('solana', '11111111111111111111111111111111'), '11111111111111111111111111111111');
  assert.throws(() => wallet('solana', '11111111111111111111111111111111111111111111'));
});
test('concurrent claims across separate SQLite connections permit one winner', async t => {
  const f = await setup(t), second = createBountyApp(f.config), server = await listen(second);
  t.after(async () => { await server.close(); second.locals.close(); });
  const p = await f.api('/bounties', post(f)), id = p.body.data.bounty.id;
  const other = async () => { const r = await fetch(`${server.url}/bounties/${id}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.actors[2].token}`, 'idempotency-key': 'other-claim' }, body: JSON.stringify({ claimer: offerFor(f.actors[2]) }) }); return r.status; };
  const statuses = await Promise.all([f.api(`/bounties/${id}/claim`, { claimer: offerFor(f.actors[1]) }, f.actors[1]).then(r => r.status), other()]);
  assert.deepEqual(statuses.sort(), [200, 409]);
});
test('concurrent completion retries return one durable signature; altered retries conflict', async t => {
  const f = await setup(t), id = await claimed(f); f.state.delayMs = 10;
  const [a, b] = await Promise.all([f.api(`/bounties/${id}/complete`, completion, f.actors[0], 'same'), f.api(`/bounties/${id}/complete`, completion, f.actors[0], 'same')]);
  assert.equal(a.status, 200); assert.deepEqual(a, b);
  const calls = f.calls.length;
  await f.restart();
  assert.deepEqual(await f.api(`/bounties/${id}/complete`, completion, f.actors[0], 'same'), a);
  assert.equal(f.calls.length, calls);
  assert.equal((await f.api(`/bounties/${id}/complete`, { ...completion, outcome: { decision: 'rejected' } }, f.actors[0], 'same')).status, 409);
  assert.equal((await f.api(`/bounties/${id}/complete`, completion)).status, 409);
});
test('signed receipt binds artifact, amount and nested settlement; tampering fails', async t => {
  const f = await setup(t), id = await claimed(f);
  const receipt = (await f.api(`/bounties/${id}/complete`, completion)).body.data.bounty.completion_receipt;
  for (const change of [r => r.artifact.sha256 = '0'.repeat(64), r => r.reward_minor++, r => r.settlement.status = 'paid']) {
    const altered = structuredClone(receipt); change(altered); assert.equal(verifyReceipt(altered, createPublicKey(f.publicKey)), false);
  }
});
test('post retries preserve original and caller history cannot produce accepted reputation', async t => {
  const f = await setup(t), body = { ...post(f), outcomes: [{ status: 'accepted' }] };
  const first = await f.api('/bounties', body, f.actors[0], 'post');
  assert.equal(first.body.data.bounty.poster_card.outcomes.approval_rate, null);
  await f.restart(); assert.deepEqual(await f.api('/bounties', body, f.actors[0], 'post'), first);
  assert.equal((await f.api('/bounties', { ...body, task: { description: 'other' } }, f.actors[0], 'post')).status, 409);
});
test('wrong shape and malformed JSON have distinct errors', async t => {
  const f = await setup(t);
  assert.equal((await f.api('/bounties', 4)).body.error.reason, 'bad_body');
  const r = await fetch(`${f.url}/bounties`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.reason, 'bad_json');
});
test('configuration refuses insecure dependencies and fixture/live database reuse', async t => {
  const f = await setup(t);
  assert.throws(() => createBountyApp({ ...f.config, fixtureMode: false }), /HTTPS/);
  assert.throws(() => createBountyApp({ ...f.config, fixtureMode: false, sellerUrl: 'https://example.com/card', preflightUrl: 'https://example.com/gate' }), /mode mismatch/);
  assert.throws(() => createBountyApp({ ...f.config, actors: [...f.actors, f.actors[0]] }), /Duplicate/);
});

test('claims racing a second Node process produce exactly one winner', async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const f = await setup(t), p = await f.api('/bounties', post(f)), id = p.body.data.bounty.id;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createBountyApp } from './src/bounty-board.js';
    let text=''; for await (const c of process.stdin) text+=c;
    const app=createBountyApp(JSON.parse(text));
    const server=app.listen(0,'127.0.0.1',()=>console.log(server.address().port));
    process.on('SIGTERM',()=>server.close(()=>{app.locals.close();process.exit(0)}));
  `], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  child.stdin.end(JSON.stringify(f.config));
  const [chunk] = await once(child.stdout, 'data');
  const port = Number(chunk.toString().trim()); assert.ok(port > 0);
  const childClaim = fetch(`http://127.0.0.1:${port}/bounties/${id}/claim`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${f.actors[2].token}`, 'idempotency-key': 'process-claim' }, body: JSON.stringify({ claimer: offerFor(f.actors[2]) }) }).then(r => r.status);
  const localClaim = f.api(`/bounties/${id}/claim`, { claimer: offerFor(f.actors[1]) }, f.actors[1]).then(r => r.status);
  assert.deepEqual((await Promise.all([childClaim, localClaim])).sort(), [200, 409]);
});
test('malformed successful seller response and missing idempotency key are rejected', async t => {
  const f = await setup(t); f.state.cardMutate = b => ({ ...b, data: { seller_card: { ...b.data.seller_card, payout_wallet: f.actors[1].wallet } } });
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'bad_seller_response');
  assert.equal((await f.api('/bounties', post(f), f.actors[0], '')).body.error.reason, 'idempotency_key_required');
});
test('rejected completion records one rejection and no accepted delivery or payment', async t => {
  const f = await setup(t), id = await claimed(f);
  const r = await f.api(`/bounties/${id}/complete`, { ...completion, outcome: { decision: 'rejected', delivery_minutes: 999 } });
  assert.equal(r.status, 200); assert.notEqual(r.body.data.bounty.outcome.delivery_minutes, 999);
  assert.equal(r.body.data.bounty.completion_receipt.settlement.status, 'not_paid');
  const next = await f.api('/bounties', post(f));
  const c = await f.api(`/bounties/${next.body.data.bounty.id}/claim`, { claimer: offerFor(f.actors[1]) }, f.actors[1]);
  assert.equal(c.body.data.bounty.claim.claimer_card.outcomes.completed_jobs, 1);
  assert.equal(c.body.data.bounty.claim.claimer_card.outcomes.accepted_jobs, 0);
});
test('board advertises its own authenticated contract and discovery', async t => {
  const f = await setup(t);
  const doc = await fetch(`${f.url}/openapi.json`).then(r => r.json());
  assert.deepEqual(doc.paths['/bounties'].post.security, [{ bearer: [] }]);
  assert.equal(doc.paths['/bounties'].post.parameters[0].name, 'Idempotency-Key');
  for (const route of ['/llms.txt', '/skill.md']) {
    const r = await fetch(`${f.url}${route}`); assert.equal(r.status, 200); assert.match(await r.text(), /Idempotency-Key/);
  }
});

test('explicit loopback seller option preserves real mode and strict HTTPS preflight', async t => {
  const f = await setup(t);
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'board-loopback-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { ...f.config, dbPath: path.join(dir, 'board.sqlite'), keyPath: path.join(dir, 'key.pem'), fixtureMode: false, allowLoopbackSeller: true, preflightUrl: 'https://intel.twzrd.xyz/v1/intel/preflight' };
  assert.throws(() => createBountyApp({ ...config, allowLoopbackSeller: false }), /HTTPS/);
  assert.throws(() => createBountyApp({ ...config, preflightUrl: 'http://127.0.0.1:4032/preflight' }), /HTTPS/);
  for (const sellerUrl of ['http://example.com/card', 'http://localhost:4032/card', 'http://127.0.0.1.example.com/card', 'http://u:p@127.0.0.1/card']) assert.throws(() => createBountyApp({ ...config, sellerUrl }), /HTTPS/);
  let preflightCalls = 0;
  const app = createBountyApp({ ...config, fetchImpl: async (url, options) => {
    if (url === config.preflightUrl) { preflightCalls++; return new Response(JSON.stringify({ readiness_card: { decision: 'warn', can_spend: false } }), { headers: { 'content-type': 'application/json' } }); }
    return fetch(url, options);
  } });
  const server = await listen(app);
  t.after(async () => { await server.close(); app.locals.close(); });
  const key = await fetch(`${server.url}/bounties-key`).then(r => r.json()); assert.equal(key.mode, 'live_coordinator');
  const r = await fetch(`${server.url}/bounties`, { method: 'POST', headers: { authorization: `Bearer ${f.actors[0].token}`, 'content-type': 'application/json', 'idempotency-key': 'loopback-check' }, body: JSON.stringify(post(f)) });
  assert.equal(r.status, 403); assert.equal((await r.json()).error.reason, 'preflight_denied');
  assert.equal(preflightCalls, 1); assert.equal(f.calls.filter(c => c.kind === 'card').length, 1);
});

test('live-shape preflight: fields the card omits are skipped, fields it echoes must match', async t => {
  const f = await setup(t);
  // Live intel returns seller_wallet and price_usdc but no chain. An absent field is not a mismatch.
  f.state.gateExtras = { chain: undefined };
  const listed = await f.api('/bounties', post(f));
  assert.equal(listed.status, 201);
  assert.equal(f.calls.at(-1).kind, 'gate');
  f.state.gateExtras = { price_usdc: 999 };
  assert.equal((await f.api('/bounties', post(f))).body.error.reason, 'preflight_binding_mismatch');
});

test('cards can be served by a seller deployment the board does not host', async t => {
  const external = express(); external.use(express.json()); external.use(createSellerRouter());
  const remote = await listen(external); t.after(() => remote.close());
  const f = await fixture({ externalSellerUrl: `${remote.url}/seller/offer/validate` }); t.after(() => f.close());
  const listed = await f.api('/bounties', post(f));
  assert.equal(listed.status, 201);
  assert.ok(listed.body.data.bounty.poster_card.schema_version === 'seller-card/v1');
  assert.equal(f.calls.filter(c => c.kind === 'card').length, 0, 'card call left the board process');
});
