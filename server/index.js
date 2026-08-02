import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { createSettlementPolicy } from './domain/policy.js';
import { SettlementService } from './domain/settlement-service.js';
import { ArcRpcClient } from './infrastructure/arc-rpc.js';
import { JsonNotificationStore } from './repositories/notification-store.js';
import { loadLocalEnvironment } from './load-env.js';
import { createCircleWalletGateway } from './infrastructure/circle-wallet-gateway.js';
import { CircleWebhookVerifier } from './infrastructure/circle-webhook-verifier.js';
import { CircleWebhookService } from './domain/circle-webhook-service.js';
import { ArcSettlementIndexer } from './infrastructure/arc-settlement-indexer.js';
import { createPostgresSettlementStore } from './repositories/postgres-settlement-store.js';
import { ReconciliationWorker } from './domain/reconciliation-worker.js';

loadLocalEnvironment();

const config = loadServerConfig();
const store = createPostgresSettlementStore(config);
const notificationStore = new JsonNotificationStore(config.circleNotificationDataFile);
await Promise.all([store.initialize(), notificationStore.initialize()]);

const policy = createSettlementPolicy(config);
const circleGateway = createCircleWalletGateway(config);
const arcIndexer = new ArcSettlementIndexer({
  rpcUrl: config.arcRpcUrl,
  settlementContractAddress: config.circleSettlementContractAddress,
});
const settlementService = new SettlementService({
  store,
  policy,
  chainId: config.arcChainId,
  quoteTtlSeconds: config.quoteTtlSeconds,
  circleGateway,
  arcIndexer,
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
const reconciliationWorker = new ReconciliationWorker({
  store,
  settlementService,
  intervalMs: config.reconciliationIntervalMs,
});
const app = createApp({
  config,
  settlementService,
  arcRpc,
  circleGateway,
  circleWebhookService,
  arcIndexer,
});
const server = app.listen(config.port, '127.0.0.1', () => {
  reconciliationWorker.start();
  console.info(JSON.stringify({
    type: 'server_started',
    port: config.port,
    chainId: config.arcChainId,
    persistence: config.databaseUrl ? 'POSTGRES' : 'PGLITE_POSTGRES',
    circleConfigured: circleGateway.configuration().configured,
  }));
});

async function shutdown(signal) {
  console.info(JSON.stringify({ type: 'server_stopping', signal }));
  await reconciliationWorker.stop();
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  await store.close?.();
}

process.on('SIGINT', () => shutdown('SIGINT').catch(console.error));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
