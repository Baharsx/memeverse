import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { OperatorAuthService } from '../../domain/operator-auth-service.js';
import { MemoryOperatorAuthStore } from '../../repositories/operator-auth-store.js';
import { OPERATOR_SESSION_COOKIE } from '../../security/cookies.js';

// The two published Hardhat/Anvil development keys. They are public knowledge, hold nothing on
// any network, and exist here only so signature tests stay deterministic without real secrets.
export const operatorAccount = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
export const outsiderAccount = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

export const testAppOrigin = 'http://127.0.0.1:5173';

export function createTestOperatorAuthService(overrides = {}) {
  return new OperatorAuthService({
    store: new MemoryOperatorAuthStore(),
    operatorAddress: operatorAccount.address,
    appOrigin: testAppOrigin,
    chainId: 5042002,
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 1200,
    executionTtlSeconds: 180,
    ...overrides,
  });
}

export function originHeaders(extra = {}) {
  return { 'content-type': 'application/json', origin: testAppOrigin, ...extra };
}

export function sessionCookieFrom(response) {
  const cookie = response.headers.getSetCookie()
    .find((value) => value.startsWith(`${OPERATOR_SESSION_COOKIE}=`));
  assert.ok(cookie, 'expected an operator session cookie');
  return cookie.split(';')[0];
}

/** Completes the full challenge → wallet signature → session cookie flow over HTTP. */
export async function signInOperator(baseUrl, account = operatorAccount) {
  const challengeResponse = await fetch(`${baseUrl}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: originHeaders(),
    body: JSON.stringify({ address: account.address }),
  });
  const challenge = (await challengeResponse.json()).data;
  const signature = await account.signMessage({ message: challenge.message });
  const verifyResponse = await fetch(`${baseUrl}/api/v1/auth/verify`, {
    method: 'POST',
    headers: originHeaders(),
    body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
  });
  assert.equal(verifyResponse.status, 200, 'operator sign-in should succeed');
  return { cookie: sessionCookieFrom(verifyResponse), challenge, signature };
}

export function authorizedHeaders(cookie, extra = {}) {
  return originHeaders({ cookie, ...extra });
}
