import { formatUsdc, parseUsdc } from './money.js';

export function createAgentPolicy({
  agentDailySpendUsdc,
  agentMaxFraudRisk,
  agentMinConfidence,
  agentSignalMaxAgeSeconds,
  agentAllowManualDemo = true,
}) {
  const dailySpendUnits = parseUsdc(agentDailySpendUsdc, 'AGENT_DAILY_SPEND_USDC');
  return Object.freeze({
    dailySpendUsdc: formatUsdc(dailySpendUnits),
    dailySpendUnits,
    maxFraudRisk: agentMaxFraudRisk,
    minConfidence: agentMinConfidence,
    signalMaxAgeSeconds: agentSignalMaxAgeSeconds,
    allowManualDemo: agentAllowManualDemo,
    weights: Object.freeze({ engagementVelocity: 45, holderRetention: 25, liquidityDepth: 30 }),
  });
}

export function evaluateAgentSignals(signals, policy, { now, arc, circle }) {
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
  if (signals.source === 'MANUAL_DEMO' && !policy.allowManualDemo) {
    reasons.push({
      code: 'MANUAL_SIGNAL_DISABLED',
      message: 'Manual demo signals are disabled in this environment.',
    });
  }
  if (arc.status !== 'verified') {
    reasons.push({ code: 'ARC_NOT_VERIFIED', message: 'Arc RPC health is not verified.' });
  }
  if (!circle.configured || circle.wallet?.state !== 'LIVE' || circle.wallet?.accountType !== 'EOA') {
    reasons.push({
      code: 'CIRCLE_TREASURY_NOT_READY',
      message: 'The Circle Arc Testnet EOA treasury is not ready.',
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
    weightedScore,
    confidenceAdjustedScore,
    policy: {
      weights: policy.weights,
      minConfidence: policy.minConfidence,
      maxFraudRisk: policy.maxFraudRisk,
      signalMaxAgeSeconds: policy.signalMaxAgeSeconds,
      dailySpendUsdc: policy.dailySpendUsdc,
      allowManualDemo: policy.allowManualDemo,
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
    autonomy: {
      mayQuote: true,
      mayPrepare: true,
      mayExecute: false,
      humanApprovalRequired: true,
    },
  });
}
