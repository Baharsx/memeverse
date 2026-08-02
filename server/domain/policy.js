import { applyBasisPoints, formatUsdc, parseUsdc } from './money.js';

export function createSettlementPolicy({
  maxSpendUsdc,
  minViralityScore,
  creatorShareBps,
}) {
  const maxSpendUnits = parseUsdc(maxSpendUsdc, 'MAX_SPEND_USDC');

  return Object.freeze({
    maxSpendUsdc: formatUsdc(maxSpendUnits),
    maxSpendUnits,
    minViralityScore,
    creatorShareBps,
  });
}

export function evaluateSettlementPolicy({ requestedAmount, viralityScore }, policy) {
  const requestedUnits = parseUsdc(requestedAmount, 'requestedAmount');
  const reasons = [];

  if (requestedUnits > policy.maxSpendUnits) {
    reasons.push({
      code: 'MAX_SPEND_EXCEEDED',
      message: `Requested amount exceeds the ${policy.maxSpendUsdc} USDC policy cap.`,
    });
  }

  if (viralityScore < policy.minViralityScore) {
    reasons.push({
      code: 'VIRALITY_SCORE_TOO_LOW',
      message: `Virality score must be at least ${policy.minViralityScore}.`,
    });
  }

  const creatorPayoutUnits = applyBasisPoints(requestedUnits, policy.creatorShareBps);
  const treasuryRetainedUnits = requestedUnits - creatorPayoutUnits;

  return Object.freeze({
    approved: reasons.length === 0,
    reasons,
    requestedAmountUsdc: formatUsdc(requestedUnits),
    requestedAmountUnits: requestedUnits.toString(),
    creatorPayoutUsdc: formatUsdc(creatorPayoutUnits),
    creatorPayoutUnits: creatorPayoutUnits.toString(),
    treasuryRetainedUsdc: formatUsdc(treasuryRetainedUnits),
    treasuryRetainedUnits: treasuryRetainedUnits.toString(),
  });
}
