import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { executionModes } from '../domain/execution-mode.js';
import { agentDecisionBody, startTestApp, stubCircleGateway } from './helpers/app.js';
import {
  authorizedHeaders,
  createTestOperatorAuthService,
  signInOperator,
} from './helpers/operator.js';

let app;
let cookie;
let sequence = 0;

async function createAwaitingSettlement(target = app, sessionCookie = cookie) {
  sequence += 1;
  const response = await fetch(`${target.baseUrl}/api/v1/agent/decisions`, {
    method: 'POST',
    headers: authorizedHeaders(sessionCookie, { 'idempotency-key': `execution-key-${sequence}` }),
    body: JSON.stringify(agentDecisionBody({ reference: `EXECUTION-CASE-${sequence}` })),
  });
  const payload = await response.json();
  assert.equal(payload.data.state, 'AWAITING_SIGNATURE', 'settlement must await signature');
  return payload.data;
}

function authorize(settlementId, target = app, sessionCookie = cookie) {
  return fetch(`${target.baseUrl}/api/v1/settlements/${settlementId}/execution-authorization`, {
    method: 'POST',
    headers: authorizedHeaders(sessionCookie),
  });
}

function execute(settlementId, authorizationId, target = app, sessionCookie = cookie) {
  return fetch(`${target.baseUrl}/api/v1/settlements/${settlementId}/execute`, {
    method: 'POST',
    headers: authorizedHeaders(sessionCookie),
    body: JSON.stringify({ authorizationId }),
  });
}

before(async () => {
  app = await startTestApp();
  ({ cookie } = await signInOperator(app.baseUrl));
});

after(async () => {
  await app.close();
});

test('an authenticated session alone cannot execute a settlement', async () => {
  const settlement = await createAwaitingSettlement();
  const missing = await fetch(`${app.baseUrl}/api/v1/settlements/${settlement.id}/execute`, {
    method: 'POST',
    headers: authorizedHeaders(cookie),
    body: JSON.stringify({}),
  });
  const fabricated = await execute(settlement.id, 'f'.repeat(43));

  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'VALIDATION_ERROR');
  assert.equal(fabricated.status, 403);
  assert.equal((await fabricated.json()).error.code, 'EXECUTION_AUTHORIZATION_INVALID');
  assert.deepEqual(app.circleGateway.calls, []);
});

test('an authorization binds the exact execution payload the operator reviewed', async () => {
  const settlement = await createAwaitingSettlement();
  const response = await authorize(settlement.id);
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.data.binding.settlementId, settlement.id);
  assert.equal(payload.data.binding.recipient, settlement.recipient);
  assert.equal(payload.data.binding.creatorPayoutUnits, settlement.amount.creatorPayoutUnits);
  assert.equal(payload.data.binding.chainId, 5042002);
  assert.equal(payload.data.binding.memoId, settlement.memoId);
  assert.ok(payload.data.binding.settlementContract.startsWith('0x'));
  assert.ok(payload.data.expiresAt);
});

test('a consumed authorization executes once and cannot be replayed', async () => {
  const settlement = await createAwaitingSettlement();
  const authorizationId = (await (await authorize(settlement.id)).json()).data.authorizationId;
  const first = await execute(settlement.id, authorizationId);
  const firstPayload = await first.json();
  const replay = await execute(settlement.id, authorizationId);

  assert.equal(first.status, 202);
  assert.equal(firstPayload.data.state, 'INITIATED');
  assert.equal(firstPayload.data.executionAuthorization.mode, executionModes.MANUAL_OPERATOR);
  assert.ok(firstPayload.data.executionAuthorization.operatorAddress.startsWith('0x'));
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).error.code, 'EXECUTION_AUTHORIZATION_INVALID');
});

test('an authorization for settlement A cannot execute settlement B', async () => {
  const settlementA = await createAwaitingSettlement();
  const settlementB = await createAwaitingSettlement();
  const authorizationId = (await (await authorize(settlementA.id)).json()).data.authorizationId;
  const response = await execute(settlementB.id, authorizationId);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'EXECUTION_AUTHORIZATION_MISMATCH');
  // Burned even though it was misused, so it can no longer execute settlement A either.
  assert.equal((await execute(settlementA.id, authorizationId)).status, 403);
});

test('an expired authorization is rejected', async () => {
  let currentTime = new Date('2026-08-03T10:00:00.000Z');
  const expiringApp = await startTestApp({
    operatorAuthService: createTestOperatorAuthService({
      executionTtlSeconds: 60,
      now: () => currentTime,
    }),
  });
  try {
    const session = await signInOperator(expiringApp.baseUrl);
    const settlement = await createAwaitingSettlement(expiringApp, session.cookie);
    const authorizationId = (await (
      await authorize(settlement.id, expiringApp, session.cookie)
    ).json()).data.authorizationId;
    currentTime = new Date(currentTime.getTime() + 61_000);
    const response = await execute(settlement.id, authorizationId, expiringApp, session.cookie);

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'EXECUTION_AUTHORIZATION_INVALID');
    assert.deepEqual(expiringApp.circleGateway.calls, []);
  } finally {
    await expiringApp.close();
  }
});

test('an authorization is invalidated by a changed recipient, amount, memo, chain, or contract', async () => {
  for (const mutate of [
    (record) => ({ ...record, recipient: '0x3333333333333333333333333333333333333333' }),
    (record) => ({ ...record, amount: { ...record.amount, creatorPayoutUnits: '999999' } }),
    (record) => ({ ...record, memoId: `0x${'ee'.repeat(32)}` }),
    (record) => ({ ...record, chainId: 1 }),
    (record) => ({
      ...record,
      executionPlan: { ...record.executionPlan, targetContract: '0x4444444444444444444444444444444444444444' },
    }),
    (record) => ({
      ...record,
      executionPlan: { ...record.executionPlan, callDataHash: `0x${'cc'.repeat(32)}` },
    }),
  ]) {
    const settlement = await createAwaitingSettlement();
    const authorizationId = (await (await authorize(settlement.id)).json()).data.authorizationId;
    const stored = await app.store.get(settlement.id);
    await app.store.update(mutate(stored));

    const response = await execute(settlement.id, authorizationId);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'EXECUTION_AUTHORIZATION_STALE');
  }
});

test('an authorization is bound to the session that created it', async () => {
  const settlement = await createAwaitingSettlement();
  const authorizationId = (await (await authorize(settlement.id)).json()).data.authorizationId;
  const otherSession = await signInOperator(app.baseUrl);
  const response = await execute(settlement.id, authorizationId, app, otherSession.cookie);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'EXECUTION_AUTHORIZATION_MISMATCH');
});

test('a settlement that is not awaiting signature cannot be authorized', async () => {
  const settlement = await createAwaitingSettlement();
  const authorizationId = (await (await authorize(settlement.id)).json()).data.authorizationId;
  await execute(settlement.id, authorizationId);
  const response = await authorize(settlement.id);

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'SETTLEMENT_NOT_EXECUTABLE');
});

test('the domain rejects execution without an enabled, explicit authority', async () => {
  const isolated = await startTestApp({ circleGateway: stubCircleGateway() });
  try {
    const session = await signInOperator(isolated.baseUrl);
    const settlement = await createAwaitingSettlement(isolated, session.cookie);

    await assert.rejects(isolated.settlementService.execute(settlement.id), {
      code: 'EXECUTION_AUTHORIZATION_REQUIRED', status: 403,
    });
    await assert.rejects(isolated.settlementService.execute(settlement.id, { mode: 'ROOT' }), {
      code: 'EXECUTION_AUTHORIZATION_REQUIRED', status: 403,
    });
    await assert.rejects(
      isolated.settlementService.execute(settlement.id, {
        mode: executionModes.AUTONOMOUS_POLICY,
        operatorAddress: null,
        authorizationRef: 'a'.repeat(32),
      }),
      { code: 'EXECUTION_MODE_NOT_ENABLED', status: 501 },
    );
    await assert.rejects(
      isolated.settlementService.execute(settlement.id, { mode: executionModes.MANUAL_OPERATOR }),
      { code: 'EXECUTION_AUTHORIZATION_REQUIRED', status: 403 },
    );
    assert.deepEqual(isolated.circleGateway.calls, []);
  } finally {
    await isolated.close();
  }
});

test('two concurrent HTTP executions produce one provider call and a stable 409 for the loser', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  const gateway = stubCircleGateway({
    async onExecute() {
      if (!first) return undefined;
      first = false;
      await held;
      return undefined;
    },
  });
  const raced = await startTestApp({ circleGateway: gateway });
  try {
    const session = await signInOperator(raced.baseUrl);
    const settlement = await createAwaitingSettlement(raced, session.cookie);
    // Two independently valid approvals for the same settlement.
    const [authorizationA, authorizationB] = await Promise.all([
      authorize(settlement.id, raced, session.cookie).then((response) => response.json()),
      authorize(settlement.id, raced, session.cookie).then((response) => response.json()),
    ]);

    const attempts = Promise.all([
      execute(settlement.id, authorizationA.data.authorizationId, raced, session.cookie),
      new Promise((resolve) => setTimeout(resolve, 40)).then(() => (
        execute(settlement.id, authorizationB.data.authorizationId, raced, session.cookie)
      )),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    release();
    const [winner, loser] = await attempts;
    const winnerBody = await winner.json();
    const loserBody = await loser.json();

    assert.equal(gateway.calls.filter(([action]) => action === 'execute').length, 1);
    assert.equal(winner.status, 202);
    assert.equal(loser.status, 409);
    assert.equal(loserBody.error.code, 'EXECUTION_ALREADY_CLAIMED');
    assert.equal(winnerBody.data.executionSubmission.status, 'SUBMITTED');
    assert.equal(
      winnerBody.data.executionAuthorization.authorizationRef,
      winnerBody.data.executionSubmission.authorizationRef,
    );

    const persisted = await raced.store.get(settlement.id);
    assert.equal(persisted.circle.transactionId, `circle-${settlement.id}`);
    assert.equal(
      persisted.executionAuthorization.authorizationRef,
      winnerBody.data.executionAuthorization.authorizationRef,
    );
  } finally {
    await raced.close();
  }
});

test('a settlement mutated after approval is rejected by the claim as well as the transport', async () => {
  const isolated = await startTestApp({ circleGateway: stubCircleGateway() });
  try {
    const session = await signInOperator(isolated.baseUrl);
    const settlement = await createAwaitingSettlement(isolated, session.cookie);
    const authorization = (await (
      await authorize(settlement.id, isolated, session.cookie)
    ).json()).data;

    // The domain re-checks the binding at claim time, closing the window after the transport
    // consumed the approval.
    const stored = await isolated.store.get(settlement.id);
    await isolated.store.update({
      ...stored,
      recipient: '0x3333333333333333333333333333333333333333',
    });
    await assert.rejects(
      isolated.settlementService.execute(settlement.id, {
        mode: executionModes.MANUAL_OPERATOR,
        operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        sessionId: 'session-1',
        authorizationRef: authorization.authorizationId.slice(0, 32),
        bindingHash: `0x${'99'.repeat(32)}`,
      }),
      { code: 'EXECUTION_BINDING_MISMATCH', status: 409 },
    );
    assert.deepEqual(isolated.circleGateway.calls, []);
  } finally {
    await isolated.close();
  }
});
