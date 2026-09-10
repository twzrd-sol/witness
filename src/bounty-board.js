import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonical, signReceipt, sourceHash } from './receipt.js';
import { validateSellerOffer } from './seller.js';
import { bountyOpenapi } from './bounty-openapi.js';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (status, reason) => { throw Object.assign(new Error(reason), { status }); };
const same = (a, b) => canonical(a) === canonical(b);
export function wallet(network, value) {
  if (network === 'base' && typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (network === 'solana' && typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    let n = 0n;
    for (const c of value) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));
    const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
    if (bytes + (value.match(/^1*/)[0].length) === 32) return value;
  }
  fail(400, 'bad_wallet');
}
function endpoint(raw, allowLoopback) {
  const u = new URL(raw);
  if (u.username || u.password || u.hash || (u.protocol !== 'https:' && !(allowLoopback && u.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('HTTPS dependency URL required (loopback HTTP requires explicit permission)');
  return u.href;
}
function signingKey(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  // SQLite startup serialization below protects first key creation across board processes.
  try { return createPrivateKey(readFileSync(file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const key = generateKeyPairSync('ed25519').privateKey;
  try { writeFileSync(file, key.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return createPrivateKey(readFileSync(file));
}

/** Authenticated single-host coordinator. Completion records acceptance, never a funds transfer. */
export function createBountyApp({ dbPath, keyPath, actors, sellerUrl = 'https://witness.outbid.sh/seller/offer/validate', preflightUrl = 'https://intel.twzrd.xyz/v1/intel/preflight', fixtureMode = false, allowLoopbackSeller = false, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!dbPath || !keyPath || !Array.isArray(actors) || !actors.length) throw new Error('dbPath, keyPath and actors required');
  const identities = actors.map(a => {
    if (!object(a) || typeof a.id !== 'string' || !a.id || typeof a.token !== 'string' || a.token.length < 32 || !['poster', 'claimer', 'operator'].includes(a.role)) throw new Error('Invalid actor configuration');
    return { ...a, wallet: wallet(a.network, a.wallet), tokenHash: Buffer.from(sourceHash(a.token), 'hex') };
  });
  if (new Set(identities.map(a => a.id)).size !== identities.length || new Set(identities.map(a => a.token)).size !== identities.length) throw new Error('Duplicate actor identity/token');
  sellerUrl = endpoint(sellerUrl, fixtureMode || allowLoopbackSeller === true); preflightUrl = endpoint(preflightUrl, fixtureMode);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS retries (key TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL)');
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const v = fn(); db.exec('COMMIT'); return v; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  let kp, publicKey, keyId;
  try {
    transaction(() => {
      kp = { privateKey: signingKey(keyPath) }; kp.publicKey = createPublicKey(kp.privateKey);
      if (kp.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required');
      publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' }); keyId = sourceHash(publicKey);
      for (const [k, v] of [['key_id', keyId], ['mode', fixtureMode ? 'internal_fixture' : 'live_coordinator']]) {
        const old = db.prepare('SELECT value FROM meta WHERE key=?').get(k);
        if (old && old.value !== v) throw new Error(`Database ${k} mismatch`);
        db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run(k, v);
      }
    });
  } catch (e) { db.close(); throw e; }
  const mode = fixtureMode ? 'internal_fixture' : 'live_coordinator';
  const get = id => { const row = db.prepare('SELECT value FROM jobs WHERE id=?').get(id); if (!row) fail(404, 'bounty_not_found'); return JSON.parse(row.value); };
  const history = actor => db.prepare('SELECT value FROM jobs').all().map(r => JSON.parse(r.value)).filter(b => b.status === 'complete' && b.claim?.offer.network === actor.network && b.claim.offer.payout_wallet === actor.wallet).map(b => ({ status: b.outcome.decision, delivery_minutes: b.outcome.delivery_minutes, receipt_id: b.completion_receipt.id }));
  async function postJSON(url, body) {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Twzrd-Caller': `witness-bounty-${mode}` }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Dependency HTTP ${response.status}`);
    return response.json();
  }
  async function card(offer, outcomes) {
    let result; try { result = await postJSON(sellerUrl, { offer, outcomes }); } catch { fail(503, 'seller_unavailable'); }
    const c = result?.data?.seller_card;
    if (result.success !== true || c?.schema_version !== 'seller-card/v1' || c.seller_id !== offer.seller_id || c.payout_wallet !== offer.payout_wallet || c.network !== offer.network || c.currency !== 'USDC' || c.price_usdc !== (offer.price_minor / 1e6).toFixed(6) || !object(c.outcomes) || !same(c.deliverable, offer.deliverable)) fail(503, 'bad_seller_response');
    return c;
  }
  async function gate(offer, amount, purpose, id) {
    const request = { resource_name: `bounty:${id}`, seller_wallet: offer.payout_wallet, price_usdc: amount / 1e6, chain: offer.network, agent_intent: purpose };
    let result; try { result = await postJSON(preflightUrl, request); } catch { fail(503, 'preflight_unavailable'); }
    const c = result?.readiness_card ?? result;
    if (!object(c) || c.decision !== 'allow' || c.can_spend !== true) fail(403, 'preflight_denied');
    if ((c.seller_wallet !== undefined && c.seller_wallet !== request.seller_wallet) || (c.chain !== undefined && c.chain !== request.chain) || (c.price_usdc !== undefined && c.price_usdc !== request.price_usdc)) fail(503, 'preflight_binding_mismatch');
    if (c.expires_at !== undefined && (!Number.isFinite(Date.parse(c.expires_at)) || Date.parse(c.expires_at) <= Date.now())) fail(503, 'preflight_expired');
    return { request, response: result, checked_at: new Date().toISOString(), mode };
  }
  const requireFresh = evidence => {
    const card = evidence.response.readiness_card ?? evidence.response;
    if (card.expires_at !== undefined && Date.parse(card.expires_at) <= Date.now()) fail(503, 'preflight_expired');
  };
  const offerFor = (body, actor, field) => {
    const offer = body[field];
    if (!validateSellerOffer(offer).valid) fail(400, 'bad_seller_offer');
    const normalized = { schema_version: offer.schema_version, seller_id: offer.seller_id, capability: offer.capability, price_minor: offer.price_minor, currency: offer.currency, network: offer.network, payout_wallet: wallet(offer.network, offer.payout_wallet), sla_minutes: offer.sla_minutes, deliverable: { description: offer.deliverable.description, mime_type: offer.deliverable.mime_type }, ...(offer.evidence_url === undefined ? {} : { evidence_url: offer.evidence_url }) };
    if (normalized.seller_id !== actor.id || normalized.network !== actor.network || normalized.payout_wallet !== actor.wallet) fail(403, 'actor_offer_mismatch');
    return normalized;
  };
  const retry = (key, hash) => { const row = db.prepare('SELECT * FROM retries WHERE key=?').get(key); if (!row) return null; if (row.hash !== hash) fail(409, 'idempotency_conflict'); return JSON.parse(row.response); };
  const app = express();
  app.locals.close = () => db.close(); app.locals.publicKey = publicKey;
  app.use(express.json({ limit: '64kb', strict: false }));
  app.get('/openapi.json', (_req, res) => res.json(bountyOpenapi()));
  app.get('/llms.txt', (_req, res) => res.type('text/plain').send('Authenticated TWZRD bounty coordinator. POST /bounties, POST /bounties/:id/claim, POST /bounties/:id/complete. Mutations require Bearer authentication and Idempotency-Key. Server-side seller HTTP cards and TWZRD preflight. Completion signs acceptance evidence, never claims payment. See /openapi.json and /bounties-key.'));
  app.get('/skill.md', (_req, res) => res.type('text/markdown').send('# Bounty coordination\n\nUse configured participant credentials, never public wallet identities as authentication. Post a poster offer and task; claim with your bound claimer offer; the poster or operator accepts/rejects a delivered artifact by SHA-256 on complete. Preserve the signed receipt and independently pinned public key. Every mutation needs Idempotency-Key; identical retries are safe. No settlement adapter is configured: completion is not payment or external-agent evidence. See /openapi.json.'));
  app.get('/bounties-key', (_req, res) => res.json({ key_id: keyId, public_key: publicKey, mode }));
  app.use((req, _res, next) => {
    const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? '';
    const hash = Buffer.from(sourceHash(token), 'hex');
    const actor = identities.find(a => timingSafeEqual(hash, a.tokenHash));
    if (!actor) return next(Object.assign(new Error('unauthorized'), { status: 401 }));
    req.actor = actor; next();
  });
  app.get('/bounties/:id', (req, res, next) => { try { res.json({ success: true, data: { bounty: get(req.params.id) } }); } catch (e) { next(e); } });
  const mutate = (operation, prepare) => async (req, res, next) => {
    try {
      if (!object(req.body)) fail(400, 'bad_body');
      const idempotency = req.get('idempotency-key');
      if (!idempotency || !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotency)) fail(400, 'idempotency_key_required');
      const key = canonical([req.actor.id, operation, req.params.id ?? '', idempotency]);
      const hash = sourceHash(canonical({ body: req.body, authority: { id: req.actor.id, role: req.actor.role, wallet: req.actor.wallet, network: req.actor.network } }));
      const cached = retry(key, hash); if (cached) return res.status(cached.status).json(cached.body);
      const prepared = await prepare(req);
      const response = transaction(() => {
        const cached = retry(key, hash); if (cached) return cached;
        const bounty = prepared();
        db.prepare('INSERT INTO jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(bounty.id, JSON.stringify(bounty));
        const result = { status: operation === 'post' ? 201 : 200, body: { success: true, data: { bounty } } };
        db.prepare('INSERT INTO retries VALUES (?,?,?)').run(key, hash, JSON.stringify(result));
        return result;
      });
      res.status(response.status).json(response.body);
    } catch (e) { next(e); }
  };
  app.post('/bounties', mutate('post', async req => {
    if (!['poster', 'operator'].includes(req.actor.role)) fail(403, 'poster_required');
    const offer = offerFor(req.body, req.actor, 'poster');
    if (!object(req.body.task) || typeof req.body.task.description !== 'string' || !req.body.task.description.trim() || req.body.task.description.length > 8000) fail(400, 'bad_task');
    const amount = offer.price_minor;
    if (amount < 500000 || amount > 2000000) fail(400, 'bad_reward');
    const id = randomUUID(), task = { description: req.body.task.description };
    const posterCard = await card(offer, []); // Payment history is unknown until settlement is independently verified.
    const preflight = await gate(offer, amount, 'list bounty', id);
    return () => { requireFresh(preflight); return ({ id, status: 'open', mode, task, reward_minor: amount, currency: 'USDC', poster: offer, poster_card: posterCard, payment_history: { paid_jobs: null, payment_rate: null }, preflight, claim: null, outcome: null, completion_receipt: null, created_at: new Date().toISOString() }); };
  }));
  app.post('/bounties/:id/claim', mutate('claim', async req => {
    if (req.actor.role !== 'claimer') fail(403, 'claimer_required');
    const bounty = get(req.params.id), offer = offerFor(req.body, req.actor, 'claimer');
    if (bounty.status !== 'open') fail(409, 'bounty_not_open');
    if (offer.network !== bounty.poster.network || offer.price_minor > bounty.reward_minor) fail(400, 'claim_terms_mismatch');
    if (offer.payout_wallet === bounty.poster.payout_wallet) fail(403, 'self_claim');
    const claimerCard = await card(offer, history(req.actor));
    return () => {
      const current = get(bounty.id); if (current.status !== 'open') fail(409, 'bounty_not_open');
      return { ...current, status: 'claimed', claim: { offer, claimer_card: claimerCard, claimed_at: new Date().toISOString() } };
    };
  }));
  app.post('/bounties/:id/complete', mutate('complete', async req => {
    const bounty = get(req.params.id);
    if (req.actor.role !== 'operator' && !(req.actor.role === 'poster' && req.actor.id === bounty.poster.seller_id && req.actor.wallet === bounty.poster.payout_wallet && req.actor.network === bounty.poster.network)) fail(403, 'acceptance_authority_required');
    if (bounty.status !== 'claimed') fail(409, 'bounty_not_claimed');
    const { outcome, artifact } = req.body;
    if (!object(outcome) || !['accepted', 'rejected'].includes(outcome.decision) || !object(artifact) || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || typeof artifact.description !== 'string' || !artifact.description.trim() || artifact.description.length > 8000) fail(400, 'bad_completion');
    const evidence = { sha256: artifact.sha256, description: artifact.description };
    // This preflight is eligibility evidence only. A future payment adapter MUST recheck immediately before signing.
    const preflight = await gate(bounty.claim.offer, bounty.reward_minor, 'completion payout eligibility (no transfer)', bounty.id);
    return () => {
      const current = get(bounty.id); if (current.status !== 'claimed') fail(409, 'bounty_not_claimed');
      requireFresh(preflight);
      const completed_at = new Date().toISOString();
      const result = { decision: outcome.decision, completed_at, delivery_minutes: Math.max(0, (Date.parse(completed_at) - Date.parse(current.claim.claimed_at)) / 60000), accepted_by: req.actor.id };
      const receipt = signReceipt({ schema_version: 'bounty-completion/v1', id: randomUUID(), bounty_id: current.id, mode, key_id: keyId, task_sha256: sourceHash(canonical(current.task)), poster: current.poster, claimer: current.claim.offer, reward_minor: current.reward_minor, currency: 'USDC', artifact: evidence, outcome: result, preflight, settlement: { status: 'not_paid', reason: 'settlement_adapter_not_configured', transaction: null } }, kp);
      return { ...current, status: 'complete', outcome: result, completion_receipt: receipt };
    };
  }));
  app.use((err, _req, res, _next) => res.status(err.type === 'entity.parse.failed' ? 400 : err.status ?? 500).json({ success: false, data: null, error: { reason: err.type === 'entity.parse.failed' ? 'bad_json' : err.status ? err.message : 'internal_error' } }));
  return app;
}
