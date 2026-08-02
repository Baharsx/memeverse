import { createAgentPolicy } from './domain/agent-policy.js';
import { AgentDecisionService } from './domain/agent-decision-service.js';
import { createSettlementPolicy } from './domain/policy.js';
import { SettlementService } from './domain/settlement-service.js';
import { ArcRpcClient } from './infrastructure/arc-rpc.js';
import { ArcSettlementIndexer } from './infrastructure/arc-settlement-indexer.js';
import { createCircleAppKitGateway } from './infrastructure/circle-app-kit-gateway.js';
import { createCircleWalletGateway } from './infrastructure/circle-wallet-gateway.js';
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
  });
  const agentDecisionService = new AgentDecisionService({
    settlementService,
    arcRpc,
    circleGateway,
    policy: createAgentPolicy(config),
  });
  const appKitGateway = createCircleAppKitGateway(config, { circleGateway });

  return {
    store,
    circleGateway,
    arcIndexer,
    arcRpc,
    settlementService,
    agentDecisionService,
    appKitGateway,
    async close() { await store.close?.(); },
  };
}
