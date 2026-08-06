import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AutonomousAgentWorker } from '../domain/autonomous-agent-worker.js';
import { AUTONOMOUS_POLICY_VERSION } from '../domain/autonomous-agent-service.js';
import { DomainError } from '../domain/errors.js';
import { AgentAutonomyStore } from '../repositories/agent-autonomy-store.js';
import { schemaSql } from '../repositories/schema.js';

const MARKET_A = '0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE';
const MARKET_B = '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D';
const CREATOR = '0xBc5F97E60Ee9eeeDaC7BDb4F6eF7f29fDE3c1709';

/** Fires scheduled ticks on demand instead of on wall-clock time. */
function manualScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(handler) {
      const id = nextId;
      nextId += 1;
      timers.set(id, handler);
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    get pending() { return timers.size; },
    async fire() {
      const scheduled = [...timers.values()];
      timers.clear();
      for (const handler of scheduled) await handler();
      return scheduled.length;
    },
  };
}

async function autonomyDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-agent-worker-'));
  const database = new PGlite(directory);
  await database.exec(schemaSql);
  return {
    database,
    store: new AgentAutonomyStore({ database }),
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A service stand-in that records what the worker asked it to do. */
function recordingService({ onEvaluate } = {}) {
  const calls = [];
  return {
    calls,
    async evaluateMarket(market) {
      calls.push(market);
      if (onEvaluate) return onEvaluate(market, calls.length);
      return {
        outcome: 'EXECUTED',
        marketAddress: market,
        creatorAddress: CREATOR,
        epoch: 1,
        payout: { amountUsdc: '0.100000' },
        settlementId: `settlement-${calls.length}`,
        executionMode: 'AUTONOMOUS_POLICY',
        transactionHash: `0x${'ab'.repeat(32)}`,
      };
    },
  };
}

const silentLogger = { info() {}, error() {} };

test('a tick discovers registered markets and pays each eligible creator with no human step', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A, MARKET_B]; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });

    const summary = await worker.tick();

    assert.deepEqual(service.calls, [MARKET_A, MARKET_B], 'every registered market is evaluated');
    assert.equal(summary.evaluated, 2);
    assert.equal(summary.executed, 2);
    assert.equal(summary.denied, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.payouts.length, 2);
    assert.equal(summary.payouts[0].amountUsdc, '0.100000');
  } finally {
    await fixture.close();
  }
});

test('a paused switch stops the worker before any work is created', async () => {
  const fixture = await autonomyDatabase();
  try {
    // Never provisioned: the fail-safe default.
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A]; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });

    const paused = await worker.tick();
    assert.equal(paused.paused, true);
    assert.deepEqual(service.calls, [], 'a paused agent evaluates nothing at all');

    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'operator' });
    await worker.tick();
    assert.deepEqual(service.calls, [MARKET_A]);

    // Pausing again immediately stops further work.
    await fixture.store.setAutonomyPaused({ paused: true, reason: 'incident', changedBy: 'operator' });
    const stopped = await worker.tick();
    assert.equal(stopped.paused, true);
    assert.equal(service.calls.length, 1, 'no evaluation after the pause');
  } finally {
    await fixture.close();
  }
});

test('one failing market never starves the rest of the sweep', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const service = recordingService({
      onEvaluate(market) {
        if (market === MARKET_A) {
          throw new DomainError('ARC_ANCHOR_UNAVAILABLE', 'anchor unavailable', { status: 503 });
        }
        return {
          outcome: 'EXECUTED',
          marketAddress: market,
          creatorAddress: CREATOR,
          epoch: 1,
          payout: { amountUsdc: '0.100000' },
          settlementId: 'settlement-b',
          executionMode: 'AUTONOMOUS_POLICY',
          transactionHash: `0x${'cd'.repeat(32)}`,
        };
      },
    });
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A, MARKET_B]; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });

    const summary = await worker.tick();

    assert.equal(summary.failed, 1);
    assert.equal(summary.executed, 1, 'the healthy market was still paid');
    assert.equal(summary.outcomes.ARC_ANCHOR_UNAVAILABLE, 1);
    assert.deepEqual(service.calls, [MARKET_A, MARKET_B]);
  } finally {
    await fixture.close();
  }
});

test('a failure discovering markets ends the tick without touching any market', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: {
        async listRegisteredMarkets() { throw new Error('arc rpc unavailable'); },
      },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });

    const summary = await worker.tick();
    assert.equal(summary.discoveryFailed, true);
    assert.equal(summary.evaluated, 0);
    assert.deepEqual(service.calls, []);
  } finally {
    await fixture.close();
  }
});

test('ticks never overlap, so a slow sweep cannot evaluate a market twice', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const service = recordingService({
      async onEvaluate(market) {
        await held;
        return {
          outcome: 'EXECUTED',
          marketAddress: market,
          creatorAddress: CREATOR,
          epoch: 1,
          payout: { amountUsdc: '0.100000' },
          settlementId: 'settlement-slow',
          executionMode: 'AUTONOMOUS_POLICY',
          transactionHash: null,
        };
      },
    });
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A]; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });

    const slow = worker.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const overlapping = await worker.tick();

    assert.equal(overlapping.skipped, 'TICK_IN_PROGRESS');
    release();
    await slow;
    assert.equal(service.calls.length, 1, 'the market was evaluated exactly once');
  } finally {
    await fixture.close();
  }
});

test('ten concurrent workers on one epoch produce exactly one payout', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });

    // Each worker runs the real durable epoch claim; only the winner may pay.
    const payouts = [];
    const makeService = (workerId) => ({
      async evaluateMarket(market) {
        const claim = await fixture.store.claimPayoutEpoch({
          marketAddress: market,
          policyVersion: AUTONOMOUS_POLICY_VERSION,
          epoch: 900,
          evidenceDigest: `0x${'11'.repeat(32)}`,
          creatorAddress: CREATOR,
          claimedBy: workerId,
        });
        if (claim.outcome === 'ALREADY_CLAIMED') {
          return { outcome: 'MARKET_IN_COOLDOWN', marketAddress: market, reasons: [] };
        }
        payouts.push(workerId);
        await fixture.store.resolvePayoutEpoch({
          marketAddress: market,
          policyVersion: AUTONOMOUS_POLICY_VERSION,
          epoch: 900,
          settlementId: `settlement-${workerId}`,
          amountUnits: 100_000n,
          outcome: 'EXECUTED',
        });
        return {
          outcome: 'EXECUTED',
          marketAddress: market,
          creatorAddress: CREATOR,
          epoch: 900,
          payout: { amountUsdc: '0.100000' },
          settlementId: `settlement-${workerId}`,
          executionMode: 'AUTONOMOUS_POLICY',
          transactionHash: null,
        };
      },
    });

    const workers = Array.from({ length: 10 }, (_, index) => new AutonomousAgentWorker({
      autonomousAgentService: makeService(`worker-${index}`),
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A]; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    }));

    const summaries = await Promise.all(workers.map((worker) => worker.tick()));

    assert.equal(payouts.length, 1, 'exactly one worker paid');
    assert.equal(summaries.filter((summary) => summary.executed === 1).length, 1);
    assert.equal(summaries.filter((summary) => summary.outcomes.MARKET_IN_COOLDOWN === 1).length, 9);

    const spent = await fixture.store.spentTodayUnits({
      marketAddress: MARKET_A, sinceIso: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(spent.marketUnits, 100_000n, 'only one payout consumed cap');
  } finally {
    await fixture.close();
  }
});

test('a restarted worker resumes without re-paying an already settled epoch', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });

    // A previous process already settled this epoch and then died.
    await fixture.store.claimPayoutEpoch({
      marketAddress: MARKET_A,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 42,
      evidenceDigest: `0x${'11'.repeat(32)}`,
      creatorAddress: CREATOR,
      claimedBy: 'worker-before-crash',
    });
    await fixture.store.resolvePayoutEpoch({
      marketAddress: MARKET_A,
      policyVersion: AUTONOMOUS_POLICY_VERSION,
      epoch: 42,
      settlementId: 'settlement-before-crash',
      amountUnits: 100_000n,
      outcome: 'EXECUTED',
    });

    const paid = [];
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: {
        async evaluateMarket(market) {
          const claim = await fixture.store.claimPayoutEpoch({
            marketAddress: market,
            policyVersion: AUTONOMOUS_POLICY_VERSION,
            epoch: 42,
            evidenceDigest: `0x${'11'.repeat(32)}`,
            creatorAddress: CREATOR,
            claimedBy: 'worker-after-restart',
          });
          if (claim.outcome === 'ALREADY_CLAIMED') {
            return { outcome: 'MARKET_IN_COOLDOWN', marketAddress: market, reasons: [] };
          }
          paid.push(market);
          return { outcome: 'EXECUTED', marketAddress: market, creatorAddress: CREATOR, epoch: 42, payout: { amountUsdc: '0.1' }, settlementId: 'x', executionMode: 'AUTONOMOUS_POLICY', transactionHash: null };
        },
      },
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A]; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });

    const summary = await worker.tick();

    assert.deepEqual(paid, [], 'a restart never re-pays a settled epoch');
    assert.equal(summary.outcomes.MARKET_IN_COOLDOWN, 1);
    const existing = await fixture.store.getPayoutEpoch({
      marketAddress: MARKET_A, policyVersion: AUTONOMOUS_POLICY_VERSION, epoch: 42,
    });
    assert.equal(existing.settlementId, 'settlement-before-crash', 'the original settlement stands');
    assert.equal(existing.claimedBy, 'worker-before-crash');
  } finally {
    await fixture.close();
  }
});

test('start and stop drive scheduled sweeps and drain cleanly', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const scheduler = manualScheduler();
    const service = recordingService({
      onEvaluate: (market) => ({
        outcome: 'MARKET_IN_COOLDOWN', marketAddress: market, reasons: [],
      }),
    });
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A]; } },
      scheduler,
      logger: silentLogger,
    });

    worker.start();
    assert.equal(scheduler.pending, 1, 'a sweep is scheduled');
    await scheduler.fire();
    assert.equal(service.calls.length, 1);
    assert.equal(scheduler.pending, 1, 'the next sweep is rescheduled');

    await worker.stop();
    assert.equal(scheduler.pending, 0, 'stopping cancels the pending sweep');
    await scheduler.fire();
    assert.equal(service.calls.length, 1, 'no sweep runs after stop');
  } finally {
    await fixture.close();
  }
});

test('a tick never evaluates more markets than its per-tick bound', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const service = recordingService({
      onEvaluate: (market) => ({ outcome: 'MARKET_IN_COOLDOWN', marketAddress: market, reasons: [] }),
    });
    const many = Array.from({ length: 50 }, (_, index) => `0x${String(index).padStart(40, '0')}`);
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return many; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
      maxMarketsPerTick: 5,
    });

    const summary = await worker.tick();
    assert.equal(summary.evaluated, 5, 'a large registry cannot make one tick unbounded');
    assert.equal(service.calls.length, 5);
  } finally {
    await fixture.close();
  }
});
