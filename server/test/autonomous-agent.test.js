import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { calculateSignalMetrics, evidenceDigest } from '../domain/agent-signal-metrics.js';
import {
  applySpendCaps, createPayoutPolicy, derivePayoutUnits, grossForCreatorPayout, payoutEpoch,
} from '../domain/agent-payout.js';
import { applyBasisPoints } from '../domain/money.js';
import {
  assertAutonomousAuthorityFresh, isAutonomousAuthority, mintAutonomousAuthority,
} from '../domain/autonomous-authority.js';
import { AgentAutonomyStore, requireAutonomyActive } from '../repositories/agent-autonomy-store.js';
import { schemaSql } from '../repositories/schema.js';

const MARKET = '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D';
const CREATOR = '0x6bbD385C0f51D273a1685C977fAfa179F9eEb689';

function trade(trader, usdcUnits, tokens, blockNumber = 100n) {
  return { trader, usdcUnits, tokens, blockNumber };
}

/** A healthy, well-traded market observation that comfortably clears every threshold. */
function healthyObservation(overrides = {}) {
  return {
    buys: [
      trade('0xaaaa000000000000000000000000000000000001', 2_000_000n, 5n * 10n ** 18n),
      trade('0xaaaa000000000000000000000000000000000002', 2_000_000n, 5n * 10n ** 18n),
      trade('0xaaaa000000000000000000000000000000000003', 1_500_000n, 4n * 10n ** 18n),
      trade('0xaaaa000000000000000000000000000000000004', 1_500_000n, 4n * 10n ** 18n),
    ],
    sells: [],
    reserveUsdcUnits: 6_000_000n,
    marketCreatedBlock: 1_000n,
    fromBlock: 2_000n,
    toBlock: 10_000n,
    headBlock: 10_012n,
    minConfirmations: 12,
    logsComplete: true,
    ...overrides,
  };
}

async function autonomyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-autonomy-'));
  const database = new PGlite(directory);
  await database.exec(schemaSql);
  const store = new AgentAutonomyStore({ database });
  return {
    database,
    store,
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal metrics
// ─────────────────────────────────────────────────────────────────────────────

test('metrics are deterministic and bounded for a healthy market', async () => {
  const first = calculateSignalMetrics(healthyObservation());
  const second = calculateSignalMetrics(healthyObservation());

  assert.deepEqual(first.signals, second.signals, 'identical evidence yields identical signals');
  for (const [name, value] of Object.entries(first.signals)) {
    assert.ok(Number.isInteger(value), `${name} must be an integer`);
    assert.ok(value >= 0 && value <= 100, `${name} must be within 0..100, got ${value}`);
  }
  assert.equal(first.signals.holderRetention, 100, 'nothing was sold back');
  assert.equal(first.signals.confidence, 100);
  assert.equal(first.signals.fraudRisk, 0);
  assert.ok(first.signals.engagementVelocity > 0);
  assert.ok(first.signals.liquidityDepth > 0);
});

test('confidence collapses to its weakest input rather than averaging it away', async () => {
  // Strong on every axis except sample size: one trade only.
  const thin = calculateSignalMetrics(healthyObservation({
    buys: [trade('0xaaaa000000000000000000000000000000000001', 9_000_000n, 20n * 10n ** 18n)],
  }));
  assert.equal(thin.components.historyScore, 100);
  assert.equal(thin.components.confirmationScore, 100);
  assert.equal(thin.signals.confidence, 25, 'one of four required samples');

  const unconfirmed = calculateSignalMetrics(healthyObservation({ headBlock: 10_003n }));
  assert.equal(unconfirmed.signals.confidence, 25, 'three of twelve confirmations');

  const young = calculateSignalMetrics(healthyObservation({ marketCreatedBlock: 9_900n }));
  assert.equal(young.signals.confidence, 20, '100 of 500 required age blocks');
});

test('incomplete log history destroys confidence and raises risk', async () => {
  const metrics = calculateSignalMetrics(healthyObservation({ logsComplete: false }));
  assert.equal(metrics.signals.confidence, 0);
  assert.ok(metrics.signals.fraudRisk >= 50);
  assert.ok(metrics.riskReasons.includes('INCOMPLETE_EVENT_HISTORY'));
});

test('risk heuristics fire on young, thin, concentrated, and churning markets', async () => {
  const silent = calculateSignalMetrics(healthyObservation({ buys: [], sells: [] }));
  assert.ok(silent.riskReasons.includes('NO_CONFIRMED_TRADES'));
  assert.ok(silent.riskReasons.includes('TOO_FEW_INDEPENDENT_TRADERS'));
  assert.equal(silent.signals.holderRetention, 0);

  const young = calculateSignalMetrics(healthyObservation({ marketCreatedBlock: 9_900n }));
  assert.ok(young.riskReasons.includes('MARKET_TOO_YOUNG'));

  const oneTrader = calculateSignalMetrics(healthyObservation({
    buys: [
      trade('0xaaaa000000000000000000000000000000000001', 4_000_000n, 10n * 10n ** 18n),
      trade('0xaaaa000000000000000000000000000000000001', 4_000_000n, 10n * 10n ** 18n),
    ],
  }));
  assert.ok(oneTrader.riskReasons.includes('TOO_FEW_INDEPENDENT_TRADERS'));
  assert.ok(oneTrader.riskReasons.includes('DOMINANT_TRADER_CONCENTRATION'));

  const churn = calculateSignalMetrics(healthyObservation({
    sells: [
      trade('0xaaaa000000000000000000000000000000000001', 2_000_000n, 9n * 10n ** 18n),
      trade('0xaaaa000000000000000000000000000000000002', 2_000_000n, 8n * 10n ** 18n),
    ],
  }));
  assert.ok(churn.riskReasons.includes('HIGH_BUY_SELL_CHURN'));
  assert.ok(churn.signals.holderRetention < 20);

  // Every score stays clamped even when several penalties stack.
  const everything = calculateSignalMetrics({
    ...healthyObservation({ buys: [], sells: [], marketCreatedBlock: 9_999n, logsComplete: false }),
  });
  assert.equal(everything.signals.fraudRisk, 100);
});

test('the evidence digest changes whenever any input changes', async () => {
  const base = {
    chainId: 5042002,
    factoryAddress: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
    marketAddress: MARKET,
    creatorAddress: CREATOR,
    metrics: calculateSignalMetrics(healthyObservation()),
    blockHash: `0x${'ab'.repeat(32)}`,
    policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1',
  };
  const digest = evidenceDigest(base);

  assert.equal(evidenceDigest(base), digest, 'the digest is stable for identical evidence');
  assert.notEqual(evidenceDigest({ ...base, blockHash: `0x${'cd'.repeat(32)}` }), digest);
  assert.notEqual(evidenceDigest({ ...base, creatorAddress: MARKET }), digest);
  assert.notEqual(
    evidenceDigest({ ...base, metrics: calculateSignalMetrics(healthyObservation({ reserveUsdcUnits: 1n })) }),
    digest,
  );
  // Address casing must not change identity; the digest lowercases addresses.
  assert.equal(evidenceDigest({ ...base, marketAddress: MARKET.toLowerCase() }), digest);
});

// ─────────────────────────────────────────────────────────────────────────────
// Payout derivation
// ─────────────────────────────────────────────────────────────────────────────

const payoutPolicy = createPayoutPolicy({
  maxPayoutUsdc: '0.100000',
  minPayoutUsdc: '0.010000',
  marketDailyCapUsdc: '0.300000',
  dailySpendUsdc: '1.000000',
  scoreFloor: 70,
});

test('the payout curve is exact at both ends and monotonic between them', async () => {
  assert.equal(derivePayoutUnits(69, payoutPolicy), 0n, 'below the floor pays nothing');
  assert.equal(derivePayoutUnits(70, payoutPolicy), 10_000n, 'the floor pays exactly the minimum');
  assert.equal(derivePayoutUnits(100, payoutPolicy), 100_000n, 'a perfect score pays exactly the maximum');
  assert.equal(derivePayoutUnits(85, payoutPolicy), 55_000n, 'halfway pays halfway');

  let previous = 0n;
  for (let score = 70; score <= 100; score += 1) {
    const payout = derivePayoutUnits(score, payoutPolicy);
    assert.ok(payout >= previous, `payout must not decrease at score ${score}`);
    assert.ok(payout <= payoutPolicy.maxUnits, `payout must never exceed the cap at score ${score}`);
    assert.equal(typeof payout, 'bigint', 'payouts are integer atomic units');
    previous = payout;
  }
  // A score above 100 cannot buy more than the cap.
  assert.equal(derivePayoutUnits(1_000, payoutPolicy), 100_000n);
});

test('caps clamp in widening order and refuse a sub-minimum remainder', async () => {
  const full = applySpendCaps(100_000n, payoutPolicy);
  assert.equal(full.approved, true);
  assert.equal(full.amountUnits, 100_000n);

  // Exactly at the market daily cap boundary.
  const atCap = applySpendCaps(100_000n, payoutPolicy, { marketSpentTodayUnits: 200_000n });
  assert.equal(atCap.amountUnits, 100_000n);
  assert.equal(atCap.approved, true);

  // One unit beyond it.
  const overCap = applySpendCaps(100_000n, payoutPolicy, { marketSpentTodayUnits: 200_001n });
  assert.equal(overCap.amountUnits, 99_999n);
  assert.ok(overCap.reasons.some((reason) => reason.code === 'CAPPED_BY_MARKET_DAILY_CAP'));

  // Global cap binds even when the market has room.
  const globalBound = applySpendCaps(100_000n, payoutPolicy, { globalSpentTodayUnits: 960_000n });
  assert.equal(globalBound.amountUnits, 40_000n);
  assert.ok(globalBound.reasons.some((reason) => reason.code === 'CAPPED_BY_GLOBAL_DAILY_CAP'));

  // A remainder below the minimum is refused outright rather than paid as dust.
  const dust = applySpendCaps(100_000n, payoutPolicy, { globalSpentTodayUnits: 999_995n });
  assert.equal(dust.approved, false);
  assert.equal(dust.amountUnits, 0n);
  assert.ok(dust.reasons.some((reason) => reason.code === 'PAYOUT_BELOW_MINIMUM'));

  // A fully exhausted day pays nothing at all.
  const exhausted = applySpendCaps(100_000n, payoutPolicy, { globalSpentTodayUnits: 1_000_000n });
  assert.equal(exhausted.approved, false);
  assert.equal(exhausted.amountUnits, 0n);
});

test('unsafe payout configuration is rejected at construction', async () => {
  const base = {
    maxPayoutUsdc: '0.100000',
    minPayoutUsdc: '0.010000',
    marketDailyCapUsdc: '0.300000',
    dailySpendUsdc: '1.000000',
    scoreFloor: 70,
  };
  assert.throws(() => createPayoutPolicy({ ...base, maxPayoutUsdc: '0.005000' }), /at least the minimum/);
  assert.throws(() => createPayoutPolicy({ ...base, marketDailyCapUsdc: '0.050000' }), /at least the per-execution maximum/);
  assert.throws(() => createPayoutPolicy({ ...base, dailySpendUsdc: '0.050000' }), /at least the per-execution maximum/);
  assert.throws(() => createPayoutPolicy({ ...base, scoreFloor: 100 }), /0\.\.99/);
});

test('payout epochs are stable within a window and advance across it', async () => {
  assert.equal(payoutEpoch(3_600, 3_600), 1);
  assert.equal(payoutEpoch(7_199, 3_600), 1, 'the whole window is one epoch');
  assert.equal(payoutEpoch(7_200, 3_600), 2);
  assert.throws(() => payoutEpoch(1, 0), /must be positive/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Autonomous authority
// ─────────────────────────────────────────────────────────────────────────────

function mint(overrides = {}) {
  return mintAutonomousAuthority({
    settlementId: 'settlement-1',
    marketAddress: MARKET,
    creatorAddress: CREATOR,
    evidenceDigest: `0x${'11'.repeat(32)}`,
    policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1',
    metricVersion: 'AGENT_SIGNAL_METRICS_V1',
    epoch: 7,
    decidedAt: '2026-08-06T10:00:00.000Z',
    expiresAt: '2026-08-06T10:05:00.000Z',
    amountUnits: 55_000n,
    ...overrides,
  });
}

test('only a minted authority carries the brand, and its reference is deterministic', async () => {
  const authority = mint();
  assert.equal(isAutonomousAuthority(authority), true);
  assert.equal(authority.mode, 'AUTONOMOUS_POLICY');
  assert.equal(authority.operatorAddress, null, 'no human approved this');
  assert.equal(authority.sessionId, null);
  assert.equal(mint().authorizationRef, authority.authorizationRef, 'deterministic reference');
  assert.notEqual(mint({ epoch: 8 }).authorizationRef, authority.authorizationRef);
  assert.notEqual(mint({ creatorAddress: MARKET }).authorizationRef, authority.authorizationRef);

  // The brand does not survive serialisation, which is the whole point.
  assert.equal(isAutonomousAuthority(JSON.parse(JSON.stringify(authority))), false);
  assert.equal(isAutonomousAuthority({ ...authority }), false, 'a spread copy loses the brand');
  assert.equal(isAutonomousAuthority({ mode: 'AUTONOMOUS_POLICY' }), false);
  assert.equal(isAutonomousAuthority(null), false);
  // The serialised form carries no secret to steal.
  const serialised = JSON.stringify(authority);
  for (const forbidden of ['secret', 'apiKey', 'entitySecret', 'token', 'privateKey']) {
    assert.equal(serialised.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
});

test('an incomplete authority cannot be minted and a stale one cannot be used', async () => {
  assert.throws(() => mint({ evidenceDigest: null }), { code: 'AUTONOMOUS_AUTHORITY_INCOMPLETE' });
  assert.throws(() => mint({ creatorAddress: null }), { code: 'AUTONOMOUS_AUTHORITY_INCOMPLETE' });

  const authority = mint();
  assert.doesNotThrow(() => assertAutonomousAuthorityFresh(
    authority, new Date('2026-08-06T10:04:59.000Z'),
  ));
  assert.throws(
    () => assertAutonomousAuthorityFresh(authority, new Date('2026-08-06T10:05:01.000Z')),
    { code: 'AUTONOMOUS_DECISION_EXPIRED' },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Durable pause switch and epoch claims
// ─────────────────────────────────────────────────────────────────────────────

test('autonomy defaults to paused until it is deliberately provisioned', async () => {
  const fixture = await autonomyFixture();
  try {
    const initial = await fixture.store.autonomyState();
    assert.equal(initial.paused, true, 'an unprovisioned control must fail safe');
    assert.equal(initial.reason, 'AUTONOMY_NOT_PROVISIONED');
    assert.throws(() => requireAutonomyActive(initial), { code: 'AUTONOMY_PAUSED' });

    const resumed = await fixture.store.setAutonomyPaused({
      paused: false, reason: 'testnet demo', changedBy: 'operator-1',
    });
    assert.equal(resumed.paused, false);
    assert.doesNotThrow(() => requireAutonomyActive(resumed));

    const paused = await fixture.store.setAutonomyPaused({
      paused: true, reason: 'incident', changedBy: 'operator-2',
    });
    assert.equal(paused.paused, true);
    assert.equal(paused.reason, 'incident');
    assert.equal(paused.changedBy, 'operator-2');
    assert.throws(() => requireAutonomyActive(paused), { code: 'AUTONOMY_PAUSED' });
  } finally {
    await fixture.close();
  }
});

test('PostgreSQL admits exactly one worker per market payout epoch', async () => {
  const fixture = await autonomyFixture();
  try {
    const contenders = Array.from({ length: 12 }, (_, index) => fixture.store.claimPayoutEpoch({
      marketAddress: MARKET,
      policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1',
      epoch: 42,
      evidenceDigest: `0x${'11'.repeat(32)}`,
      creatorAddress: CREATOR,
      claimedBy: `worker-${index}`,
    }));
    const results = await Promise.all(contenders);
    const winners = results.filter((result) => result.outcome === 'CLAIMED');
    const losers = results.filter((result) => result.outcome === 'ALREADY_CLAIMED');

    assert.equal(winners.length, 1, 'exactly one worker may own an epoch');
    assert.equal(losers.length, 11);
    for (const loser of losers) assert.ok(loser.existing.claimedBy.startsWith('worker-'));

    // A different epoch is a separate claim; the same one is never re-claimable.
    assert.equal((await fixture.store.claimPayoutEpoch({
      marketAddress: MARKET, policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1', epoch: 43,
      evidenceDigest: `0x${'22'.repeat(32)}`, creatorAddress: CREATOR, claimedBy: 'worker-late',
    })).outcome, 'CLAIMED');
    assert.equal((await fixture.store.claimPayoutEpoch({
      marketAddress: MARKET, policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1', epoch: 42,
      evidenceDigest: `0x${'33'.repeat(32)}`, creatorAddress: CREATOR, claimedBy: 'worker-retry',
    })).outcome, 'ALREADY_CLAIMED');
  } finally {
    await fixture.close();
  }
});

test('only settled epochs consume daily cap, and a failed one gives it back', async () => {
  const fixture = await autonomyFixture();
  try {
    const since = '2026-08-06T00:00:00.000Z';
    const other = '0x1111111111111111111111111111111111111111';

    const claim = async (epoch, marketAddress = MARKET) => fixture.store.claimPayoutEpoch({
      marketAddress, policyVersion: 'V1', epoch, evidenceDigest: `0x${'11'.repeat(32)}`,
      creatorAddress: CREATOR, claimedBy: 'worker-1',
    });

    // A claimed but unresolved epoch has committed nothing yet.
    await claim(1);
    let spent = await fixture.store.spentTodayUnits({ marketAddress: MARKET, sinceIso: since });
    assert.equal(spent.marketUnits, 0n);
    assert.equal(spent.globalUnits, 0n);

    await fixture.store.resolvePayoutEpoch({
      marketAddress: MARKET, policyVersion: 'V1', epoch: 1,
      settlementId: 'settlement-1', amountUnits: 60_000n, outcome: 'EXECUTED',
    });
    spent = await fixture.store.spentTodayUnits({ marketAddress: MARKET, sinceIso: since });
    assert.equal(spent.marketUnits, 60_000n);
    assert.equal(spent.globalUnits, 60_000n);

    // Another market contributes to the global total but not this market's.
    await claim(1, other);
    await fixture.store.resolvePayoutEpoch({
      marketAddress: other, policyVersion: 'V1', epoch: 1,
      settlementId: 'settlement-2', amountUnits: 25_000n, outcome: 'EXECUTED',
    });
    spent = await fixture.store.spentTodayUnits({ marketAddress: MARKET, sinceIso: since });
    assert.equal(spent.marketUnits, 60_000n);
    assert.equal(spent.globalUnits, 85_000n);

    // A failed epoch never committed treasury, so it must not consume cap.
    await claim(2);
    await fixture.store.resolvePayoutEpoch({
      marketAddress: MARKET, policyVersion: 'V1', epoch: 2,
      settlementId: 'settlement-3', amountUnits: 90_000n, outcome: 'FAILED',
    });
    spent = await fixture.store.spentTodayUnits({ marketAddress: MARKET, sinceIso: since });
    assert.equal(spent.marketUnits, 60_000n, 'a failed payout releases its cap');
    assert.equal(spent.globalUnits, 85_000n);
  } finally {
    await fixture.close();
  }
});

test('collector checkpoints only ever advance', async () => {
  const fixture = await autonomyFixture();
  try {
    assert.equal(await fixture.store.getCheckpoint(MARKET), undefined);

    await fixture.store.saveCheckpoint({
      marketAddress: MARKET, lastScannedBlock: 1_000n, lastBlockHash: `0x${'aa'.repeat(32)}`,
    });
    assert.equal((await fixture.store.getCheckpoint(MARKET)).lastScannedBlock, 1_000n);

    await fixture.store.saveCheckpoint({
      marketAddress: MARKET, lastScannedBlock: 2_000n, lastBlockHash: `0x${'bb'.repeat(32)}`,
    });
    assert.equal((await fixture.store.getCheckpoint(MARKET)).lastScannedBlock, 2_000n);

    // A stale worker writing an older cursor must not rewind the scan.
    await fixture.store.saveCheckpoint({
      marketAddress: MARKET, lastScannedBlock: 500n, lastBlockHash: `0x${'cc'.repeat(32)}`,
    });
    const checkpoint = await fixture.store.getCheckpoint(MARKET);
    assert.equal(checkpoint.lastScannedBlock, 2_000n, 'checkpoints are monotonic');
    assert.equal(checkpoint.lastBlockHash, `0x${'bb'.repeat(32)}`, 'and keep the matching hash');
  } finally {
    await fixture.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Gross-versus-creator-payout accounting
//
// Stage 1 settlement splits a *gross* request by `creatorShareBps`: the creator receives that
// share and the remainder is simply never transferred. A live run made this concrete — a decided
// payout of 0.10 USDC produced an onchain creator delta of exactly 0.06 USDC at 6000 bps. The
// autonomous caps are therefore expressed in what the creator actually receives, and the gross
// is derived from it. These tests pin that relationship in both directions.
// ─────────────────────────────────────────────────────────────────────────────

test('the gross request delivers the decided creator payout exactly', async () => {
  // The exact live case: 0.06 USDC to the creator at a 60% share needs a 0.10 gross.
  const sixtyPercent = grossForCreatorPayout(60_000n, 6_000);
  assert.equal(sixtyPercent.exact, true);
  assert.equal(sixtyPercent.grossUnits, 100_000n);
  assert.equal(applyBasisPoints(sixtyPercent.grossUnits, 6_000), 60_000n);

  // And the inverse of the observed discrepancy: a 0.10 gross pays 0.06, never 0.10.
  assert.equal(applyBasisPoints(100_000n, 6_000), 60_000n);

  for (const bps of [6_000, 10_000, 5_000, 2_500]) {
    for (const target of [1n, 2n, 10_000n, 60_000n, 100_000n, 999_999n]) {
      const gross = grossForCreatorPayout(target, bps);
      if (!gross.exact) continue;
      assert.equal(
        applyBasisPoints(gross.grossUnits, bps),
        target,
        `bps ${bps} target ${target} must round-trip exactly`,
      );
      // Never overpay the treasury more than the share arithmetic requires.
      assert.ok(
        applyBasisPoints(gross.grossUnits - 1n, bps) < target,
        `bps ${bps} target ${target} must use the smallest exact gross`,
      );
    }
  }
});

test('a full creator share makes gross and payout identical', async () => {
  const gross = grossForCreatorPayout(60_000n, 10_000);
  assert.equal(gross.exact, true);
  assert.equal(gross.grossUnits, 60_000n, 'at 100% nothing is retained');
});

test('every valid creator share can express any payout to the atomic unit', async () => {
  // For any share <= 100%, incrementing the gross by one raises the creator's cut by at most one
  // atomic unit, so no target is ever skipped and an exact gross always exists. The service's
  // `exact` guard is therefore defence in depth against a future share model, not a live branch.
  for (const bps of [1, 3_333, 5_000, 6_000, 9_999, 10_000]) {
    for (let target = 1n; target <= 50n; target += 1n) {
      const gross = grossForCreatorPayout(target, bps);
      assert.equal(gross.exact, true, `bps ${bps} target ${target} must be expressible`);
      assert.equal(applyBasisPoints(gross.grossUnits, bps), target);
    }
  }
});

test('a zero payout needs no gross request', async () => {
  const gross = grossForCreatorPayout(0n, 6_000);
  assert.equal(gross.grossUnits, 0n);
  assert.equal(gross.exact, true);
});

test('an impossible creator share is rejected outright', async () => {
  assert.throws(() => grossForCreatorPayout(60_000n, 0), /1\.\.10000/);
  assert.throws(() => grossForCreatorPayout(60_000n, 10_001), /1\.\.10000/);
});

test('caps bound what the creator receives, not the gross request', async () => {
  // The per-execution cap is 0.10. Under the old accounting a "0.10 payout" delivered 0.06 and
  // recorded 0.10 against the daily cap; both numbers were wrong in opposite directions.
  const capped = applySpendCaps(derivePayoutUnits(100, payoutPolicy), payoutPolicy);
  assert.equal(capped.approved, true);
  assert.equal(capped.amountUnits, 100_000n, 'the cap is the creator payout');

  const gross = grossForCreatorPayout(capped.amountUnits, 6_000);
  assert.equal(gross.exact, true);
  assert.equal(gross.grossUnits, 166_667n, 'the gross needed to deliver 0.10 at 60%');
  assert.equal(
    applyBasisPoints(gross.grossUnits, 6_000),
    100_000n,
    'the creator receives exactly the capped amount',
  );
});
