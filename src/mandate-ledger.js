/**
 * Single-host mandate reservation ledger.
 *
 * Atomic load-check-save (no await in the critical section). Same mandate_id
 * + same request hash replays the original decision. Same mandate_id +
 * different input is idempotency_conflict. Reserved totals cannot exceed
 * max_total_minor. File-backed so a new process on the same path sees prior
 * reservations.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

function empty() {
  return { mandates: {}, purchases: {} };
}

function load(file) {
  if (!file || !existsSync(file)) return empty();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.mandates && typeof parsed.mandates === "object") {
      return { mandates: parsed.mandates, purchases: parsed.purchases && typeof parsed.purchases === "object" ? parsed.purchases : {} };
    }
  } catch {
    /* unreadable ledger starts empty; do not invent reservations */
  }
  return empty();
}

function save(file, data) {
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`);
  renameSync(tmp, file);
}

export function createMandateLedger(file) {
  const memory = file ? null : empty();

  return {
    reserve({ mandateId, payloadHash, requestHash, amountMinor, maxTotalMinor, subject, decide }) {
      const data = memory ?? load(file);
      const row = data.mandates[mandateId];
      if (row && row.payload_hash !== payloadHash) return { status: "idempotency_conflict" };
      if (row) {
        const prior = row.purchases.find((p) => p.request_hash === requestHash);
        if (prior) return { status: "replay", decision: { ...prior.decision, replay: true } };
        if (row.reserved_minor + amountMinor > maxTotalMinor) return { status: "budget_exceeded" };
      } else if (amountMinor > maxTotalMinor) {
        return { status: "budget_exceeded" };
      }

      const purchase_id = `pur_${randomUUID()}`;
      const decision = decide({ purchase_id, replay: false });
      const next = row ?? { payload_hash: payloadHash, reserved_minor: 0, purchases: [] };
      next.reserved_minor += amountMinor;
      next.purchases.push({ purchase_id, request_hash: requestHash, reserved_minor: amountMinor, subject, decision });
      data.mandates[mandateId] = next;
      data.purchases = data.purchases ?? {};
      data.purchases[purchase_id] = { mandate_id: mandateId, subject, decision };
      if (memory) Object.assign(memory, data);
      else save(file, data);
      return { status: "reserved", decision };
    },

    get(purchaseId) {
      if (typeof purchaseId !== "string" || !purchaseId) return null;
      const data = memory ?? load(file);
      const indexed = data.purchases?.[purchaseId];
      if (indexed) return indexed;
      for (const [mandateId, row] of Object.entries(data.mandates || {})) {
        const prior = row.purchases?.find((p) => p.purchase_id === purchaseId);
        if (prior) return { mandate_id: mandateId, subject: prior.subject, decision: prior.decision };
      }
      return null;
    },
  };
}
