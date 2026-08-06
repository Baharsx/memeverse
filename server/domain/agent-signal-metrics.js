import { keccak256, stringToHex } from 'viem';

/**
 * Deterministic MemeVerse market signal metrics derived from confirmed Arc evidence.
 *
 * Every value here is an integer in 0..100 computed from raw onchain observations with integer
 * arithmetic only — no floating point, no wall-clock input, no offchain social data. The same
 * observation set always yields the same metrics, which is what makes an autonomous payout
 * reproducible and auditable after the fact.
 *
 * These are deliberately modest measurements of onchain behaviour. `fraudRisk` in particular is
 * a *risk score* built from crude heuristics, not a fraud detector: it cannot prove intent, and
 * a low score is not a statement that a market is honest.
 */

export const METRIC_VERSION = 'AGENT_SIGNAL_METRICS_V1';

/** Tunable shape of each curve. Committed defaults are deliberately conservative. */
export const defaultMetricConfig = Object.freeze({
  // Engagement is measured against a target trade count and USDC volume for the window.
  targetTradeCount: 8,
  targetVolumeUnits: 5_000_000n, // 5 USDC of executed volume in the window.
  // Liquidity is measured against a target confirmed reserve.
  targetReserveUnits: 5_000_000n, // 5 USDC held in the curve reserve.
  // Confidence inputs.
  minSampleTrades: 4,
  minMarketAgeBlocks: 500n,
  // Fraud-risk heuristics.
  minUniqueTraders: 2,
  concentrationThresholdBps: 6_000, // A single trader above 60% of volume is concentrated.
  churnThresholdBps: 5_000, // More than 50% of bought supply sold back is churn.
});

function clamp(value, low = 0, high = 100) {
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/** floor(100 * value / target), saturating at 100. Pure integer maths on BigInt inputs. */
function ratioScore(value, target) {
  if (target <= 0n) return 100;
  if (value <= 0n) return 0;
  const score = (value * 100n) / target;
  return score >= 100n ? 100 : Number(score);
}

/**
 * Reduces raw confirmed Arc observations into the signal vector the policy consumes.
 *
 * @param observation Raw evidence collected from a registered market over a confirmed window.
 */
export function calculateSignalMetrics(observation, config = defaultMetricConfig) {
  const {
    buys = [],
    sells = [],
    reserveUsdcUnits = 0n,
    marketCreatedBlock = 0n,
    fromBlock,
    toBlock,
    headBlock,
    minConfirmations,
    logsComplete = true,
  } = observation;

  const tradeCount = buys.length + sells.length;
  const buyVolumeUnits = buys.reduce((total, entry) => total + BigInt(entry.usdcUnits ?? 0n), 0n);
  const sellVolumeUnits = sells.reduce((total, entry) => total + BigInt(entry.usdcUnits ?? 0n), 0n);
  const volumeUnits = buyVolumeUnits + sellVolumeUnits;

  const grossBoughtTokens = buys.reduce((total, entry) => total + BigInt(entry.tokens ?? 0n), 0n);
  const soldBackTokens = sells.reduce((total, entry) => total + BigInt(entry.tokens ?? 0n), 0n);

  const traders = new Map();
  for (const entry of [...buys, ...sells]) {
    const key = String(entry.trader).toLowerCase();
    traders.set(key, (traders.get(key) ?? 0n) + BigInt(entry.usdcUnits ?? 0n));
  }
  const uniqueTraders = traders.size;
  const topTraderVolume = [...traders.values()].reduce((top, value) => (value > top ? value : top), 0n);

  // ── Engagement velocity: confirmed trading activity in the window ──
  const tradeScore = ratioScore(BigInt(tradeCount), BigInt(config.targetTradeCount));
  const volumeScore = ratioScore(volumeUnits, config.targetVolumeUnits);
  const engagementVelocity = clamp(Math.floor((tradeScore + volumeScore) / 2));

  // ── Holder retention: the share of bought supply not sold straight back ──
  // This is an onchain retention proxy over the window, not a claim about offchain holders.
  const retainedTokens = grossBoughtTokens > soldBackTokens
    ? grossBoughtTokens - soldBackTokens
    : 0n;
  const holderRetention = grossBoughtTokens === 0n
    ? 0
    : clamp(Number((retainedTokens * 100n) / grossBoughtTokens));

  // ── Liquidity depth: confirmed USDC actually sitting in the curve reserve ──
  const liquidityDepth = ratioScore(reserveUsdcUnits, config.targetReserveUnits);

  // ── Confidence: how much this evidence can be relied on, worst component wins ──
  const confirmations = headBlock >= toBlock ? headBlock - toBlock : 0n;
  const confirmationScore = ratioScore(confirmations, BigInt(minConfirmations));
  const sampleScore = ratioScore(BigInt(tradeCount), BigInt(config.minSampleTrades));
  const marketAgeBlocks = toBlock > marketCreatedBlock ? toBlock - marketCreatedBlock : 0n;
  const historyScore = ratioScore(marketAgeBlocks, config.minMarketAgeBlocks);
  const completenessScore = logsComplete ? 100 : 0;
  // The minimum, not an average: a single missing input must not be averaged away by strong
  // scores elsewhere, because confidence gates whether money moves at all.
  const confidence = Math.min(confirmationScore, sampleScore, historyScore, completenessScore);

  // ── Fraud risk: additive penalties from crude, deterministic heuristics ──
  const reasons = [];
  let fraudRisk = 0;
  if (tradeCount === 0) {
    fraudRisk += 50;
    reasons.push('NO_CONFIRMED_TRADES');
  }
  if (marketAgeBlocks < config.minMarketAgeBlocks) {
    fraudRisk += 40;
    reasons.push('MARKET_TOO_YOUNG');
  }
  if (uniqueTraders < config.minUniqueTraders) {
    fraudRisk += 30;
    reasons.push('TOO_FEW_INDEPENDENT_TRADERS');
  }
  if (volumeUnits > 0n) {
    const concentrationBps = Number((topTraderVolume * 10_000n) / volumeUnits);
    if (concentrationBps > config.concentrationThresholdBps) {
      // Scaled so a market that is merely concentrated is penalised less than a single-trader one.
      fraudRisk += Math.min(
        30,
        Math.floor((concentrationBps - config.concentrationThresholdBps) / 100),
      );
      reasons.push('DOMINANT_TRADER_CONCENTRATION');
    }
  }
  if (grossBoughtTokens > 0n) {
    const churnBps = Number((soldBackTokens * 10_000n) / grossBoughtTokens);
    if (churnBps > config.churnThresholdBps) {
      fraudRisk += 20;
      reasons.push('HIGH_BUY_SELL_CHURN');
    }
  }
  if (!logsComplete) {
    fraudRisk += 50;
    reasons.push('INCOMPLETE_EVENT_HISTORY');
  }
  fraudRisk = clamp(fraudRisk);

  const raw = Object.freeze({
    tradeCount,
    buyCount: buys.length,
    sellCount: sells.length,
    uniqueTraders,
    buyVolumeUnits: buyVolumeUnits.toString(),
    sellVolumeUnits: sellVolumeUnits.toString(),
    volumeUnits: volumeUnits.toString(),
    grossBoughtTokens: grossBoughtTokens.toString(),
    soldBackTokens: soldBackTokens.toString(),
    retainedTokens: retainedTokens.toString(),
    topTraderVolumeUnits: topTraderVolume.toString(),
    reserveUsdcUnits: reserveUsdcUnits.toString(),
    marketCreatedBlock: marketCreatedBlock.toString(),
    marketAgeBlocks: marketAgeBlocks.toString(),
    confirmations: confirmations.toString(),
    logsComplete,
  });

  return Object.freeze({
    metricVersion: METRIC_VERSION,
    signals: Object.freeze({
      engagementVelocity,
      holderRetention,
      liquidityDepth,
      confidence,
      fraudRisk,
    }),
    components: Object.freeze({
      tradeScore,
      volumeScore,
      confirmationScore,
      sampleScore,
      historyScore,
      completenessScore,
    }),
    riskReasons: Object.freeze(reasons),
    raw,
    window: Object.freeze({
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      headBlock: headBlock.toString(),
      minConfirmations,
    }),
  });
}

/**
 * A stable digest over everything that produced a decision.
 *
 * Binding the evidence, the window, the metric version, and the chain identity into one hash
 * gives the autonomous path an idempotency identity that changes whenever any input changes —
 * and lets an auditor prove after the fact which evidence a payout was based on.
 */
export function evidenceDigest({
  chainId, factoryAddress, marketAddress, creatorAddress, metrics, blockHash, policyVersion,
}) {
  return keccak256(stringToHex(JSON.stringify({
    chainId,
    factoryAddress: String(factoryAddress).toLowerCase(),
    marketAddress: String(marketAddress).toLowerCase(),
    creatorAddress: String(creatorAddress).toLowerCase(),
    blockHash,
    policyVersion,
    metricVersion: metrics.metricVersion,
    window: metrics.window,
    signals: metrics.signals,
    raw: metrics.raw,
  })));
}
