import assert from 'node:assert/strict';
import test from 'node:test';
import { fundingLink, needsMoreUsdc, QUICK_BUY_AMOUNTS, RELAY_BRIDGE_TO_ARC_URL } from '../../src/funding.js';

test('mainnet funding bridges Base USDC to Arc USDC through Relay', () => {
  const url = new URL(fundingLink(true).href);
  assert.equal(url.href, RELAY_BRIDGE_TO_ARC_URL);
  assert.equal(url.origin + url.pathname, 'https://relay.link/bridge/arc');
  assert.equal(url.searchParams.get('fromChainId'), '8453', 'source must not be Arc itself');
  assert.equal(url.searchParams.get('toCurrency'), '0x3600000000000000000000000000000000000000');
  assert.match(fundingLink(false).href, /^https:\/\/faucet\.circle\.com/);
});

test('the funding prompt appears only for a known balance below the budget', () => {
  assert.equal(needsMoreUsdc({ onArc: true, balance: 500000n, budget: 1000000n }), true);
  assert.equal(needsMoreUsdc({ onArc: true, balance: 1000000n, budget: 1000000n }), false);
  assert.equal(needsMoreUsdc({ onArc: true, balance: undefined, budget: 1000000n }), false);
  assert.equal(needsMoreUsdc({ onArc: false, balance: 0n, budget: 1000000n }), false);
  assert.equal(needsMoreUsdc({ onArc: true, balance: 0n, budget: 0n }), false);
  assert.deepEqual([...QUICK_BUY_AMOUNTS], ['1', '5', '10', '25']);
});
