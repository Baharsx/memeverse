import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { createSettlementPolicy } from './domain/policy.js';
import { SettlementService } from './domain/settlement-service.js';
import { ArcRpcClient } from './infrastructure/arc-rpc.js';
import { JsonSettlementStore } from './repositories/settlement-store.js';
import { JsonNotificationStore } from './repositories/notification-store.js';
import { loadLocalEnvironment } from './load-env.js';
import { createCircleWalletGateway } from './infrastructure/circle-wallet-gateway.js';
import { CircleWebhookVerifier } from './infrastructure/circle-webhook-verifier.js';
import { CircleWebhookService } from './domain/circle-webhook-service.js';

loadLocalEnvironment();

const config = loadServerConfig();
const store = new JsonSettlementStore(config.dataFile);
const notificationStore = new JsonNotificationStore(config.circleNotificationDataFile);
await Promise.all([store.initialize(), notificationStore.initialize()]);

const policy = createSettlementPolicy(config);
const circleGateway = createCircleWalletGateway(config);
const settlementService = new SettlementService({
  store,
  policy,
  chainId: config.arcChainId,
  quoteTtlSeconds: config.quoteTtlSeconds,
  circleGateway,
});
const arcRpc = new ArcRpcClient({
  rpcUrl: config.arcRpcUrl,
  expectedChainId: config.arcChainId,
});
const webhookVerifier = new CircleWebhookVerifier({
  circleGateway,
  cacheSeconds: config.circleWebhookKeyCacheSeconds,
});
const circleWebhookService = new CircleWebhookService({
  verifier: webhookVerifier,
  notificationStore,
  settlementService,
});
const app = createApp({
  config,
  settlementService,
  arcRpc,
  circleGateway,
  circleWebhookService,
});
const server = app.listen(config.port, '127.0.0.1', () => {
  console.info(JSON.stringify({
    type: 'server_started',
    port: config.port,
    chainId: config.arcChainId,
    dataFile: config.dataFile,
    circleConfigured: circleGateway.configuration().configured,
  }));
});

function shutdown(signal) {
  console.info(JSON.stringify({ type: 'server_stopping', signal }));
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
