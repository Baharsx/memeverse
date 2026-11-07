import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  FIRST_EPOCH_END, PROGRAM_START, WEEK_SECONDS, computeRewards, epochBounds, epochOf, formatReward, payoutPlan, timeLeft,
} from '../../src/rewards.js';
import { RewardsService } from '../domain/rewards-service.js';
import { plannedPayouts } from '../../scripts/pay-rewards.js';
import { startTestApp } from './helpers/app.js';

const ALICE = '0x00000000000000000000000000000000000000a1';
const BOB = '0x00000000000000000000000000000000000000b0';
const CAROL = '0x00000000000000000000000000000000000000c0';
const TREASURY = '0x00000000000000000000000000000000000000f0';
const week1 = PROGRAM_START + 3_600;
const week2 = FIRST_EPOCH_END + 3_600;
const trade = (trader, usdc, at) => ({ trader, usdc: String(usdc), treasuryFee: String(usdc / 100), at });

test('weekly epochs start with the kickoff week and end every Monday', () => {
  assert.equal(epochOf(PROGRAM_START - 1), null, 'trades before the program never count');
  assert.equal(epochOf(PROGRAM_START), 1);
  assert.equal(epochOf(FIRST_EPOCH_END - 1), 1);
  assert.equal(epochOf(FIRST_EPOCH_END), 2);
  assert.equal(epochOf(FIRST_EPOCH_END + WEEK_SECONDS), 3);
  assert.deepEqual(epochBounds(1), { epoch: 1, start: PROGRAM_START, end: FIRST_EPOCH_END });
  assert.equal(new Date(epochBounds(2).end * 1000).getUTCDay(), 1, 'weeks end on Monday');
});

test('30% of the fee returns to the trader, 20% to the referrer, only after the referral was signed', () => {
  const result = computeRewards({
    trades: [trade(ALICE, 10_000_000, week1 - 60), trade(ALICE, 20_000_000, week1 + 60), trade(BOB, 5_000_000, week1), trade(TREASURY, 9_000_000, week1)],
    referrals: [{ wallet: ALICE, referrer: BOB, createdAt: new Date(week1 * 1000).toISOString() }],
    nowSeconds: week2,
    exclude: [TREASURY],
  });
  const alice = result.wallets[ALICE].epochs[1];
  assert.equal(alice.volume, 30_000_000n);
  assert.equal(alice.trading, 90_000n, '30% of 0.30 USDC in fees');
  const bob = result.wallets[BOB];
  assert.equal(bob.epochs[1].referral, 40_000n, '20% of the fee from the trade after signing only');
  assert.equal(bob.epochs[1].trading, 15_000n);
  assert.equal(bob.invited, 1);
  assert.equal(bob.invitedTraded, 1);
  assert.equal(result.wallets[TREASURY], undefined, 'the treasury never earns');
  assert.equal(result.epochs[1].final, true);
  assert.equal(result.epochs[1].tradingPool, 105_000n);
});

test('wash trading and self-referral always cost more than they return', () => {
  const fee = 1_000_000n; // 1 USDC of treasury fee from 100 USDC of volume
  const result = computeRewards({
    trades: [trade(ALICE, 100_000_000, week1)],
    referrals: [{ wallet: ALICE, referrer: CAROL, createdAt: new Date(PROGRAM_START * 1000).toISOString() }, { wallet: BOB, referrer: BOB, createdAt: new Date(PROGRAM_START * 1000).toISOString() }],
    nowSeconds: week2,
  });
  const returned = result.wallets[ALICE].earned + result.wallets[CAROL].earned; // CAROL may be ALICE's own second wallet
  assert.equal(returned, fee / 2n, 'at most half of the platform fee comes back');
  assert.ok(returned < fee * 2n, 'and the trader paid 2% in fees in the first place');
  assert.equal(result.wallets[BOB], undefined, 'self-referral is ignored');
});

test('only ended weeks are payable, payouts are subtracted and dust waits', () => {
  const trades = [trade(ALICE, 100_000_000, week1), trade(BOB, 1_000_000, week1), trade(ALICE, 50_000_000, week2)];
  const running = computeRewards({ trades, nowSeconds: week1 + 60 });
  assert.equal(running.wallets[ALICE].earned, 0n, 'nothing is final during the week');
  assert.equal(running.wallets[ALICE].thisWeek, 300_000n);
  const ended = computeRewards({ trades, payouts: [{ wallet: ALICE, amount: '100000', status: 'confirmed' }, { wallet: ALICE, amount: '999', status: 'failed' }], nowSeconds: week2 + 60 });
  assert.equal(ended.wallets[ALICE].earned, 300_000n);
  assert.equal(ended.wallets[ALICE].unpaid, 200_000n);
  assert.equal(ended.wallets[ALICE].thisWeek, 150_000n);
  assert.deepEqual(payoutPlan(ended), [{ wallet: ALICE, amount: 200_000n }], 'BOB’s 0.003 USDC waits for the minimum');
});

test('the payout plan can never exceed half of the revenue of ended weeks', () => {
  const trades = [trade(ALICE, 100_000_000, week1)];
  const { total, ceiling } = plannedPayouts({ trades, referrals: [], payouts: [], nowSeconds: week2, exclude: [] });
  assert.equal(total, 300_000n);
  assert.equal(ceiling, 500_000n);
  assert.throws(() => plannedPayouts({ trades, referrals: [], payouts: [{ wallet: BOB, amount: '400000', status: 'confirmed' }], nowSeconds: week2, exclude: [] }), /exceed/);
});

test('the rewards API serves the week, the leaderboard and a wallet without exposing referral links', async () => {
  const storageDir = await mkdtemp(join(tmpdir(), 'rewards-'));
  await mkdir(join(storageDir, 'referrals', 'invites'), { recursive: true });
  await writeFile(join(storageDir, 'referrals', `${ALICE}.json`), JSON.stringify({ wallet: ALICE, referrer: BOB, createdAt: new Date(PROGRAM_START * 1000).toISOString() }));
  const indexer = { available: true, trades: () => [trade(ALICE, 20_000_000, week1), trade(CAROL, 5_000_000, week1)] };
  const rewardsService = new RewardsService({ indexer, storageDir, clock: () => (week1 + 120) * 1000 });
  const app = await startTestApp({ rewardsService });
  try {
    const summary = (await (await fetch(app.baseUrl + '/api/v1/rewards')).json()).data;
    assert.equal(summary.current.epoch, 1);
    assert.equal(summary.current.tradingPool, '75000');
    assert.equal(summary.program.tradingShareBps, 3000);
    assert.deepEqual(summary.leaderboard.map((row) => [row.rank, row.volume]), [[1, '20000000'], [2, '5000000']]);
    const bob = (await (await fetch(app.baseUrl + `/api/v1/rewards/${BOB}`)).json()).data;
    assert.deepEqual([bob.invited, bob.invitedTraded, bob.thisWeek.referral], [1, 1, '40000']);
    assert.equal(JSON.stringify(bob).toLowerCase().includes(ALICE), false, 'who was invited is never revealed');
    assert.equal((await fetch(app.baseUrl + '/api/v1/rewards/not-a-wallet')).status, 400);
  } finally { await app.close(); }
});

test('rewards read naturally even when tiny', () => {
  assert.equal(formatReward('0'), '$0');
  assert.equal(formatReward('4500'), '$0.0045');
  assert.equal(formatReward('376500'), '$0.37');
  assert.equal(formatReward('125500000'), '$125.50');
  assert.equal(formatReward('100000000'), '$100');
  assert.equal(timeLeft(1_000 + 2 * 86_400 + 3_600, 1_000), '2d 1h');
  assert.equal(timeLeft(1_000 + 3_700, 1_000), '1h 1m');
  assert.equal(timeLeft(500, 1_000), '0m');
});
