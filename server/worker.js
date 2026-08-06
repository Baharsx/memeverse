import { randomUUID } from 'node:crypto';
import { loadServerConfig } from './config.js';
import { AutonomousAgentWorker } from './domain/autonomous-agent-worker.js';
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

/**
 * The autonomous agent runs only when it has been deliberately enabled *and* an Agent Wallet is
 * configured. Absent either, the worker keeps doing reconciliation and simply never creates
 * autonomous work — it does not silently fall back to spending from the manual treasury.
 */
const agentWorker = config.agentAutonomousEnabled && runtime.autonomousAgentService
  ? new AutonomousAgentWorker({
    autonomousAgentService: runtime.autonomousAgentService,
    autonomyStore: runtime.autonomyStore,
    collector: runtime.signalCollector,
    intervalMs: config.agentWorkerIntervalMs,
  })
  : null;

console.info(JSON.stringify({
  type: 'worker_started',
  persistence: config.databaseUrl ? 'POSTGRES' : 'PGLITE_POSTGRES',
  intervalMs: config.reconciliationIntervalMs,
  leaseSeconds: config.reconciliationLeaseSeconds,
  authCleanupIntervalSeconds: config.authCleanupIntervalSeconds,
  autonomousAgent: agentWorker
    ? { enabled: true, intervalMs: config.agentWorkerIntervalMs }
    : {
      enabled: false,
      reason: config.agentAutonomousEnabled
        ? 'AGENT_WALLET_NOT_CONFIGURED'
        : 'AGENT_AUTONOMOUS_ENABLED_FALSE',
    },
}));

if (process.env.WORKER_ONCE === 'true') {
  await worker.tick();
  if (agentWorker) await agentWorker.tick();
  await runtime.close();
  console.info(JSON.stringify({ type: 'worker_completed_once' }));
} else {
  await worker.tick();
  worker.start();
  if (agentWorker) {
    // The first sweep runs immediately so an eligible creator is not left waiting a whole
    // interval after a deploy or restart.
    await agentWorker.tick().catch((error) => console.error(JSON.stringify({
      type: 'agent_worker_initial_tick_failed', message: error?.message,
    })));
    agentWorker.start();
  }
  const shutdown = async (signal) => {
    console.info(JSON.stringify({ type: 'worker_stopping', signal }));
    await worker.stop();
    if (agentWorker) await agentWorker.stop();
    await runtime.close();
  };
  process.on('SIGINT', () => shutdown('SIGINT').catch(console.error));
  process.on('SIGTERM', () => shutdown('SIGTERM').catch(console.error));
}
