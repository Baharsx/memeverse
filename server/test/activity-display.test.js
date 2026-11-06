import assert from 'node:assert/strict';
import test from 'node:test';
import { shortTrader, timeAgo, trendingMarkets } from '../../src/activity.js';

test('trending ranks real 24h activity and never invents a trend', () => {
  const markets = ['A', 'B', 'C', 'D'].map((address) => ({ address }));
  const stats = {
    A: { trades: 4, trades24h: 1, volume24hUsdc: '5000000', volumeUsdc: '9000000' },
    B: { trades: 2, trades24h: 2, volume24hUsdc: '5000000', volumeUsdc: '5000000' },
    C: { trades: 9, trades24h: 0, volume24hUsdc: '0', volumeUsdc: '90000000' },
    D: { trades: 0, trades24h: 0, volume24hUsdc: '0', volumeUsdc: '0' },
  };
  assert.deepEqual(trendingMarkets(markets, stats, 5).map(({ market }) => market.address), ['B', 'A', 'C']);
  assert.deepEqual(trendingMarkets(markets, {}), []);
});

test('activity times and traders read naturally', () => {
  assert.equal(timeAgo(1_000, 1_030), 'just now');
  assert.equal(timeAgo(1_000, 1_000 + 125), '2m ago');
  assert.equal(timeAgo(1_000, 1_000 + 7_200), '2h ago');
  assert.equal(timeAgo(1_000, 1_000 + 172_800), '2d ago');
  assert.equal(timeAgo(null), '');
  assert.equal(shortTrader('0x52e1d2a7ECe14cb84aA74687Fafe40D5794de2fF'), '0x52e1…e2fF');
});
