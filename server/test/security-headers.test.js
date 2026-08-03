import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  contentSecurityPolicyDirectives,
  serializeContentSecurityPolicy,
} from '../security/csp.js';
import { startTestApp, unlimitedRateLimits } from './helpers/app.js';
import { operatorAccount, originHeaders } from './helpers/operator.js';

let app;

before(async () => {
  app = await startTestApp();
});

after(async () => {
  await app.close();
});

test('responses carry a strict Content Security Policy with no wildcard source', async () => {
  const response = await fetch(`${app.baseUrl}/api/health`);
  const policy = response.headers.get('content-security-policy');
  const directives = Object.fromEntries(
    policy.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(' ');
      return [name, values];
    }),
  );

  assert.deepEqual(directives['default-src'], ["'self'"]);
  assert.deepEqual(directives['script-src'], ["'self'"]);
  assert.deepEqual(directives['object-src'], ["'none'"]);
  assert.deepEqual(directives['base-uri'], ["'self'"]);
  assert.deepEqual(directives['frame-ancestors'], ["'none'"]);
  assert.deepEqual(directives['form-action'], ["'self'"]);
  assert.ok(directives['connect-src'].includes('https://rpc.testnet.arc.io'));
  assert.ok(directives['connect-src'].includes('https://rpc.drpc.testnet.arc.io'));
  // Only the exact web-font hosts the stylesheet imports, and only for styles and font files.
  assert.deepEqual(directives['style-src'], [
    "'self'", "'unsafe-inline'", 'https://api.fontshare.com', 'https://fonts.googleapis.com',
  ]);
  assert.deepEqual(directives['font-src'], [
    "'self'", 'https://cdn.fontshare.com', 'https://fonts.gstatic.com',
  ]);
  assert.equal(directives['style-src'].includes("'unsafe-eval'"), false);
  assert.equal(policy.includes('*'), false);
  assert.equal(policy.includes("'unsafe-eval'"), false);
  assert.equal(policy.includes("script-src 'self' 'unsafe-inline'"), false);
});

test('the shared policy builder emits no wildcard and rejects unknown connect origins', () => {
  const directives = contentSecurityPolicyDirectives({
    connectSources: ['https://app.example/memeverse/', 'not a url', ''],
  });
  const serialized = serializeContentSecurityPolicy(directives);

  assert.ok(directives['connect-src'].includes('https://app.example'));
  assert.equal(directives['connect-src'].includes('not a url'), false);
  assert.equal(serialized.includes('*'), false);
  assert.ok(serialized.includes("frame-ancestors 'none'"));
});

test('standard hardening headers are present and the server does not advertise itself', async () => {
  const response = await fetch(`${app.baseUrl}/api/health`);

  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.ok(response.headers.get('x-request-id'));
});

test('the auth challenge route has its own conservative rate limit', async () => {
  const limited = await startTestApp({
    configOverrides: { rateLimits: { ...unlimitedRateLimits, authChallenge: 3 } },
  });
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${limited.baseUrl}/api/v1/auth/challenge`, {
        method: 'POST',
        headers: originHeaders(),
        body: JSON.stringify({ address: operatorAccount.address }),
      });
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  } finally {
    await limited.close();
  }
});

test('a forged X-Forwarded-For cannot reset a rate limit when no proxy is trusted', async () => {
  const limited = await startTestApp({
    configOverrides: { rateLimits: { ...unlimitedRateLimits, authVerify: 2 }, trustedProxyHopCount: 0 },
  });
  try {
    const attempt = (forwarded) => fetch(`${limited.baseUrl}/api/v1/auth/verify`, {
      method: 'POST',
      headers: originHeaders({ 'x-forwarded-for': forwarded }),
      body: JSON.stringify({ challengeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', signature: '0xdead' }),
    });

    assert.equal((await attempt('10.0.0.1')).status, 401);
    assert.equal((await attempt('10.0.0.2')).status, 401);
    assert.equal((await attempt('10.0.0.3')).status, 429);
  } finally {
    await limited.close();
  }
});

test('the global limit still bounds unauthenticated public traffic', async () => {
  const limited = await startTestApp({ configOverrides: { rateLimits: { ...unlimitedRateLimits, global: 4 } } });
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await fetch(`${limited.baseUrl}/api/v1/config`)).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 429, 429]);
  } finally {
    await limited.close();
  }
});
