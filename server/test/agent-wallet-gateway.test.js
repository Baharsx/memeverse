import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { CircleAgentWalletGateway } from '../infrastructure/circle-agent-wallet-gateway.js';
import { ArcSettlementIndexer } from '../infrastructure/arc-settlement-indexer.js';
import {
  ARC_MEMO_ADDRESS, ARC_USDC_ADDRESS, createArcDirectSettlementExecutionPlan,
} from '../infrastructure/arc-contracts.js';

const AGENT_WALLET = '0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3';
const AGENT_SETTLEMENT = '0x2176107C2562Ed30ca1d490C43cD53C3369946e2';
const MEMO_SETTLEMENT = '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7';
const RECIPIENT = '0xBc5F97E60Ee9eeeDaC7BDb4F6eF7f29fDE3c1709';
const BUNDLER = '0xa7fA08Fc6CCE632981ac45fd4Cf278358233B762';
const ENTRY_POINT = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789';

const config = {
  agentWalletAddress: AGENT_WALLET,
  agentSettlementContractAddress: AGENT_SETTLEMENT,
  arcRpcUrl: 'http://127.0.0.1:0',
};

function settlementRecord(overrides = {}) {
  const record = {
    id: 'settlement-1',
    recipient: RECIPIENT,
    memoId: keccak256(stringToHex('memeverse:test:settlement-1')),
    amount: { creatorPayoutUnits: '60000', creatorPayoutUsdc: '0.060000' },
    executionSubmission: { providerOperationKey: 'settlement-1' },
    ...overrides,
  };
  record.executionPlan = overrides.executionPlan
    ?? createArcDirectSettlementExecutionPlan(record, AGENT_SETTLEMENT);
  return record;
}

/** A stand-in for the Circle CLI that records the exact argv it was invoked with. */
function fakeCli(responder) {
  const invocations = [];
  return {
    invocations,
    async execute(command, args) {
      invocations.push({ command, args });
      const result = responder(args, invocations.length);
      if (result instanceof Error) throw result;
      return { stdout: JSON.stringify(result), stderr: '' };
    },
  };
}

test('the gateway reports the Agent Wallet honestly and leaks no account identity', async () => {
  const cli = fakeCli((args) => {
    if (args[1] === 'status') {
      return {
        data: {
          type: 'agent',
          mainnet: { tokenStatus: 'NOT_LOGGED_IN' },
          testnet: { email: 'someone@example.com', tokenStatus: 'VALID', expiresIn: '28d' },
        },
      };
    }
    return {
      data: {
        balances: [
          { amount: '20', token: { symbol: 'USDC', decimals: 18, isNative: true } },
          { amount: '20', token: { symbol: 'USDC', decimals: 6 } },
        ],
      },
    };
  });
  const gateway = new CircleAgentWalletGateway({ config, execute: cli.execute });

  const readiness = await gateway.readiness();
  assert.equal(readiness.configured, true);
  assert.equal(readiness.provider, 'CIRCLE_AGENT_WALLET');
  assert.equal(readiness.wallet.address, AGENT_WALLET);
  // An Agent Wallet is an ERC-4337 smart contract account and must be reported as one.
  assert.equal(readiness.wallet.accountType, 'SCA');
  assert.equal(readiness.wallet.state, 'LIVE');
  assert.equal(readiness.usdcBalance, '20', 'the six-decimal interface balance is preferred');
  assert.equal(await gateway.treasuryAvailableUnits(), 20_000_000n);

  // The signed-in email is a personal identifier and must never reach payout evidence.
  assert.equal(JSON.stringify(readiness).includes('someone@example.com'), false);
  assert.equal(JSON.stringify(readiness).includes('@'), false);
});

test('an expired or missing session is never reported as live', async () => {
  for (const testnet of [
    { tokenStatus: 'NOT_LOGGED_IN' },
    { tokenStatus: 'EXPIRED' },
    undefined,
  ]) {
    const cli = fakeCli((args) => (args[1] === 'status'
      ? { data: { type: 'agent', testnet } }
      : { data: { balances: [] } }));
    const gateway = new CircleAgentWalletGateway({ config, execute: cli.execute });
    const readiness = await gateway.readiness();
    assert.equal(readiness.wallet.state, 'UNAVAILABLE');
    assert.equal(readiness.usdcBalance, '0');
  }
});

test('an unconfigured Agent Wallet fails closed rather than guessing', async () => {
  const gateway = new CircleAgentWalletGateway({
    config: { arcRpcUrl: 'http://127.0.0.1:0' },
    execute: async () => { throw new Error('the CLI must not be invoked'); },
  });
  assert.equal(gateway.configuration().configured, false);
  assert.deepEqual(
    gateway.configuration().missing,
    ['AGENT_WALLET_ADDRESS', 'AGENT_SETTLEMENT_CONTRACT_ADDRESS'],
  );
  await assert.rejects(() => gateway.treasuryAvailableUnits(), { code: 'AGENT_WALLET_NOT_CONFIGURED' });
  assert.throws(() => gateway.createExecutionPlan(settlementRecord()), {
    code: 'AGENT_WALLET_NOT_CONFIGURED',
  });
});

test('execution passes the settlement identity and its deterministic idempotency key', async () => {
  const cli = fakeCli(() => ({
    data: {
      id: 'circle-tx-1',
      state: 'COMPLETE',
      txHash: `0x${'ab'.repeat(32)}`,
      sourceAddress: AGENT_WALLET.toLowerCase(),
      blockchain: 'ARC-TESTNET',
    },
  }));
  const gateway = new CircleAgentWalletGateway({ config, execute: cli.execute });
  const record = settlementRecord();

  const transaction = await gateway.executeSettlement(record);

  const { args } = cli.invocations[0];
  assert.deepEqual(args.slice(0, 3), ['wallet', 'execute', 'settle(bytes32,address,uint256)']);
  assert.equal(args[3], record.memoId, 'the contract settlement id is the memo id');
  assert.equal(args[4], RECIPIENT);
  assert.equal(args[5], '60000', 'the exact creator payout in atomic units');
  assert.equal(args[args.indexOf('--contract') + 1], AGENT_SETTLEMENT);
  assert.equal(args[args.indexOf('--address') + 1], AGENT_WALLET);
  assert.equal(args[args.indexOf('--chain') + 1], 'ARC-TESTNET');
  // The provider operation key is what makes a resumed claim replay rather than pay twice.
  assert.equal(args[args.indexOf('--idempotency-key') + 1], 'settlement-1');

  assert.equal(transaction.id, 'circle-tx-1');
  assert.equal(transaction.state, 'COMPLETE');
  assert.equal(transaction.sourceAddress, AGENT_WALLET);
  assert.equal(transaction.walletId, null, 'no internal Circle identifier is surfaced');
});

test('a resumed execution reuses the identical provider operation key', async () => {
  const cli = fakeCli(() => ({
    data: { id: 'circle-tx-1', state: 'COMPLETE', txHash: `0x${'ab'.repeat(32)}` },
  }));
  const gateway = new CircleAgentWalletGateway({ config, execute: cli.execute });
  const record = settlementRecord();

  await gateway.executeSettlement(record);
  await gateway.executeSettlement({
    ...record,
    executionSubmission: { providerOperationKey: 'settlement-1', attempt: 2 },
  });

  const keys = cli.invocations.map(({ args }) => args[args.indexOf('--idempotency-key') + 1]);
  assert.deepEqual(keys, ['settlement-1', 'settlement-1']);
});

test('the gateway refuses to execute a Memo-routed plan', async () => {
  const gateway = new CircleAgentWalletGateway({
    config,
    execute: async () => { throw new Error('the CLI must not be invoked'); },
  });
  await assert.rejects(
    () => gateway.executeSettlement(settlementRecord({
      executionPlan: { operation: 'ARC_MEMO_CONTRACT_SETTLEMENT' },
    })),
    { code: 'EXECUTION_PLAN_MISMATCH' },
  );
});

test('a CLI failure surfaces a sanitized provider error', async () => {
  const failure = Object.assign(new Error('Command failed'), {
    stdout: JSON.stringify({ error: { code: 'INTERNAL', message: 'Transaction failed: ESTIMATION_ERROR' } }),
  });
  const gateway = new CircleAgentWalletGateway({
    config, execute: async () => { throw failure; },
  });

  await assert.rejects(() => gateway.executeSettlement(settlementRecord()), (error) => {
    assert.equal(error.code, 'CIRCLE_AGENT_REQUEST_FAILED');
    assert.equal(error.status, 502);
    assert.equal(error.details.providerCode, 'INTERNAL');
    assert.ok(error.details.providerMessage.length <= 200);
    return true;
  });
});

test('the direct execution plan carries no Memo hop but keeps the settlement identity', async () => {
  const record = settlementRecord();
  const plan = record.executionPlan;

  assert.equal(plan.provider, 'CIRCLE_AGENT_WALLET');
  assert.equal(plan.operation, 'ARC_DIRECT_SETTLEMENT');
  assert.equal(plan.memoContract, null, 'the agent wallet cannot use Arc Memo CallFrom');
  assert.equal(plan.memoData, null);
  assert.equal(plan.targetContract, AGENT_SETTLEMENT);
  assert.equal(plan.memoId, record.memoId, 'the contract-level settlement id is unchanged');
  assert.equal(plan.callDataHash, keccak256(plan.callData));
  assert.equal(plan.amountUnits, '60000');
});

// ─────────────────────────────────────────────────────────────────────────────
// Reconciliation of a direct (Agent Wallet) settlement
// ─────────────────────────────────────────────────────────────────────────────

function settlementLog(overrides = {}) {
  const {
    address = AGENT_SETTLEMENT,
    settlementId,
    operator = AGENT_WALLET,
    recipient = RECIPIENT,
    amount = 60_000n,
  } = overrides;
  return {
    address,
    logIndex: 1,
    topics: [
      keccak256(stringToHex('SettlementExecuted(bytes32,address,address,uint256)')),
      settlementId,
      `0x${operator.slice(2).toLowerCase().padStart(64, '0')}`,
      `0x${recipient.slice(2).toLowerCase().padStart(64, '0')}`,
    ],
    data: `0x${amount.toString(16).padStart(64, '0')}`,
  };
}

function transferLog({ from = AGENT_WALLET, to = RECIPIENT, value = 60_000n } = {}) {
  return {
    address: ARC_USDC_ADDRESS,
    logIndex: 2,
    topics: [
      keccak256(stringToHex('Transfer(address,address,uint256)')),
      `0x${from.slice(2).toLowerCase().padStart(64, '0')}`,
      `0x${to.slice(2).toLowerCase().padStart(64, '0')}`,
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  };
}

function indexerWith(receipt, transaction) {
  return new ArcSettlementIndexer({
    settlementContractAddress: MEMO_SETTLEMENT,
    agentSettlementContractAddress: AGENT_SETTLEMENT,
    client: {
      async getTransactionReceipt() { return receipt; },
      async getTransaction() { return transaction; },
    },
  });
}

test('a direct Agent Wallet settlement reconciles as VERIFIED without a Memo event', async () => {
  const record = settlementRecord({ transactionHash: `0x${'ab'.repeat(32)}` });
  const receipt = {
    status: 'success',
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    logs: [
      settlementLog({ settlementId: record.memoId }),
      transferLog(),
    ],
  };
  // The outer transaction targets the ERC-4337 EntryPoint, not the settlement contract.
  const indexer = indexerWith(receipt, { to: ENTRY_POINT, from: BUNDLER });

  const result = await indexer.verify(record);

  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.route, 'DIRECT');
  assert.equal(result.settlementContract, AGENT_SETTLEMENT);
  assert.equal(result.operator, AGENT_WALLET, 'the operator is the agent wallet, not the bundler');
  assert.equal(result.memoIndex, null, 'a direct settlement has no memo index');
});

test('a direct settlement emitted by a look-alike contract is rejected', async () => {
  const record = settlementRecord({ transactionHash: `0x${'ab'.repeat(32)}` });
  const receipt = {
    status: 'success',
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    logs: [
      // Correct event shape, wrong contract.
      settlementLog({ settlementId: record.memoId, address: MEMO_SETTLEMENT }),
      transferLog(),
    ],
  };
  const indexer = indexerWith(receipt, { to: ENTRY_POINT, from: BUNDLER });

  const result = await indexer.verify(record);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.failures.includes('SETTLEMENT_EVENT_MISSING')
    || result.failures.includes('SETTLEMENT_CONTRACT_MISMATCH'));
});

test('a direct settlement missing its USDC transfer is rejected', async () => {
  const record = settlementRecord({ transactionHash: `0x${'ab'.repeat(32)}` });
  const receipt = {
    status: 'success',
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    logs: [settlementLog({ settlementId: record.memoId })],
  };
  const indexer = indexerWith(receipt, { to: ENTRY_POINT, from: BUNDLER });

  const result = await indexer.verify(record);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.failures.includes('USDC_TRANSFER_EVENT_MISSING'));
});

test('a direct settlement paying the wrong recipient or amount is rejected', async () => {
  for (const transfer of [
    transferLog({ to: AGENT_WALLET }),
    transferLog({ value: 60_001n }),
  ]) {
    const record = settlementRecord({ transactionHash: `0x${'ab'.repeat(32)}` });
    const receipt = {
      status: 'success',
      blockNumber: 100n,
      blockHash: `0x${'bb'.repeat(32)}`,
      transactionIndex: 0,
      logs: [settlementLog({ settlementId: record.memoId }), transfer],
    };
    const indexer = indexerWith(receipt, { to: ENTRY_POINT, from: BUNDLER });
    const result = await indexer.verify(record);
    assert.equal(result.status, 'MISMATCH');
    assert.ok(result.failures.includes('USDC_TRANSFER_EVENT_MISSING'));
  }
});

test('the Memo route keeps every Memo assertion it had before', async () => {
  // A Memo-routed record whose receipt carries no Memo event must still fail, proving the
  // direct-route addition did not quietly relax the Developer-Controlled Wallet path.
  const record = settlementRecord({ transactionHash: `0x${'ab'.repeat(32)}` });
  record.executionPlan = {
    operation: 'ARC_MEMO_CONTRACT_SETTLEMENT',
    callData: record.executionPlan.callData,
    callDataHash: record.executionPlan.callDataHash,
    memoData: stringToHex('memeverse:settlement:settlement-1'),
  };
  const receipt = {
    status: 'success',
    blockNumber: 100n,
    blockHash: `0x${'bb'.repeat(32)}`,
    transactionIndex: 0,
    logs: [
      settlementLog({ settlementId: record.memoId, address: MEMO_SETTLEMENT }),
      transferLog({ from: AGENT_WALLET }),
    ],
  };
  const indexer = indexerWith(receipt, { to: ARC_MEMO_ADDRESS, from: AGENT_WALLET });

  const result = await indexer.verify(record);
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.failures.includes('MEMO_EVENT_MISSING'), 'the Memo route still demands a Memo');
});
