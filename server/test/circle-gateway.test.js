import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData } from 'viem';
import { CircleWalletGateway } from '../infrastructure/circle-wallet-gateway.js';
import { ARC_MEMO_ADDRESS, memoAbi } from '../infrastructure/arc-contracts.js';

const config = {
  circleApiKey: 'TEST_API_KEY',
  circleEntitySecret: 'a'.repeat(64),
  circleWalletId: 'wallet-id',
  circleFeeLevel: 'MEDIUM',
  arcUsdcAddress: '0x3600000000000000000000000000000000000000',
  circleSettlementContractAddress: '0x2222222222222222222222222222222222222222',
};

test('Circle gateway builds a direct EOA Arc Memo contract execution without exposing secrets', async () => {
  let transferInput;
  const gateway = new CircleWalletGateway({
    config,
    client: {
      async createContractExecutionTransaction(input) {
        transferInput = input;
        return { data: { id: 'circle-tx-1', state: 'INITIATED' } };
      },
    },
  });
  const record = {
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    recipient: '0x1111111111111111111111111111111111111111',
    memoId: `0x${'ab'.repeat(32)}`,
    amount: { creatorPayoutUsdc: '15', creatorPayoutUnits: '15000000' },
  };
  record.executionPlan = gateway.createExecutionPlan(record);
  const transaction = await gateway.executeSettlement(record);

  assert.equal(transaction.id, 'circle-tx-1');
  assert.equal(transferInput.contractAddress, ARC_MEMO_ADDRESS);
  assert.equal(transferInput.walletId, 'wallet-id');
  assert.equal(transferInput.idempotencyKey, record.id);
  const decoded = decodeFunctionData({ abi: memoAbi, data: transferInput.callData });
  assert.equal(decoded.functionName, 'memo');
  assert.equal(decoded.args[0], config.circleSettlementContractAddress);
  assert.equal(decoded.args[2], record.memoId);
  assert.equal('circleEntitySecret' in transferInput, false);
});

test('Circle gateway reports missing server configuration and fails closed', async () => {
  const gateway = new CircleWalletGateway({ config: {}, client: null });

  assert.deepEqual(gateway.configuration().missing, [
    'CIRCLE_API_KEY',
    'CIRCLE_ENTITY_SECRET',
    'CIRCLE_WALLET_ID',
    'CIRCLE_SETTLEMENT_CONTRACT_ADDRESS',
  ]);
  await assert.rejects(gateway.executeSettlement({}), {
    code: 'CIRCLE_NOT_CONFIGURED',
    status: 503,
  });
});

test('Circle readiness returns only operational wallet and USDC information', async () => {
  const gateway = new CircleWalletGateway({
    config,
    client: {
      async getWallet() {
        return { data: { wallet: {
          id: 'wallet-id', address: '0xabc', blockchain: 'ARC-TESTNET',
          state: 'LIVE', accountType: 'EOA',
        } } };
      },
      async getWalletTokenBalance() {
        return { data: { tokenBalances: [{
          amount: '20.123456789012345678',
          token: { blockchain: 'ARC-TESTNET', symbol: 'USDC' },
        }] } };
      },
    },
  });

  const readiness = await gateway.readiness();
  assert.equal(readiness.configured, true);
  assert.equal(readiness.wallet.accountType, 'EOA');
  assert.equal(readiness.usdcBalance, '20.123456789012345678');
  assert.equal(await gateway.treasuryAvailableUnits(), 20_123_456n);
  assert.equal(JSON.stringify(readiness).includes(config.circleEntitySecret), false);
});
