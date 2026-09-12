#!/usr/bin/env node
/** One-shot buyer for a fuchss x402-trust report (operator-authorized, 2026-09-09).
 *  Pays ~$0.005 USDC on Base from the outbid receiver key (0xB36e, idle hedge funds;
 *  NOT witness payTo 0x14df — keep witness settlement income accounting pure).
 *  Step 1 is always free: read the seller's own /.well-known/x402 descriptor.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const RESOURCE = process.argv.find((a) => a.startsWith("--resource="))?.slice(11) ?? "https://witness.outbid.sh/witness";
const KEYFILE = process.argv.find((a) => a.startsWith("--key="))?.slice(6) ?? "/home/twzrd/security/wallets/outbid/receiver.evm.json";

// Step 1: free discovery — the seller's own advertised descriptor.
const desc = await (await fetch("https://x402.fuchss.app/.well-known/x402")).json();
console.log("DISCOVERY", JSON.stringify(desc, null, 2));

// Step 2: build the paying client on Base mainnet only.
const { x402Client } = require("@x402/fetch");
const { wrapFetchWithPayment } = require("@x402/fetch");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { privateKeyToAccount } = require("viem/accounts");

const keyDoc = JSON.parse(readFileSync(KEYFILE, "utf8"));
const pk = keyDoc.privateKey.startsWith("0x") ? keyDoc.privateKey : "0x" + keyDoc.privateKey;
const account = privateKeyToAccount(pk);
console.log("PAYER", account.address);

const client = new x402Client().register("eip155:8453", new ExactEvmScheme(account));
const pay = wrapFetchWithPayment(globalThis.fetch, client);

// Step 3: one paid POST /v1/x402-trust.
const res = await pay("https://x402.fuchss.app/v1/x402-trust", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ resource: RESOURCE }),
});
console.log("STATUS", res.status);
const report = await res.json().catch(() => ({}));
writeFileSync("/tmp/fuchss-report.json", JSON.stringify(report, null, 2));
console.log("REPORT_WRITTEN /tmp/fuchss-report.json");

// Print the parts that matter: verdict, flags with severities.
const r = report ?? {};
console.log("VERDICT", r.grade ?? r.verdict ?? "?", "score:", r.score ?? r.full_density_score ?? "?");
const flags = r.flagsDetailed ?? r.flags ?? [];
for (const f of flags) console.log("FLAG", f.severity ?? "?", f.code ?? f.name ?? "?", JSON.stringify(f.detail ?? f.message ?? "").slice(0, 200));
