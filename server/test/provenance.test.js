import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { signalProvenance } from '../domain/signal-provenance.js';
import { agentDecisionBody, startTestApp } from './helpers/app.js';
import { authorizedHeaders, operatorAccount, signInOperator } from './helpers/operator.js';

let app;
let cookie;
let sequence = 0;

function submit(body, key) {
  sequence += 1;
  return fetch(`${app.baseUrl}/api/v1/agent/decisions`, {
    method: 'POST',
    headers: authorizedHeaders(cookie, { 'idempotency-key': key ?? `provenance-key-${sequence}` }),
    body: JSON.stringify(body),
  });
}

before(async () => {
  app = await startTestApp();
  ({ cookie } = await signInOperator(app.baseUrl));
});

after(async () => {
  await app.close();
});

test('the browser cannot claim a trusted provenance class', async () => {
  const claims = [
    { source: 'ONCHAIN_INDEXER' },
    { source: 'ANALYTICS_PIPELINE' },
    { source: 'MANUAL_DEMO' },
    { provenance: 'ONCHAIN_INDEXER' },
    { provenance: 'OPERATOR_INPUT' },
    { trusted: true },
  ];

  for (const claim of claims) {
    const body = agentDecisionBody();
    const response = await submit({ ...body, signals: { ...body.signals, ...claim } });
    const payload = await response.json();
    assert.equal(response.status, 400, `claim ${JSON.stringify(claim)} must be rejected`);
    assert.equal(payload.error.code, 'VALIDATION_ERROR');
  }
});

test('the browser cannot supply or backdate the observation timestamp', async () => {
  const body = agentDecisionBody();
  const response = await submit({
    ...body,
    signals: { ...body.signals, observedAt: '2020-01-01T00:00:00.000Z' },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
});

test('operator HTTP evidence is persisted as server-stamped operator input', async () => {
  const response = await submit(agentDecisionBody({ reference: 'OPERATOR-PROVENANCE' }));
  const record = (await response.json()).data;
  const decision = record.agentDecision;

  assert.equal(response.status, 201);
  assert.equal(decision.signals.provenance, signalProvenance.OPERATOR_INPUT);
  assert.equal(decision.evidence.assignedBy, 'SERVER');
  assert.equal(decision.evidence.provenanceTrusted, false);
  assert.equal(decision.evidence.suppliedBy, 'AUTHENTICATED_OPERATOR');
  assert.equal(decision.evidence.operatorAddress, operatorAccount.address);
  assert.equal(decision.evidence.observedAtSource, 'SERVER_CLOCK');
  assert.ok(decision.evidence.operatorSessionId);
  assert.equal(decision.autonomy.executionMode, 'MANUAL_OPERATOR');
  assert.equal(decision.autonomy.mayExecute, false);
  // Freshness is measured against the server clock, so operator evidence is never stale.
  assert.ok(decision.signals.ageSeconds >= 0 && decision.signals.ageSeconds <= 5);

  const persisted = await app.store.get(record.id);
  assert.equal(persisted.agentDecision.signals.provenance, signalProvenance.OPERATOR_INPUT);
  assert.equal(persisted.agentDecision.evidence.operatorAddress, operatorAccount.address);
});

test('trusted provenance is reachable only through internal server code', async () => {
  const input = agentDecisionBody({ reference: 'INTERNAL-COLLECTOR' });
  const trusted = await app.agentDecisionService.decideTrusted({
    provenance: signalProvenance.ONCHAIN_INDEXER,
    input,
    collector: 'arc-indexer-worker',
    idempotencyKey: 'internal-collector-0001',
  });

  assert.equal(trusted.record.agentDecision.signals.provenance, signalProvenance.ONCHAIN_INDEXER);
  assert.equal(trusted.record.agentDecision.evidence.provenanceTrusted, true);
  assert.equal(trusted.record.agentDecision.evidence.suppliedBy, 'INTERNAL_COLLECTOR');
  assert.equal(trusted.record.agentDecision.evidence.collector, 'arc-indexer-worker');

  await assert.rejects(app.agentDecisionService.decideTrusted({
    provenance: signalProvenance.OPERATOR_INPUT,
    input,
    idempotencyKey: 'internal-collector-0002',
  }), { code: 'UNTRUSTED_SIGNAL_PROVENANCE' });
  await assert.rejects(app.agentDecisionService.decideTrusted({
    provenance: 'MANUAL_DEMO',
    input,
    idempotencyKey: 'internal-collector-0003',
  }), { code: 'UNKNOWN_SIGNAL_PROVENANCE' });
});

test('internal collector evidence still fails closed on stale timestamps', async () => {
  const result = await app.agentDecisionService.decideTrusted({
    provenance: signalProvenance.ANALYTICS_PIPELINE,
    input: agentDecisionBody({ reference: 'STALE-COLLECTOR' }),
    observedAt: '2020-01-01T00:00:00.000Z',
    idempotencyKey: 'internal-collector-0004',
  });

  assert.equal(result.record.state, 'DENIED');
  assert.deepEqual(
    result.record.policy.reasons.map((reason) => reason.code),
    ['SIGNAL_STALE'],
  );
});

test('the agent decision service refuses to act without an authenticated operator', async () => {
  await assert.rejects(app.agentDecisionService.decideOperator({
    input: agentDecisionBody(),
    operator: {},
    idempotencyKey: 'no-operator-0001',
  }), { code: 'OPERATOR_AUTH_REQUIRED', status: 401 });
});
