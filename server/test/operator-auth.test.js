import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { OPERATOR_SESSION_COOKIE } from '../security/cookies.js';
import { startTestApp } from './helpers/app.js';
import {
  authorizedHeaders,
  createTestOperatorAuthService,
  operatorAccount,
  originHeaders,
  outsiderAccount,
  sessionCookieFrom,
  signInOperator,
  testAppOrigin,
} from './helpers/operator.js';

let app;
let cookie;

async function challengeFor(address, baseUrl = app.baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: originHeaders(),
    body: JSON.stringify({ address }),
  });
  return { response, payload: await response.json() };
}

function verify(body, baseUrl = app.baseUrl) {
  return fetch(`${baseUrl}/api/v1/auth/verify`, {
    method: 'POST',
    headers: originHeaders(),
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

test('challenge binds identity, origin, chain, scope, expiry, and a random nonce', async () => {
  const first = await challengeFor(operatorAccount.address);
  const second = await challengeFor(operatorAccount.address);

  assert.equal(first.response.status, 201);
  assert.match(first.payload.data.message, /^127\.0\.0\.1:5173 wants you to sign in/);
  assert.ok(first.payload.data.message.includes(operatorAccount.address));
  assert.ok(first.payload.data.message.includes(`URI: ${testAppOrigin}`));
  assert.ok(first.payload.data.message.includes('Chain ID: 5042002'));
  assert.ok(first.payload.data.message.includes('Scope: SETTLEMENT_OPERATOR_SESSION'));
  assert.ok(first.payload.data.message.includes('Expires At:'));
  assert.notEqual(first.payload.data.challengeId, second.payload.data.challengeId);
  const nonceOf = (payload) => payload.data.message.match(/Nonce: (\S+)/)[1];
  assert.notEqual(nonceOf(first.payload), nonceOf(second.payload));
  assert.ok(nonceOf(first.payload).length >= 32);
});

test('challenge rejects a malformed address', async () => {
  const { response, payload } = await challengeFor('not-an-address');
  assert.equal(response.status, 400);
  assert.equal(payload.error.code, 'INVALID_OPERATOR_ADDRESS');
});

test('a valid operator signature creates a hardened session cookie', async () => {
  const { payload } = await challengeFor(operatorAccount.address);
  const signature = await operatorAccount.signMessage({ message: payload.data.message });
  const response = await verify({ challengeId: payload.data.challengeId, signature });
  const body = await response.json();
  const setCookie = response.headers.getSetCookie()
    .find((value) => value.startsWith(`${OPERATOR_SESSION_COOKIE}=`));

  assert.equal(response.status, 200);
  assert.equal(body.data.authenticated, true);
  assert.equal(body.data.operatorAddress, operatorAccount.address);
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('SameSite=Strict'));
  assert.ok(setCookie.includes('Path=/'));
  assert.equal(setCookie.includes('Secure'), false);
  assert.equal(JSON.stringify(body).includes(setCookie.split('=')[1].split(';')[0]), false);
});

test('the session cookie is Secure when the deployment is production', async () => {
  const secureApp = await startTestApp({ configOverrides: { secureCookies: true } });
  try {
    const { payload } = await challengeFor(operatorAccount.address, secureApp.baseUrl);
    const signature = await operatorAccount.signMessage({ message: payload.data.message });
    const response = await verify(
      { challengeId: payload.data.challengeId, signature },
      secureApp.baseUrl,
    );
    assert.equal(response.status, 200);
    assert.ok(sessionCookieFrom(response));
    assert.ok(response.headers.getSetCookie()[0].includes('Secure'));
  } finally {
    await secureApp.close();
  }
});

test('a non-operator wallet receives a generic unauthorized response', async () => {
  const { response: challengeResponse, payload } = await challengeFor(outsiderAccount.address);
  const signature = await outsiderAccount.signMessage({ message: payload.data.message });
  const response = await verify({ challengeId: payload.data.challengeId, signature });
  const body = await response.json();

  // The challenge itself must not reveal who the configured operator is.
  assert.equal(challengeResponse.status, 201);
  assert.equal(response.status, 401);
  assert.equal(body.error.code, 'OPERATOR_AUTH_FAILED');
  assert.equal(body.error.message, 'Operator authentication failed.');
  assert.equal(response.headers.getSetCookie().length, 0);
});

test('a signature from the wrong key over an operator challenge is rejected', async () => {
  const { payload } = await challengeFor(operatorAccount.address);
  const signature = await outsiderAccount.signMessage({ message: payload.data.message });
  const response = await verify({ challengeId: payload.data.challengeId, signature });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'OPERATOR_AUTH_FAILED');
});

test('a signature over a modified message is rejected', async () => {
  const { payload } = await challengeFor(operatorAccount.address);
  const tampered = payload.data.message.replace('Chain ID: 5042002', 'Chain ID: 1');
  const signature = await operatorAccount.signMessage({ message: tampered });
  const response = await verify({ challengeId: payload.data.challengeId, signature });

  assert.equal(response.status, 401);
});

test('a challenge is single use and a replayed signature fails', async () => {
  const { payload } = await challengeFor(operatorAccount.address);
  const signature = await operatorAccount.signMessage({ message: payload.data.message });
  const first = await verify({ challengeId: payload.data.challengeId, signature });
  const replay = await verify({ challengeId: payload.data.challengeId, signature });

  assert.equal(first.status, 200);
  assert.equal(replay.status, 401);
});

test('a failed attempt burns the challenge so it cannot be retried', async () => {
  const { payload } = await challengeFor(operatorAccount.address);
  const wrong = await outsiderAccount.signMessage({ message: payload.data.message });
  const right = await operatorAccount.signMessage({ message: payload.data.message });

  assert.equal((await verify({ challengeId: payload.data.challengeId, signature: wrong })).status, 401);
  assert.equal((await verify({ challengeId: payload.data.challengeId, signature: right })).status, 401);
});

test('an expired challenge is rejected', async () => {
  let currentTime = new Date('2026-08-03T10:00:00.000Z');
  const expiringApp = await startTestApp({
    operatorAuthService: createTestOperatorAuthService({
      challengeTtlSeconds: 60,
      now: () => currentTime,
    }),
  });
  try {
    const { payload } = await challengeFor(operatorAccount.address, expiringApp.baseUrl);
    const signature = await operatorAccount.signMessage({ message: payload.data.message });
    currentTime = new Date(currentTime.getTime() + 61_000);
    const response = await verify(
      { challengeId: payload.data.challengeId, signature },
      expiringApp.baseUrl,
    );
    assert.equal(response.status, 401);
  } finally {
    await expiringApp.close();
  }
});

test('an unknown challenge ID and a malformed signature both fail generically', async () => {
  const signature = `0x${'ab'.repeat(65)}`;
  const unknown = await verify({ challengeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', signature });
  const malformed = await verify({ challengeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', signature: '0xdead' });

  assert.equal(unknown.status, 401);
  assert.equal(malformed.status, 401);
  assert.equal((await malformed.json()).error.code, 'OPERATOR_AUTH_FAILED');
});

test('the session endpoint returns sanitized status and never a token', async () => {
  const anonymous = await fetch(`${app.baseUrl}/api/v1/auth/session`);
  const anonymousBody = await anonymous.json();
  const authenticated = await fetch(`${app.baseUrl}/api/v1/auth/session`, {
    headers: { cookie },
  });
  const authenticatedBody = await authenticated.json();

  assert.deepEqual(anonymousBody.data, {
    authenticated: false, operatorAddress: null, expiresAt: null,
  });
  assert.equal(authenticatedBody.data.authenticated, true);
  assert.equal(authenticatedBody.data.operatorAddress, operatorAccount.address);
  assert.ok(authenticatedBody.data.expiresAt);
  assert.equal(JSON.stringify(authenticatedBody).includes(cookie.split('=')[1]), false);
});

test('a forged or modified cookie is rejected', async () => {
  const forged = `${OPERATOR_SESSION_COOKIE}=${'z'.repeat(43)}`;
  const modified = `${cookie.slice(0, -1)}${cookie.at(-1) === 'A' ? 'B' : 'A'}`;

  for (const candidate of [forged, modified, `${OPERATOR_SESSION_COOKIE}=`]) {
    const response = await fetch(`${app.baseUrl}/api/v1/settlements`, {
      headers: { cookie: candidate },
    });
    assert.equal(response.status, 401, `expected ${candidate.slice(0, 40)} to be rejected`);
    assert.equal((await response.json()).error.code, 'OPERATOR_AUTH_REQUIRED');
  }
});

test('logout revokes the session for every later request', async () => {
  const session = await signInOperator(app.baseUrl);
  const before = await fetch(`${app.baseUrl}/api/v1/settlements`, { headers: { cookie: session.cookie } });
  const logout = await fetch(`${app.baseUrl}/api/v1/auth/logout`, {
    method: 'POST',
    headers: authorizedHeaders(session.cookie),
  });
  const afterLogout = await fetch(`${app.baseUrl}/api/v1/settlements`, {
    headers: { cookie: session.cookie },
  });

  assert.equal(before.status, 200);
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie()[0].includes('Max-Age=0'));
  assert.equal(afterLogout.status, 401);
});

test('an expired session is rejected', async () => {
  let currentTime = new Date('2026-08-03T10:00:00.000Z');
  const expiringApp = await startTestApp({
    operatorAuthService: createTestOperatorAuthService({
      sessionTtlSeconds: 300,
      now: () => currentTime,
    }),
  });
  try {
    const session = await signInOperator(expiringApp.baseUrl);
    const before = await fetch(`${expiringApp.baseUrl}/api/v1/settlements`, {
      headers: { cookie: session.cookie },
    });
    currentTime = new Date(currentTime.getTime() + 301_000);
    const afterExpiry = await fetch(`${expiringApp.baseUrl}/api/v1/settlements`, {
      headers: { cookie: session.cookie },
    });

    assert.equal(before.status, 200);
    assert.equal(afterExpiry.status, 401);
  } finally {
    await expiringApp.close();
  }
});

test('a rotated operator address invalidates existing sessions', async () => {
  const authService = createTestOperatorAuthService();
  const rotatingApp = await startTestApp({ operatorAuthService: authService });
  try {
    const session = await signInOperator(rotatingApp.baseUrl);
    authService.operatorAddress = outsiderAccount.address;
    const response = await fetch(`${rotatingApp.baseUrl}/api/v1/settlements`, {
      headers: { cookie: session.cookie },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'OPERATOR_FORBIDDEN');
  } finally {
    await rotatingApp.close();
  }
});

test('operator authentication fails closed when no operator address is configured', async () => {
  const unconfigured = await startTestApp({
    operatorAuthService: createTestOperatorAuthService({ operatorAddress: undefined }),
  });
  try {
    const challenge = await fetch(`${unconfigured.baseUrl}/api/v1/auth/challenge`, {
      method: 'POST',
      headers: originHeaders(),
      body: JSON.stringify({ address: operatorAccount.address }),
    });
    const settlements = await fetch(`${unconfigured.baseUrl}/api/v1/settlements`);

    assert.equal(challenge.status, 503);
    assert.equal((await challenge.json()).error.code, 'OPERATOR_AUTH_NOT_CONFIGURED');
    assert.equal(settlements.status, 401);
  } finally {
    await unconfigured.close();
  }
});

test('cross-origin and origin-less privileged writes are blocked before business logic', async () => {
  const crossOrigin = await fetch(`${app.baseUrl}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ address: operatorAccount.address }),
  });
  const missingOrigin = await fetch(`${app.baseUrl}/api/v1/settlements/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': 'csrf-key-0001' },
    body: JSON.stringify({
      recipient: '0x1111111111111111111111111111111111111111',
      requestedAmount: '1.00',
      viralityScore: 90,
      reference: 'CSRF-ATTEMPT',
    }),
  });
  const crossOriginExecute = await fetch(`${app.baseUrl}/api/v1/settlements/anything/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie },
    body: JSON.stringify({ authorizationId: 'a'.repeat(43) }),
  });

  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, 'CROSS_ORIGIN_BLOCKED');
  assert.equal(missingOrigin.status, 403);
  assert.equal((await missingOrigin.json()).error.code, 'ORIGIN_REQUIRED');
  assert.equal(crossOriginExecute.status, 403);
});
