import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { canonicalizeAppOrigin, loadServerConfig } from '../config.js';
import { ReconciliationWorker } from '../domain/reconciliation-worker.js';
import { PostgresOperatorAuthStore } from '../repositories/operator-auth-store.js';
import { PostgresSettlementStore } from '../repositories/postgres-settlement-store.js';

test('APP_ORIGIN is canonicalized to a bare origin', () => {
  assert.equal(canonicalizeAppOrigin('https://app.example.com/'), 'https://app.example.com');
  assert.equal(canonicalizeAppOrigin('https://app.example.com'), 'https://app.example.com');
  assert.equal(canonicalizeAppOrigin('http://127.0.0.1:5173/'), 'http://127.0.0.1:5173');
  assert.equal(canonicalizeAppOrigin('HTTPS://App.Example.com/'), 'https://app.example.com');
  // The default HTTPS port is dropped by URL.origin, keeping comparisons byte-exact.
  assert.equal(canonicalizeAppOrigin('https://app.example.com:443/'), 'https://app.example.com');
  assert.equal(loadServerConfig({ APP_ORIGIN: 'https://app.example.com/' }).appOrigin,
    'https://app.example.com');
});

test('APP_ORIGIN rejects anything that is not an origin', () => {
  const invalid = [
    ['https://app.example.com/memeverse', /must not contain a path/],
    ['https://app.example.com/?next=1', /query string or fragment/],
    ['https://app.example.com/#section', /query string or fragment/],
    ['https://operator:secret@app.example.com', /must not contain credentials/],
    ['ftp://app.example.com', /must use http or https/],
    ['app.example.com', /absolute http\(s\) origin/],
    ['', /absolute http\(s\) origin/],
  ];
  for (const [value, message] of invalid) {
    assert.throws(() => canonicalizeAppOrigin(value), message, `expected "${value}" to be rejected`);
    if (value) assert.throws(() => loadServerConfig({ APP_ORIGIN: value }), message);
  }
});

test('the claim lease and auth cleanup interval are validated and configurable', () => {
  const defaults = loadServerConfig({});
  assert.equal(defaults.executionClaimLeaseSeconds, 120);
  assert.equal(defaults.authCleanupIntervalSeconds, 3600);

  const tuned = loadServerConfig({
    EXECUTION_CLAIM_LEASE_SECONDS: '90',
    AUTH_CLEANUP_INTERVAL_SECONDS: '600',
  });
  assert.equal(tuned.executionClaimLeaseSeconds, 90);
  assert.equal(tuned.authCleanupIntervalSeconds, 600);

  assert.throws(() => loadServerConfig({ EXECUTION_CLAIM_LEASE_SECONDS: '5' }));
  assert.throws(() => loadServerConfig({ EXECUTION_CLAIM_LEASE_SECONDS: '4000' }));
  assert.throws(() => loadServerConfig({ AUTH_CLEANUP_INTERVAL_SECONDS: '1' }));
});

test('expired operator auth records are purged while live records survive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-auth-cleanup-'));
  const database = new PGlite(directory);
  try {
    await new PostgresSettlementStore({ database }).initialize();
    const store = new PostgresOperatorAuthStore({ database });
    const now = new Date('2026-08-04T12:00:00.000Z');
    const nowIso = now.toISOString();
    const longExpired = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const recentlyExpired = new Date(now.getTime() - 60_000).toISOString();
    const live = new Date(now.getTime() + 600_000).toISOString();

    const challenge = (id, expiresAt) => store.createChallenge({
      id,
      nonceHash: `nonce-${id}`,
      message: 'challenge message',
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      origin: 'https://app.example.com',
      chainId: 5042002,
      issuedAt: longExpired,
      expiresAt,
    });
    await challenge('stale-challenge', longExpired);
    await challenge('recent-challenge', recentlyExpired);
    await challenge('live-challenge', live);
    for (const [id, expiresAt] of [['stale-session', longExpired], ['live-session', live]]) {
      await store.createSession({
        id, tokenHash: `hash-${id}`, address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        challengeId: 'live-challenge', createdAt: longExpired, expiresAt,
      });
    }
    for (const [idHash, expiresAt] of [['stale-auth', longExpired], ['live-auth', live]]) {
      await store.createExecutionAuthorization({
        idHash, sessionId: 'live-session', settlementId: 'settlement-1',
        bindingHash: `0x${'11'.repeat(32)}`,
        operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        createdAt: longExpired, expiresAt,
      });
    }

    await store.purgeExpired(nowIso);
    // Repeating the sweep must be harmless, because several processes may run it.
    await store.purgeExpired(nowIso);

    const remaining = async (table, column) => (await database.query(
      `SELECT ${column} AS id FROM ${table} ORDER BY ${column}`,
    )).rows.map((row) => row.id);

    assert.deepEqual(await remaining('operator_auth_challenges', 'id'),
      ['live-challenge', 'recent-challenge']);
    assert.deepEqual(await remaining('operator_sessions', 'id'), ['live-session']);
    assert.deepEqual(await remaining('operator_execution_authorizations', 'id_hash'), ['live-auth']);
    // A live session is still usable after the sweep.
    assert.ok(await store.getActiveSession('hash-live-session', nowIso));
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the worker sweeps auth records on its own interval without disturbing reconciliation', async () => {
  const purges = [];
  const reconciled = [];
  let currentTime = 1_000_000;
  const worker = new ReconciliationWorker({
    store: {
      async claimReconciliationCandidates() { return [{ id: 'settlement-1' }]; },
      async releaseReconciliationLease() {},
    },
    settlementService: { async reconcile(id) { reconciled.push(id); } },
    operatorAuthStore: { async purgeExpired(nowIso) { purges.push(nowIso); } },
    authCleanupIntervalMs: 60_000,
    now: () => currentTime,
    logger: { error() {}, info() {} },
  });

  await worker.runOnce();
  await worker.runOnce();
  assert.equal(purges.length, 1, 'the interval throttles repeated sweeps');

  currentTime += 60_001;
  await worker.runOnce();
  assert.equal(purges.length, 2);
  assert.equal(reconciled.length, 3, 'reconciliation runs on every tick');
});

test('a failing auth sweep is logged and never breaks reconciliation', async () => {
  const logged = [];
  const reconciled = [];
  const worker = new ReconciliationWorker({
    store: {
      async claimReconciliationCandidates() { return [{ id: 'settlement-1' }]; },
      async releaseReconciliationLease() {},
    },
    settlementService: { async reconcile(id) { reconciled.push(id); } },
    operatorAuthStore: {
      async purgeExpired() { throw new Error('connection reset'); },
    },
    logger: { error(line) { logged.push(line); }, info() {} },
  });

  await worker.runOnce();

  assert.equal(reconciled.length, 1);
  assert.equal(logged.length, 1);
  const entry = JSON.parse(logged[0]);
  assert.equal(entry.type, 'auth_cleanup_error');
  // Never a token, nonce, or signature.
  assert.equal(logged[0].includes('nonce'), false);
  assert.equal(logged[0].includes('tokenHash'), false);
});
