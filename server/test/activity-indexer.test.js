import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, getAddress } from 'viem';
import { ActivityIndexer, activityAbi, applyLogs, marketStats, recentTrades } from '../domain/activity-indexer.js';
import { startTestApp } from './helpers/app.js';

const FACTORY = getAddress('0x00000000000000000000000000000000000000f1');
const MARKET = getAddress('0x00000000000000000000000000000000000000a1');
const LATE = getAddress('0x00000000000000000000000000000000000000a2');
const ALICE = getAddress('0x0000000000000000000000000000000000000a11');
const BOB = getAddress('0x0000000000000000000000000000000000000b0b');
const ZERO = '0x0000000000000000000000000000000000000000';
let sequence = 0;

function log(address, eventName, args, block) {
  const event = activityAbi.find((item) => item.name === eventName);
  const indexed = event.inputs.filter((input) => input.indexed);
  const plain = event.inputs.filter((input) => !input.indexed);
  sequence += 1;
  return {
    address,
    topics: encodeEventTopics({ abi: activityAbi, eventName, args: Object.fromEntries(indexed.map((input) => [input.name, args[input.name]])) }),
    data: encodeAbiParameters(plain, plain.map((input) => args[input.name])),
    blockNumber: BigInt(block),
    logIndex: sequence,
    transactionHash: `0x${sequence.toString(16).padStart(64, '0')}`,
  };
}
const buy = (market, buyer, usdc, tokens, block) => log(market, 'Bought', { buyer, maximumUsdcIn: usdc, actualUsdcSpent: usdc, tokenOut: tokens, curveCostUsdc: usdc, creatorFeeUsdc: 0n, treasuryFeeUsdc: 0n, soldAfter: tokens }, block);
const sell = (market, seller, usdc, tokens, block) => log(market, 'Sold', { seller, tokenIn: tokens, usdcOut: usdc, grossCurveReturnUsdc: usdc, creatorFeeUsdc: 0n, treasuryFeeUsdc: 0n, soldAfter: 0n }, block);
const transfer = (market, from, to, value, block) => log(market, 'Transfer', { from, to, value }, block);

test('trades, holders and 24h statistics follow the chain', () => {
  const state = { cursor: '0', markets: { [MARKET]: {} }, trades: [], balances: {}, blockTimes: { 10: 1_000, 20: 90_000, 30: 100_000 } };
  const logs = [
    transfer(MARKET, ZERO, MARKET, 10n ** 24n, 5), // Mint into curve inventory: no holder.
    buy(MARKET, ALICE, 2_000_000n, 2n * 10n ** 18n, 10), transfer(MARKET, MARKET, ALICE, 2n * 10n ** 18n, 10),
    buy(MARKET, BOB, 1_000_000n, 10n ** 18n, 20), transfer(MARKET, MARKET, BOB, 10n ** 18n, 20),
    sell(MARKET, ALICE, 1_500_000n, 2n * 10n ** 18n, 30), transfer(MARKET, ALICE, MARKET, 2n * 10n ** 18n, 30),
  ];
  applyLogs(state, logs);
  applyLogs(state, logs); // Re-reading a range never double-counts trades.
  assert.equal(state.trades.length, 3);
  assert.deepEqual(Object.keys(state.balances[MARKET]), [BOB], 'a fully sold position is no longer a holder');
  const stats = marketStats(state, 100_000)[MARKET];
  const { periods, ...totals } = stats;
  assert.deepEqual(totals, { holders: 1, trades: 3, volumeUsdc: '4500000', trades24h: 2, volume24hUsdc: '2500000', traders24h: 2, lastTradeAt: 100_000 });
  assert.deepEqual(periods['24h'], { trades: 2, volumeUsdc: '2500000' });
  assert.deepEqual(periods['7d'], { trades: 3, volumeUsdc: '4500000' });
  assert.deepEqual(periods.all, { trades: 3, volumeUsdc: '4500000' });
  assert.deepEqual(marketStats(state, 100_000 + 10 * 86_400)[MARKET].periods, {
    '24h': { trades: 0, volumeUsdc: '0' }, '7d': { trades: 0, volumeUsdc: '0' }, '30d': { trades: 3, volumeUsdc: '4500000' }, all: { trades: 3, volumeUsdc: '4500000' },
  });
  const recent = recentTrades(state, 2);
  assert.deepEqual(recent.map((trade) => [trade.side, trade.trader, trade.usdc, trade.at]), [['SELL', ALICE, '1500000', 100_000], ['BUY', BOB, '1000000', 90_000]]);
});

test('the indexer walks bounded chunks, catches up late markets, backs off on rate limits and persists', async () => {
  const chain = [buy(MARKET, ALICE, 1_000_000n, 10n ** 18n, 120), transfer(MARKET, MARKET, ALICE, 10n ** 18n, 120), buy(LATE, BOB, 3_000_000n, 10n ** 18n, 150)];
  const ranges = [];
  let markets = [MARKET];
  let throttled = 1;
  const client = {
    async readContract({ address, functionName, args }) {
      if (functionName === 'deployedAtBlock') return 100n;
      if (functionName === 'marketCount') return BigInt(markets.length);
      if (functionName === 'markets') return markets[Number(args[0])];
      if (functionName === 'isMarket') return true;
      if (functionName === 'createdBlock') return address === LATE ? 140n : 100n;
      throw new Error(functionName);
    },
    async getBlockNumber() { return 160n; },
    async getBlock({ blockNumber }) { return { timestamp: blockNumber * 10n }; },
    async getLogs({ address, fromBlock, toBlock }) {
      if (throttled-- > 0) throw Object.assign(new Error('rate limit exceeded'), { code: -32005 });
      assert.ok(toBlock - fromBlock < 25n, 'every request stays within the chunk limit');
      ranges.push([address.length, fromBlock, toBlock]);
      return chain.filter((item) => address.includes(item.address) && item.blockNumber >= fromBlock && item.blockNumber <= toBlock);
    },
  };
  const dir = await mkdtemp(join(tmpdir(), 'activity-'));
  const sleeps = [];
  const indexer = new ActivityIndexer({ publicClient: client, factories: [FACTORY], stateFile: join(dir, 'state.json'), chunkBlocks: 25n, spacingMs: 0, sleep: async (ms) => sleeps.push(ms) });
  await indexer.tick();
  assert.ok(sleeps.includes(1_000), 'a rate limit waits before retrying');
  assert.equal(indexer.state.cursor, '160');
  assert.equal(indexer.state.trades.length, 1, 'the late market was not listed yet');

  markets = [MARKET, LATE]; // A market created at block 140 appears after the cursor passed it.
  await indexer.tick();
  assert.deepEqual(indexer.state.trades.map((trade) => trade.market).sort(), [MARKET, LATE].sort());
  assert.equal(indexer.snapshot({ nowSeconds: 1_600 }).markets[LATE].volume24hUsdc, '3000000');
  const stored = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  assert.equal(stored.trades.length, 2);

  const resumed = new ActivityIndexer({ publicClient: client, factories: [FACTORY], stateFile: join(dir, 'state.json'), chunkBlocks: 25n, spacingMs: 0, sleep: async () => {} });
  await resumed.load();
  assert.equal(resumed.state.cursor, '160', 'a restart resumes from the stored cursor');
});

test('the activity endpoint is public, bounded and degrades when no indexer runs', async () => {
  const indexer = { available: true, snapshot: ({ limit }) => ({ recent: Array.from({ length: limit }, () => ({})), markets: {}, status: { syncing: false } }) };
  const app = await startTestApp({ activityIndexer: indexer });
  try {
    const response = await fetch(app.baseUrl + '/api/v1/activity?limit=9000');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.recent.length, 500);
  } finally { await app.close(); }
  const bare = await startTestApp();
  try {
    const body = await (await fetch(bare.baseUrl + '/api/v1/activity')).json();
    assert.deepEqual(body.data.recent, []);
  } finally { await bare.close(); }
});
