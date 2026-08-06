import { createAgentPolicy } from './domain/agent-policy.js';
import { AgentDecisionService } from './domain/agent-decision-service.js';
import { OperatorAuthService } from './domain/operator-auth-service.js';
import { createSettlementPolicy } from './domain/policy.js';
import { SettlementService } from './domain/settlement-service.js';
import { ArcRpcClient } from './infrastructure/arc-rpc.js';
import { ArcSettlementIndexer } from './infrastructure/arc-settlement-indexer.js';
import { createCircleAppKitGateway } from './infrastructure/circle-app-kit-gateway.js';
import { createCircleWalletGateway } from './infrastructure/circle-wallet-gateway.js';
import { PostgresOperatorAuthStore } from './repositories/operator-auth-store.js';
import { createPostgresSettlementStore } from './repositories/postgres-settlement-store.js';

export async function createSettlementRuntime(config) {
  const store = createPostgresSettlementStore(config);
  await store.initialize({ migrate: config.runDatabaseMigrations });
  const circleGateway = createCircleWalletGateway(config);
  const arcIndexer = new ArcSettlementIndexer({
    rpcUrl: config.arcRpcUrl,
    settlementContractAddress: config.circleSettlementContractAddress,
  });
  const arcRpc = new ArcRpcClient({
    rpcUrl: config.arcRpcUrl,
    expectedChainId: config.arcChainId,
  });
  const settlementService = new SettlementService({
    store,
    policy: createSettlementPolicy(config),
    chainId: config.arcChainId,
    quoteTtlSeconds: config.quoteTtlSeconds,
    circleGateway,
    arcIndexer,
    executionClaimLeaseSeconds: config.executionClaimLeaseSeconds,
    executionClaimHeartbeatSeconds: config.executionClaimHeartbeatSeconds,
  });
  const agentDecisionService = new AgentDecisionService({
    settlementService,
    arcRpc,
    circleGateway,
    policy: createAgentPolicy(config),
  });
  const appKitGateway = createCircleAppKitGateway(config, { circleGateway });
  const operatorAuthStore = new PostgresOperatorAuthStore({ database: store.database });
  const operatorAuthService = new OperatorAuthService({
    store: operatorAuthStore,
    operatorAddress: config.settlementOperatorAddress,
    appOrigin: config.appOrigin,
    chainId: config.arcChainId,
    challengeTtlSeconds: config.operatorChallengeTtlSeconds,
    sessionTtlSeconds: config.operatorSessionTtlSeconds,
    executionTtlSeconds: config.operatorExecutionTtlSeconds,
  });

  return {
    store,
    operatorAuthStore,
    circleGateway,
    arcIndexer,
    arcRpc,
    settlementService,
    agentDecisionService,
    appKitGateway,
    operatorAuthService,
    /**
     * Deleting long-expired challenges, sessions, and approvals is idempotent and safe to run
     * from any process. A failure is reported by the caller and never blocks startup or
     * settlement reconciliation.
     */
    purgeExpiredAuthRecords() {
      return operatorAuthStore.purgeExpired(new Date().toISOString());
    },
    async close() { await store.close?.(); },
  };
}
