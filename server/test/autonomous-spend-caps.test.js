import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createPayoutPolicy } from '../domain/agent-payout.js';
import {
  AgentAutonomyStore, spendReservationId, spendReservationStatuses,
} from '../repositories/agent-autonomy-store.js';
import { schemaSql } from '../repositories/schema.js';

/**
 * Durable admission control for autonomous spending.
 *
 * These tests exist because of a real cross-market race. The payout-epoch primary key serialises
 * workers contending for the *same* market and epoch, but the global daily cap spans every
 * market: two workers evaluating different markets could each read a global total of zero, each
 * approve a full payout, and together spend twice the configured limit. Their epoch keys differ,
 * so nothing collided and nothing stopped them.
 *
 * Every test below drives the real store against a real database. The invariant asserted is not
 * arithmetic — it is that concurrent transactions cannot oversubscribe the cap.
 */

const POLICY_VERSION = 'AGENT_AUTONOMOUS_POLICY_V1';
const MARKET_A = '0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE';
const MARKET_B = '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D';
const MARKET_C = '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-spend-'));
  const database = new PGlite(directory);
  await database.exec(schemaSql);
  return {
    database,
    store: new AgentAutonomyStore({ database }),
    async reopen() {
      // A brand-new store over the same database, as a restarted process would see it.
      return new AgentAutonomyStore({ database });
    },
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A policy whose global cap admits exactly one full payout. */
function tightPolicy({ globalDailyUsdc = '0.100000', marketDailyUsdc = '0.100000' } = {}) {
  return createPayoutPolicy({
    maxPayoutUsdc: '0.100000',
    minPayoutUsdc: '0.010000',
    marketDailyCapUsdc: marketDailyUsdc,
    dailySpendUsdc: globalDailyUsdc,
    scoreFloor: 70,
  });
}

const FULL_PAYOUT = 100_000n;

// ─────────────────────────────────────────────────────────────────────────────
// TEST A — cross-market global race
// ─────────────────────────────────────────────────────────────────────────────

test('two workers on DIFFERENT markets cannot both spend the whole global cap', async () => {
  const context = await fixture();
  try {
    const policy = tightPolicy(); // global cap 0.100000, one full payout only
    const workers = [MARKET_A, MARKET_B].map((marketAddress) => context.store.reserveDailySpend({
      marketAddress,
      policyVersion: POLICY_VERSION,
      epoch: 1,
      requestedUnits: FULL_PAYOUT,
      policy,
    }));

    const results = await Promise.all(workers);
    const reserved = results.filter((result) => result.outcome === 'RESERVED');
    const denied = results.filter((result) => result.outcome === 'DENIED');

    // Before the fix both markets were admitted: their epoch keys differ, so nothing collided.
    assert.equal(reserved.length, 1, 'exactly one market may take the whole global cap');
    assert.equal(denied.length, 1, 'the other must be denied');
    assert.equal(reserved[0].amountUnits, FULL_PAYOUT);
    assert.ok(
      denied[0].reasons.some((reason) => reason.code === 'PAYOUT_BELOW_MINIMUM'
        || reason.code === 'CAPPED_BY_GLOBAL_DAILY_CAP'),
      `unexpected denial reasons: ${JSON.stringify(denied[0].reasons)}`,
    );

    const state = await context.store.dailySpendState();
    assert.equal(state.committedUnits, FULL_PAYOUT, 'the global cap is not oversubscribed');
    assert.ok(state.committedUnits <= policy.dailySpendUnits);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST B — larger adversarial race
// ─────────────────────────────────────────────────────────────────────────────

test('twelve concurrent evaluations across many markets never exceed the global cap', async () => {
  const context = await fixture();
  try {
    // Room for exactly three full payouts, contended by twelve concurrent admissions.
    const policy = tightPolicy({ globalDailyUsdc: '0.300000', marketDailyUsdc: '0.300000' });
    const markets = [MARKET_A, MARKET_B, MARKET_C];

    const attempts = Array.from({ length: 12 }, (_, index) => context.store.reserveDailySpend({
      marketAddress: markets[index % markets.length],
      policyVersion: POLICY_VERSION,
      // A distinct epoch per attempt, so the epoch key can never be what saves us here.
      epoch: 100 + index,
      requestedUnits: FULL_PAYOUT,
      policy,
    }));
    const results = await Promise.all(attempts);

    const reserved = results.filter((result) => result.outcome === 'RESERVED');
    const total = reserved.reduce((sum, result) => sum + result.amountUnits, 0n);

    assert.equal(reserved.length, 3, 'only three full payouts fit in a 0.300000 global cap');
    assert.equal(total, 300_000n);

    const state = await context.store.dailySpendState();
    assert.equal(
      state.reservedUnits + state.consumedUnits,
      policy.dailySpendUnits,
      'reserved plus consumed must equal, never exceed, the configured global cap',
    );
    assert.ok(state.committedUnits <= policy.dailySpendUnits);
  } finally {
    await context.close();
  }
});

test('a partial remainder is admitted only when it still clears the minimum payout', async () => {
  const context = await fixture();
  try {
    // 0.150000 global: one full 0.100000, then a 0.050000 remainder that still beats the minimum.
    const policy = tightPolicy({ globalDailyUsdc: '0.150000', marketDailyUsdc: '0.150000' });

    const first = await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    const second = await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    const third = await context.store.reserveDailySpend({
      marketAddress: MARKET_C, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });

    assert.equal(first.amountUnits, 100_000n);
    assert.equal(second.outcome, 'RESERVED');
    assert.equal(second.amountUnits, 50_000n, 'the remainder is admitted, not the full request');
    assert.equal(third.outcome, 'DENIED', 'nothing is left above the minimum');

    const state = await context.store.dailySpendState();
    assert.equal(state.committedUnits, 150_000n);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST C — per-market cap still works
// ─────────────────────────────────────────────────────────────────────────────

test('the per-market daily cap still binds across epochs while the global cap has room', async () => {
  const context = await fixture();
  try {
    // Plenty of global room; one market may take only 0.200000 of it.
    const policy = tightPolicy({ globalDailyUsdc: '1.000000', marketDailyUsdc: '0.200000' });

    const admitted = [];
    for (const epoch of [1, 2, 3, 4]) {
      admitted.push(await context.store.reserveDailySpend({
        marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch,
        requestedUnits: FULL_PAYOUT, policy,
      }));
    }

    const total = admitted
      .filter((entry) => entry.outcome === 'RESERVED')
      .reduce((sum, entry) => sum + entry.amountUnits, 0n);
    assert.equal(total, 200_000n, 'one market cannot exceed its own daily cap');
    assert.equal(admitted[2].outcome, 'DENIED');
    assert.equal(admitted[3].outcome, 'DENIED');

    // A different market still has global headroom, proving the market cap is not global.
    const other = await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(other.outcome, 'RESERVED');
    assert.equal(other.amountUnits, FULL_PAYOUT);

    const state = await context.store.dailySpendState({ marketAddress: MARKET_A });
    assert.equal(state.marketCommittedUnits, 200_000n);
    assert.equal(state.committedUnits, 300_000n);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST D — failure release
// ─────────────────────────────────────────────────────────────────────────────

test('a provably pre-provider failure returns its capacity to the day', async () => {
  const context = await fixture();
  try {
    const policy = tightPolicy();
    const first = await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(first.outcome, 'RESERVED');

    // With the cap fully held, nothing else fits.
    assert.equal((await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    })).outcome, 'DENIED');

    // The payout never reached the provider, so its budget is genuinely unspent.
    const released = await context.store.releaseDailySpend({ reservationId: first.reservationId });
    assert.equal(released.updated, true);
    assert.equal(released.amountUnits, FULL_PAYOUT);
    assert.equal((await context.store.dailySpendState()).committedUnits, 0n);

    // And the freed capacity is genuinely usable again.
    const retry = await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(retry.outcome, 'RESERVED');
    assert.equal(retry.amountUnits, FULL_PAYOUT);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST E — uncertain outcome
// ─────────────────────────────────────────────────────────────────────────────

test('an undetermined provider outcome keeps holding capacity', async () => {
  const context = await fixture();
  try {
    const policy = tightPolicy();
    const held = await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(held.outcome, 'RESERVED');

    // An UNKNOWN_OUTCOME performs no release: the money may already be moving. The reservation
    // simply stays RESERVED, and the day stays fully committed.
    const reservation = await context.store.getSpendReservation(held.reservationId);
    assert.equal(reservation.status, spendReservationStatuses.RESERVED);
    assert.equal((await context.store.dailySpendState()).committedUnits, FULL_PAYOUT);

    // No other market may borrow against the undetermined payout.
    assert.equal((await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    })).outcome, 'DENIED');

    // Consuming it later moves capacity from held to spent without changing the total.
    const consumed = await context.store.consumeDailySpend({
      reservationId: held.reservationId, settlementId: 'settlement-1',
    });
    assert.equal(consumed.updated, true);
    const state = await context.store.dailySpendState();
    assert.equal(state.reservedUnits, 0n);
    assert.equal(state.consumedUnits, FULL_PAYOUT);
    assert.equal(state.committedUnits, FULL_PAYOUT, 'the total commitment never changed');

    // A consumed reservation can no longer be released back into the budget.
    assert.equal((await context.store.releaseDailySpend({
      reservationId: held.reservationId,
    })).updated, false);
    assert.equal((await context.store.dailySpendState()).committedUnits, FULL_PAYOUT);
  } finally {
    await context.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST F — restart and retry safety
// ─────────────────────────────────────────────────────────────────────────────

test('a restarted process sees committed budget and cannot re-reserve the same epoch', async () => {
  const context = await fixture();
  try {
    const policy = tightPolicy();
    const original = await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 7,
      requestedUnits: FULL_PAYOUT, policy,
    });
    await context.store.consumeDailySpend({
      reservationId: original.reservationId, settlementId: 'settlement-before-restart',
    });

    // A brand-new store instance, as a restarted worker would construct.
    const restarted = await context.reopen();

    assert.equal(
      (await restarted.dailySpendState()).committedUnits,
      FULL_PAYOUT,
      'a restart must not make spent budget look available again',
    );

    // The same market and epoch re-evaluated after the restart finds its own prior admission
    // rather than reserving a second time.
    const repeat = await restarted.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 7,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(repeat.outcome, 'ALREADY_RESERVED');
    assert.equal(repeat.reservationId, original.reservationId);
    assert.equal(repeat.status, spendReservationStatuses.CONSUMED);
    assert.equal(repeat.settlementId, 'settlement-before-restart');

    // And the day is still exactly at its cap, not double-counted.
    assert.equal((await restarted.dailySpendState()).committedUnits, FULL_PAYOUT);

    // A different market after the restart is correctly refused.
    assert.equal((await restarted.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 7,
      requestedUnits: FULL_PAYOUT, policy,
    })).outcome, 'DENIED');
  } finally {
    await context.close();
  }
});

test('reservation identity is deterministic and per market, policy, and epoch', async () => {
  const base = { policyVersion: POLICY_VERSION, marketAddress: MARKET_A, epoch: 5 };
  assert.equal(spendReservationId(base), spendReservationId(base));
  assert.equal(
    spendReservationId({ ...base, marketAddress: MARKET_A.toLowerCase() }),
    spendReservationId(base),
    'address casing must not change identity',
  );
  assert.notEqual(spendReservationId({ ...base, epoch: 6 }), spendReservationId(base));
  assert.notEqual(spendReservationId({ ...base, marketAddress: MARKET_B }), spendReservationId(base));
  assert.notEqual(spendReservationId({ ...base, policyVersion: 'V2' }), spendReservationId(base));
});

test('a denied admission writes nothing at all', async () => {
  const context = await fixture();
  try {
    const policy = tightPolicy();
    await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });

    const denied = await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(denied.outcome, 'DENIED');

    // No row exists for the denied market, so a denial can never consume or leak capacity.
    assert.equal(await context.store.getSpendReservation(denied.reservationId), undefined);
    const rows = await context.database.query(
      'SELECT count(*)::int AS total FROM agent_spend_reservations',
    );
    assert.equal(rows.rows[0].total, 1, 'only the admitted reservation was written');
  } finally {
    await context.close();
  }
});

test('a released reservation is re-admitted through the caps, never returned as held capacity', async () => {
  const context = await fixture();
  try {
    const policy = tightPolicy();
    const first = await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    await context.store.releaseDailySpend({ reservationId: first.reservationId });
    assert.equal((await context.store.dailySpendState()).committedUnits, 0n);

    // Re-admitting the same identity must go through the caps again and genuinely take capacity,
    // not report the released row's old amount as though it were still held.
    const again = await context.store.reserveDailySpend({
      marketAddress: MARKET_A, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    });
    assert.equal(again.outcome, 'RESERVED');
    assert.equal(again.reAdmitted, true);
    assert.equal((await context.store.dailySpendState()).committedUnits, FULL_PAYOUT);

    // And the cap is still respected: nothing else fits afterwards.
    assert.equal((await context.store.reserveDailySpend({
      marketAddress: MARKET_B, policyVersion: POLICY_VERSION, epoch: 1,
      requestedUnits: FULL_PAYOUT, policy,
    })).outcome, 'DENIED');

    // Exactly one row exists for that identity; re-admission never duplicates.
    const rows = await context.database.query(
      'SELECT count(*)::int AS total FROM agent_spend_reservations WHERE id = $1',
      [first.reservationId],
    );
    assert.equal(rows.rows[0].total, 1);
  } finally {
    await context.close();
  }
});
