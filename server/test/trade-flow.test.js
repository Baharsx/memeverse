import assert from 'node:assert/strict';
import test from 'node:test';
import { friendlyTradeError, maxBuyAmount, sellPresetAmount, tradeButtonState, tradeStatusLine } from '../../src/trade-flow.js';

const idle = { status: 'IDLE', hash: null, error: null };

test('one buy button walks allowance, signature, submission and completion', () => {
  assert.deepEqual(tradeButtonState({ side: 'BUY', step: null, needsApproval: true, approval: idle, action: idle, ready: true }), { busy: false, label: 'ALLOW USDC & BUY →', progress: null, disabled: false });
  assert.equal(tradeButtonState({ side: 'BUY', step: null, needsApproval: false, approval: idle, action: idle, ready: false }).disabled, true);
  const approving = tradeButtonState({ side: 'BUY', step: 'approve', needsApproval: true, approval: { status: 'WALLET_SIGNATURE' }, action: idle });
  assert.deepEqual([approving.busy, approving.label, approving.progress], [true, 'CONFIRM IN YOUR WALLET', 'Step 1 of 2 · Allow USDC for this buy']);
  assert.equal(tradeButtonState({ side: 'BUY', step: 'approve', approval: { status: 'SUBMITTED' }, action: idle }).label, 'ALLOWING USDC…');
  const buying = tradeButtonState({ side: 'BUY', step: 'trade', needsApproval: true, approval: { status: 'CONFIRMED', hash: '0x1' }, action: { status: 'SUBMITTED', hash: '0x2' } });
  assert.deepEqual([buying.label, buying.progress], ['BUYING…', 'Step 2 of 2 · Waiting for Arc']);
  assert.equal(tradeButtonState({ side: 'SELL', step: 'trade', action: { status: 'WALLET_SIGNATURE' } }).progress, 'Approve the sale in your wallet');
});

test('a single status line reports hints, pending hashes, receipts and friendly errors', () => {
  assert.equal(tradeStatusLine({ side: 'BUY', step: null, needsApproval: true, approval: idle, action: idle }).tone, 'hint');
  assert.deepEqual(tradeStatusLine({ side: 'BUY', step: 'trade', approval: idle, action: { status: 'SUBMITTED', hash: '0xab' } }), { tone: 'pending', text: 'Transaction sent.', hash: '0xab' });
  assert.equal(tradeStatusLine({ side: 'BUY', step: null, approval: idle, action: { status: 'CONFIRMED', hash: '0xcd' } }).tone, 'done');
  assert.deepEqual(tradeStatusLine({ side: 'SELL', step: null, action: { status: 'FAILED', error: 'User rejected the request.' } }), { tone: 'error', text: 'You cancelled the request in your wallet.', hash: undefined });
  assert.equal(tradeStatusLine({ side: 'SELL', step: null, action: idle }), null);
  assert.match(friendlyTradeError('execution reverted'), /not executed/);
});

test('sell presets use exact fractions or whole tokens', () => {
  const balance = 41n * 10n ** 18n + 5n * 10n ** 17n; // 41.5
  assert.equal(sellPresetAmount(balance, 1n, 1n, true), '41.5');
  assert.equal(sellPresetAmount(balance, 1n, 2n, true), '20.75');
  assert.equal(sellPresetAmount(balance, 1n, 4n, false), '10', 'whole-token markets round down');
  assert.equal(sellPresetAmount(balance, 1n, 1n, false), '41');
  assert.equal(sellPresetAmount(10n ** 17n, 1n, 4n, false), '', 'no whole token to sell');
  assert.equal(sellPresetAmount(0n, 1n, 1n, true), '');
});

test('a blocked sale reads as a calm disabled button', () => {
  assert.deepEqual(tradeButtonState({ side: 'SELL', step: null, action: { status: 'IDLE' }, ready: false, blockedLabel: 'NO DGR TO SELL' }), { busy: false, label: 'NO DGR TO SELL', progress: null, disabled: true });
});

test('MAX buys the balance and keeps a small USDC gas reserve', () => {
  assert.equal(maxBuyAmount(458544n), '0.428544');
  assert.equal(maxBuyAmount(25_000_000n), '24.97');
  assert.equal(maxBuyAmount(30_000n), '', 'nothing to spend after gas');
  assert.equal(maxBuyAmount(undefined), '');
});
