import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PostgresSettlementStore } from '../repositories/postgres-settlement-store.js';

function record(id, key) {
  const timestamp = '2026-08-02T10:00:00.000Z';
  return {
    id,
    idempotencyKey: key,
    state: 'PREPARED',
    policy: { approved: true },
    amount: { creatorPayoutUnits: '6000000' },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

test('embedded Postgres persists records and serializes treasury reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-pglite-'));
  const database = new PGlite(directory);
  const store = new PostgresSettlementStore({ database });
  try {
    await store.initialize();
    await store.initialize({ migrate: false });
    const results = await Promise.allSettled([
      store.createIfAbsent(record('record-a', 'reserve-key-a'), { treasuryAvailableUnits: 10000000n }),
      store.createIfAbsent(record('record-b', 'reserve-key-b'), { treasuryAvailableUnits: 10000000n }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'TREASURY_CAPACITY_EXCEEDED');
    const records = await store.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].reservation.status, 'ACTIVE');

    const released = {
      ...records[0],
      state: 'EXPIRED',
      updatedAt: '2026-08-02T10:06:00.000Z',
    };
    await store.update(released);
    assert.equal((await store.get(released.id)).reservation.status, 'RELEASED');

    const agentRecord = { ...record('agent-a', 'agent-key-a'), agentDecision: { version: 'V2' } };
    await store.createIfAbsent(agentRecord, { agentDailyCapUnits: 10_000_000n });
    await assert.rejects(
      store.createIfAbsent(
        { ...record('agent-b', 'agent-key-b'), agentDecision: { version: 'V2' } },
        { agentDailyCapUnits: 10_000_000n },
      ),
      { code: 'AGENT_DAILY_CAP_EXCEEDED' },
    );

    const submitted = {
      ...(await store.get('agent-a')),
      state: 'SENT',
      circle: { transactionId: 'circle-agent-a' },
      updatedAt: '2026-08-02T10:07:00.000Z',
    };
    await store.update(submitted);
    const claimed = await store.claimReconciliationCandidates({
      owner: 'worker-a', leaseSeconds: 30, limit: 10,
    });
    assert.equal(claimed.some((candidate) => candidate.id === 'agent-a'), true);
    const duplicateClaim = await store.claimReconciliationCandidates({
      owner: 'worker-b', leaseSeconds: 30, limit: 10,
    });
    assert.equal(duplicateClaim.some((candidate) => candidate.id === 'agent-a'), false);
    await store.releaseReconciliationLease('agent-a', 'worker-a');

    let notificationCalls = 0;
    const firstNotification = await store.processOnce('notification-1', async () => {
      notificationCalls += 1;
      return { matched: true };
    });
    const replayedNotification = await store.processOnce('notification-1', async () => {
      notificationCalls += 1;
      return { matched: false };
    });
    assert.equal(firstNotification.replayed, false);
    assert.equal(replayedNotification.replayed, true);
    assert.equal(notificationCalls, 1);

    const failedAfterBroadcast = {
      ...(await store.get('agent-a')),
      state: 'FAILED',
      broadcast: true,
      updatedAt: '2026-08-02T10:08:00.000Z',
    };
    await store.update(failedAfterBroadcast);
    assert.equal((await store.get('agent-a')).reservation.status, 'HELD');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
