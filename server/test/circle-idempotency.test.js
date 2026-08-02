import assert from 'node:assert/strict';
import test from 'node:test';
import { circleIdempotencyKey } from '../../scripts/circle-idempotency.js';

test('Circle idempotency keys are stable for retries and change with artifact identity', () => {
  const original = circleIdempotencyKey('market-factory-deploy', ['0x6001', 'ARC-TESTNET']);
  const retry = circleIdempotencyKey('market-factory-deploy', ['0x6001', 'ARC-TESTNET']);
  const revised = circleIdempotencyKey('market-factory-deploy', ['0x6002', 'ARC-TESTNET']);

  assert.equal(retry, original);
  assert.notEqual(revised, original);
  assert.match(original, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
