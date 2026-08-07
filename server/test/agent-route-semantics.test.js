import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AGENT_EXECUTION_ROUTES, evaluateAgentSignals } from '../domain/agent-policy.js';
import { signalProvenance } from '../domain/signal-provenance.js';
import { agentDecisionBody, startTestApp } from './helpers/app.js';
import { authorizedHeaders, signInOperator } from './helpers/operator.js';

/**
 * Which settlement route a persisted agent decision belongs to.
 *
 * Both routes share one signal evaluator, and the evaluator used to hardcode the manual answer.
 * That meant an autonomous payout — one that genuinely executes with no human in the path —
 * persisted nested metadata claiming a human approval was required, so the stored audit trail
 * contradicted the payment it described. The route descriptor is now supplied by whichever caller
 * knows the route, and these tests pin both ends of that.
 */

const policy = {
  minConfidence: 80,
  maxFraudRisk: 20,
  signalMaxAgeSeconds: 300,
  dailySpendUsdc: '30.000000',
  weights: { engagementVelocity: 45, holderRetention: 25, liquidityDepth: 30 },
};

function evaluate(context = {}) {
  return evaluateAgentSignals(
    {
      engagementVelocity: 94,
      holderRetention: 92,
      liquidityDepth: 90,
      fraudRisk: 4,
      confidence: 96,
      provenance: signalProvenance.ONCHAIN_INDEXER,
      observedAt: new Date('2026-08-07T12:00:00.000Z').toISOString(),
      sourceReference: 'test',
    },
    policy,
    {
      now: new Date('2026-08-07T12:00:10.000Z'),
      arc: { status: 'verified', chainId: 5042002, blockNumber: 1 },
      circle: { configured: true, wallet: { state: 'LIVE', accountType: 'SCA' } },
      evidence: { suppliedBy: 'INTERNAL_COLLECTOR' },
      ...context,
    },
  );
}

test('the autonomous route records that it may execute without a human', () => {
  const decision = evaluate({ route: AGENT_EXECUTION_ROUTES.AUTONOMOUS_POLICY });

  assert.equal(decision.autonomy.executionMode, 'AUTONOMOUS_POLICY');
  assert.equal(decision.autonomy.mayExecute, true);
  assert.equal(decision.autonomy.humanApprovalRequired, false);
  assert.equal(decision.autonomy.mayQuote, true);
  assert.equal(decision.autonomy.mayPrepare, true);
});

test('the manual route records that a human still has to authorize execution', () => {
  const decision = evaluate({ route: AGENT_EXECUTION_ROUTES.MANUAL_OPERATOR });

  assert.equal(decision.autonomy.executionMode, 'MANUAL_OPERATOR');
  assert.equal(decision.autonomy.mayExecute, false);
  assert.equal(decision.autonomy.humanApprovalRequired, true);
});

test('a caller that names no route gets the restrictive one, never execution permission', () => {
  // Failing open here would hand an unnamed caller the autonomous capability descriptor.
  const decision = evaluate();

  assert.equal(decision.autonomy.executionMode, 'MANUAL_OPERATOR');
  assert.equal(decision.autonomy.mayExecute, false);
  assert.equal(decision.autonomy.humanApprovalRequired, true);
});

test('only the route descriptor differs — scoring and approval are identical', () => {
  const manual = evaluate({ route: AGENT_EXECUTION_ROUTES.MANUAL_OPERATOR });
  const autonomous = evaluate({ route: AGENT_EXECUTION_ROUTES.AUTONOMOUS_POLICY });

  // The whole point of parameterizing the route was to leave the policy untouched.
  assert.equal(manual.weightedScore, autonomous.weightedScore);
  assert.equal(manual.confidenceAdjustedScore, autonomous.confidenceAdjustedScore);
  assert.equal(manual.approved, autonomous.approved);
  assert.equal(manual.version, autonomous.version);
  assert.deepEqual(manual.reasons, autonomous.reasons);
  assert.deepEqual(manual.policy, autonomous.policy);
  assert.deepEqual(manual.signals, autonomous.signals);

  const { autonomy: _manualRoute, ...manualRest } = manual;
  const { autonomy: _autonomousRoute, ...autonomousRest } = autonomous;
  assert.deepEqual(manualRest, autonomousRest, 'the route must change nothing else');
});

test('the route descriptors are frozen so a caller cannot mutate a shared object', () => {
  assert.throws(() => {
    AGENT_EXECUTION_ROUTES.MANUAL_OPERATOR.mayExecute = true;
  }, TypeError);
  assert.equal(AGENT_EXECUTION_ROUTES.MANUAL_OPERATOR.mayExecute, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// The persisted manual decision, end to end through the API
// ─────────────────────────────────────────────────────────────────────────────

let app;
let cookie;

before(async () => {
  app = await startTestApp();
  ({ cookie } = await signInOperator(app.baseUrl));
});

after(async () => {
  await app.close();
});

test('a manual operator decision persists MANUAL_OPERATOR and human approval required', async () => {
  const response = await fetch(`${app.baseUrl}/api/v1/agent/decisions`, {
    method: 'POST',
    headers: authorizedHeaders(cookie, { 'idempotency-key': 'route-semantics-manual-1' }),
    body: JSON.stringify(agentDecisionBody()),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.data.agentDecision.autonomy.executionMode, 'MANUAL_OPERATOR');
  assert.equal(payload.data.agentDecision.autonomy.mayExecute, false);
  assert.equal(payload.data.agentDecision.autonomy.humanApprovalRequired, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// The public configuration surface
// ─────────────────────────────────────────────────────────────────────────────

test('the public config names both settlement routes instead of only the manual one', async () => {
  const { data } = await (await fetch(`${app.baseUrl}/api/v1/config`)).json();

  // A reader used to see only MANUAL_OPERATOR / humanApprovalRequired: true and would reasonably
  // conclude that every MemeVerse agent payout needs a human. It does not.
  assert.equal(data.agent.manualRoute.executionMode, 'MANUAL_OPERATOR');
  assert.equal(data.agent.manualRoute.humanApprovalRequired, true);
  assert.equal(data.agent.autonomousRoute.executionMode, 'AUTONOMOUS_POLICY');
  assert.equal(data.agent.autonomousRoute.humanApprovalRequired, false);
  assert.equal(typeof data.agent.autonomousRoute.configured, 'boolean');
  assert.equal(typeof data.agent.autonomousRoute.enabled, 'boolean');

  // Policy constants stay public and grouped.
  assert.equal(data.agent.policy.signalProvenance, 'SERVER_ASSIGNED');
  assert.equal(data.agent.policy.browserProvenance, 'OPERATOR_INPUT');
  assert.ok(data.agent.policy.dailySpendUsdc);

  // Backward compatibility: the old flat fields still exist, and are now scoped rather than
  // silently redefined.
  assert.equal(data.agent.executionMode, 'MANUAL_OPERATOR');
  assert.equal(data.agent.humanApprovalRequired, true);
  assert.equal(data.agent.appliesTo, 'MANUAL_OPERATOR_ROUTE');
});

test('the public config still carries no wallet, worker, or credential identity', async () => {
  const response = await fetch(`${app.baseUrl}/api/v1/config`);
  const body = await response.text();

  for (const secret of [
    'apiKey', 'entitySecret', 'walletId', 'circleWalletId', 'workerId', 'sessionToken',
    'CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'KIT_KEY',
  ]) {
    assert.equal(body.includes(secret), false, `the public config must not carry ${secret}`);
  }
  assert.equal(response.headers.has('set-cookie'), false);
});
