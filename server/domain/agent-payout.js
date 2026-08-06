import { formatUsdc, parseUsdc } from './money.js';

/**
 * Deterministic autonomous payout derivation in exact six-decimal USDC atomic units.
 *
 * The autonomous path never accepts an amount from a caller. It derives one from the decided
 * score with integer arithmetic, then clamps it through every configured cap. Two evaluations of
 * the same score under the same configuration always produce the same integer.
 *
 * No floating point appears anywhere in this file: JavaScript numbers are used only for the
 * 0..100 score, and every currency value is a BigInt.
 */

export const PAYOUT_FORMULA_VERSION = 'AGENT_PAYOUT_V1';

export function createPayoutPolicy({
  maxPayoutUsdc,
  minPayoutUsdc,
  marketDailyCapUsdc,
  dailySpendUsdc,
  scoreFloor,
}) {
  const maxUnits = parseUsdc(maxPayoutUsdc, 'AGENT_AUTONOMOUS_MAX_PAYOUT_USDC');
  const minUnits = parseUsdc(minPayoutUsdc, 'AGENT_AUTONOMOUS_MIN_PAYOUT_USDC');
  const marketDailyCapUnits = parseUsdc(marketDailyCapUsdc, 'AGENT_MARKET_DAILY_CAP_USDC');
  const dailySpendUnits = parseUsdc(dailySpendUsdc, 'AGENT_DAILY_SPEND_USDC');

  if (minUnits <= 0n) throw new Error('AGENT_AUTONOMOUS_MIN_PAYOUT_USDC must be greater than zero.');
  if (maxUnits < minUnits) {
    throw new Error('AGENT_AUTONOMOUS_MAX_PAYOUT_USDC must be at least the minimum payout.');
  }
  if (marketDailyCapUnits < maxUnits) {
    throw new Error('AGENT_MARKET_DAILY_CAP_USDC must be at least the per-execution maximum.');
  }
  if (dailySpendUnits < maxUnits) {
    throw new Error('AGENT_DAILY_SPEND_USDC must be at least the per-execution maximum.');
  }
  if (!Number.isInteger(scoreFloor) || scoreFloor < 0 || scoreFloor > 99) {
    throw new Error('Autonomous payout score floor must be an integer in 0..99.');
  }

  return Object.freeze({
    formulaVersion: PAYOUT_FORMULA_VERSION,
    maxUnits,
    minUnits,
    marketDailyCapUnits,
    dailySpendUnits,
    scoreFloor,
    maxPayoutUsdc: formatUsdc(maxUnits),
    minPayoutUsdc: formatUsdc(minUnits),
    marketDailyCapUsdc: formatUsdc(marketDailyCapUnits),
    dailySpendUsdc: formatUsdc(dailySpendUnits),
  });
}

/**
 * Maps an eligible score onto the bounded payout curve.
 *
 * payout(score) = min + floor((max - min) * (score - floor) / (100 - floor))
 *
 * A score at the floor pays exactly the minimum; a score of 100 pays exactly the maximum; the
 * division floors, so rounding is always in the treasury's favour and never above the cap.
 */
export function derivePayoutUnits(score, policy) {
  if (score < policy.scoreFloor) return 0n;
  const span = BigInt(100 - policy.scoreFloor);
  const offset = BigInt(Math.min(score, 100) - policy.scoreFloor);
  const range = policy.maxUnits - policy.minUnits;
  const payout = policy.minUnits + (range * offset) / span;
  return payout > policy.maxUnits ? policy.maxUnits : payout;
}

/**
 * Applies every spend cap to a derived payout.
 *
 * Caps are applied in widening order — per execution, then per market per day, then global per
 * day — and a payout that would fall below the configured minimum after clamping is refused
 * outright rather than paid at a token amount.
 */
export function applySpendCaps(payoutUnits, policy, { marketSpentTodayUnits = 0n, globalSpentTodayUnits = 0n } = {}) {
  const reasons = [];
  let amountUnits = payoutUnits;

  if (amountUnits > policy.maxUnits) {
    amountUnits = policy.maxUnits;
    reasons.push({ code: 'CAPPED_BY_PER_EXECUTION_MAX', message: 'Payout was reduced to the per-execution maximum.' });
  }

  const marketRemaining = policy.marketDailyCapUnits > marketSpentTodayUnits
    ? policy.marketDailyCapUnits - marketSpentTodayUnits
    : 0n;
  if (amountUnits > marketRemaining) {
    amountUnits = marketRemaining;
    reasons.push({ code: 'CAPPED_BY_MARKET_DAILY_CAP', message: 'Payout was reduced by this market daily cap.' });
  }

  const globalRemaining = policy.dailySpendUnits > globalSpentTodayUnits
    ? policy.dailySpendUnits - globalSpentTodayUnits
    : 0n;
  if (amountUnits > globalRemaining) {
    amountUnits = globalRemaining;
    reasons.push({ code: 'CAPPED_BY_GLOBAL_DAILY_CAP', message: 'Payout was reduced by the global daily cap.' });
  }

  // Paying less than the configured minimum is not a useful payout; it burns gas and clutters
  // the audit trail. Below the floor the agent declines instead.
  const approved = amountUnits >= policy.minUnits;
  if (!approved) {
    reasons.push({
      code: 'PAYOUT_BELOW_MINIMUM',
      message: `Remaining capacity yields less than the ${policy.minPayoutUsdc} USDC minimum payout.`,
    });
  }

  return Object.freeze({
    approved,
    amountUnits: approved ? amountUnits : 0n,
    amountUsdc: formatUsdc(approved ? amountUnits : 0n),
    derivedUnits: payoutUnits,
    derivedUsdc: formatUsdc(payoutUnits),
    reasons: Object.freeze(reasons),
  });
}

/**
 * The gross settlement amount required to deliver an exact creator payout.
 *
 * Stage 1 settlement semantics split a requested amount by `creatorShareBps`: the creator
 * receives `floor(gross * bps / 10000)` and the remainder is simply *not spent* — it stays in the
 * treasury and never moves onchain. The autonomous caps are expressed in what the creator
 * actually receives (which is also exactly what leaves the wallet), so the gross has to be
 * derived from the target rather than the other way round.
 *
 * `gross = ceil(target * 10000 / bps)`, then verified to round-trip exactly. A share
 * configuration that cannot express the target to the atomic unit fails closed instead of
 * silently paying a creator less than the policy decided.
 */
export function grossForCreatorPayout(creatorPayoutUnits, creatorShareBps) {
  if (creatorPayoutUnits <= 0n) return { grossUnits: 0n, exact: true };
  const bps = BigInt(creatorShareBps);
  if (bps <= 0n || bps > 10_000n) {
    throw new Error('creatorShareBps must be within 1..10000 to derive a settlement amount.');
  }
  const numerator = creatorPayoutUnits * 10_000n;
  // Ceiling division, so the creator is never short-changed by truncation.
  let grossUnits = numerator / bps + (numerator % bps === 0n ? 0n : 1n);
  // The ceiling can overshoot by one atomic unit; step back if a smaller gross is still exact.
  if ((grossUnits - 1n) * bps / 10_000n === creatorPayoutUnits) grossUnits -= 1n;
  const delivered = (grossUnits * bps) / 10_000n;
  return { grossUnits, deliveredUnits: delivered, exact: delivered === creatorPayoutUnits };
}

/**
 * The deterministic epoch a market's payout belongs to.
 *
 * Cooldown is expressed as an epoch number rather than a "last paid at" comparison so that two
 * workers evaluating the same market at the same moment compute the identical epoch and collide
 * on one durable unique key, instead of both reading a stale timestamp and both paying.
 */
export function payoutEpoch(observedAtSeconds, cooldownSeconds) {
  if (cooldownSeconds <= 0) throw new Error('AGENT_MARKET_COOLDOWN_SECONDS must be positive.');
  return Math.floor(observedAtSeconds / cooldownSeconds);
}
