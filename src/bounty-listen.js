import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createBountyApp } from './bounty-board.js';

const dir = process.env.BOUNTY_DATA_DIR ?? 'data/bounty-board';
if (!process.env.BOUNTY_ACTORS_FILE) throw new Error('BOUNTY_ACTORS_FILE required');
const app = createBountyApp({
  dbPath: path.join(dir, 'board.sqlite'), keyPath: path.join(dir, 'signing-key.pem'),
  actors: JSON.parse(readFileSync(process.env.BOUNTY_ACTORS_FILE, 'utf8')),
  sellerUrl: process.env.BOUNTY_SELLER_URL,
  allowLoopbackSeller: process.env.BOUNTY_ALLOW_LOOPBACK_SELLER === "1",
  preflightUrl: process.env.BOUNTY_PREFLIGHT_URL,
});
const server = app.listen(Number(process.env.BOUNTY_PORT ?? 8788), process.env.BOUNTY_HOST ?? '127.0.0.1', () => console.log('Bounty board listening', server.address()));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { app.locals.close(); process.exit(0); }));
