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
      return executedResult({ market, settlementId: `settlement-${calls.length}` });
    },
  };
}

const silentLogger = { info() {}, error() {} };

/**
 * The real `AutonomousAgentService` success shape.
 *
 * Kept faithful on purpose: an earlier drift where the worker read `payout.amountUsdc` while the
 * service emitted `payout.creatorPayoutUsdc` survived precisely because the worker tests used an
 * invented shape. Mocks here mirror the service, so that class of bug fails the suite.
 */
function executedResult({ market, settlementId = 'settlement-1', creatorPayoutUsdc = '0.100000' }) {
  return {
    outcome: 'EXECUTED',
    marketAddress: market,
    creatorAddress: CREATOR,
    epoch: 1,
    payout: {
      creatorPayoutUsdc,
      creatorPayoutUnits: '100000',
      grossRequestUsdc: '0.166667',
      grossRequestUnits: '166667',
      treasuryRetainedUsdc: '0.066667',
      derivedUsdc: creatorPayoutUsdc,
      capReasons: [],
    },
    settlementId,
    executionMode: 'AUTONOMOUS_POLICY',
    circleTransactionId: 'circle-tx-1',
    transactionHash: `0x${'ab'.repeat(32)}`,
    state: 'COMPLETE',
  };
}

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
    // The canonical figure is what the creator received, never the Stage 1 gross request.
    assert.equal(summary.payouts[0].creatorPayoutUsdc, '0.100000');
    assert.equal(summary.payouts[0].grossRequestUsdc, '0.166667');
    assert.equal(summary.payouts[0].amountUsdc, undefined, 'the ambiguous field is gone');
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
        return executedResult({ market, settlementId: 'settlement-b' });
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
        return executedResult({ market, settlementId: 'settlement-slow' });
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
        return executedResult({ market, settlementId: `settlement-${workerId}` });
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
          return executedResult({ market, settlementId: 'x' });
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

test('the worker logs the creator payout, not the gross request', async () => {
  const context = await autonomyDatabase();
  try {
    await context.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const lines = [];
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: recordingService(),
      autonomyStore: context.store,
      collector: { async listRegisteredMarkets() { return [MARKET_A]; } },
      scheduler: manualScheduler(),
      logger: { info(line) { lines.push(JSON.parse(line)); }, error() {} },
    });

    await worker.tick();

    const payout = lines.find((entry) => entry.type === 'agent_worker_payout');
    assert.ok(payout, 'a payout must be logged');
    assert.equal(payout.creatorPayoutUsdc, '0.100000', 'the real amount that left the wallet');
    assert.equal(payout.grossRequestUsdc, '0.166667');
    // The old ambiguous field would previously have logged `undefined` here.
    assert.equal(payout.amountUsdc, undefined);
    assert.equal(payout.executionMode, 'AUTONOMOUS_POLICY');
  } finally {
    await context.close();
  }
});

/**
 * Sweep fairness.
 *
 * The per-tick bound is deliberate: a tick must not run for as long as the factory is large, and
 * ticks never overlap. What was wrong was always taking that bound from index zero — with more
 * registered markets than the bound, everything past it was starved permanently, because every
 * sweep re-read the same prefix. Correctness against double payment is the PostgreSQL epoch claim
 * and is unaffected either way; this is purely about every market eventually being looked at.
 */
function marketAddresses(count) {
  return Array.from(
    { length: count },
    (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
  );
}

test('one tick never evaluates more than the per-tick bound', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const markets = marketAddresses(60);
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return markets; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
      maxMarketsPerTick: 25,
    });

    const summary = await worker.tick();

    assert.equal(summary.evaluated, 25, 'the bound still holds');
    assert.equal(service.calls.length, 25);
    assert.equal(new Set(service.calls).size, 25, 'no market is evaluated twice in one tick');
    assert.deepEqual(service.calls, markets.slice(0, 25), 'the first sweep starts at the top');
  } finally {
    await fixture.close();
  }
});

test('markets beyond the first batch are eventually evaluated across ticks', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const markets = marketAddresses(60);
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return markets; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
      maxMarketsPerTick: 25,
    });

    // Before the fix, market 26 onwards could never be reached, no matter how long the worker ran.
    await worker.tick();
    assert.equal(service.calls.includes(markets[25]), false, 'not in the first batch');

    await worker.tick();
    assert.deepEqual(service.calls.slice(25), markets.slice(25, 50), 'the sweep continues');

    await worker.tick();
    assert.equal(
      new Set(service.calls).size,
      60,
      'three ticks of 25 cover all 60 registered markets',
    );
    for (const market of markets) {
      assert.ok(service.calls.includes(market), `${market} must eventually be evaluated`);
    }
  } finally {
    await fixture.close();
  }
});

test('the sweep cursor wraps around the end of the market list', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const markets = marketAddresses(7);
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return markets; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
      maxMarketsPerTick: 3,
    });

    await worker.tick();
    await worker.tick();
    await worker.tick();

    // 3 + 3 + 3 over a list of 7 must wrap: indices 0-2, 3-5, then 6,0,1.
    assert.deepEqual(service.calls, [
      markets[0], markets[1], markets[2],
      markets[3], markets[4], markets[5],
      markets[6], markets[0], markets[1],
    ]);
  } finally {
    await fixture.close();
  }
});

test('a bound larger than the market list evaluates each market exactly once', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const markets = marketAddresses(3);
    const service = recordingService();
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return markets; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
      maxMarketsPerTick: 25,
    });

    const summary = await worker.tick();
    assert.equal(summary.evaluated, 3);
    assert.equal(new Set(service.calls).size, 3, 'wrapping must not duplicate within a tick');

    // And an empty factory is not an error.
    const empty = new AutonomousAgentWorker({
      autonomousAgentService: recordingService(),
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return []; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
    });
    assert.equal((await empty.tick()).evaluated, 0);
  } finally {
    await fixture.close();
  }
});

test('a failing market inside a rotated batch still does not stop the sweep', async () => {
  const fixture = await autonomyDatabase();
  try {
    await fixture.store.setAutonomyPaused({ paused: false, changedBy: 'test' });
    const markets = marketAddresses(6);
    const service = recordingService({
      onEvaluate(market) {
        if (market === markets[4]) throw new DomainError('COLLECTOR_FAILED', 'boom');
        return executedResult({ market });
      },
    });
    const worker = new AutonomousAgentWorker({
      autonomousAgentService: service,
      autonomyStore: fixture.store,
      collector: { async listRegisteredMarkets() { return markets; } },
      scheduler: manualScheduler(),
      logger: silentLogger,
      maxMarketsPerTick: 3,
    });

    await worker.tick();
    const second = await worker.tick();

    assert.equal(second.evaluated, 3, 'the failure did not shorten the batch');
    assert.equal(second.failed, 1);
    assert.equal(second.outcomes.COLLECTOR_FAILED, 1);
    assert.ok(service.calls.includes(markets[5]), 'the market after the failure still ran');
  } finally {
    await fixture.close();
  }
});
