import { formatUsdc, parseUsdc } from './money.js';
import { assertKnownProvenance, trustedSignalProvenance } from './signal-provenance.js';

export function createAgentPolicy({
  agentDailySpendUsdc,
  agentMaxFraudRisk,
  agentMinConfidence,
  agentSignalMaxAgeSeconds,
}) {
  const dailySpendUnits = parseUsdc(agentDailySpendUsdc, 'AGENT_DAILY_SPEND_USDC');
  return Object.freeze({
    dailySpendUsdc: formatUsdc(dailySpendUnits),
    dailySpendUnits,
    maxFraudRisk: agentMaxFraudRisk,
    minConfidence: agentMinConfidence,
    signalMaxAgeSeconds: agentSignalMaxAgeSeconds,
    weights: Object.freeze({ engagementVelocity: 45, holderRetention: 25, liquidityDepth: 30 }),
  });
}

/**
 * What the route that requested this evaluation is allowed to do with it.
 *
 * The signal evaluator scores evidence; it has no way of knowing which of the two settlement
 * routes asked. Both routes share this evaluator, so hardcoding the manual answer here meant an
 * autonomous payout — one that genuinely executes with no human in the path — persisted nested
 * metadata claiming a human approval was required. The scoring is identical for both; only this
 * capability descriptor differs, so the caller that knows the route supplies it.
 *
 * The manual descriptor is the default, deliberately: a caller that forgets to say which route it
 * is gets the restrictive answer rather than an execution permission it never asked for.
 */
export const AGENT_EXECUTION_ROUTES = Object.freeze({
  MANUAL_OPERATOR: Object.freeze({
    mayQuote: true,
    mayPrepare: true,
    mayExecute: false,
    humanApprovalRequired: true,
    executionMode: 'MANUAL_OPERATOR',
  }),
  AUTONOMOUS_POLICY: Object.freeze({
    mayQuote: true,
    mayPrepare: true,
    mayExecute: true,
    humanApprovalRequired: false,
    executionMode: 'AUTONOMOUS_POLICY',
  }),
});

export function evaluateAgentSignals(signals, policy, {
  now, arc, circle, evidence, route = AGENT_EXECUTION_ROUTES.MANUAL_OPERATOR,
}) {
  assertKnownProvenance(signals.provenance);
  const reasons = [];
  const observedAt = new Date(signals.observedAt);
  const ageSeconds = Math.floor((now.getTime() - observedAt.getTime()) / 1000);
  if (ageSeconds < -30) {
    reasons.push({ code: 'SIGNAL_FROM_FUTURE', message: 'Signal timestamp is too far in the future.' });
  } else if (ageSeconds > policy.signalMaxAgeSeconds) {
    reasons.push({ code: 'SIGNAL_STALE', message: 'Signal evidence is older than the policy window.' });
  }
  if (signals.confidence < policy.minConfidence) {
    reasons.push({
      code: 'SIGNAL_CONFIDENCE_TOO_LOW',
      message: `Signal confidence must be at least ${policy.minConfidence}.`,
    });
  }
  if (signals.fraudRisk > policy.maxFraudRisk) {
    reasons.push({
      code: 'FRAUD_RISK_TOO_HIGH',
      message: `Fraud risk must not exceed ${policy.maxFraudRisk}.`,
    });
  }
  if (arc.status !== 'verified') {
    reasons.push({ code: 'ARC_NOT_VERIFIED', message: 'Arc RPC health is not verified.' });
  }
  // Both Circle wallet models MemeVerse uses are accepted, and only those two. The manual
  // operator path executes from a Developer-Controlled EOA, which must sign Arc's Memo CallFrom
  // directly. The autonomous path executes from a Circle Agent Wallet, which is an ERC-4337
  // smart contract account and therefore calls its own settlement contract directly. Anything
  // reporting some other account type is not a wallet this system knows how to settle through.
  const acceptedAccountTypes = ['EOA', 'SCA'];
  if (!circle.configured || circle.wallet?.state !== 'LIVE'
    || !acceptedAccountTypes.includes(circle.wallet?.accountType)) {
    reasons.push({
      code: 'CIRCLE_TREASURY_NOT_READY',
      message: 'The Circle Arc Testnet treasury wallet is not ready.',
    });
  }

  const weightedScore = Math.floor((
    signals.engagementVelocity * policy.weights.engagementVelocity
    + signals.holderRetention * policy.weights.holderRetention
    + signals.liquidityDepth * policy.weights.liquidityDepth
  ) / 100);
  const confidenceAdjustedScore = Math.floor(weightedScore * signals.confidence / 100);

  return Object.freeze({
    version: 'AGENT_POLICY_V2',
    approved: reasons.length === 0,
    reasons,
    signals: { ...signals, ageSeconds },
    evidence: Object.freeze({
      ...evidence,
      provenance: signals.provenance,
      provenanceTrusted: trustedSignalProvenance.has(signals.provenance),
      assignedBy: 'SERVER',
    }),
    weightedScore,
    confidenceAdjustedScore,
    policy: {
      weights: policy.weights,
      minConfidence: policy.minConfidence,
      maxFraudRisk: policy.maxFraudRisk,
      signalMaxAgeSeconds: policy.signalMaxAgeSeconds,
      dailySpendUsdc: policy.dailySpendUsdc,
    },
    operationalEvidence: {
      arc: { status: arc.status, chainId: arc.chainId, blockNumber: arc.blockNumber },
      circle: {
        configured: circle.configured,
        walletState: circle.wallet?.state ?? null,
        accountType: circle.wallet?.accountType ?? null,
        usdcBalance: circle.usdcBalance ?? null,
      },
    },
    // Supplied by the caller, because only the caller knows which route it is.
    autonomy: route,
  });
}
