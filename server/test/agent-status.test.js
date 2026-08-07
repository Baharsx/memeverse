import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AUTONOMOUS_POLICY_VERSION, AutonomousAgentService } from '../domain/autonomous-agent-service.js';
import { createPayoutPolicy } from '../domain/agent-payout.js';
import { AgentAutonomyStore } from '../repositories/agent-autonomy-store.js';
import { schemaSql } from '../repositories/schema.js';

/**
 * The public, unauthenticated agent status endpoint.
 *
 * Stage 3 makes this the primary judging surface, so it now carries the day's budget, the last
 * evaluation time, and the settlement contract alongside the existing decision trail. Everything
 * added is either a policy constant, a public Arc address, or a figure already derivable from
 * onchain data — and these tests assert the boundary directly rather than trusting the shape.
 */

const MARKET = '0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE';
const CREATOR = '0xBc5F97E60Ee9eeeDaC7BDb4F6eF7f29fDE3c1709';
const AGENT_WALLET = '0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3';
const AGENT_CONTRACT = '0x2176107C2562Ed30ca1d490C43cD53C3369946e2';

const payoutPolicy = createPayoutPolicy({
  maxPayoutUsdc: '0.100000',
  minPayoutUsdc: '0.010000',
  marketDailyCapUsdc: '0.300000',
  dailySpendUsdc: '1.000000',
  scoreFloor: 70,
});

async function statusFixture({ settlementStore, circleGateway } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-agent-status-'));
  const database = new PGlite(directory);
  await database.exec(schemaSql);
  const autonomyStore = new AgentAutonomyStore({ database });
  const service = new AutonomousAgentService({
    autonomyStore,
    payoutPolicy,
    agentPolicy: { minConfidence: 80, maxFraudRisk: 20, signalMaxAgeSeconds: 300 },
    settlementService: settlementStore ? { store: settlementStore } : undefined,
    circleGateway,
    settlementContractAddress: AGENT_CONTRACT,
    cooldownSeconds: 3600,
    decisionTtlSeconds: 300,
    creatorShareBps: 6000,
    workerId: 'test-worker:1',
  });
  return {
    service,
    autonomyStore,
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('an agent that has never run reports absence, not a plausible-looking default', async () => {
  const fixture = await statusFixture();
  try {
    const status = await fixture.service.status();

    assert.equal(status.paused, true, 'unprovisioned autonomy fails safe to paused');
    assert.equal(status.lastEvaluationAt, null, 'never evaluated must read as never');
    assert.deepEqual(status.recentEpochs, []);
    assert.equal(status.settlementContract, AGENT_CONTRACT);
    assert.equal(status.policyVersion, AUTONOMOUS_POLICY_VERSION);
    // The whole daily budget is genuinely available, and says so from the real ledger.
    assert.equal(status.budget.available, true);
    assert.equal(status.budget.capUsdc, '1');
    assert.equal(status.budget.usedUsdc, '0');
    assert.equal(status.budget.remainingUsdc, '1');
  } finally {
    await fixture.close();
  }
});

test('the reported budget is the same ledger the spend gate admits against', async () => {
  const fixture = await statusFixture();
  try {
    const reserved = await fixture.autonomyStore.reserveDailySpend({
      marketAddress: MARKET,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 496114,
      requestedUnits: 100_000n,
      policy: payoutPolicy,
    });
    assert.equal(reserved.outcome, 'RESERVED');

    const held = await fixture.service.status();
    // A reservation is not yet spent, but it is not available either. Reporting it as free is
    // exactly how a status page would talk an operator into overspending.
    assert.equal(held.budget.usedUsdc, '0.1');
    assert.equal(held.budget.reservedUsdc, '0.1');
    assert.equal(held.budget.settledUsdc, '0');
    assert.equal(held.budget.remainingUsdc, '0.9');

    await fixture.autonomyStore.consumeDailySpend({
      reservationId: reserved.reservationId, settlementId: 'settlement-1',
    });
    const settled = await fixture.service.status();
    assert.equal(settled.budget.usedUsdc, '0.1', 'consumption does not double-count');
    assert.equal(settled.budget.reservedUsdc, '0');
    assert.equal(settled.budget.settledUsdc, '0.1');
    assert.equal(settled.budget.remainingUsdc, '0.9');

    await fixture.autonomyStore.releaseDailySpend({ reservationId: reserved.reservationId });
    const afterRelease = await fixture.service.status();
    assert.equal(
      afterRelease.budget.settledUsdc, '0.1',
      'a consumed reservation is not releasable, so the report does not move',
    );
  } finally {
    await fixture.close();
  }
});

test('a released reservation returns its capacity to the reported budget', async () => {
  const fixture = await statusFixture();
  try {
    const reserved = await fixture.autonomyStore.reserveDailySpend({
      marketAddress: MARKET,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 496115,
      requestedUnits: 100_000n,
      policy: payoutPolicy,
    });
    await fixture.autonomyStore.releaseDailySpend({ reservationId: reserved.reservationId });

    const status = await fixture.service.status();
    assert.equal(status.budget.usedUsdc, '0');
    assert.equal(status.budget.remainingUsdc, '1');
  } finally {
    await fixture.close();
  }
});

test('a budget the ledger cannot answer reads as unavailable, never as empty', async () => {
  const fixture = await statusFixture();
  try {
    fixture.service.autonomyStore = {
      autonomyState: () => fixture.autonomyStore.autonomyState(),
      listRecentEpochs: () => fixture.autonomyStore.listRecentEpochs(10),
      dailySpendState() { throw new Error('database unreachable'); },
    };
    const status = await fixture.service.status();

    assert.equal(status.budget.available, false);
    assert.equal(status.budget.capUsdc, '1', 'the configured cap is still a known constant');
    assert.equal(status.budget.remainingUsdc, undefined, 'no remaining figure is invented');
  } finally {
    await fixture.close();
  }
});

test('the last evaluation time comes from a real claim and nothing else', async () => {
  const fixture = await statusFixture();
  try {
    await fixture.autonomyStore.claimPayoutEpoch({
      marketAddress: MARKET,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 496114,
      evidenceDigest: `0x${'11'.repeat(32)}`,
      creatorAddress: CREATOR,
      claimedBy: 'test-worker:1',
    });

    const status = await fixture.service.status();
    assert.ok(status.lastEvaluationAt, 'a claimed epoch is an evaluation');
    assert.equal(status.lastEvaluationAt, status.recentEpochs[0].claimedAt);
    assert.ok(Number.isFinite(Date.parse(status.lastEvaluationAt)));
  } finally {
    await fixture.close();
  }
});

test('a resolved payout is joined to its evidence without leaking provider identity', async () => {
  const settlement = {
    id: 'settlement-1',
    state: 'COMPLETE',
    reference: 'AUTONOMOUS UCAT EPOCH 496114',
    amount: { creatorPayoutUsdc: '0.100000', treasuryRetainedUsdc: '0.066667' },
    transactionHash: `0x${'ab'.repeat(32)}`,
    executionSubmission: { executionMode: 'AUTONOMOUS_POLICY' },
    executionAuthorization: { mode: 'AUTONOMOUS_POLICY' },
    circle: {
      state: 'COMPLETE',
      sourceAddress: AGENT_WALLET,
      // Deliberately present in the stored record and deliberately absent from the response.
      transactionId: '39510412-8eba-5c8d-896e-40bd8c0d74cc',
      walletId: '162cd0e8-b814-5cf7-87d1-dc429a8f4539',
    },
    agentDecision: {
      confidenceAdjustedScore: 100,
      signals: {
        engagementVelocity: 100,
        holderRetention: 100,
        liquidityDepth: 100,
        confidence: 100,
        fraudRisk: 0,
      },
      evidence: { provenance: 'ONCHAIN_INDEXER', fromBlock: 55585878, toBlock: 55586500 },
    },
    policy: { approved: true, reasons: [] },
    reconciliation: { status: 'VERIFIED', route: 'DIRECT', settlementContract: AGENT_CONTRACT },
  };
  const fixture = await statusFixture({
    settlementStore: { async get() { return settlement; } },
  });
  try {
    await fixture.autonomyStore.claimPayoutEpoch({
      marketAddress: MARKET,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 496114,
      evidenceDigest: `0x${'11'.repeat(32)}`,
      creatorAddress: CREATOR,
      claimedBy: 'test-worker:1',
    });
    await fixture.autonomyStore.resolvePayoutEpoch({
      marketAddress: MARKET,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 496114,
      settlementId: 'settlement-1',
      amountUnits: 100_000n,
      outcome: 'EXECUTED',
    });

    const status = await fixture.service.status();
    const [entry] = status.recentEpochs;

    assert.equal(entry.outcome, 'EXECUTED');
    assert.equal(entry.creatorPayoutUsdc, '0.100000');
    assert.equal(entry.executionMode, 'AUTONOMOUS_POLICY');
    assert.equal(entry.humanAuthorization, false, 'no operator and no session means no human');
    assert.equal(entry.reference, 'AUTONOMOUS UCAT EPOCH 496114');
    assert.equal(entry.policyVersion, AUTONOMOUS_POLICY_VERSION);
    assert.equal(entry.executedBy, AGENT_WALLET, 'the onchain executor is public');
    assert.equal(entry.reconciliation.status, 'VERIFIED');

    // Nothing that identifies the Circle account, wallet, or worker may cross this boundary.
    const serialized = JSON.stringify(status);
    for (const secret of [
      '39510412-8eba-5c8d-896e-40bd8c0d74cc',
      '162cd0e8-b814-5cf7-87d1-dc429a8f4539',
      'test-worker:1',
      'walletId',
      'transactionId',
      'apiKey',
      'entitySecret',
    ]) {
      assert.equal(
        serialized.includes(secret),
        false,
        `the public status must not carry ${secret}`,
      );
    }
  } finally {
    await fixture.close();
  }
});

test('an executor the gateway cannot describe is reported unconfigured, not assumed live', async () => {
  const fixture = await statusFixture({
    circleGateway: { async readiness() { throw new Error('circle CLI missing'); } },
  });
  try {
    const status = await fixture.service.status();
    assert.equal(status.executor.configured, false);
    assert.equal(status.executor.state, 'UNAVAILABLE');
    assert.equal(status.executor.address, undefined, 'no wallet address is invented');
  } finally {
    await fixture.close();
  }
});
