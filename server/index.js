import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { loadLocalEnvironment } from './load-env.js';
import { CircleWebhookVerifier } from './infrastructure/circle-webhook-verifier.js';
import { CircleWebhookService } from './domain/circle-webhook-service.js';
import { createSettlementRuntime } from './runtime.js';

loadLocalEnvironment();

const config = loadServerConfig();
const runtime = await createSettlementRuntime(config);
const { store, circleGateway, arcIndexer, settlementService, arcRpc,
  agentDecisionService, autonomousAgentService, autonomyStore,
  appKitGateway, operatorAuthService } = runtime;
const webhookVerifier = new CircleWebhookVerifier({
  circleGateway,
  cacheSeconds: config.circleWebhookKeyCacheSeconds,
});
const circleWebhookService = new CircleWebhookService({
  verifier: webhookVerifier,
  notificationStore: store,
  settlementService,
});
const app = createApp({
  config,
  settlementService,
  arcRpc,
  circleGateway,
  circleWebhookService,
  arcIndexer,
  store,
  agentDecisionService,
  autonomousAgentService,
  autonomyStore,
  appKitGateway,
  operatorAuthService,
});
// One best-effort sweep at boot; the supervised worker repeats it on an interval.
runtime.purgeExpiredAuthRecords().catch((error) => console.error(JSON.stringify({
  type: 'auth_cleanup_error',
  message: error?.message ?? String(error),
})));

const server = app.listen(config.port, '127.0.0.1', () => {
  console.info(JSON.stringify({
    type: 'server_started',
    port: config.port,
    chainId: config.arcChainId,
    persistence: config.databaseUrl ? 'POSTGRES' : 'PGLITE_POSTGRES',
    circleConfigured: circleGateway.configuration().configured,
    operatorAuthConfigured: operatorAuthService.configured,
    executionMode: 'MANUAL_OPERATOR',
    reconciliationMode: 'SEPARATE_WORKER',
  }));
});

async function shutdown(signal) {
  console.info(JSON.stringify({ type: 'server_stopping', signal }));
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  await runtime.close();
}

process.on('SIGINT', () => shutdown('SIGINT').catch(console.error));
process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
