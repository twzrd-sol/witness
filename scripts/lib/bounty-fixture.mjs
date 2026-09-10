// Local internal experiment only. The allow response is a fixture, never TWZRD evidence.
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createBountyApp } from '../../src/bounty-board.js';
import { createSellerRouter } from '../../src/routes/seller.js';

export const fixtureActors = () => ['poster', 'claimer', 'claimer2', 'operator'].map((id, i) => ({ id, role: id === 'claimer2' ? 'claimer' : id, token: randomBytes(32).toString('hex'), network: 'base', wallet: `0x${String(i + 1).padStart(40, '0')}` }));
export function offerFor(actor, price = 500000) {
  return { schema_version: 'seller-offer/v1', seller_id: actor.id, payout_wallet: actor.wallet, network: actor.network, currency: 'USDC', price_minor: price, sla_minutes: 60, capability: 'TWZRD backlog work', deliverable: { description: 'Reviewed Markdown artifact', mime_type: 'text/markdown' } };
}
export async function listen(app) {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
// externalSellerUrl swaps the in-process seller router for a real out-of-process witness
// instance (the pilot shape). The gate stays a labelled fixture either way.
export async function fixture({ externalSellerUrl = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'witness-bounty-'));
  const actors = fixtureActors(), calls = [], state = { decision: 'allow', canSpend: true, gateStatus: 200, sellerStatus: 200, delayMs: 0, cardMutate: null, gateExtras: {} };
  const deps = express(); deps.use(express.json());
  deps.post('/seller/offer/validate', (req, res, next) => {
    calls.push({ kind: 'card', body: req.body });
    if (state.sellerStatus !== 200) return res.sendStatus(state.sellerStatus);
    if (state.cardMutate) { const json = res.json.bind(res); res.json = body => json(state.cardMutate(body)); }
    next();
  });
  deps.use(createSellerRouter());
  deps.post('/preflight', async (req, res) => {
    calls.push({ kind: 'gate', body: req.body });
    if (state.delayMs) await new Promise(resolve => setTimeout(resolve, state.delayMs));
    if (state.gateStatus !== 200) return res.sendStatus(state.gateStatus);
    res.json({ readiness_card: { decision: state.decision, can_spend: state.canSpend, seller_wallet: req.body.seller_wallet, chain: req.body.chain, price_usdc: req.body.price_usdc, ...state.gateExtras }, fixture: true });
  });
  const dependency = await listen(deps);
  const config = { dbPath: path.join(dir, 'board.sqlite'), keyPath: path.join(dir, 'key.pem'), actors, sellerUrl: externalSellerUrl ?? `${dependency.url}/seller/offer/validate`, preflightUrl: `${dependency.url}/preflight`, fixtureMode: true };
  let app = createBountyApp(config), board = await listen(app);
  let seq = 0;
  const api = async (route, body, actor = actors[0], key = `request-${++seq}`) => {
    const r = await fetch(`${board.url}${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  return { actors, calls, state, config, api, sellerUrl: config.sellerUrl, externalSeller: externalSellerUrl !== null, get url() { return board.url; }, get publicKey() { return app.locals.publicKey; },
    restart: async () => { await board.close(); app.locals.close(); app = createBountyApp(config); board = await listen(app); },
    close: async () => { await board.close(); app.locals.close(); await dependency.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
