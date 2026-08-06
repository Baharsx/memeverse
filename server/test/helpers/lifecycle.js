import { createSettlementPolicy } from '../../domain/policy.js';
import { settlementExecutionBindingHash } from '../../domain/settlement-binding.js';
import { SettlementService } from '../../domain/settlement-service.js';
import { MemorySettlementStore } from '../../repositories/settlement-store.js';

export const operatorAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const otherOperator = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const transactionHash = `0x${'ab'.repeat(32)}`;

/**
 * Fires scheduled heartbeats on demand instead of on wall-clock time, so a lease-renewal test
 * controls exactly when a beat happens relative to the simulated provider call and the clock.
 */
export function manualScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(handler, delayMs) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { handler, delayMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    /** Runs every currently scheduled beat to completion, including the write it performs. */
    async fire() {
      const scheduled = [...timers.values()];
      timers.clear();
      for (const timer of scheduled) await timer.handler();
      return scheduled.length;
    },
  };
}

/** A clock the test moves by hand, shared by the service, the quote TTL, and the claim lease. */
export function manualClock(start = '2026-08-03T10:00:00.000Z') {
  let current = new Date(start);
  return {
    get now() { return current; },
    advance(seconds) { current = new Date(current.getTime() + seconds * 1000); },
    reader: () => current,
  };
}

/**
 * Records every provider invocation and can hold one open indefinitely, so a test has a real
 * window in which the quote TTL elapses or a second executor tries to take over.
 */
export function recordingGateway({ onExecute, transaction, treasuryAvailableUnits } = {}) {
  const gateway = {
    executeCalls: [],
    statusCalls: [],
    configuration() {
      return { configured: true, missing: [] };
    },
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
  if (treasuryAvailableUnits !== undefined) {
    gateway.treasuryAvailableUnits = async () => treasuryAvailableUnits;
  }
  return gateway;
}

let bindingHash = null;

/** Mirrors what the transport resolves after consuming a real, settlement-bound approval. */
export function authority(reference, overrides = {}) {
  return {
    mode: 'MANUAL_OPERATOR',
    operatorAddress,
    sessionId: `session-${reference}`,
    authorizationRef: `${reference}`.padEnd(32, 'a'),
    bindingHash,
    authorizedAt: '2026-08-03T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * A quoted, prepared settlement whose quote TTL, claim lease, and heartbeat interval are all
 * short enough to cross by hand.
 */
export async function lifecycleFixture({
  gateway = recordingGateway(),
  store,
  arcIndexer,
  clock = manualClock(),
  scheduler = manualScheduler(),
  quoteTtlSeconds = 60,
  executionClaimLeaseSeconds = 30,
  executionClaimHeartbeatSeconds = 5,
  idempotencyKey = 'lifecycle-key-0001',
  reference = 'LIFECYCLE-CASE',
  settlementId = 'lifecycle-settlement-1',
} = {}) {
  const settlementStore = store ?? new MemorySettlementStore();
  let nextId = 0;
  const service = new SettlementService({
    store: settlementStore,
    policy: createSettlementPolicy({
      maxSpendUsdc: '25.00', minViralityScore: 78, creatorShareBps: 6000,
    }),
    chainId: 5042002,
    quoteTtlSeconds,
    circleGateway: gateway,
    arcIndexer,
    executionClaimLeaseSeconds,
    executionClaimHeartbeatSeconds,
    scheduler,
    now: clock.reader,
    id: () => {
      nextId += 1;
      return nextId === 1 ? settlementId : `${settlementId}-claim-${nextId}`;
    },
  });
  const quote = await service.quote({
    recipient: '0x1111111111111111111111111111111111111111',
    requestedAmount: '10.00',
    viralityScore: 90,
    reference,
  }, idempotencyKey);
  const prepared = await service.prepare(quote.record.id);
  bindingHash = settlementExecutionBindingHash(prepared);
  return {
    service,
    store: settlementStore,
    gateway,
    scheduler,
    clock,
    id: quote.record.id,
    expiresAt: quote.record.expiresAt,
  };
}

/** A promise plus the function that settles it, for holding a provider call open. */
export function gate() {
  let open;
  const held = new Promise((resolve) => { open = resolve; });
  return { held, open: () => open() };
}

export function settle() {
  return new Promise((resolve) => { setImmediate(resolve); });
}
