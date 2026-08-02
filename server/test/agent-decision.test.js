import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentDecisionService } from '../domain/agent-decision-service.js';
import { createAgentPolicy } from '../domain/agent-policy.js';
import { createSettlementPolicy } from '../domain/policy.js';
import { SettlementService } from '../domain/settlement-service.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';

function fixture() {
  const now = new Date('2026-08-02T13:00:00.000Z');
  let sequence = 0;
  const store = new MemorySettlementStore();
  const circleGateway = {
    async readiness() {
      return {
        configured: true,
        wallet: { state: 'LIVE', accountType: 'EOA' },
        usdcBalance: '100',
      };
    },
    async treasuryAvailableUnits() { return 100_000_000n; },
  };
  const settlementService = new SettlementService({
    store,
    policy: createSettlementPolicy({
      maxSpendUsdc: '25', minViralityScore: 78, creatorShareBps: 6000,
    }),
    chainId: 5042002,
    quoteTtlSeconds: 300,
    circleGateway,
    now: () => now,
    id: () => `agent-settlement-${++sequence}`,
  });
  const service = new AgentDecisionService({
    settlementService,
    circleGateway,
    arcRpc: { async health() { return { status: 'verified', chainId: 5042002, blockNumber: 55 }; } },
    policy: createAgentPolicy({
      agentDailySpendUsdc: '30',
      agentMaxFraudRisk: 20,
      agentMinConfidence: 80,
      agentSignalMaxAgeSeconds: 300,
    }),
    now: () => now,
  });
  return { service, store };
}

function request(overrides = {}) {
  return {
    recipient: '0x1111111111111111111111111111111111111111',
    requestedAmount: '25',
    reference: 'AGENT-SIGNAL-001',
    signals: {
      engagementVelocity: 94,
      holderRetention: 92,
      liquidityDepth: 90,
      fraudRisk: 8,
      confidence: 96,
      observedAt: '2026-08-02T12:59:30.000Z',
      source: 'ANALYTICS_PIPELINE',
      sourceReference: 'analytics-batch-100',
      ...overrides,
    },
  };
}

test('agent derives a confidence-adjusted score and may prepare but never execute', async () => {
  const { service } = fixture();
  const result = await service.decide(request(), 'agent-key-0001');

  assert.equal(result.record.state, 'AWAITING_SIGNATURE');
  assert.equal(result.record.agentDecision.weightedScore, 92);
  assert.equal(result.record.agentDecision.confidenceAdjustedScore, 88);
  assert.equal(result.record.agentDecision.autonomy.mayPrepare, true);
  assert.equal(result.record.agentDecision.autonomy.mayExecute, false);
  assert.equal(result.record.agentDecision.operationalEvidence.arc.blockNumber, 55);
  assert.equal(result.record.reservation.status, 'ACTIVE');
});

test('agent fails closed on stale or high-risk evidence', async () => {
  const { service } = fixture();
  const result = await service.decide(request({
    fraudRisk: 40,
    observedAt: '2026-08-02T12:00:00.000Z',
  }), 'agent-key-0002');

  assert.equal(result.record.state, 'DENIED');
  assert.deepEqual(
    result.record.policy.reasons.map((reason) => reason.code),
    ['SIGNAL_STALE', 'FRAUD_RISK_TOO_HIGH'],
  );
  assert.equal(result.record.reservation, null);
});

test('agent daily payout cap is transactionally enforced', async () => {
  const { service, store } = fixture();
  await service.decide(request(), 'agent-key-0003');
  await service.decide({ ...request(), reference: 'AGENT-SIGNAL-002' }, 'agent-key-0004');
  const records = await store.list();
  assert.equal(records.length, 2);
  assert.equal(records.reduce((sum, record) => sum + BigInt(record.reservation.units), 0n), 30_000_000n);
  assert.deepEqual(records.map((record) => [Boolean(record.agentDecision), record.reservation.status]), [
    [true, 'ACTIVE'],
    [true, 'ACTIVE'],
  ]);
  await assert.rejects(
    service.decide({
      ...request(), requestedAmount: '1', reference: 'AGENT-SIGNAL-003',
    }, 'agent-key-0005'),
    { code: 'AGENT_DAILY_CAP_EXCEEDED', status: 409 },
  );
});
