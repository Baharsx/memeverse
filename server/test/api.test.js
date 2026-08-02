import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.js';
import { createSettlementPolicy } from '../domain/policy.js';
import { SettlementService } from '../domain/settlement-service.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';

let server;
let baseUrl;

before(async () => {
  const config = {
    nodeEnv: 'test',
    appOrigin: 'http://127.0.0.1:5173',
    arcChainId: 5042002,
    quoteTtlSeconds: 300,
    maxSpendUsdc: '25.00',
    minViralityScore: 78,
    creatorShareBps: 6000,
  };
  const settlementService = new SettlementService({
    store: new MemorySettlementStore(),
    policy: createSettlementPolicy(config),
    chainId: config.arcChainId,
    quoteTtlSeconds: config.quoteTtlSeconds,
  });
  const arcRpc = {
    async health() {
      return { status: 'verified', chainId: 5042002, blockNumber: 123, checkedAt: new Date().toISOString() };
    },
  };
  const logger = { info() {}, error() {} };
  const app = createApp({ config, settlementService, arcRpc, logger });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health verifies the Arc RPC chain', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.status, 'ok');
  assert.equal(payload.arc.chainId, 5042002);
});

test('quote and prepare form an idempotent API path', async () => {
  const body = JSON.stringify({
    recipient: '0x2222222222222222222222222222222222222222',
    requestedAmount: '20.00',
    viralityScore: 90,
    reference: 'API-PAYOUT-001',
  });
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'api-key-0001' };
  const first = await fetch(`${baseUrl}/api/v1/settlements/quote`, { method: 'POST', headers, body });
  const firstPayload = await first.json();
  const replay = await fetch(`${baseUrl}/api/v1/settlements/quote`, { method: 'POST', headers, body });
  const replayPayload = await replay.json();
  const prepared = await fetch(
    `${baseUrl}/api/v1/settlements/${firstPayload.data.id}/prepare`,
    { method: 'POST' },
  );
  const preparedPayload = await prepared.json();

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replayPayload.meta.replayed, true);
  assert.equal(replayPayload.data.id, firstPayload.data.id);
  assert.equal(preparedPayload.data.state, 'AWAITING_SIGNATURE');
});

test('API exposes stable validation errors', async () => {
  const response = await fetch(`${baseUrl}/api/v1/settlements/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'api-key-0002' },
    body: JSON.stringify({ recipient: 'invalid' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.error.code, 'VALIDATION_ERROR');
  assert.ok(response.headers.get('x-request-id'));
});
