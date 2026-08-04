import { randomUUID } from 'node:crypto';
import { loadServerConfig } from './config.js';
import { ReconciliationWorker } from './domain/reconciliation-worker.js';
import { loadLocalEnvironment } from './load-env.js';
import { createSettlementRuntime } from './runtime.js';

loadLocalEnvironment();
const config = loadServerConfig();
if (!config.databaseUrl && process.env.WORKER_ONCE !== 'true') {
  throw new Error('DATABASE_URL is required for a continuously running separate worker.');
}
const runtime = await createSettlementRuntime(config);
const worker = new ReconciliationWorker({
  store: runtime.store,
  settlementService: runtime.settlementService,
  intervalMs: config.reconciliationIntervalMs,
  leaseSeconds: config.reconciliationLeaseSeconds,
  owner: `worker-${randomUUID()}`,
  operatorAuthStore: runtime.operatorAuthStore,
  authCleanupIntervalMs: config.authCleanupIntervalSeconds * 1000,
});

console.info(JSON.stringify({
  type: 'worker_started',
  persistence: config.databaseUrl ? 'POSTGRES' : 'PGLITE_POSTGRES',
  intervalMs: config.reconciliationIntervalMs,
  leaseSeconds: config.reconciliationLeaseSeconds,
  authCleanupIntervalSeconds: config.authCleanupIntervalSeconds,
}));

if (process.env.WORKER_ONCE === 'true') {
  await worker.tick();
  await runtime.close();
  console.info(JSON.stringify({ type: 'worker_completed_once' }));
} else {
  await worker.tick();
  worker.start();
  const shutdown = async (signal) => {
    console.info(JSON.stringify({ type: 'worker_stopping', signal }));
    await worker.stop();
    await runtime.close();
  };
  process.on('SIGINT', () => shutdown('SIGINT').catch(console.error));
  process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
}
