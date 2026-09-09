import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, handleQuote } from '../src/server.js';
import { generateProcessKey } from '../src/receipt.js';
import { openapiDoc } from '../src/openapi.js';
const body = { url: 'https://example.com/pricing', extract: { price: 'number' } };
const retrieve = async () => ({ text: 'price: 49' });

test('preserve current verdict contract: a false assertion is a deliverable contradiction', async () => {
  const result = await handleQuote({ ...body, assertion: 'price < 10' }, { retrieve });
  assert.equal(result.status, 200);
  assert.equal(result.json.verdict, 'contradicted');
});

test('preserve current verdict contract: malformed assertions remain unpriced', async () => {
  const result = await handleQuote({ ...body, assertion: 'price ~~ cheap' }, { retrieve });
  assert.equal(result.status, 422);
  assert.equal(result.json.reason, 'assertion_malformed');
  assert.equal(result.json.price_usdc, undefined);
});

test('preserve live parse-error contract: malformed JSON never gets a payment challenge', async () => {
  let retrieves = 0;
  const server = createApp({ key: generateProcessKey(), funnelDir: null,
    retrieve: async () => { retrieves++; return retrieve(); },
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const route of ['/quote', '/witness']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
      });
      assert.equal(response.status, 400, route);
      assert.deepEqual(await response.json(), { reason: 'bad_json' });
      assert.equal(response.headers.get('payment-required'), null);
    }
    assert.equal(retrieves, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('preserve published change-proof request and signed response fields', () => {
  const doc = openapiDoc({});
  for (const route of ['/quote', '/witness']) {
    assert.ok(doc.paths[route].post.requestBody.content['application/json'].schema.properties.prior_receipt);
  }
  const props = doc.paths['/witness'].post.responses['200'].content['application/json'].schema.properties;
  assert.equal(props.changed.type, 'boolean');
  assert.equal(props.previous_source_hash.type, 'string');
});
