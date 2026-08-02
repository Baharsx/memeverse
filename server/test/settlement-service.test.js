import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettlementPolicy } from '../domain/policy.js';
import { SettlementService } from '../domain/settlement-service.js';
import { MemorySettlementStore } from '../repositories/settlement-store.js';

function fixture(circleGateway) {
  let currentTime = new Date('2026-08-02T10:00:00.000Z');
  const store = new MemorySettlementStore();
  const policy = createSettlementPolicy({
    maxSpendUsdc: '25.00',
    minViralityScore: 78,
    creatorShareBps: 6000,
  });
  const service = new SettlementService({
    store,
    policy,
    chainId: 5042002,
    quoteTtlSeconds: 300,
    circleGateway,
    now: () => currentTime,
    id: () => 'settlement-1',
  });
  return {
    store,
    service,
    advance(milliseconds) {
      currentTime = new Date(currentTime.getTime() + milliseconds);
    },
  };
}

const validRequest = {
  recipient: '0x1111111111111111111111111111111111111111',
  requestedAmount: '25.00',
  viralityScore: 84,
  reference: 'CREATOR-PAYOUT-001',
};

test('quote is persistent, exact, Arc-specific, and never broadcast', async () => {
  const { service } = fixture();
  const result = await service.quote(validRequest, 'request-key-001');

  assert.equal(result.replayed, false);
  assert.equal(result.record.state, 'PREPARED');
  assert.equal(result.record.chainId, 5042002);
  assert.equal(result.record.chainCode, 'ARC-TESTNET');
  assert.equal(result.record.amount.creatorPayoutUsdc, '15');
  assert.equal(result.record.broadcast, false);
  assert.match(result.record.memoId, /^0x[0-9a-f]{64}$/);
});

test('same idempotency key replays the record and rejects a changed payload', async () => {
  const { service } = fixture();
  const first = await service.quote(validRequest, 'request-key-002');
  const replay = await service.quote(validRequest, 'request-key-002');

  assert.equal(replay.replayed, true);
  assert.equal(replay.record.id, first.record.id);
  await assert.rejects(
    service.quote({ ...validRequest, requestedAmount: '10.00' }, 'request-key-002'),
    { code: 'IDEMPOTENCY_KEY_REUSED', status: 409 },
  );
});

test('approved quote prepares a non-broadcast Circle adapter plan idempotently', async () => {
  const { service } = fixture();
  const quote = await service.quote(validRequest, 'request-key-003');
  const prepared = await service.prepare(quote.record.id);
  const replay = await service.prepare(quote.record.id);

  assert.equal(prepared.state, 'AWAITING_SIGNATURE');
  assert.equal(prepared.executionPlan.provider, 'CIRCLE_DEVELOPER_CONTROLLED_WALLET');
  assert.equal(prepared.executionPlan.amountUsdc, '15');
  assert.equal(prepared.executionPlan.broadcast, false);
  assert.deepEqual(replay, prepared);
});

test('expired quotes cannot be prepared', async () => {
  const { service, advance } = fixture();
  const quote = await service.quote(validRequest, 'request-key-004');
  advance(300_001);

  await assert.rejects(service.prepare(quote.record.id), {
    code: 'SETTLEMENT_NOT_PREPARABLE',
    status: 409,
  });
  assert.equal((await service.get(quote.record.id)).state, 'EXPIRED');
});

test('denied quote is stored with reasons and cannot be prepared', async () => {
  const { service } = fixture();
  const denied = await service.quote(
    { ...validRequest, viralityScore: 40 },
    'request-key-005',
  );

  assert.equal(denied.record.state, 'DENIED');
  assert.equal(denied.record.policy.approved, false);
  assert.equal(denied.record.policy.reasons[0].code, 'VIRALITY_SCORE_TOO_LOW');
  await assert.rejects(service.prepare(denied.record.id), {
    code: 'SETTLEMENT_NOT_PREPARABLE',
  });
});

test('Circle execution and reconciliation persist asynchronous provider states', async () => {
  const transactionHash = `0x${'ab'.repeat(32)}`;
  const calls = [];
  const circleGateway = {
    async executeTransfer(record) {
      calls.push(['execute', record.id]);
      return { id: 'circle-transaction-1', state: 'INITIATED', walletId: 'wallet-1' };
    },
    async getTransaction(id) {
      calls.push(['reconcile', id]);
      return {
        id,
        state: 'SENT',
        blockchain: 'ARC-TESTNET',
        destinationAddress: validRequest.recipient,
        txHash: transactionHash,
        walletId: 'wallet-1',
      };
    },
  };
  const { service } = fixture(circleGateway);
  const quote = await service.quote(validRequest, 'request-key-006');
  await service.prepare(quote.record.id);
  const initiated = await service.execute(quote.record.id);
  const sent = await service.execute(quote.record.id);

  assert.equal(initiated.state, 'INITIATED');
  assert.equal(initiated.broadcast, false);
  assert.equal(initiated.circle.transactionId, 'circle-transaction-1');
  assert.equal(sent.state, 'SENT');
  assert.equal(sent.broadcast, true);
  assert.equal(sent.transactionHash, transactionHash);
  assert.deepEqual(calls, [
    ['execute', quote.record.id],
    ['reconcile', 'circle-transaction-1'],
  ]);
});

test('Circle webhook ignores stale success states after confirmation', async () => {
  const circleGateway = {
    async executeTransfer() {
      return { id: 'circle-transaction-2', state: 'CONFIRMED' };
    },
  };
  const { service } = fixture(circleGateway);
  const quote = await service.quote(validRequest, 'request-key-007');
  await service.prepare(quote.record.id);
  await service.execute(quote.record.id);
  const outcome = await service.applyCircleNotification({
    id: 'circle-transaction-2',
    state: 'QUEUED',
  });
  const current = await service.get(quote.record.id);

  assert.equal(outcome.matched, true);
  assert.equal(current.state, 'CONFIRMED');
  assert.equal(current.circle.state, 'CONFIRMED');
});
