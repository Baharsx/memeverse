import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
} from 'viem';
import { ArcSettlementIndexer } from '../infrastructure/arc-settlement-indexer.js';
import {
  ARC_MEMO_ADDRESS,
  ARC_USDC_ADDRESS,
  createArcSettlementExecutionPlan,
  memoAbi,
  settlementAbi,
  usdcAbi,
} from '../infrastructure/arc-contracts.js';

const operator = getAddress('0x1111111111111111111111111111111111111111');
const recipient = getAddress('0x2222222222222222222222222222222222222222');
const settlementContract = getAddress('0x3333333333333333333333333333333333333333');
const transactionHash = `0x${'44'.repeat(32)}`;

function log(address, topics, data, logIndex) {
  return { address, topics, data, logIndex, transactionHash };
}

function fixture() {
  const record = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    recipient,
    memoId: `0x${'ab'.repeat(32)}`,
    amount: { creatorPayoutUsdc: '1.5', creatorPayoutUnits: '1500000' },
    circle: { state: 'COMPLETE', sourceAddress: operator },
    transactionHash,
  };
  record.executionPlan = createArcSettlementExecutionPlan(record, settlementContract);

  const memoTopics = encodeEventTopics({
    abi: memoAbi,
    eventName: 'Memo',
    args: { sender: operator, target: settlementContract, memoId: record.memoId },
  });
  const memoData = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes' }, { type: 'uint256' }],
    [record.executionPlan.callDataHash, record.executionPlan.memoData, 7n],
  );
  const settlementTopics = encodeEventTopics({
    abi: settlementAbi,
    eventName: 'SettlementExecuted',
    args: { settlementId: record.memoId, operator, recipient },
  });
  const settlementData = encodeAbiParameters([{ type: 'uint256' }], [1500000n]);
  const transferTopics = encodeEventTopics({
    abi: usdcAbi,
    eventName: 'Transfer',
    args: { from: operator, to: recipient },
  });
  const transferData = encodeAbiParameters([{ type: 'uint256' }], [1500000n]);
  const receipt = {
    status: 'success',
    blockNumber: 42n,
    blockHash: `0x${'55'.repeat(32)}`,
    transactionIndex: 3,
    logs: [
      log(ARC_MEMO_ADDRESS, memoTopics, memoData, 1),
      log(ARC_USDC_ADDRESS, transferTopics, transferData, 2),
      log(settlementContract, settlementTopics, settlementData, 3),
    ],
  };
  return { record, receipt };
}

test('Arc indexer independently verifies Memo, settlement, and USDC events', async () => {
  const { record, receipt } = fixture();
  const indexer = new ArcSettlementIndexer({
    settlementContractAddress: settlementContract,
    client: {
      async getTransactionReceipt() { return receipt; },
      async getTransaction() { return { from: operator, to: ARC_MEMO_ADDRESS }; },
    },
  });

  const result = await indexer.verify(record);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.blockNumber, 42);
  assert.equal(result.memoIndex, '7');
  assert.equal(result.eventLogIndex, 3);
});

test('Arc indexer fails closed when the expected USDC transfer event is absent', async () => {
  const { record, receipt } = fixture();
  receipt.logs = receipt.logs.filter((entry) => entry.address !== ARC_USDC_ADDRESS);
  const indexer = new ArcSettlementIndexer({
    settlementContractAddress: settlementContract,
    client: {
      async getTransactionReceipt() { return receipt; },
      async getTransaction() { return { from: operator, to: ARC_MEMO_ADDRESS }; },
    },
  });

  const result = await indexer.verify(record);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.failures.includes('USDC_TRANSFER_EVENT_MISSING'));
});
