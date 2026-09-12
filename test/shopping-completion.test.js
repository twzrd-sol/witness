import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, GATE_METHOD, logRun } from '../scripts/shopping-preapproval.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { generateProcessKey, pubkeyB64, signReceipt } from '../src/receipt.js';
import { createApp, handleWitness } from '../src/server.js';

test('live without independent pin blocks before network or wallet loading', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const run = await runOnce({ mode: 'live', base: 'http://unused', keypairPath: '/missing' });
  assert.equal(run.approve, false);
  assert.equal(run.completion, 'incomplete');
  assert.equal(run.decision.reason, 'trusted_key_invalid');
  assert.equal(run.paid, false);
});

test('live path requires separate verifier: real signed fixture, no payment or key lookup', async (t) => {
  const key = generateProcessKey();
  const out = await handleWitness(GATE_METHOD, {
    key, paid: true, retrieve: async () => ({ text: '<p>price: $5.99</p>' }),
  });
  assert.equal(out.status, 200);
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'http://unused/quote');
    return Response.json({ can_deliver: true, verdict: 'supported' });
  });
  const spawn = childProcess.spawnSync;
  let childPid;
  t.mock.method(childProcess, 'spawnSync', (...args) => {
    const result = spawn(...args);
    childPid = result.pid;
    return result;
  });
  const run = await runOnce({ mode: 'live', base: 'http://unused', trustedPubkeyB64: pubkeyB64(key),
    paymentTransport: async () => ({ payer: 'fixture-not-a-wallet', pay: async () => Response.json(out.json) }),
  });
  assert.equal(run.approve, true);
  assert.equal(run.completion, 'complete');
  assert.equal(run.check.verifier_pid, childPid);
  assert.notEqual(childPid, process.pid);
  assert.equal(run.check.expected_method.url, GATE_METHOD.url);
  assert.equal(run.payment_status, 'unknown');
  assert.equal(run.paid, false, 'receipt is not proof of settlement');
});

async function fixture() {
  const key = generateProcessKey();
  const out = await handleWitness(GATE_METHOD, { key, paid: true,
    retrieve: async () => ({ text: '<p>price: $5.99</p>' }) });
  assert.equal(out.status, 200);
  return { key, receipt: out.json };
}

async function runFixture(t, receipt, key) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, 'http://unused/quote');
    return Response.json({ can_deliver: true, verdict: 'supported', success: true });
  });
  return runOnce({ mode: 'live', base: 'http://unused', trustedPubkeyB64: pubkeyB64(key),
    paymentTransport: async () => ({ payer: 'fixture', pay: async () => Response.json(receipt) }) });
}

const cases = {
  'tampered value': (r) => ({ ...r, value: { price: 1 } }),
  'absent evidence': () => null,
  'actor story and success flag': () => ({ success: true, approve: true, verdict: 'supported', narration: 'I checked it' }),
  'signed wrong source': (r, k) => signReceipt({ ...r, method: { ...r.method, url: 'https://wrong.example/product' } }, k),
  'signed wrong assertion': (r, k) => signReceipt({ ...r, method: { ...r.method, assertion: 'price < 1000' } }, k),
  'signed wrong retrieval': (r, k) => signReceipt({ ...r, method: { ...r.method, retrieval: 'browse' } }, k),
  'signed mismatched spec hash': (r, k) => signReceipt({ ...r, spec_hash: 'bad' }, k),
  'signed wrong requested url': (r, k) => signReceipt({ ...r, requested_url: 'https://wrong.example/product' }, k),
  'signed expired': (r, k) => signReceipt({ ...r, observed_at: '2000-01-01T00:00:00Z', valid_until: '2000-01-01T01:00:00Z' }, k),
  'signed future observation': (r, k) => signReceipt({ ...r, observed_at: '2100-01-01T00:00:00Z', valid_until: '2100-01-01T01:00:00Z' }, k),
  'signed missing expiry': (r, k) => { delete r.valid_until; return signReceipt(r, k); },
  'signed malformed timestamp': (r, k) => signReceipt({ ...r, observed_at: 'not-a-date' }, k),
  'signed missing source hash': (r, k) => { delete r.source_hash; return signReceipt(r, k); },
  'signed unsupported verdict': (r, k) => signReceipt({ ...r, verdict: 'incomplete' }, k),
  'signed inconsistent value': (r, k) => signReceipt({ ...r, value: { price: 900 } }, k),
};
for (const [name, mutate] of Object.entries(cases)) {
  test(`integrated predicate blocks ${name}`, async (t) => {
    const { key, receipt } = await fixture();
    // Remove the old signature before signing mutations: canonical signer signs all fields.
    const { receipt: signature, ...body } = receipt;
    const input = name.startsWith('signed ') ? body : receipt;
    const run = await runFixture(t, mutate(input, key), key);
    assert.equal(run.approve, false);
    assert.equal(run.completion, 'incomplete');
  });
}

test('integrated predicate rejects wrong pinned key', async (t) => {
  const { receipt } = await fixture();
  assert.equal((await runFixture(t, receipt, generateProcessKey())).approve, false);
});

test('integrated predicate blocks real verifier crash', async (t) => {
  const { key, receipt } = await fixture();
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', () => spawn(process.execPath, ['-e', 'process.exit(17)']));
  const run = await runFixture(t, receipt, key);
  assert.equal(run.approve, false);
  assert.equal(run.completion, 'incomplete');
  assert.equal(run.check.reason, 'verifier_failed');
});

test('dry simulation can approve but cannot complete or authorize checkout', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ can_deliver: true, verdict: 'supported' }));
  const run = await runOnce({ mode: 'dry', base: 'http://unused' });
  assert.equal(run.approve, true, 'legacy simulated decision stays unchanged');
  assert.equal(run.completion, 'incomplete');
  assert.equal(run.checkout_approved, false);
  assert.equal(run.check.reason, 'not_run');
});

test('ledger preserves completion and mechanical check evidence', async (t) => {
  const { receipt, key } = await fixture();
  const run = await runFixture(t, receipt, key);
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'shopping-check-log-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  logRun(run, { dataDir });
  const line = JSON.parse(readFileSync(path.join(dataDir, 'preapproval.ndjson'), 'utf8'));
  assert.equal(line.completion, 'complete');
  assert.deepEqual(line.check, run.check);
  assert.equal(line.checkout_approved, true);
  assert.equal(line.payment_status, 'unknown');
});

test('network failure is a structured incomplete result', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  const run = await runOnce({ mode: 'live', base: 'http://unused', trustedPubkeyB64: pubkeyB64(generateProcessKey()) });
  assert.equal(run.completion, 'incomplete');
  assert.equal(run.approve, false);
  assert.equal(run.checkout_approved, false);
});

test('malformed pin blocks before quote and transport', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const run = await runOnce({ mode: 'live', trustedPubkeyB64: pubkeyB64(generateProcessKey()) + '!' });
  assert.equal(run.decision.reason, 'trusted_key_invalid');
});

test('verifier success flag without check evidence cannot approve', async (t) => {
  const { key, receipt } = await fixture();
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', () => spawn(process.execPath, ['-e',
    'console.log(JSON.stringify({approve:true,reason:"I verified",verifier_pid:process.pid}))'], { encoding: 'utf8' }));
  const run = await runFixture(t, receipt, key);
  assert.equal(run.approve, false);
  assert.equal(run.check.reason, 'verifier_failed');
});

for (const [name, program] of Object.entries({
  'malformed output': 'console.log("not JSON")',
  'timeout': 'setInterval(()=>{},1000)',
})) {
  test(`verifier ${name} fails closed`, async (t) => {
    const { key, receipt } = await fixture();
    const spawn = childProcess.spawnSync;
    t.mock.method(childProcess, 'spawnSync', () => spawn(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 50 }));
    const run = await runFixture(t, receipt, key);
    assert.equal(run.approve, false);
    assert.equal(run.completion, 'incomplete');
    assert.equal(run.check.reason, 'verifier_failed');
  });
}

test('CLI exit 0 is checkout_approved only; dry supported quote is incomplete', async (t) => {
  const key = generateProcessKey();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wit-shop-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = createApp({ key, retrieve: async () => ({ text: '<p>price: $5.99</p>' }), observationsDir: dir });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/shopping-preapproval.mjs');
  const child = childProcess.spawn(process.execPath, [script, `--base=${base}`, '--mode=dry'], {
    env: { PATH: process.env.PATH },
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('CLI timed out'));
    }, 10_000);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  assert.equal(code, 1);
  const run = JSON.parse(Buffer.concat(stdout).toString('utf8'));
  assert.equal(run.approve, true, 'legacy simulated decision stays unchanged');
  assert.equal(run.completion, 'incomplete');
  assert.equal(run.checkout_approved, false);
});
