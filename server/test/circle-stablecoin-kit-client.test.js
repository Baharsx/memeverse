import assert from 'node:assert/strict';
import test from 'node:test';
import { CircleStablecoinKitClient } from '../infrastructure/circle-stablecoin-kit-client.js';

const walletAddress = '0x6bbd385c0f51d273a1685c977fafa179f9eeb689';
const kitKey = 'KIT_KEY:key-id:secret-value';

function walletGateway(overrides = {}) {
  return {
    async readiness() {
      return {
        configured: true,
        wallet: {
          address: walletAddress,
          blockchain: 'ARC-TESTNET',
          state: 'LIVE',
          ...overrides,
        },
      };
    },
  };
}

function providerResponse(overrides = {}) {
  return {
    tokenInAddress: '0x3600000000000000000000000000000000000000',
    tokenInChain: 'Arc_Testnet',
    tokenOutAddress: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    tokenOutChain: 'Arc_Testnet',
    fromAddress: walletAddress,
    toAddress: walletAddress,
    amount: '1000000',
    stopLimit: '970000',
    estimatedAmount: '990000',
    correlationId: 'c87a10d0-d3d0-44a4-a8ec-59eef7351d04',
    fees: { provider: [{ token: 'USDC', symbol: 'USDC', amount: '200', decimals: 6 }] },
    transaction: { signature: 'not-returned-by-memeverse' },
    ...overrides,
  };
}

test('Stablecoin Kits client authenticates server-side and returns a sanitized estimate', async () => {
  let captured;
  const client = new CircleStablecoinKitClient({
    kitKey,
    apiBaseUrl: 'https://api.circle.com',
    walletGateway: walletGateway(),
    fetchImpl: async (url, options) => {
      captured = { url: url.toString(), options };
      return new Response(JSON.stringify(providerResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const estimate = await client.estimateSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' });
  const requestBody = JSON.parse(captured.options.body);

  assert.equal(captured.url, 'https://api.circle.com/v1/stablecoinKits/swap');
  assert.equal(captured.options.headers.authorization, `Bearer ${kitKey}`);
  assert.equal(requestBody.amount, '1000000');
  assert.equal(requestBody.tokenInChain, 'Arc_Testnet');
  assert.equal(estimate.estimatedOutput.amount, '0.99');
  assert.equal(estimate.stopLimit.amount, '0.97');
  assert.equal(estimate.fees[0].amount, '0.0002');
  assert.equal(JSON.stringify(estimate).includes('signature'), false);
  assert.equal(JSON.stringify(estimate).includes(kitKey), false);
});

test('Stablecoin Kits client rejects a quote whose echoed parameters differ', async () => {
  const client = new CircleStablecoinKitClient({
    kitKey,
    apiBaseUrl: 'https://api.circle.com',
    walletGateway: walletGateway(),
    fetchImpl: async () => new Response(JSON.stringify(providerResponse({ amount: '2000000' })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    client.estimateSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' }),
    { code: 'APP_KIT_PROVIDER_MISMATCH', status: 502 },
  );
});

test('Stablecoin Kits client redacts provider errors', async () => {
  const client = new CircleStablecoinKitClient({
    kitKey,
    apiBaseUrl: 'https://api.circle.com',
    walletGateway: walletGateway(),
    fetchImpl: async () => new Response(JSON.stringify({
      code: 'AUTH_DENIED',
      message: `credential ${kitKey} rejected`,
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }),
  });

  await assert.rejects(
    client.estimateSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' }),
    (error) => {
      assert.equal(error.code, 'APP_KIT_PROVIDER_REJECTED');
      assert.equal(error.status, 502);
      assert.equal(JSON.stringify(error).includes(kitKey), false);
      assert.equal(error.message.includes(kitKey), false);
      return true;
    },
  );
});

test('Stablecoin Kits client requires a live Arc Testnet wallet', async () => {
  const client = new CircleStablecoinKitClient({
    kitKey,
    apiBaseUrl: 'https://api.circle.com',
    walletGateway: walletGateway({ state: 'FROZEN' }),
    fetchImpl: async () => { throw new Error('must not be called'); },
  });

  await assert.rejects(
    client.estimateSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' }),
    { code: 'APP_KIT_WALLET_NOT_READY', status: 503 },
  );
});
