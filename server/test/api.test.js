import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../app.js';
import { createSettlementPolicy } from '../domain/policy.js';
import { SettlementService } from '../domain/settlement-service.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';

let server;
let baseUrl;
let capturedAgentDecision;
let capturedSwapEstimate;

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
  const agentDecisionService = {
    async decide(input, idempotencyKey) {
      capturedAgentDecision = { input, idempotencyKey };
      return {
        record: { id: 'agent-api-1', state: 'DENIED', policy: { approved: false, reasons: [] } },
        replayed: false,
      };
    },
  };
  const appKitGateway = {
    configuration() {
      return {
        provider: 'CIRCLE_STABLECOIN_KITS_API',
        network: 'Arc_Testnet',
        kitKeyConfigured: true,
        runtimeEnabled: true,
        dependencyStatus: 'AVAILABLE_AUDIT_CLEAN',
      };
    },
    async estimateSwap(input) {
      capturedSwapEstimate = input;
      return {
        provider: 'CIRCLE_STABLECOIN_KITS',
        chain: 'Arc_Testnet',
        estimatedOutput: { token: input.tokenOut, amount: '0.99' },
      };
    },
  };
  const app = createApp({
    config,
    settlementService,
    arcRpc,
    agentDecisionService,
    appKitGateway,
    logger,
  });
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
  assert.equal(payload.circle.configured, false);
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
  const execute = await fetch(
    `${baseUrl}/api/v1/settlements/${firstPayload.data.id}/execute`,
    { method: 'POST' },
  );
  const executePayload = await execute.json();

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replayPayload.meta.replayed, true);
  assert.equal(replayPayload.data.id, firstPayload.data.id);
  assert.equal(preparedPayload.data.state, 'AWAITING_SIGNATURE');
  assert.equal(execute.status, 503);
  assert.equal(executePayload.error.code, 'CIRCLE_NOT_CONFIGURED');
});

test('Circle wallet and webhook routes fail closed when integration is absent', async () => {
  const walletResponse = await fetch(`${baseUrl}/api/v1/circle/wallet`);
  const walletPayload = await walletResponse.json();
  const webhookResponse = await fetch(`${baseUrl}/api/webhooks/circle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const webhookPayload = await webhookResponse.json();

  assert.equal(walletResponse.status, 503);
  assert.equal(walletPayload.error.code, 'CIRCLE_NOT_CONFIGURED');
  assert.equal(webhookResponse.status, 503);
  assert.equal(webhookPayload.error.code, 'CIRCLE_WEBHOOK_NOT_CONFIGURED');
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

test('agent endpoint validates structured signal evidence and forwards idempotency', async () => {
  const response = await fetch(`${baseUrl}/api/v1/agent/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'agent-api-key-0001' },
    body: JSON.stringify({
      recipient: '0x2222222222222222222222222222222222222222',
      requestedAmount: '1.00',
      reference: 'AGENT-API-EVIDENCE',
      signals: {
        engagementVelocity: 90,
        holderRetention: 85,
        liquidityDepth: 88,
        fraudRisk: 5,
        confidence: 95,
        observedAt: '2026-08-02T13:00:00.000Z',
        source: 'ANALYTICS_PIPELINE',
        sourceReference: 'batch-100',
      },
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.data.id, 'agent-api-1');
  assert.equal(capturedAgentDecision.idempotencyKey, 'agent-api-key-0001');
  assert.equal(capturedAgentDecision.input.signals.source, 'ANALYTICS_PIPELINE');
});

test('App Kit routes expose runtime status and a server-side swap estimate', async () => {
  const capabilitiesResponse = await fetch(`${baseUrl}/api/v1/app-kit/capabilities`);
  const capabilities = await capabilitiesResponse.json();
  const estimateResponse = await fetch(`${baseUrl}/api/v1/app-kit/swap/estimate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1.00' }),
  });
  const estimate = await estimateResponse.json();

  assert.equal(capabilitiesResponse.status, 200);
  assert.equal(capabilities.data.runtimeEnabled, true);
  assert.equal(JSON.stringify(capabilities).includes('KIT_KEY:'), false);
  assert.equal(estimateResponse.status, 200);
  assert.equal(estimate.data.estimatedOutput.amount, '0.99');
  assert.deepEqual(capturedSwapEstimate, { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1.00' });
});
