import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createSettlementPolicy } from '../domain/policy.js';
import { SettlementService } from '../domain/settlement-service.js';
import { PostgresSettlementStore } from '../repositories/postgres-settlement-store.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';

const transactionHash = `0x${'ab'.repeat(32)}`;
const circleTransactionId = 'circle-race-1';

/**
 * Holds the first matching write so a second writer can commit ahead of it. This reproduces the
 * exact interleaving the version column exists to defeat: two writers read the same row, and the
 * slower one must not overwrite the newer state.
 */
class GatedSettlementStore {
  constructor(inner) {
    this.inner = inner;
    this.release = null;
    this.holdFor = null;
    this.held = new Promise((resolve) => { this.markHeld = resolve; });
  }

  list() { return this.inner.list(); }
  get(id) { return this.inner.get(id); }
  getByIdempotencyKey(key) { return this.inner.getByIdempotencyKey(key); }
  getByCircleTransactionId(id) { return this.inner.getByCircleTransactionId(id); }
  createIfAbsent(record, options) { return this.inner.createIfAbsent(record, options); }
  listReconciliationCandidates() { return this.inner.listReconciliationCandidates(); }
  claimReconciliationCandidates(options) { return this.inner.claimReconciliationCandidates(options); }
  async releaseReconciliationLease() {}

  async update(record) {
    if (this.holdFor?.(record)) {
      const predicate = this.holdFor;
      this.holdFor = null;
      const wait = new Promise((resolve) => { this.release = resolve; });
      this.markHeld(predicate);
      await wait;
    }
    return this.inner.update(record);
  }
}

async function fixture({ transactions = {}, reconciliation } = {}) {
  const inner = new MemorySettlementStore();
  const store = new GatedSettlementStore(inner);
  let nextTransaction = { id: circleTransactionId, state: 'INITIATED', walletId: 'wallet-1' };
  const circleGateway = {
    async executeSettlement() { return nextTransaction; },
    async getTransaction(id) { return { ...(transactions.reconcile ?? { state: 'SENT' }), id }; },
  };
  const arcIndexer = reconciliation ? { async verify() { return reconciliation; } } : undefined;
  const service = new SettlementService({
    store,
    policy: createSettlementPolicy({
      maxSpendUsdc: '25.00', minViralityScore: 78, creatorShareBps: 6000,
    }),
    chainId: 5042002,
    quoteTtlSeconds: 300,
    circleGateway,
    arcIndexer,
    id: () => 'race-settlement-1',
  });
  const quote = await service.quote({
    recipient: '0x1111111111111111111111111111111111111111',
    requestedAmount: '10.00',
    viralityScore: 90,
    reference: 'RACE-CASE',
  }, 'race-key-0001');
  await service.prepare(quote.record.id);
  await service.execute(quote.record.id, {
    mode: 'MANUAL_OPERATOR',
    operatorAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    authorizationRef: 'a'.repeat(32),
  });
  return { store, service, id: quote.record.id, setTransaction(value) { nextTransaction = value; } };
}

function webhook(state, extra = {}) {
  return { id: circleTransactionId, state, blockchain: 'ARC-TESTNET', ...extra };
}

test('the store rejects a write that carries a stale version', async () => {
  const store = new MemorySettlementStore();
  const created = await store.createIfAbsent({
    id: 'version-1',
    idempotencyKey: 'version-key-1',
    state: 'PREPARED',
    policy: { approved: true },
    amount: { creatorPayoutUnits: '1000000' },
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
  });
  const snapshot = created.record;
  assert.equal(snapshot.version, 0);

  const advanced = await store.update({ ...snapshot, state: 'AWAITING_SIGNATURE' });
  assert.equal(advanced.version, 1);
  await assert.rejects(store.update({ ...snapshot, state: 'CANCELLED' }), {
    code: 'SETTLEMENT_VERSION_CONFLICT', status: 409,
  });
  assert.equal((await store.get('version-1')).state, 'AWAITING_SIGNATURE');
});

test('PostgreSQL enforces the same optimistic concurrency contract', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-race-'));
  const database = new PGlite(directory);
  const store = new PostgresSettlementStore({ database });
  try {
    await store.initialize();
    const created = await store.createIfAbsent({
      id: 'pg-version-1',
      idempotencyKey: 'pg-version-key-1',
      state: 'SENT',
      policy: { approved: true },
      broadcast: true,
      transactionHash,
      circle: { transactionId: circleTransactionId, state: 'SENT' },
      amount: { creatorPayoutUnits: '1000000' },
      createdAt: '2026-08-03T10:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z',
    });
    const snapshot = created.record;
    const confirmed = await store.update({
      ...snapshot,
      state: 'CONFIRMED',
      circle: { ...snapshot.circle, state: 'CONFIRMED' },
    });

    assert.equal(confirmed.version, 1);
    await assert.rejects(store.update({ ...snapshot, state: 'QUEUED', transactionHash: null }), {
      code: 'SETTLEMENT_VERSION_CONFLICT',
    });
    const current = await store.get('pg-version-1');
    assert.equal(current.state, 'CONFIRMED');
    assert.equal(current.transactionHash, transactionHash);
    assert.equal(current.version, 1);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a stale worker snapshot cannot overwrite newer webhook evidence', async () => {
  const { store, service, id } = await fixture({
    transactions: { reconcile: { state: 'SENT', blockchain: 'ARC-TESTNET', txHash: transactionHash } },
  });
  store.holdFor = (record) => record.circle?.state === 'SENT';

  const worker = service.reconcile(id);
  await store.held;
  await service.applyCircleNotification(webhook('CONFIRMED', { txHash: transactionHash }));
  store.release();
  await worker;

  const final = await service.get(id);
  assert.equal(final.state, 'CONFIRMED');
  assert.equal(final.circle.state, 'CONFIRMED');
  assert.equal(final.transactionHash, transactionHash);
  assert.equal(final.broadcast, true);
  assert.equal(final.history.at(-1).state, 'CONFIRMED');
});

test('a stale webhook cannot erase a newer verified reconciliation or regress COMPLETE', async () => {
  const { service, id } = await fixture({
    reconciliation: { status: 'VERIFIED', blockNumber: 500, transactionHash },
  });
  await service.applyCircleNotification(webhook('COMPLETE', { txHash: transactionHash }));
  const completed = await service.get(id);
  assert.equal(completed.state, 'COMPLETE');
  assert.equal(completed.reconciliation.status, 'VERIFIED');
  assert.equal(completed.reservation.status, 'CONSUMED');

  for (const staleState of ['SENT', 'QUEUED', 'CONFIRMED', 'INITIATED']) {
    await service.applyCircleNotification(webhook(staleState));
    const current = await service.get(id);
    assert.equal(current.state, 'COMPLETE', `${staleState} must not regress COMPLETE`);
    assert.equal(current.circle.state, 'COMPLETE');
    assert.equal(current.reconciliation.status, 'VERIFIED');
    assert.equal(current.transactionHash, transactionHash);
    assert.equal(current.reservation.status, 'CONSUMED');
  }
});

test('a post-broadcast failure holds its reservation and cannot be resurrected', async () => {
  const { service, id } = await fixture();
  await service.applyCircleNotification(webhook('SENT', { txHash: transactionHash }));
  await service.applyCircleNotification(webhook('FAILED', {
    txHash: transactionHash,
    errorReason: 'INSUFFICIENT_FUNDS',
  }));
  const failed = await service.get(id);

  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.circle.state, 'FAILED');
  assert.equal(failed.circle.errorReason, 'INSUFFICIENT_FUNDS');
  assert.equal(failed.reservation.status, 'HELD');

  await service.applyCircleNotification(webhook('CONFIRMED', { txHash: transactionHash }));
  const afterStaleSuccess = await service.get(id);
  assert.equal(afterStaleSuccess.state, 'FAILED');
  assert.equal(afterStaleSuccess.circle.state, 'FAILED');
  assert.equal(afterStaleSuccess.circle.errorReason, 'INSUFFICIENT_FUNDS');
  assert.equal(afterStaleSuccess.reservation.status, 'HELD');
  assert.equal(afterStaleSuccess.transactionHash, transactionHash);
});

test('duplicate and out-of-order notifications converge on one monotonic record', async () => {
  const { service, id } = await fixture();
  const deliveries = ['SENT', 'QUEUED', 'SENT', 'CONFIRMED', 'INITIATED', 'CONFIRMED', 'QUEUED'];
  for (const state of deliveries) {
    await service.applyCircleNotification(webhook(state, {
      txHash: state === 'SENT' ? transactionHash : undefined,
    }));
  }
  const final = await service.get(id);
  const observedStates = final.history.map((entry) => entry.state);

  assert.equal(final.state, 'CONFIRMED');
  assert.equal(final.circle.state, 'CONFIRMED');
  assert.equal(final.transactionHash, transactionHash);
  assert.deepEqual(observedStates, ['PREPARED', 'AWAITING_SIGNATURE', 'INITIATED', 'SENT', 'CONFIRMED']);
});

test('simultaneous reconciliation workers and a webhook keep a single valid record', async () => {
  const { service, id } = await fixture({
    transactions: { reconcile: { state: 'CONFIRMED', blockchain: 'ARC-TESTNET', txHash: transactionHash } },
    reconciliation: { status: 'VERIFIED', blockNumber: 777, transactionHash },
  });

  const results = await Promise.allSettled([
    service.reconcile(id),
    service.reconcile(id),
    service.applyCircleNotification(webhook('SENT', { txHash: transactionHash })),
    service.reconcile(id),
  ]);
  assert.equal(results.every((result) => result.status === 'fulfilled'), true,
    results.map((result) => result.reason?.message).join(' | '));

  const final = await service.get(id);
  assert.equal(final.state, 'COMPLETE');
  assert.equal(final.circle.state, 'CONFIRMED');
  assert.equal(final.reconciliation.status, 'VERIFIED');
  assert.equal(final.reconciliation.blockNumber, 777);
  assert.equal(final.transactionHash, transactionHash);
  assert.equal(final.reservation.status, 'CONSUMED');
  assert.equal(final.history.filter((entry) => entry.state === 'COMPLETE').length, 1);
});

test('a later provider snapshot without a hash preserves the recorded transaction hash', async () => {
  const { service, id } = await fixture();
  await service.applyCircleNotification(webhook('SENT', { txHash: transactionHash }));
  await service.applyCircleNotification(webhook('CONFIRMED'));
  const final = await service.get(id);

  assert.equal(final.transactionHash, transactionHash);
  assert.equal(final.circle.transactionId, circleTransactionId);
  assert.equal(final.circle.walletId, 'wallet-1');
  assert.equal(final.broadcast, true);
});

test('a mismatched Circle transaction ID never overwrites the recorded one', async () => {
  const { service, id } = await fixture();
  await assert.rejects(
    service.applyCircleTransaction(id, { id: 'circle-other', state: 'CONFIRMED' }, 'TEST'),
    { code: 'CIRCLE_TRANSACTION_MISMATCH', status: 502 },
  );
  assert.equal((await service.get(id)).circle.transactionId, circleTransactionId);
});
