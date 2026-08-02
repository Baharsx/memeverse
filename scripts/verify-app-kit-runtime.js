import { loadLocalEnvironment } from '../server/load-env.js';
import { loadServerConfig } from '../server/config.js';
import { createCircleAppKitGateway } from '../server/infrastructure/circle-app-kit-gateway.js';
import { createCircleWalletGateway } from '../server/infrastructure/circle-wallet-gateway.js';

loadLocalEnvironment();

const config = loadServerConfig();
const circleGateway = createCircleWalletGateway(config);
const appKitGateway = createCircleAppKitGateway(config, { circleGateway });
const configuration = appKitGateway.configuration();

if (!configuration.runtimeEnabled) {
  throw new Error('The App Kit runtime is not enabled. Check server-only Circle credentials.');
}

const estimate = await appKitGateway.estimateSwap({
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '0.01',
});

console.log(JSON.stringify({
  type: 'app_kit_runtime_verified',
  network: configuration.network,
  provider: configuration.provider,
  dependencyStatus: configuration.dependencyStatus,
  pair: `${estimate.tokenIn}/${estimate.tokenOut}`,
  quoteReceived: Boolean(estimate.estimatedOutput?.amount),
  transactionExecuted: false,
}));
