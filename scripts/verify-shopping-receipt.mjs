#!/usr/bin/env node
// Offline child process. No wallet, network, or actor success flag.
import { readFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { canonical, evalAssertion, sourceHash, verifyReceipt } from '../src/receipt.js';
import { specHash, VALID_FOR_MS } from '../src/observatory.js';

let result = { approve: false, reason: 'evidence_invalid', verifier_pid: process.pid };
try {
  const { receipt, trustedPubkeyB64, expectedMethod } = JSON.parse(readFileSync(0, 'utf8'));
  const key = createPublicKey({ key: Buffer.from(trustedPubkeyB64, 'base64'), format: 'der', type: 'spki' });
  const verified = key.asymmetricKeyType === 'ed25519' && verifyReceipt(receipt, key) === true;
  const now = Date.now();
  result = { ...result, expected_method: expectedMethod, receipt_verified: verified,
    checked_at: new Date(now).toISOString(), receipt_hash: sourceHash(canonical(receipt)),
    trusted_key_hash: sourceHash(key.export({ format: 'der', type: 'spki' })),
    reason: 'signature_invalid' };
  if (verified) {
    const observed = typeof receipt.observed_at === 'string' ? Date.parse(receipt.observed_at) : NaN;
    const until = typeof receipt.valid_until === 'string' ? Date.parse(receipt.valid_until) : NaN;
    if (!expectedMethod || canonical(receipt.method) !== canonical(expectedMethod)
        || receipt.spec_hash !== specHash(expectedMethod)
        || receipt.requested_url !== expectedMethod.url || receipt.assertion !== expectedMethod.assertion) {
      result.reason = 'method_mismatch';
    } else if (!Number.isFinite(observed) || !Number.isFinite(until)
        || until - observed !== VALID_FOR_MS || observed > now || now >= until) {
      result.reason = 'freshness_invalid';
    } else if (!/^[a-f0-9]{64}$/.test(receipt.source_hash ?? '')
        || typeof receipt.evidence !== 'string' || !receipt.evidence.length
        || !Number.isInteger(receipt.evidence_spans?.price?.start)
        || !Number.isInteger(receipt.evidence_spans?.price?.end)
        || receipt.evidence_spans.price.start < 0
        || receipt.evidence_spans.price.end <= receipt.evidence_spans.price.start
        || receipt.agreement !== '1-of-1'
        || !receipt.value || typeof receipt.value.price !== 'number' || !Number.isFinite(receipt.value.price)) {
      result.reason = 'evidence_invalid';
    } else if (receipt.verdict !== 'supported') {
      result.reason = 'verdict_not_supported';
    } else if (!evalAssertion(receipt.value, expectedMethod.assertion)) {
      result.reason = 'assertion_not_supported';
    } else {
      result.approve = true;
      result.reason = 'receipt_supported';
    }
  }
} catch { /* Missing or malformed evidence is incomplete, never approval. */ }
console.log(JSON.stringify(result));
process.exitCode = result.approve ? 0 : 1;
