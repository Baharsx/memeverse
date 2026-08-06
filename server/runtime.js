import { hostname } from 'node:os';
import { createPublicClient, http } from 'viem';
import { createAgentPolicy } from './domain/agent-policy.js';
import { AgentDecisionService } from './domain/agent-decision-service.js';
import { createPayoutPolicy } from './domain/agent-payout.js';
import {
  AUTONOMOUS_POLICY_VERSION, AutonomousAgentService,
} from './domain/autonomous-agent-service.js';
import { defaultMetricConfig } from './domain/agent-signal-metrics.js';
import { OperatorAuthService } from './domain/operator-auth-service.js';
import { createSettlementPolicy } from './domain/policy.js';
import { SettlementService } from './domain/settlement-service.js';
import { ArcRpcClient } from './infrastructure/arc-rpc.js';
import { ArcMarketSignalCollector } from './infrastructure/arc-market-signal-collector.js';
import { ArcSettlementIndexer } from './infrastructure/arc-settlement-indexer.js';
import { createCircleAgentWalletGateway } from './infrastructure/circle-agent-wallet-gateway.js';
import { createCircleAppKitGateway } from './infrastructure/circle-app-kit-gateway.js';
import { createCircleWalletGateway } from './infrastructure/circle-wallet-gateway.js';
import { AgentAutonomyStore } from './repositories/agent-autonomy-store.js';
import { PostgresOperatorAuthStore } from './repositories/operator-auth-store.js';
import { createPostgresSettlementStore } from './repositories/postgres-settlement-store.js';

export async function createSettlementRuntime(config) {
  const store = createPostgresSettlementStore(config);
  await store.initialize({ migrate: config.runDatabaseMigrations });
  const circleGateway = createCircleWalletGateway(config);
  const arcIndexer = new ArcSettlementIndexer({
    rpcUrl: config.arcRpcUrl,
    settlementContractAddress: config.circleSettlementContractAddress,
    agentSettlementContractAddress: config.agentSettlementContractAddress,
    agentWalletAddress: config.agentWalletAddress,
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

  const autonomyStore = new AgentAutonomyStore({ database: store.database });

  /**
   * The autonomous path executes as the Circle Agent Wallet, through its own settlement contract.
   * It reuses the very same SettlementService class — and therefore the same execution claim,
   * lease heartbeat, optimistic concurrency, and reconciliation — with only the provider gateway
   * swapped. The manual operator path keeps the Developer-Controlled Wallet and its Memo-routed
   * contract, so the two payout routes never share a wallet, a contract, or an allowance.
   */
  const agentWalletGateway = createCircleAgentWalletGateway(config, { store });
  const autonomousSettlementService = agentWalletGateway.configuration().configured
    ? new SettlementService({
      store,
      policy: createSettlementPolicy(config),
      chainId: config.arcChainId,
      quoteTtlSeconds: config.quoteTtlSeconds,
      circleGateway: agentWalletGateway,
      arcIndexer,
      executionClaimLeaseSeconds: config.executionClaimLeaseSeconds,
      executionClaimHeartbeatSeconds: config.executionClaimHeartbeatSeconds,
    })
    : null;
  const signalCollector = new ArcMarketSignalCollector({
    publicClient: createPublicClient({ transport: http(config.arcRpcUrl) }),
    chainId: config.arcChainId,
    factoryAddress: config.marketFactoryAddress,
    minConfirmations: config.agentMinConfirmations,
    lookbackBlocks: config.agentSignalLookbackBlocks,
    metricConfig: defaultMetricConfig,
    policyVersion: AUTONOMOUS_POLICY_VERSION,
  });
  /**
   * Autonomy exists only when the Circle Agent Wallet route exists.
   *
   * There is deliberately no fallback to the Developer-Controlled Wallet. AUTONOMOUS_POLICY means
   * "the Agent Wallet paid this, through the autonomous settlement contract"; letting it quietly
   * mean "the manual treasury paid this with no human approval" would be a different and far
   * worse thing wearing the same name. Without the Agent Wallet the service is simply not
   * constructed, so no caller — worker, script, transport, or future code — can reach it.
   */
  const autonomousAgentService = autonomousSettlementService ? new AutonomousAgentService({
    collector: signalCollector,
    autonomyStore,
    settlementService: autonomousSettlementService,
    agentPolicy: createAgentPolicy(config),
    payoutPolicy: createPayoutPolicy({
      maxPayoutUsdc: config.agentAutonomousMaxPayoutUsdc,
      minPayoutUsdc: config.agentAutonomousMinPayoutUsdc,
      marketDailyCapUsdc: config.agentMarketDailyCapUsdc,
      dailySpendUsdc: config.agentDailySpendUsdc,
      scoreFloor: config.agentAutonomousScoreFloor,
    }),
    arcRpc,
    circleGateway: agentWalletGateway,
    cooldownSeconds: config.agentMarketCooldownSeconds,
    decisionTtlSeconds: config.agentDecisionTtlSeconds,
    creatorShareBps: config.creatorShareBps,
    // Identifies which process owns an epoch claim. Never surfaced publicly.
    workerId: `${hostname()}:${process.pid}`,
  }) : null;

  return {
    store,
    operatorAuthStore,
    autonomyStore,
    circleGateway,
    arcIndexer,
    arcRpc,
    settlementService,
    agentDecisionService,
    signalCollector,
    agentWalletGateway,
    autonomousSettlementService,
    autonomousAgentService,
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
