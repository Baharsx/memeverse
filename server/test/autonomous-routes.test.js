import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { AgentAutonomyStore } from '../repositories/agent-autonomy-store.js';
import { schemaSql } from '../repositories/schema.js';
import { agentDecisionBody, startTestApp } from './helpers/app.js';
import { authorizedHeaders, signInOperator } from './helpers/operator.js';

/** Quotes and prepares a settlement through the ordinary operator route. */
async function createAwaitingSettlement(fixture, cookie, reference = 'ROUTE-CASE') {
  const response = await fetch(`${fixture.baseUrl}/api/v1/agent/decisions`, {
    method: 'POST',
    headers: authorizedHeaders(cookie, { 'idempotency-key': `route-key-${reference}` }),
    body: JSON.stringify(agentDecisionBody({ reference })),
  });
  const payload = await response.json();
  assert.equal(payload.data.state, 'AWAITING_SIGNATURE');
  return payload.data;
}

/**
 * The HTTP surface of the autonomous agent.
 *
 * These tests are written from the attacker's side of the boundary: they try to make the API
 * pay someone, choose an amount, claim trusted provenance, or select the autonomous execution
 * mode, and assert that none of it is even expressible over HTTP.
 */

async function autonomyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-routes-'));
  const database = new PGlite(directory);
  await database.exec(schemaSql);
  const autonomyStore = new AgentAutonomyStore({ database });
  const autonomousAgentService = {
    async status() {
      const state = await autonomyStore.autonomyState();
      return {
        policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1',
        paused: state.paused,
        pauseReason: state.reason,
        changedAt: state.changedAt,
        caps: {
          perExecutionUsdc: '0.100000',
          minimumUsdc: '0.010000',
          marketDailyUsdc: '0.300000',
          globalDailyUsdc: '1.000000',
          scoreFloor: 70,
          cooldownSeconds: 3600,
        },
        recentEpochs: await autonomyStore.listRecentEpochs(10),
      };
    },
  };
  const app = await startTestApp({ autonomyStore, autonomousAgentService });
  return {
    ...app,
    autonomyStore,
    async close() {
      await app.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('the public autonomy status leaks no operational secrets', async () => {
  const fixture = await autonomyFixture();
  try {
    // No session, no origin header: an ordinary anonymous browser read.
    const response = await fetch(`${fixture.baseUrl}/api/v1/agent/autonomy`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.data.paused, true, 'autonomy reports its fail-safe default');
    assert.equal(body.data.policyVersion, 'AGENT_AUTONOMOUS_POLICY_V1');
    assert.equal(body.data.caps.perExecutionUsdc, '0.100000');

    const serialised = JSON.stringify(body).toLowerCase();
    for (const secret of [
      'apikey', 'entitysecret', 'walletid', 'circle_api', 'privatekey', 'password',
      'postgres://', 'postgresql://', 'kit_key', 'cookie', 'authorization',
    ]) {
      assert.equal(serialised.includes(secret), false, `status must not expose ${secret}`);
    }
  } finally {
    await fixture.close();
  }
});

test('an anonymous caller cannot pause or resume autonomy', async () => {
  const fixture = await autonomyFixture();
  try {
    for (const paused of [false, true]) {
      const response = await fetch(`${fixture.baseUrl}/api/v1/agent/autonomy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
        body: JSON.stringify({ paused }),
      });
      assert.equal(response.status, 401, 'the switch requires an authenticated operator');
    }
    assert.equal((await fixture.autonomyStore.autonomyState()).paused, true);
  } finally {
    await fixture.close();
  }
});

test('an authenticated operator may flip the switch but cannot smuggle a payout into it', async () => {
  const fixture = await autonomyFixture();
  try {
    const session = await signInOperator(fixture.baseUrl);

    const resumed = await fetch(`${fixture.baseUrl}/api/v1/agent/autonomy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5173',
        cookie: session.cookie,
      },
      body: JSON.stringify({ paused: false, reason: 'demo window' }),
    });
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).data.paused, false);
    assert.equal((await fixture.autonomyStore.autonomyState()).paused, false);

    // The switch schema is strict: any attempt to name a market, recipient, amount, or mode is
    // rejected outright rather than quietly ignored.
    for (const body of [
      { paused: false, marketAddress: '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D' },
      { paused: false, recipient: '0x1111111111111111111111111111111111111111' },
      { paused: false, amountUsdc: '25.00' },
      { paused: false, executionMode: 'AUTONOMOUS_POLICY' },
      { paused: false, provenance: 'ONCHAIN_INDEXER' },
      { paused: false, observedAt: '2026-08-06T00:00:00.000Z' },
    ]) {
      const response = await fetch(`${fixture.baseUrl}/api/v1/agent/autonomy`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://127.0.0.1:5173',
          cookie: session.cookie,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, `${Object.keys(body)[1]} must be rejected`);
    }

    const paused = await fetch(`${fixture.baseUrl}/api/v1/agent/autonomy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5173',
        cookie: session.cookie,
      },
      body: JSON.stringify({ paused: true, reason: 'incident' }),
    });
    assert.equal(paused.status, 200);
    assert.equal((await fixture.autonomyStore.autonomyState()).paused, true);
  } finally {
    await fixture.close();
  }
});

test('the execute route accepts no execution mode, recipient, or amount', async () => {
  const fixture = await autonomyFixture();
  try {
    const session = await signInOperator(fixture.baseUrl);
    const settlement = await createAwaitingSettlement(fixture, session.cookie);

    // Every one of these is an attempt to steer execution from the browser. The strict schema
    // refuses each before any authority is resolved.
    for (const body of [
      { authorizationId: 'a'.repeat(32), executionMode: 'AUTONOMOUS_POLICY' },
      { authorizationId: 'a'.repeat(32), recipient: '0x1111111111111111111111111111111111111111' },
      { authorizationId: 'a'.repeat(32), amountUsdc: '25.00' },
      { authorizationId: 'a'.repeat(32), agent: { evidenceDigest: `0x${'11'.repeat(32)}` } },
      { executionMode: 'AUTONOMOUS_POLICY' },
    ]) {
      const response = await fetch(
        `${fixture.baseUrl}/api/v1/settlements/${settlement.id}/execute`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'http://127.0.0.1:5173',
            cookie: session.cookie,
          },
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 400, `${JSON.stringify(body)} must be rejected`);
    }

    assert.deepEqual(fixture.circleGateway.calls, [], 'no provider call was ever made');
    const current = await fixture.store.get(settlement.id);
    assert.equal(current.executionSubmission ?? null, null);
    assert.equal(current.circle ?? null, null);
  } finally {
    await fixture.close();
  }
});

test('no public route can assign trusted signal provenance', async () => {
  const fixture = await autonomyFixture();
  try {
    const session = await signInOperator(fixture.baseUrl);

    // The operator decision route is the only agent write reachable over HTTP. It must refuse
    // to let its caller name the provenance, and must stamp OPERATOR_INPUT itself.
    const response = await fetch(`${fixture.baseUrl}/api/v1/agent/decisions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://127.0.0.1:5173',
        cookie: session.cookie,
        'idempotency-key': 'provenance-attempt-0001',
      },
      body: JSON.stringify({
        recipient: '0x1111111111111111111111111111111111111111',
        requestedAmount: '1.00',
        reference: 'PROVENANCE ATTEMPT',
        signals: {
          engagementVelocity: 90,
          holderRetention: 90,
          liquidityDepth: 90,
          confidence: 95,
          fraudRisk: 1,
          provenance: 'ONCHAIN_INDEXER',
          observedAt: '2020-01-01T00:00:00.000Z',
        },
      }),
    });
    assert.equal(response.status, 400, 'a client-supplied provenance is not even a valid field');
  } finally {
    await fixture.close();
  }
});
