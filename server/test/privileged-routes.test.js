import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { agentDecisionBody, startTestApp } from './helpers/app.js';
import { authorizedHeaders, originHeaders, signInOperator } from './helpers/operator.js';

let app;
let cookie;
let settlementId;

const quoteBody = {
  recipient: '0x1111111111111111111111111111111111111111',
  requestedAmount: '1.00',
  viralityScore: 90,
  reference: 'PRIVILEGED-ROUTE-TEST',
};

before(async () => {
  app = await startTestApp();
  ({ cookie } = await signInOperator(app.baseUrl));
  const response = await fetch(`${app.baseUrl}/api/v1/settlements/quote`, {
    method: 'POST',
    headers: authorizedHeaders(cookie, { 'idempotency-key': 'privileged-seed-0001' }),
    body: JSON.stringify(quoteBody),
  });
  settlementId = (await response.json()).data.id;
});

after(async () => {
  await app.close();
});

test('every privileged route denies anonymous callers before business logic', async () => {
  const attempts = [
    ['POST', '/api/v1/settlements/quote', quoteBody, { 'idempotency-key': 'anon-key-0001' }],
    ['POST', '/api/v1/agent/decisions', agentDecisionBody(), { 'idempotency-key': 'anon-key-0002' }],
    ['POST', `/api/v1/settlements/${settlementId}/prepare`, undefined, {}],
    ['POST', `/api/v1/settlements/${settlementId}/execution-authorization`, undefined, {}],
    ['POST', `/api/v1/settlements/${settlementId}/execute`, { authorizationId: 'a'.repeat(43) }, {}],
    ['POST', `/api/v1/settlements/${settlementId}/reconcile`, undefined, {}],
    ['GET', `/api/v1/settlements/${settlementId}`, undefined, {}],
    ['GET', '/api/v1/settlements', undefined, {}],
    ['GET', '/api/v1/circle/wallet', undefined, {}],
  ];

  for (const [method, path, body, extraHeaders] of attempts) {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: originHeaders(extraHeaders),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json();
    assert.equal(response.status, 401, `${method} ${path} should be unauthorized`);
    assert.equal(payload.error.code, 'OPERATOR_AUTH_REQUIRED');
  }
});

test('settlement existence is not leaked to unauthorized callers', async () => {
  const known = await fetch(`${app.baseUrl}/api/v1/settlements/${settlementId}`);
  const unknown = await fetch(`${app.baseUrl}/api/v1/settlements/does-not-exist-at-all`);

  assert.equal(known.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(await known.json().then((body) => body.error), await unknown.json().then((body) => body.error));
});

test('public routes stay reachable without an operator session', async () => {
  const publicRoutes = ['/api/health', '/api/v1/config', '/api/v1/app-kit/capabilities'];
  for (const path of publicRoutes) {
    const response = await fetch(`${app.baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} must remain public`);
  }
  const config = await (await fetch(`${app.baseUrl}/api/v1/config`)).json();
  assert.equal(config.data.operatorAuth.configured, true);
  assert.equal(config.data.agent.signalProvenance, 'SERVER_ASSIGNED');
  assert.equal(config.data.agent.executionMode, 'MANUAL_OPERATOR');
});

test('an authenticated operator reaches every privileged route', async () => {
  const list = await fetch(`${app.baseUrl}/api/v1/settlements`, { headers: { cookie } });
  const listPayload = await list.json();
  const single = await fetch(`${app.baseUrl}/api/v1/settlements/${settlementId}`, {
    headers: { cookie },
  });
  const agent = await fetch(`${app.baseUrl}/api/v1/agent/decisions`, {
    method: 'POST',
    headers: authorizedHeaders(cookie, { 'idempotency-key': 'operator-agent-0001' }),
    body: JSON.stringify(agentDecisionBody()),
  });
  const agentPayload = await agent.json();

  assert.equal(list.status, 200);
  assert.ok(listPayload.meta.count >= 1);
  assert.equal(single.status, 200);
  assert.equal(agent.status, 201);
  assert.equal(agentPayload.data.state, 'AWAITING_SIGNATURE');
});

test('public responses never carry credentials, cookies, or internal wallet identity', async () => {
  const responses = await Promise.all(
    ['/api/health', '/api/v1/config', '/api/v1/app-kit/capabilities']
      .map(async (path) => JSON.stringify(await (await fetch(`${app.baseUrl}${path}`)).json())),
  );
  const forbidden = [
    'KIT_KEY:', 'CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'entitySecret', 'apiKey',
    'walletId', 'wallet-1', 'postgresql://', 'set-cookie', 'memeverse_operator_session',
  ];
  for (const body of responses) {
    for (const token of forbidden) {
      assert.equal(body.includes(token), false, `public response leaked ${token}`);
    }
  }
});

test('detailed Circle wallet data requires an operator session', async () => {
  const anonymous = await fetch(`${app.baseUrl}/api/v1/circle/wallet`);
  const authenticated = await fetch(`${app.baseUrl}/api/v1/circle/wallet`, { headers: { cookie } });
  const payload = await authenticated.json();
  const health = await (await fetch(`${app.baseUrl}/api/health`)).json();

  assert.equal(anonymous.status, 401);
  assert.equal(authenticated.status, 200);
  assert.equal(payload.data.wallet.id, 'wallet-1');
  // The public health probe still reports treasury readiness without any identifier.
  assert.deepEqual(health.circle, { ready: true });
});
