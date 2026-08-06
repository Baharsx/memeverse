import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DomainError } from '../domain/errors.js';
import { PostgresSettlementStore } from '../repositories/postgres-settlement-store.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';
import {
  authority,
  gate,
  lifecycleFixture,
  operatorAddress,
  otherOperator,
  recordingGateway,
  settle,
  transactionHash,
} from './helpers/lifecycle.js';

/** Advances the shared clock in heartbeat-sized steps, running every beat that falls due. */
async function elapse(fixture, seconds, stepSeconds = 5) {
  for (let elapsed = 0; elapsed < seconds; elapsed += stepSeconds) {
    fixture.clock.advance(stepSeconds);
    await fixture.scheduler.fire();
  }
}

/** Every code path that can decide a settlement has expired. */
async function runEveryExpiryPath(fixture, quoteSequence) {
  await fixture.service.get(fixture.id);
  await fixture.service.list();
  await fixture.service.releaseExpiredReservations();
  await fixture.service.quote({
    recipient: '0x2222222222222222222222222222222222222222',
    requestedAmount: '1.00',
    viralityScore: 90,
    reference: `SWEEP-${quoteSequence}`,
  }, `lifecycle-sweep-${quoteSequence}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote expiry versus execution lifecycle
// ─────────────────────────────────────────────────────────────────────────────

test('a provider call that crosses the quote TTL keeps its claim, reservation, and result', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 60 });
  const { service, id } = fixture;

  const submission = service.execute(id, authority('winner'));
  await settle();
  const claimed = await service.get(id);
  assert.equal(claimed.executionSubmission.status, 'CLAIMED');

  // Cross the original quote expiry while the provider call is still open.
  await elapse(fixture, 90);
  assert.ok(fixture.clock.now.getTime() > new Date(fixture.expiresAt).getTime());
  await runEveryExpiryPath(fixture, 1);

  const duringCall = await service.get(id);
  assert.equal(duringCall.state, 'AWAITING_SIGNATURE', 'an in-flight execution never expires');
  assert.equal(duringCall.reservation.status, 'ACTIVE', 'treasury capacity stays reserved');
  assert.equal(duringCall.executionSubmission.status, 'CLAIMED');
  assert.equal(duringCall.executionSubmission.claimId, claimed.executionSubmission.claimId);
  assert.equal(duringCall.executionAuthorization.authorizationRef, authority('winner').authorizationRef);

  provider.open();
  const executed = await submission;

  assert.equal(gateway.executeCalls.length, 1);
  assert.equal(executed.circle.transactionId, `circle-${id}`, 'the provider result still persists');
  const final = await service.get(id);
  assert.equal(final.circle.transactionId, `circle-${id}`);
  assert.equal(final.executionSubmission.status, 'SUBMITTED');
  assert.equal(final.state, 'INITIATED');
  assert.equal(final.history.some((entry) => entry.state === 'EXPIRED'), false);
});

test('an unknown provider outcome survives the quote TTL and stays recoverable', async () => {
  const gateway = recordingGateway({
    async onExecute(record, callNumber) {
      if (callNumber === 1) {
        throw new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
          status: 502, details: { operation: 'transfer' },
        });
      }
      return { id: `circle-${record.id}`, state: 'SENT', txHash: transactionHash, walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 60 });
  const { service, id } = fixture;

  await assert.rejects(service.execute(id, authority('lost')), { code: 'CIRCLE_REQUEST_FAILED' });
  assert.equal((await service.get(id)).executionSubmission.status, 'UNKNOWN_OUTCOME');

  // Past the quote TTL and past the claim lease: the outcome is still undetermined.
  fixture.clock.advance(120);
  await runEveryExpiryPath(fixture, 2);

  const undetermined = await service.get(id);
  assert.equal(undetermined.state, 'AWAITING_SIGNATURE', 'an unknown outcome never expires');
  assert.equal(undetermined.reservation.status, 'ACTIVE');
  assert.equal(undetermined.executionSubmission.status, 'UNKNOWN_OUTCOME');

  const recovered = await service.execute(id, authority('recovery'));
  assert.equal(gateway.executeCalls.length, 2);
  assert.deepEqual(gateway.executeCalls.map((call) => call.idempotencyKey), [id, id]);
  assert.equal(recovered.circle.transactionId, `circle-${id}`);
  assert.equal(recovered.transactionHash, transactionHash);
  assert.equal((await service.get(id)).reservation.status, 'ACTIVE');
});

test('a claim released before the provider was reached expires on the original quote TTL', async () => {
  const gateway = recordingGateway({
    async onExecute() {
      throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
        status: 503,
      });
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 60 });
  const { service, id } = fixture;

  await assert.rejects(service.execute(id, authority('blocked')), { code: 'CIRCLE_NOT_CONFIGURED' });
  const released = await service.get(id);
  assert.equal(released.executionSubmission.status, 'RELEASED');
  assert.equal(released.state, 'AWAITING_SIGNATURE', 'still live while the quote is valid');
  assert.equal(released.reservation.status, 'ACTIVE');

  fixture.clock.advance(61);
  const expired = await service.get(id);

  assert.equal(expired.state, 'EXPIRED', 'a provably unreached provider restores quote TTL');
  assert.equal(expired.reservation.status, 'RELEASED', 'capacity returns to the treasury');
  assert.equal(expired.history.at(-1).reason, 'QUOTE_TTL_ELAPSED');
});

test('a settlement completing after its original TTL is COMPLETE, never EXPIRED', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'COMPLETE', txHash: transactionHash };
    },
  });
  const fixture = await lifecycleFixture({
    gateway,
    quoteTtlSeconds: 60,
    arcIndexer: { async verify() { return { status: 'VERIFIED', blockNumber: 900, transactionHash }; } },
  });
  const { service, id } = fixture;

  const submission = service.execute(id, authority('slow'));
  await settle();
  await elapse(fixture, 120);
  await runEveryExpiryPath(fixture, 3);
  provider.open();
  const completed = await submission;

  assert.equal(completed.state, 'COMPLETE');
  const final = await service.get(id);
  assert.equal(final.state, 'COMPLETE');
  assert.equal(final.reservation.status, 'CONSUMED');
  assert.equal(final.history.some((entry) => entry.state === 'EXPIRED'), false);
});

test('an execution claimed one millisecond before expiry is protected by that claim', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 60 });
  const { service, id } = fixture;

  // The last instant at which execution may legitimately begin.
  fixture.clock.advance(59.999);
  const submission = service.execute(id, authority('just-in-time'));
  await settle();
  assert.equal((await service.get(id)).executionSubmission.status, 'CLAIMED');

  fixture.clock.advance(0.002);
  assert.ok(fixture.clock.now.getTime() > new Date(fixture.expiresAt).getTime());
  await runEveryExpiryPath(fixture, 10);

  const held = await service.get(id);
  assert.equal(held.state, 'AWAITING_SIGNATURE');
  assert.equal(held.reservation.status, 'ACTIVE');

  provider.open();
  await submission;
  assert.equal((await service.get(id)).circle.transactionId, `circle-${id}`);
});

test('quote cleanup holding a stale snapshot cannot expire a settlement claimed since', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 60 });
  const { service, store, id } = fixture;

  // The snapshot a sweep would have read just before the claim landed.
  const staleSnapshot = await store.get(id);
  assert.equal(staleSnapshot.executionSubmission ?? null, null);

  const submission = service.execute(id, authority('claimant'));
  await settle();
  fixture.clock.advance(61);

  // The sweep now believes it is looking at an unclaimed, lapsed quote. It re-reads under the
  // row version before writing, so it finds the claim and stands down.
  await service.expireIfNeeded(staleSnapshot);

  const current = await service.get(id);
  assert.equal(current.state, 'AWAITING_SIGNATURE');
  assert.equal(current.reservation.status, 'ACTIVE');
  assert.equal(current.executionSubmission.status, 'CLAIMED');

  provider.open();
  await submission;
  assert.equal((await service.get(id)).circle.transactionId, `circle-${id}`);
});

test('an undetermined execution past its TTL still consumes treasury capacity in PostgreSQL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-lifecycle-'));
  const database = new PGlite(directory);
  const store = new PostgresSettlementStore({ database });
  try {
    await store.initialize();
    const gateway = recordingGateway({
      treasuryAvailableUnits: 10_000_000n,
      async onExecute() {
        throw new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
          status: 502,
        });
      },
    });
    const fixture = await lifecycleFixture({ gateway, store, quoteTtlSeconds: 60 });
    const { service, id } = fixture;

    await assert.rejects(service.execute(id, authority('unknown')), { code: 'CIRCLE_REQUEST_FAILED' });
    assert.equal((await service.get(id)).executionSubmission.status, 'UNKNOWN_OUTCOME');

    // Well past the quote TTL: the reservation must still count against the treasury, because
    // Circle may already have accepted the payout.
    fixture.clock.advance(600);
    await assert.rejects(
      service.quote({
        recipient: '0x2222222222222222222222222222222222222222',
        requestedAmount: '10.00',
        viralityScore: 90,
        reference: 'CAPACITY-CASE',
      }, 'lifecycle-capacity-0001'),
      { code: 'TREASURY_CAPACITY_EXCEEDED' },
    );
    assert.equal((await store.get(id)).reservation.status, 'ACTIVE');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution claim heartbeat
// ─────────────────────────────────────────────────────────────────────────────

test('a healthy claimant renews its lease across a provider call far longer than the lease', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const fixture = await lifecycleFixture({
    gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30, executionClaimHeartbeatSeconds: 5,
  });
  const { service, store, id } = fixture;

  const submission = service.execute(id, authority('healthy'));
  await settle();
  const claimed = await store.get(id);
  const firstLease = claimed.executionSubmission.leaseExpiresAt;

  // Five times the lease, with the provider still blocked.
  for (let step = 0; step < 30; step += 1) {
    fixture.clock.advance(5);
    await fixture.scheduler.fire();
    const held = await store.get(id);
    assert.ok(
      new Date(held.executionSubmission.leaseExpiresAt).getTime() > fixture.clock.now.getTime(),
      `lease must stay ahead of the clock at step ${step}`,
    );
    await assert.rejects(
      service.execute(id, authority(`thief-${step}`, { operatorAddress: otherOperator })),
      { code: 'EXECUTION_ALREADY_CLAIMED', status: 409 },
    );
  }

  const renewed = await store.get(id);
  assert.notEqual(renewed.executionSubmission.leaseExpiresAt, firstLease, 'the lease was renewed');
  assert.equal(renewed.executionSubmission.claimId, claimed.executionSubmission.claimId);
  assert.equal(gateway.executeCalls.length, 1, 'a slow call is never duplicated');

  provider.open();
  const executed = await submission;
  assert.equal(executed.executionSubmission.status, 'SUBMITTED');
  assert.equal(executed.circle.transactionId, `circle-${id}`);
  assert.equal(fixture.scheduler.pending, 0, 'the heartbeat stops with the provider call');
});

test('a claimant that stops beating becomes recoverable only after its lease expires', async () => {
  const gateway = recordingGateway();
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30 });
  const { service, id } = fixture;

  // A process that persisted its claim and died: no beats will ever be fired for it.
  const claim = await service.claimExecution(id, authority('crashed'));
  assert.equal(claim.outcome, 'CLAIMED');
  assert.equal(gateway.executeCalls.length, 0);

  fixture.clock.advance(20);
  await assert.rejects(service.execute(id, authority('early')), { code: 'EXECUTION_ALREADY_CLAIMED' });
  assert.equal(gateway.executeCalls.length, 0);

  fixture.clock.advance(11);
  const resumed = await service.execute(id, authority('resumed'));

  assert.equal(gateway.executeCalls.length, 1);
  assert.equal(gateway.executeCalls[0].idempotencyKey, id, 'the provider identity is reused verbatim');
  assert.equal(resumed.executionSubmission.attempt, 2);
  assert.equal(resumed.executionSubmission.resumedFromClaimId, claim.record.executionSubmission.claimId);
});

test('a renewal presenting the wrong claim changes nothing at all', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600 });
  const { service, store, id } = fixture;

  const submission = service.execute(id, authority('owner'));
  await settle();
  const before = await store.get(id);

  const stolen = await store.renewExecutionClaim({
    settlementId: id,
    claimId: 'not-the-owner',
    leaseUntil: '2099-01-01T00:00:00.000Z',
    nowIso: fixture.clock.now.toISOString(),
  });

  assert.equal(stolen.outcome, 'OWNERSHIP_LOST');
  const after = await store.get(id);
  assert.equal(after.executionSubmission.leaseExpiresAt, before.executionSubmission.leaseExpiresAt);
  assert.equal(after.executionSubmission.claimId, before.executionSubmission.claimId);
  assert.equal(after.executionAuthorization.authorizationRef, before.executionAuthorization.authorizationRef);
  assert.equal(after.version, before.version, 'a rejected renewal writes nothing');
  assert.equal(gateway.executeCalls.length, 1);

  provider.open();
  await submission;
});

test('a transaction appearing mid-call stops the heartbeat and never causes a second submit', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600 });
  const { service, store, id } = fixture;

  const submission = service.execute(id, authority('owner'));
  await settle();
  fixture.clock.advance(5);
  await fixture.scheduler.fire();
  assert.equal(fixture.scheduler.pending, 1, 'the heartbeat is running');

  // Another writer records the provider transaction while the call is still open.
  const current = await store.get(id);
  await store.update({
    ...current,
    state: 'INITIATED',
    circle: { transactionId: `circle-${id}`, state: 'INITIATED', lastSyncedAt: fixture.clock.now.toISOString() },
    updatedAt: fixture.clock.now.toISOString(),
  });

  fixture.clock.advance(5);
  await fixture.scheduler.fire();
  assert.equal(fixture.scheduler.pending, 0, 'a persisted transaction ends claim ownership');

  provider.open();
  await submission;

  assert.equal(gateway.executeCalls.length, 1, 'no second provider submission');
  const final = await service.get(id);
  assert.equal(final.circle.transactionId, `circle-${id}`);
  assert.equal(final.executionAuthorization.authorizationRef, authority('owner').authorizationRef);
});

test('heartbeat writes never regress concurrent reconciliation or webhook evidence', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 60 });
  const { service, id } = fixture;

  const submission = service.execute(id, authority('owner'));
  await settle();
  // Quote cleanup and list sweeps run against the row while the heartbeat is renewing it.
  for (let step = 0; step < 12; step += 1) {
    fixture.clock.advance(5);
    await Promise.all([fixture.scheduler.fire(), service.releaseExpiredReservations(), service.list()]);
  }
  provider.open();
  await submission;

  await service.applyCircleNotification({
    id: `circle-${id}`, state: 'SENT', blockchain: 'ARC-TESTNET', txHash: transactionHash,
  });
  await service.applyCircleNotification({
    id: `circle-${id}`, state: 'FAILED', blockchain: 'ARC-TESTNET', txHash: transactionHash,
    errorReason: 'INSUFFICIENT_FUNDS',
  });

  const final = await service.get(id);
  assert.equal(final.state, 'FAILED');
  assert.equal(final.transactionHash, transactionHash, 'the hash survived every heartbeat write');
  assert.equal(final.circle.errorReason, 'INSUFFICIENT_FUNDS');
  assert.equal(final.reservation.status, 'HELD', 'a broadcast failure never releases capacity');
  assert.equal(final.executionSubmission.status, 'SUBMITTED');
  assert.equal(gateway.executeCalls.length, 1);
});

test('PostgreSQL enforces claim ownership on every lease renewal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-heartbeat-'));
  const database = new PGlite(directory);
  const store = new PostgresSettlementStore({ database });
  try {
    await store.initialize();
    const provider = gate();
    const gateway = recordingGateway({
      async onExecute(record) {
        await provider.held;
        return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
      },
    });
    const fixture = await lifecycleFixture({
      gateway, store, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30,
    });
    const { service, id } = fixture;

    const submission = service.execute(id, authority('owner'));
    await settle();
    const claimed = await store.get(id);
    const claimId = claimed.executionSubmission.claimId;

    // Five leases' worth of a blocked provider call, renewed by the beat the service scheduled.
    for (let step = 0; step < 30; step += 1) {
      fixture.clock.advance(5);
      await fixture.scheduler.fire();
      await assert.rejects(
        service.execute(id, authority(`thief-${step}`, { operatorAddress: otherOperator })),
        { code: 'EXECUTION_ALREADY_CLAIMED', status: 409 },
      );
    }

    // Both the indexed column and the document carry the renewed lease, so the claim gate and
    // the persisted submission can never disagree about who owns the settlement.
    const row = await database.query(
      'SELECT execution_claim_id, execution_claim_until, record FROM settlements WHERE id = $1',
      [id],
    );
    const document = typeof row.rows[0].record === 'string'
      ? JSON.parse(row.rows[0].record)
      : row.rows[0].record;
    assert.equal(row.rows[0].execution_claim_id, claimId);
    assert.equal(
      new Date(row.rows[0].execution_claim_until).toISOString(),
      document.executionSubmission.leaseExpiresAt,
    );
    assert.ok(new Date(row.rows[0].execution_claim_until).getTime() > fixture.clock.now.getTime());

    const stolen = await store.renewExecutionClaim({
      settlementId: id, claimId: 'not-the-owner', leaseUntil: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(stolen.outcome, 'OWNERSHIP_LOST');
    assert.equal(
      (await store.get(id)).executionSubmission.leaseExpiresAt,
      document.executionSubmission.leaseExpiresAt,
      'a rejected renewal writes nothing',
    );

    provider.open();
    await submission;
    assert.equal(gateway.executeCalls.length, 1);

    // A settled transaction ends renewal outright, whoever asks.
    assert.equal(
      (await store.renewExecutionClaim({ settlementId: id, claimId, leaseUntil: '2099-01-01T00:00:00.000Z' })).outcome,
      'ALREADY_SUBMITTED',
    );
    assert.equal(
      (await store.renewExecutionClaim({ settlementId: 'missing', claimId, leaseUntil: '2099-01-01T00:00:00.000Z' })).outcome,
      'NOT_FOUND',
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a transient renewal failure is retried, and an unprovable claim stands down quietly', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const store = new MemorySettlementStore();
  let failRenewals = 0;
  const renewals = [];
  const inner = store.renewExecutionClaim.bind(store);
  store.renewExecutionClaim = async (request) => {
    renewals.push(request.claimId);
    if (failRenewals > 0) {
      failRenewals -= 1;
      throw new Error('connection terminated unexpectedly');
    }
    return inner(request);
  };
  const fixture = await lifecycleFixture({ gateway, store, quoteTtlSeconds: 3600 });
  const { service, id } = fixture;

  const submission = service.execute(id, authority('owner'));
  await settle();

  // A single blip: the heartbeat keeps beating and the lease is renewed on the next attempt.
  failRenewals = 1;
  fixture.clock.advance(5);
  await fixture.scheduler.fire();
  assert.equal(fixture.scheduler.pending, 1, 'a transient failure does not surrender the claim');
  fixture.clock.advance(5);
  await fixture.scheduler.fire();
  const renewed = await store.get(id);
  assert.ok(new Date(renewed.executionSubmission.leaseExpiresAt).getTime() > fixture.clock.now.getTime());

  // Sustained failure: ownership can no longer be proven, so the heartbeat stops.
  failRenewals = 10;
  for (let step = 0; step < 3; step += 1) {
    fixture.clock.advance(5);
    await fixture.scheduler.fire();
  }
  assert.equal(fixture.scheduler.pending, 0, 'an unprovable claim stops beating');

  provider.open();
  await submission;

  // Crucially, standing down never creates a second provider request.
  assert.equal(gateway.executeCalls.length, 1);
  assert.equal((await service.get(id)).circle.transactionId, `circle-${id}`);
  assert.equal(new Set(renewals).size, 1, 'only ever one claim was renewed');
});

test('a superseded claimant still persists its provider transaction without stealing the record', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({
    gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30,
  });
  const { service, store, id } = fixture;

  const submission = service.execute(id, authority('alpha'));
  await settle();
  const first = await store.get(id);

  // The lease lapses with no beats — as it would for a dead process — and another authorized
  // operator resumes. Only then does the original, still-live provider call return.
  fixture.clock.advance(31);
  const resumedClaim = await service.claimExecution(id, authority('bravo', {
    operatorAddress: otherOperator,
  }));
  assert.equal(resumedClaim.outcome, 'CLAIMED');

  provider.open();
  await submission;

  const final = await service.get(id);
  assert.equal(final.circle.transactionId, `circle-${id}`, 'the transaction ID is never lost');
  assert.equal(final.executionAuthorization.authorizationRef, authority('alpha').authorizationRef);
  assert.equal(
    final.executionSubmission.claimId,
    resumedClaim.record.executionSubmission.claimId,
    'a superseded claimant never rewrites the current claim',
  );
  assert.equal(final.executionSubmission.authorizationRef, authority('bravo').authorizationRef);
  assert.equal(
    final.executionAttempts.find((entry) => entry.claimId === first.executionSubmission.claimId).status,
    'SUBMITTED',
  );
  assert.ok(final.history.some((entry) => entry.reason === 'EXECUTION_SUBMITTED_BY_SUPERSEDED_CLAIM'));
  assert.equal(final.reservation.status, 'ACTIVE');
});

/** A settlement whose first claim was superseded while its provider call was still open. */
async function supersededFixture(failure) {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record, callNumber) {
      if (callNumber === 1) {
        await provider.held;
        throw failure;
      }
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({
    gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30,
  });
  const { service, store, id } = fixture;

  const submission = service.execute(id, authority('alpha'));
  await settle();
  const alphaClaimId = (await store.get(id)).executionSubmission.claimId;

  // No beats are fired, so the lease lapses exactly as it would for a dead process, and a
  // second authorized operator takes the settlement over.
  fixture.clock.advance(31);
  const resumed = await service.claimExecution(id, authority('bravo', {
    operatorAddress: otherOperator,
  }));
  assert.equal(resumed.outcome, 'CLAIMED');

  // Only now does the original, long-superseded provider call come back — with an error.
  provider.open();
  return {
    ...fixture, submission, alphaClaimId, bravo: resumed.record.executionSubmission,
  };
}

test('a superseded claimant recording a late unknown outcome finalises only its own attempt', async () => {
  const failure = new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
    status: 502, details: { operation: 'transfer' },
  });
  const fixture = await supersededFixture(failure);
  const { service, gateway, id, alphaClaimId, bravo } = fixture;

  await assert.rejects(fixture.submission, { code: 'CIRCLE_REQUEST_FAILED' });
  const final = await service.get(id);

  // The current claim is untouched in every respect.
  assert.equal(final.executionSubmission.claimId, bravo.claimId);
  assert.equal(final.executionSubmission.status, 'CLAIMED', 'the live claim is not failed');
  assert.equal(final.executionSubmission.failedAt, null);
  assert.equal(final.executionSubmission.lastError, null);
  assert.equal(
    final.executionSubmission.leaseExpiresAt,
    bravo.leaseExpiresAt,
    'the live claim keeps its lease',
  );
  assert.equal(final.executionSubmission.authorizationRef, authority('bravo').authorizationRef);

  // Neither the audit root, the state, nor the treasury reservation moves.
  assert.equal(final.executionAuthorization.authorizationRef, authority('alpha').authorizationRef);
  assert.equal(final.state, 'AWAITING_SIGNATURE');
  assert.equal(final.reservation.status, 'ACTIVE', 'capacity is never released');

  // The superseded attempt now records its real outcome instead of a stale CLAIMED.
  const attempt = final.executionAttempts.find((entry) => entry.claimId === alphaClaimId);
  assert.equal(attempt.status, 'UNKNOWN_OUTCOME');
  assert.equal(attempt.failureClassification, 'UNKNOWN_OUTCOME');
  assert.equal(attempt.failureCode, 'CIRCLE_REQUEST_FAILED');
  assert.equal(attempt.attempt, 1, 'the original attempt number is preserved');
  assert.equal(attempt.authorizationRef, authority('alpha').authorizationRef);
  assert.equal(attempt.operatorAddress, operatorAddress);
  assert.equal(attempt.supersededByClaimId, bravo.claimId);
  assert.ok(attempt.failedAt);

  const entry = final.history.findLast(
    (item) => item.reason === 'EXECUTION_FAILURE_BY_SUPERSEDED_CLAIM',
  );
  assert.equal(entry.claimId, alphaClaimId);
  assert.equal(entry.attempt, 1);
  assert.equal(entry.classification, 'UNKNOWN_OUTCOME');
  assert.equal(entry.supersededByClaimId, bravo.claimId);

  // Above all: no retry and no second provider call were created.
  assert.equal(gateway.executeCalls.length, 1);
});

test('a superseded pre-provider failure never releases the live claim or its capacity', async () => {
  const failure = new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
    status: 503,
  });
  const fixture = await supersededFixture(failure);
  const { service, gateway, id, alphaClaimId, bravo } = fixture;

  await assert.rejects(fixture.submission, { code: 'CIRCLE_NOT_CONFIGURED' });
  const final = await service.get(id);

  // A PRE_PROVIDER classification releases *that attempt*, and nothing else. Were it allowed to
  // release the settlement, the live claimant's quote TTL would resume underneath it.
  const attempt = final.executionAttempts.find((entry) => entry.claimId === alphaClaimId);
  assert.equal(attempt.status, 'RELEASED');
  assert.equal(attempt.failureClassification, 'PRE_PROVIDER');
  assert.equal(attempt.supersededByClaimId, bravo.claimId);

  assert.equal(final.executionSubmission.claimId, bravo.claimId);
  assert.equal(final.executionSubmission.status, 'CLAIMED');
  assert.equal(final.executionSubmission.leaseExpiresAt, bravo.leaseExpiresAt);
  assert.equal(final.reservation.status, 'ACTIVE');
  assert.equal(gateway.executeCalls.length, 1);

  // The live claim still holds the settlement: a fresh contender is locked out for as long as
  // bravo's lease runs, which is precisely what a wrongly-released claim would have broken.
  fixture.clock.advance(1);
  await assert.rejects(
    service.execute(id, authority('charlie', { operatorAddress: otherOperator })),
    { code: 'EXECUTION_ALREADY_CLAIMED' },
  );
  assert.equal(gateway.executeCalls.length, 1);

  // Once that lease lapses on schedule, recovery proceeds under the original provider identity.
  fixture.clock.advance(31);
  const executed = await service.execute(id, authority('charlie', { operatorAddress: otherOperator }));
  assert.equal(executed.circle.transactionId, `circle-${id}`);
  assert.equal(gateway.executeCalls.length, 2);
  assert.deepEqual(gateway.executeCalls.map((call) => call.idempotencyKey), [id, id]);
  assert.equal(executed.executionAuthorization.authorizationRef, authority('alpha').authorizationRef);
});

test('a late failure naming a claim with no attempt history writes nothing at all', async () => {
  const gateway = recordingGateway();
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600 });
  const { service, store, id } = fixture;

  const executed = await service.execute(id, authority('owner'));
  const before = await store.get(id);

  await service.recordSubmissionFailure(id, 'a-claim-that-never-existed', new DomainError(
    'CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', { status: 502 },
  ));

  const after = await store.get(id);
  assert.equal(after.version, before.version, 'an unrecognised claim burns no row version');
  assert.deepEqual(after.executionAttempts, before.executionAttempts);
  assert.equal(after.executionSubmission.status, 'SUBMITTED');
  assert.equal(after.circle.transactionId, executed.circle.transactionId);
  assert.equal(
    after.history.some((entry) => entry.reason === 'EXECUTION_FAILURE_BY_SUPERSEDED_CLAIM'),
    false,
  );
});

test('a late failure never contradicts an attempt whose provider call already succeeded', async () => {
  const provider = gate();
  const gateway = recordingGateway({
    async onExecute(record) {
      await provider.held;
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const fixture = await lifecycleFixture({
    gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30,
  });
  const { service, store, id } = fixture;

  const submission = service.execute(id, authority('alpha'));
  await settle();
  const alphaClaimId = (await store.get(id)).executionSubmission.claimId;
  fixture.clock.advance(31);
  await service.claimExecution(id, authority('bravo', { operatorAddress: otherOperator }));
  provider.open();
  await submission;

  // The superseded attempt already recorded SUBMITTED via the late-success path. A spurious
  // late error for the same claim must not rewrite a provider success into a failure.
  const before = await store.get(id);
  assert.equal(
    before.executionAttempts.find((entry) => entry.claimId === alphaClaimId).status,
    'SUBMITTED',
  );

  await service.recordSubmissionFailure(id, alphaClaimId, new DomainError(
    'CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', { status: 502 },
  ));

  const after = await store.get(id);
  assert.equal(after.version, before.version, 'a resolved attempt is never rewritten');
  assert.equal(
    after.executionAttempts.find((entry) => entry.claimId === alphaClaimId).status,
    'SUBMITTED',
  );
  assert.equal(after.circle.transactionId, `circle-${id}`);
});

test('PostgreSQL keeps the live claim and reservation after a superseded late error', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-superseded-'));
  const database = new PGlite(directory);
  const store = new PostgresSettlementStore({ database });
  try {
    await store.initialize();
    const provider = gate();
    const gateway = recordingGateway({
      treasuryAvailableUnits: 100_000_000n,
      async onExecute(record, callNumber) {
        if (callNumber === 1) {
          await provider.held;
          throw new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
            status: 502,
          });
        }
        return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
      },
    });
    const fixture = await lifecycleFixture({
      gateway, store, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30,
    });
    const { service, id } = fixture;

    const submission = service.execute(id, authority('alpha'));
    await settle();
    const alphaClaimId = (await store.get(id)).executionSubmission.claimId;
    fixture.clock.advance(31);
    const resumed = await service.claimExecution(id, authority('bravo', {
      operatorAddress: otherOperator,
    }));
    const bravoClaimId = resumed.record.executionSubmission.claimId;

    provider.open();
    await assert.rejects(submission, { code: 'CIRCLE_REQUEST_FAILED' });

    // The indexed claim gate — the column another worker races on — must still name the live
    // claimant, and the reservation must still count against the treasury.
    const row = await database.query(
      `SELECT execution_claim_id, execution_claim_until, reservation_status, state
       FROM settlements WHERE id = $1`,
      [id],
    );
    assert.equal(row.rows[0].execution_claim_id, bravoClaimId);
    assert.equal(row.rows[0].reservation_status, 'ACTIVE');
    assert.equal(row.rows[0].state, 'AWAITING_SIGNATURE');
    assert.ok(new Date(row.rows[0].execution_claim_until).getTime() > fixture.clock.now.getTime());

    // A third contender is still locked out by the live lease.
    await assert.rejects(
      service.execute(id, authority('charlie', { operatorAddress: otherOperator })),
      { code: 'EXECUTION_ALREADY_CLAIMED' },
    );
    assert.equal(gateway.executeCalls.length, 1);

    const stored = await store.get(id);
    assert.equal(
      stored.executionAttempts.find((entry) => entry.claimId === alphaClaimId).status,
      'UNKNOWN_OUTCOME',
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Execution authority audit
// ─────────────────────────────────────────────────────────────────────────────

test('an unknown outcome recovered by another authority keeps the original attribution', async () => {
  const gateway = recordingGateway({
    async onExecute(record, callNumber) {
      if (callNumber === 1) {
        throw new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
          status: 502,
        });
      }
      return { id: `circle-${record.id}`, state: 'SENT', txHash: transactionHash };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30 });
  const { service, id } = fixture;

  await assert.rejects(service.execute(id, authority('alpha')), { code: 'CIRCLE_REQUEST_FAILED' });
  const original = await service.get(id);
  const originalKey = original.executionSubmission.providerOperationKey;

  fixture.clock.advance(31);
  const recovered = await service.execute(id, authority('bravo', {
    operatorAddress: otherOperator, sessionId: 'session-bravo',
  }));

  assert.equal(
    recovered.executionAuthorization.authorizationRef,
    authority('alpha').authorizationRef,
    'the root authority is the first winning claim, forever',
  );
  assert.equal(recovered.executionAuthorization.operatorAddress, operatorAddress);
  assert.equal(recovered.executionSubmission.authorizationRef, authority('bravo').authorizationRef);
  assert.equal(recovered.executionSubmission.initialAuthorizationRef, authority('alpha').authorizationRef);
  assert.equal(recovered.executionSubmission.operatorAddress, otherOperator);
  assert.equal(recovered.executionSubmission.providerOperationKey, originalKey);
  assert.equal(recovered.circle.transactionId, `circle-${id}`);

  assert.equal(recovered.executionAttempts.length, 2);
  assert.deepEqual(
    recovered.executionAttempts.map((entry) => [entry.attempt, entry.authorizationRef, entry.status]),
    [
      [1, authority('alpha').authorizationRef, 'UNKNOWN_OUTCOME'],
      [2, authority('bravo').authorizationRef, 'SUBMITTED'],
    ],
  );
  assert.equal(recovered.executionAttempts[0].operatorAddress, operatorAddress);
  assert.equal(recovered.executionAttempts[1].operatorAddress, otherOperator);
  assert.equal(recovered.executionAttempts[1].resumedFromClaimId, recovered.executionAttempts[0].claimId);

  const references = recovered.history
    .filter((entry) => entry.event === 'EXECUTION')
    .map((entry) => entry.authorizationRef ?? null);
  assert.ok(references.includes(authority('alpha').authorizationRef));
  assert.ok(references.includes(authority('bravo').authorizationRef));
});

test('three recovery authorities are individually reconstructible under one provider identity', async () => {
  const gateway = recordingGateway({
    async onExecute(record, callNumber) {
      if (callNumber < 3) {
        throw new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
          status: 502,
        });
      }
      return { id: `circle-${record.id}`, state: 'SENT', txHash: transactionHash };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600, executionClaimLeaseSeconds: 30 });
  const { service, id } = fixture;

  await assert.rejects(service.execute(id, authority('alpha')), { code: 'CIRCLE_REQUEST_FAILED' });
  fixture.clock.advance(31);
  await assert.rejects(service.execute(id, authority('bravo')), { code: 'CIRCLE_REQUEST_FAILED' });
  fixture.clock.advance(31);
  const final = await service.execute(id, authority('charlie'));

  assert.equal(final.executionAuthorization.authorizationRef, authority('alpha').authorizationRef);
  assert.deepEqual(
    final.executionAttempts.map((entry) => [entry.attempt, entry.authorizationRef]),
    [
      [1, authority('alpha').authorizationRef],
      [2, authority('bravo').authorizationRef],
      [3, authority('charlie').authorizationRef],
    ],
  );
  assert.equal(new Set(gateway.executeCalls.map((call) => call.idempotencyKey)).size, 1);
  assert.equal(gateway.executeCalls[0].idempotencyKey, id);
  assert.equal(
    new Set(final.executionAttempts.map(() => final.executionSubmission.providerOperationKey)).size,
    1,
  );
  assert.equal(final.circle.transactionId, `circle-${id}`);
});

test('a pre-provider release keeps the original authority as the stable audit root', async () => {
  const gateway = recordingGateway({
    async onExecute(record, callNumber) {
      if (callNumber === 1) {
        throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
          status: 503,
        });
      }
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600 });
  const { service, id } = fixture;

  await assert.rejects(service.execute(id, authority('alpha')), { code: 'CIRCLE_NOT_CONFIGURED' });
  const retried = await service.execute(id, authority('bravo'));

  assert.equal(retried.executionAuthorization.authorizationRef, authority('alpha').authorizationRef);
  assert.equal(retried.executionSubmission.authorizationRef, authority('bravo').authorizationRef);
  assert.deepEqual(
    retried.executionAttempts.map((entry) => [entry.attempt, entry.status]),
    [[1, 'RELEASED'], [2, 'SUBMITTED']],
  );
});

test('a settlement executed once records identical root and attempt authority', async () => {
  const gateway = recordingGateway();
  const fixture = await lifecycleFixture({ gateway, quoteTtlSeconds: 3600 });
  const { service, id } = fixture;

  const executed = await service.execute(id, authority('only'));

  assert.equal(
    executed.executionAuthorization.authorizationRef,
    executed.executionSubmission.authorizationRef,
  );
  assert.equal(
    executed.executionSubmission.initialAuthorizationRef,
    executed.executionSubmission.authorizationRef,
  );
  assert.equal(executed.executionAttempts.length, 1);
  assert.equal(executed.executionAttempts[0].attempt, 1);
  assert.equal(executed.executionAttempts[0].resumedFromClaimId, null);
  assert.equal(executed.executionAttempts[0].status, 'SUBMITTED');
  // No raw approval or session material is ever persisted alongside the attribution.
  assert.equal(JSON.stringify(executed).includes('signature'), false);
});
