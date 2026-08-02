import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettlementPolicy, evaluateSettlementPolicy } from '../domain/policy.js';

const policy = createSettlementPolicy({
  maxSpendUsdc: '25.00',
  minViralityScore: 78,
  creatorShareBps: 6000,
});

test('policy approves an eligible settlement and uses exact USDC integer math', () => {
  const result = evaluateSettlementPolicy(
    { requestedAmount: '25.00', viralityScore: 84 },
    policy,
  );

  assert.equal(result.approved, true);
  assert.equal(result.requestedAmountUnits, '25000000');
  assert.equal(result.creatorPayoutUnits, '15000000');
  assert.equal(result.creatorPayoutUsdc, '15');
  assert.equal(result.treasuryRetainedUsdc, '10');
});

test('policy returns every applicable denial reason', () => {
  const result = evaluateSettlementPolicy(
    { requestedAmount: '30.00', viralityScore: 20 },
    policy,
  );

  assert.equal(result.approved, false);
  assert.deepEqual(result.reasons.map(({ code }) => code), [
    'MAX_SPEND_EXCEEDED',
    'VIRALITY_SCORE_TOO_LOW',
  ]);
});

test('policy rejects fractional USDC beyond six decimals', () => {
  assert.throws(
    () => evaluateSettlementPolicy({ requestedAmount: '1.0000001', viralityScore: 90 }, policy),
    { code: 'INVALID_USDC_AMOUNT' },
  );
});
