import assert from 'node:assert/strict';
import test from 'node:test';
import { CircleAppKitGateway } from '../infrastructure/circle-app-kit-gateway.js';

test('App Kit boundary publishes truthful Arc capabilities without exposing the kit key', () => {
  const gateway = new CircleAppKitGateway({
    config: { circleKitKey: 'KIT_KEY:key-id:secret-value' },
    client: { async estimateSwap() {} },
  });
  const configuration = gateway.configuration();

  assert.equal(configuration.kitKeyConfigured, true);
  assert.equal(configuration.runtimeEnabled, true);
  assert.equal(configuration.dependencyStatus, 'AVAILABLE_AUDIT_CLEAN');
  assert.equal(configuration.capabilities.length, 4);
  assert.equal(configuration.capabilities.find(({ operation }) => operation === 'SWAP').enabled, true);
  assert.equal(configuration.capabilities.find(({ operation }) => operation === 'SEND').enabled, false);
  assert.equal(JSON.stringify(configuration).includes('secret-value'), false);
});

test('App Kit swap estimation fails closed without a runtime client', async () => {
  const gateway = new CircleAppKitGateway({
    config: { circleKitKey: 'KIT_KEY:key-id:secret-value' },
  });
  await assert.rejects(
    gateway.estimateSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' }),
    { code: 'APP_KIT_RUNTIME_UNAVAILABLE', status: 503 },
  );
});

test('App Kit boundary delegates estimates without passing the Kit Key', async () => {
  let received;
  const gateway = new CircleAppKitGateway({
    config: { circleKitKey: 'KIT_KEY:key-id:secret-value' },
    client: {
      async estimateSwap(input) {
        received = input;
        return { estimatedOutput: { token: 'EURC', amount: '0.91' } };
      },
    },
  });
  const result = await gateway.estimateSwap({ tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' });

  assert.equal(result.estimatedOutput.amount, '0.91');
  assert.deepEqual(received, { tokenIn: 'USDC', tokenOut: 'EURC', amountIn: '1' });
  assert.equal(JSON.stringify(received).includes('secret-value'), false);
});
