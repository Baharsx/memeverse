import assert from 'node:assert/strict';
import test from 'node:test';
import { CircleWalletGateway } from '../infrastructure/circle-wallet-gateway.js';

const config = {
  circleApiKey: 'TEST_API_KEY',
  circleEntitySecret: 'a'.repeat(64),
  circleWalletId: 'wallet-id',
  circleFeeLevel: 'MEDIUM',
  arcUsdcAddress: '0x3600000000000000000000000000000000000000',
};

test('Circle gateway builds an Arc Testnet USDC transfer without exposing secrets', async () => {
  let transferInput;
  const gateway = new CircleWalletGateway({
    config,
    client: {
      async createTransaction(input) {
        transferInput = input;
        return { data: { id: 'circle-tx-1', state: 'INITIATED' } };
      },
    },
  });
  const transaction = await gateway.executeTransfer({
    id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    recipient: '0x1111111111111111111111111111111111111111',
    amount: { creatorPayoutUsdc: '15' },
  });

  assert.equal(transaction.id, 'circle-tx-1');
  assert.deepEqual(transferInput, {
    idempotencyKey: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    walletId: 'wallet-id',
    destinationAddress: '0x1111111111111111111111111111111111111111',
    amount: ['15'],
    tokenAddress: config.arcUsdcAddress,
    blockchain: 'ARC-TESTNET',
    refId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  assert.equal('circleEntitySecret' in transferInput, false);
});

test('Circle gateway reports missing server configuration and fails closed', async () => {
  const gateway = new CircleWalletGateway({ config: {}, client: null });

  assert.deepEqual(gateway.configuration().missing, [
    'CIRCLE_API_KEY',
    'CIRCLE_ENTITY_SECRET',
    'CIRCLE_WALLET_ID',
  ]);
  await assert.rejects(gateway.executeTransfer({}), {
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
          amount: '20',
          token: { blockchain: 'ARC-TESTNET', symbol: 'USDC' },
        }] } };
      },
    },
  });

  const readiness = await gateway.readiness();
  assert.equal(readiness.configured, true);
  assert.equal(readiness.wallet.accountType, 'EOA');
  assert.equal(readiness.usdcBalance, '20');
  assert.equal(JSON.stringify(readiness).includes(config.circleEntitySecret), false);
});
