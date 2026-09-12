#!/usr/bin/env node
/**
 * Loopback fixture storefront. Not the live Witness host.
 * Bind is 127.0.0.1 / ::1 only. No payment.
 */
import { listenFixture, KIND } from "../src/fixture-storefront.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
if (!Number.isInteger(port) || port < 0) {
  console.error("PORT must be a non-negative integer");
  process.exit(1);
}

let server;
try {
  server = listenFixture({ host, port });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

server.on("listening", () => {
  const addr = server.address();
  console.log(`${KIND} http://${addr.address}:${addr.port} (local only; live_shopify=false; no payment)`);
});
server.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
