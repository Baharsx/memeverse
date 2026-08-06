import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { mintAutonomousAuthority } from '../domain/autonomous-authority.js';
import { DomainError } from '../domain/errors.js';
import { executionModes } from '../domain/execution-mode.js';
import { createSettlementPolicy } from '../domain/policy.js';
import { settlementExecutionBindingHash } from '../domain/settlement-binding.js';
import { SettlementService } from '../domain/settlement-service.js';
import { PostgresSettlementStore } from '../repositories/postgres-settlement-store.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';

const operatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const otherOperator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const transactionHash = `0x${'ab'.repeat(32)}`;

/**
 * Mirrors what the transport resolves after consuming a real approval: the binding hash is the
 * live settlement's, so the domain's own re-check passes for a genuine authorization.
 */
let currentBindingHash = null;

function authority(reference, overrides = {}) {
  return {
    mode: executionModes.MANUAL_OPERATOR,
    operatorAddress,
    sessionId: `session-${reference}`,
    authorizationRef: `${reference}`.padEnd(32, 'a'),
    bindingHash: currentBindingHash,
    authorizedAt: '2026-08-03T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Records every provider invocation and can hold one open, so a second caller has a real window
 * in which to attempt its own submission.
 */
function recordingGateway({ onExecute, transaction } = {}) {
  const gateway = {
    executeCalls: [],
    statusCalls: [],
    createExecutionPlan(record) {
      return {
        provider: 'CIRCLE_DEVELOPER_CONTROLLED_WALLET',
        chain: 'ARC-TESTNET',
        asset: 'USDC',
        recipient: record.recipient,
        amountUsdc: record.amount.creatorPayoutUsdc,
        amountUnits: record.amount.creatorPayoutUnits,
        memoId: record.memoId,
        memoContract: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
        targetContract: '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7',
        callDataHash: `0x${'cd'.repeat(32)}`,
        requiresSigning: true,
        broadcast: false,
      };
    },
    async executeSettlement(record) {
      gateway.executeCalls.push({
        settlementId: record.id,
        idempotencyKey: record.executionSubmission?.providerOperationKey ?? record.id,
        claimId: record.executionSubmission?.claimId ?? null,
      });
      if (onExecute) return onExecute(record, gateway.executeCalls.length);
      return transaction ?? { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
    async getTransaction(id) {
      gateway.statusCalls.push(id);
      return { id, state: 'SENT', blockchain: 'ARC-TESTNET', txHash: transactionHash };
    },
  };
  return gateway;
}

async function fixture({ gateway = recordingGateway(), store, arcIndexer, clock } = {}) {
  const settlementStore = store ?? new MemorySettlementStore();
  let currentTime = clock?.value ?? new Date('2026-08-03T10:00:00.000Z');
  const clockControl = {
    get now() { return currentTime; },
    advance(seconds) { currentTime = new Date(currentTime.getTime() + seconds * 1000); },
  };
  const service = new SettlementService({
    store: settlementStore,
    policy: createSettlementPolicy({
      maxSpendUsdc: '25.00', minViralityScore: 78, creatorShareBps: 6000,
    }),
    chainId: 5042002,
    quoteTtlSeconds: 3600,
    circleGateway: gateway,
    arcIndexer,
    executionClaimLeaseSeconds: 120,
    now: () => currentTime,
    id: () => 'claim-settlement-1',
  });
  const quote = await service.quote({
    recipient: '0x1111111111111111111111111111111111111111',
    requestedAmount: '10.00',
    viralityScore: 90,
    reference: 'CLAIM-CASE',
  }, 'claim-key-0001');
  const prepared = await service.prepare(quote.record.id);
  currentBindingHash = settlementExecutionBindingHash(prepared);
  return { service, store: settlementStore, gateway, id: quote.record.id, clock: clockControl };
}

test('two concurrent authorizations produce exactly one provider call and one winning authority', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let firstCall = true;
  const gateway = recordingGateway({
    async onExecute(record) {
      if (firstCall) {
        firstCall = false;
        // Hold the provider call open so the loser has a real window to race into.
        await held;
      }
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const { service, id } = await fixture({ gateway });

  const winnerAttempt = service.execute(id, authority('winner'));
  await new Promise((resolve) => setImmediate(resolve));
  const loserAttempt = service.execute(id, authority('loser', { sessionId: 'session-loser' }));
  const loserOutcome = await loserAttempt.then(
    (record) => ({ ok: true, record }),
    (error) => ({ ok: false, error }),
  );
  release();
  const winner = await winnerAttempt;

  assert.equal(gateway.executeCalls.length, 1, 'exactly one Circle invocation');
  assert.equal(loserOutcome.ok, false, 'the losing caller must not succeed');
  assert.equal(loserOutcome.error.code, 'EXECUTION_ALREADY_CLAIMED');
  assert.equal(loserOutcome.error.status, 409);

  const final = await service.get(id);
  assert.equal(winner.circle.transactionId, `circle-${id}`);
  assert.equal(final.circle.transactionId, `circle-${id}`);
  assert.equal(final.executionAuthorization.authorizationRef, authority('winner').authorizationRef);
  assert.equal(final.executionAuthorization.sessionId, 'session-winner');
  assert.equal(final.executionSubmission.status, 'SUBMITTED');
  assert.equal(final.executionSubmission.attempt, 1);
  assert.ok(final.executionSubmission.submittedAt);
});

test('twenty concurrent executions yield a single provider call and no evidence corruption', async () => {
  const gateway = recordingGateway({
    async onExecute(record) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
  });
  const { service, id } = await fixture({ gateway });

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) => service.execute(id, authority(`caller-${index}`, {
      sessionId: `session-${index}`,
    }))),
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');

  assert.equal(gateway.executeCalls.length, 1, 'exactly one Circle invocation');
  assert.equal(fulfilled.length >= 1, true);
  assert.equal(
    rejected.every((result) => ['EXECUTION_ALREADY_CLAIMED', 'SETTLEMENT_NOT_EXECUTABLE']
      .includes(result.reason.code)),
    true,
    rejected.map((result) => result.reason.code).join(','),
  );

  const final = await service.get(id);
  const winningRef = final.executionAuthorization.authorizationRef;
  assert.equal(final.executionSubmission.authorizationRef, winningRef);
  assert.equal(final.circle.transactionId, `circle-${id}`);
  assert.equal(final.executionSubmission.status, 'SUBMITTED');
  // Every fulfilled caller observed the same single provider transaction.
  for (const result of fulfilled) {
    assert.equal(result.value.circle.transactionId, `circle-${id}`);
    assert.equal(result.value.executionAuthorization.authorizationRef, winningRef);
  }
});

test('an active claim cannot be stolen and keeps the winning authority immutable', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const gateway = recordingGateway({
    async onExecute(record) {
      await held;
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const { service, id, clock } = await fixture({ gateway });

  const winnerAttempt = service.execute(id, authority('winner'));
  await new Promise((resolve) => setImmediate(resolve));
  const claimed = await service.get(id);
  assert.equal(claimed.executionSubmission.status, 'CLAIMED');
  assert.equal(claimed.executionSubmission.operatorAddress, operatorAddress);

  clock.advance(119);
  await assert.rejects(
    service.execute(id, authority('thief', { operatorAddress: otherOperator, sessionId: 'session-thief' })),
    { code: 'EXECUTION_ALREADY_CLAIMED', status: 409 },
  );

  const duringClaim = await service.get(id);
  assert.equal(duringClaim.executionAuthorization.authorizationRef, authority('winner').authorizationRef);
  assert.equal(duringClaim.executionAuthorization.operatorAddress, operatorAddress);
  assert.equal(duringClaim.executionSubmission.claimId, claimed.executionSubmission.claimId);
  assert.equal(gateway.executeCalls.length, 1);

  release();
  await winnerAttempt;
});

test('a crashed claim can be resumed only after the lease expires, reusing the provider identity', async () => {
  const gateway = recordingGateway();
  const { service, store, id, clock } = await fixture({ gateway });

  // Simulate a process that persisted its claim and then died before calling Circle.
  const claim = await service.claimExecution(id, authority('crashed'));
  assert.equal(claim.outcome, 'CLAIMED');
  assert.equal(claim.record.executionSubmission.status, 'CLAIMED');
  assert.equal(claim.record.executionSubmission.providerOperationKey, id);
  assert.equal(gateway.executeCalls.length, 0);

  clock.advance(60);
  await assert.rejects(service.execute(id, authority('early')), {
    code: 'EXECUTION_ALREADY_CLAIMED', status: 409,
  });
  assert.equal(gateway.executeCalls.length, 0);

  clock.advance(61);
  const resumed = await service.execute(id, authority('resumed', { sessionId: 'session-resumed' }));

  assert.equal(gateway.executeCalls.length, 1);
  // The provider identity is derived from the settlement, never regenerated for a resume.
  assert.equal(gateway.executeCalls[0].idempotencyKey, id);
  assert.equal(resumed.executionSubmission.attempt, 2);
  assert.equal(resumed.executionSubmission.resumedFromClaimId, claim.record.executionSubmission.claimId);
  // The root authority records the first claim that ever won; the resume is attempt 2's authority.
  assert.equal(resumed.executionAuthorization.authorizationRef, authority('crashed').authorizationRef);
  assert.equal(resumed.executionSubmission.authorizationRef, authority('resumed').authorizationRef);
  assert.equal(resumed.circle.transactionId, `circle-${id}`);
  const history = (await store.get(id)).history.map((entry) => entry.reason);
  assert.ok(history.includes('EXECUTION_CLAIMED'));
  assert.ok(history.includes('EXECUTION_CLAIM_RESUMED'));
});

test('a lost provider response is recovered through the same idempotent operation', async () => {
  const gateway = recordingGateway({
    async onExecute(record, callNumber) {
      if (callNumber === 1) {
        // Circle accepted the request; the application never saw the response.
        throw new DomainError('CIRCLE_REQUEST_FAILED', 'Circle transfer request failed.', {
          status: 502, details: { operation: 'transfer' },
        });
      }
      // The idempotent replay returns the original transaction.
      return { id: `circle-${record.id}`, state: 'SENT', txHash: transactionHash, walletId: 'wallet-1' };
    },
  });
  const { service, id, clock } = await fixture({ gateway });

  await assert.rejects(service.execute(id, authority('lost')), { code: 'CIRCLE_REQUEST_FAILED' });
  const unknown = await service.get(id);
  assert.equal(unknown.executionSubmission.status, 'UNKNOWN_OUTCOME');
  assert.equal(unknown.executionSubmission.lastError.code, 'CIRCLE_REQUEST_FAILED');
  assert.equal(unknown.state, 'AWAITING_SIGNATURE');
  assert.equal(unknown.reservation.status, 'ACTIVE');

  // An unknown outcome holds its claim until the lease expires; no immediate second attempt.
  await assert.rejects(service.execute(id, authority('early')), { code: 'EXECUTION_ALREADY_CLAIMED' });
  assert.equal(gateway.executeCalls.length, 1);

  clock.advance(121);
  const recovered = await service.execute(id, authority('recovery', { sessionId: 'session-recovery' }));

  assert.equal(gateway.executeCalls.length, 2);
  assert.deepEqual(gateway.executeCalls.map((call) => call.idempotencyKey), [id, id]);
  assert.equal(recovered.circle.transactionId, `circle-${id}`);
  assert.equal(recovered.transactionHash, transactionHash);
  assert.equal(recovered.executionSubmission.status, 'SUBMITTED');
});

test('a pre-provider failure releases the claim so a fresh approval can retry immediately', async () => {
  let failFirst = true;
  const gateway = recordingGateway({
    async onExecute(record) {
      if (failFirst) {
        failFirst = false;
        throw new DomainError('CIRCLE_NOT_CONFIGURED', 'Circle wallet gateway is unavailable.', {
          status: 503,
        });
      }
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const { service, id } = await fixture({ gateway });

  await assert.rejects(service.execute(id, authority('blocked')), { code: 'CIRCLE_NOT_CONFIGURED' });
  const released = await service.get(id);
  assert.equal(released.executionSubmission.status, 'RELEASED');
  assert.equal(released.executionSubmission.lastError.code, 'CIRCLE_NOT_CONFIGURED');

  // No lease wait is required because the provider was never reached.
  const retried = await service.execute(id, authority('retry', { sessionId: 'session-retry' }));
  assert.equal(gateway.executeCalls.length, 2);
  assert.equal(retried.circle.transactionId, `circle-${id}`);
  // Even a provably unreached first attempt keeps the audit root stable at the first claim.
  assert.equal(retried.executionAuthorization.authorizationRef, authority('blocked').authorizationRef);
  assert.equal(retried.executionSubmission.authorizationRef, authority('retry').authorizationRef);
});

test('an existing Circle transaction reconciles instead of submitting again', async () => {
  const gateway = recordingGateway();
  const { service, id } = await fixture({ gateway });
  await service.execute(id, authority('first'));
  assert.equal(gateway.executeCalls.length, 1);

  const again = await service.execute(id, authority('second', { sessionId: 'session-second' }));

  assert.equal(gateway.executeCalls.length, 1, 'no second provider submission');
  assert.equal(gateway.statusCalls.length, 1, 'the repeat execute reconciles');
  assert.equal(again.circle.transactionId, `circle-${id}`);
  // The winning authority is never replaced by a later approval.
  assert.equal(again.executionAuthorization.authorizationRef, authority('first').authorizationRef);
  assert.equal(again.executionSubmission.authorizationRef, authority('first').authorizationRef);
});

test('a post-broadcast failure keeps its reservation and never resubmits', async () => {
  const gateway = recordingGateway();
  const { service, id } = await fixture({ gateway });
  await service.execute(id, authority('first'));
  await service.applyCircleNotification({
    id: `circle-${id}`, state: 'SENT', blockchain: 'ARC-TESTNET', txHash: transactionHash,
  });
  await service.applyCircleNotification({
    id: `circle-${id}`, state: 'FAILED', blockchain: 'ARC-TESTNET', txHash: transactionHash,
    errorReason: 'INSUFFICIENT_FUNDS',
  });
  const failed = await service.get(id);
  assert.equal(failed.state, 'FAILED');
  assert.equal(failed.reservation.status, 'HELD');

  // A repeat execute reconciles the known transaction; it can never create a second payout.
  const reconciled = await service.execute(id, authority('retry'));
  assert.equal(gateway.executeCalls.length, 1);
  assert.equal(reconciled.state, 'FAILED');
  assert.equal(reconciled.executionAuthorization.authorizationRef, authority('first').authorizationRef);
  assert.equal((await service.get(id)).reservation.status, 'HELD');
});

test('a completed settlement can never be reclaimed', async () => {
  const gateway = recordingGateway({
    async onExecute(record) {
      return { id: `circle-${record.id}`, state: 'COMPLETE', txHash: transactionHash };
    },
  });
  const { service, id } = await fixture({
    gateway,
    arcIndexer: { async verify() { return { status: 'VERIFIED', blockNumber: 900, transactionHash }; } },
  });
  const completed = await service.execute(id, authority('first'));
  assert.equal(completed.state, 'COMPLETE');
  assert.equal(completed.reservation.status, 'CONSUMED');

  const replayed = await service.execute(id, authority('replay'));
  assert.equal(gateway.executeCalls.length, 1, 'a completed settlement is never resubmitted');
  assert.equal(replayed.state, 'COMPLETE');
  assert.equal(replayed.executionAuthorization.authorizationRef, authority('first').authorizationRef);
  assert.equal((await service.get(id)).reservation.status, 'CONSUMED');
});

test('a settlement payload changed after authorization still fails the claim', async () => {
  const gateway = recordingGateway();
  const { service, store, id } = await fixture({ gateway });
  const stored = await store.get(id);
  await store.update({ ...stored, recipient: '0x3333333333333333333333333333333333333333' });

  await assert.rejects(
    service.execute(id, authority('stale')),
    { code: 'EXECUTION_BINDING_MISMATCH', status: 409 },
  );
  assert.equal(gateway.executeCalls.length, 0);
});

test('an unbranded AUTONOMOUS_POLICY authority fails closed before any claim is written', async () => {
  const gateway = recordingGateway();
  const { service, id } = await fixture({ gateway });

  // The mode is enabled in this release, but a plain object claiming it is exactly what an
  // HTTP body would deserialise into, and it must never execute.
  await assert.rejects(
    service.execute(id, authority('autonomous', { mode: executionModes.AUTONOMOUS_POLICY })),
    { code: 'AUTONOMOUS_AUTHORITY_REQUIRED', status: 403 },
  );
  assert.equal(gateway.executeCalls.length, 0);
  assert.equal((await service.get(id)).executionSubmission ?? null, null);
});

test('a JSON copy of a genuine autonomous authority is still refused', async () => {
  const gateway = recordingGateway();
  const { service, id } = await fixture({ gateway });

  // A real authority, minted the only legitimate way.
  const genuine = mintAutonomousAuthority({
    settlementId: id,
    marketAddress: '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D',
    creatorAddress: '0x6bbD385C0f51D273a1685C977fAfa179F9eEb689',
    evidenceDigest: `0x${'11'.repeat(32)}`,
    policyVersion: 'AGENT_AUTONOMOUS_POLICY_V1',
    metricVersion: 'AGENT_SIGNAL_METRICS_V1',
    epoch: 1,
    decidedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    amountUnits: 10_000n,
  });

  // Serialising and reviving it is precisely what crossing an HTTP boundary would do. The brand
  // is a Symbol, so it cannot survive the round trip, and the copy is powerless.
  const replayed = JSON.parse(JSON.stringify(genuine));
  assert.equal(replayed.mode, 'AUTONOMOUS_POLICY');
  assert.equal(replayed.authorizationRef, genuine.authorizationRef);

  await assert.rejects(service.execute(id, replayed), {
    code: 'AUTONOMOUS_AUTHORITY_REQUIRED', status: 403,
  });
  await assert.rejects(service.executeAutonomous(id, replayed), {
    code: 'AUTONOMOUS_AUTHORITY_REQUIRED', status: 403,
  });
  assert.equal(gateway.executeCalls.length, 0);
  assert.equal((await service.get(id)).executionSubmission ?? null, null);
});

test('PostgreSQL proves the atomic claim under real concurrent writers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-claim-'));
  const database = new PGlite(directory);
  const store = new PostgresSettlementStore({ database });
  try {
    await store.initialize();
    const gateway = recordingGateway({
      async onExecute(record) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { id: `circle-${record.id}`, state: 'INITIATED' };
      },
    });
    const { service, id } = await fixture({ gateway, store });

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => service.execute(id, authority(`pg-${index}`, {
        sessionId: `session-pg-${index}`,
      }))),
    );

    assert.equal(gateway.executeCalls.length, 1, 'exactly one Circle invocation against PostgreSQL');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(rejected.length >= 1, true);
    assert.equal(
      rejected.every((result) => ['EXECUTION_ALREADY_CLAIMED', 'SETTLEMENT_NOT_EXECUTABLE']
        .includes(result.reason.code)),
      true,
      rejected.map((result) => result.reason.code).join(','),
    );

    const final = await store.get(id);
    assert.equal(final.circle.transactionId, `circle-${id}`);
    assert.equal(final.executionSubmission.status, 'SUBMITTED');
    assert.equal(final.executionAuthorization.authorizationRef, final.executionSubmission.authorizationRef);
    assert.equal(final.executionSubmission.executionMode, executionModes.MANUAL_OPERATOR);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the claim never exposes raw authorization or session material', async () => {
  const gateway = recordingGateway();
  const { service, id } = await fixture({ gateway });
  const executed = await service.execute(id, authority('audit'));
  const serialized = JSON.stringify(executed);

  assert.ok(executed.executionSubmission.claimId);
  assert.equal(serialized.includes('memeverse_operator_session'), false);
  assert.equal(serialized.includes('signature'), false);
  // Only the opaque authorization reference is persisted, never a usable token.
  assert.equal(executed.executionSubmission.authorizationRef, authority('audit').authorizationRef);
  assert.equal('token' in executed.executionSubmission, false);
});

test('concurrent replays of one authorization yield at most one claim and one provider call', async () => {
  const gateway = recordingGateway({
    async onExecute(record) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const { service, id } = await fixture({ gateway });
  // The transport consumes an approval once; this proves the domain is safe even if a caller
  // somehow presents the identical resolved authority several times at once.
  const replayed = authority('replay');

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => service.execute(id, replayed)),
  );

  assert.equal(gateway.executeCalls.length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length >= 1, true);
  const final = await service.get(id);
  const claimEvents = final.history.filter((entry) => entry.event === 'EXECUTION'
    && entry.reason === 'EXECUTION_CLAIMED');
  assert.equal(claimEvents.length, 1, 'exactly one claim was ever written');
  assert.equal(final.executionSubmission.status, 'SUBMITTED');
  assert.equal(final.circle.transactionId, `circle-${id}`);
});

test('a stale settlement version is retried and still produces one claim', async () => {
  const gateway = recordingGateway();
  const { service, store, id } = await fixture({ gateway });
  const stale = await store.get(id);
  // Another writer advances the row between the caller's read and its claim attempt.
  await store.update({ ...stale, updatedAt: '2026-08-03T10:05:00.000Z' });

  const executed = await service.execute(id, authority('retrying'));

  assert.equal(gateway.executeCalls.length, 1);
  assert.equal(executed.circle.transactionId, `circle-${id}`);
  assert.equal(executed.executionSubmission.status, 'SUBMITTED');
  assert.equal(executed.executionAuthorization.authorizationRef, authority('retrying').authorizationRef);
});

test('mutating the settlement after a claim cannot create a second payout', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const gateway = recordingGateway({
    async onExecute(record) {
      await held;
      return { id: `circle-${record.id}`, state: 'INITIATED' };
    },
  });
  const { service, store, id } = await fixture({ gateway });

  const winnerAttempt = service.execute(id, authority('winner'));
  await new Promise((resolve) => setImmediate(resolve));
  const claimed = await store.get(id);
  assert.equal(claimed.executionSubmission.status, 'CLAIMED');

  // A concurrent writer changes the approved payload while the provider call is in flight.
  await store.update({
    ...claimed,
    recipient: '0x3333333333333333333333333333333333333333',
    amount: { ...claimed.amount, creatorPayoutUnits: '999999' },
  });
  release();
  await winnerAttempt;

  // A provider transaction now exists, so any later attempt reconciles rather than submitting,
  // and the single transaction stays attributed to the winning authority.
  const afterwards = await service.execute(id, authority('after'));
  assert.equal(gateway.executeCalls.length, 1);
  assert.equal(afterwards.circle.transactionId, `circle-${id}`);
  const final = await service.get(id);
  assert.equal(final.circle.transactionId, `circle-${id}`);
  assert.equal(final.executionAuthorization.authorizationRef, authority('winner').authorizationRef);
  assert.equal(final.executionSubmission.claimId, claimed.executionSubmission.claimId);
  assert.equal(final.executionSubmission.status, 'SUBMITTED');
});
