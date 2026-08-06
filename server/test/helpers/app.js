import { createApp } from '../../app.js';
import { AgentDecisionService } from '../../domain/agent-decision-service.js';
import { createAgentPolicy } from '../../domain/agent-policy.js';
import { createSettlementPolicy } from '../../domain/policy.js';
import { SettlementService } from '../../domain/settlement-service.js';
import { createArcSettlementExecutionPlan } from '../../infrastructure/arc-contracts.js';
import { MemorySettlementStore } from '../../repositories/settlement-store.js';
import { createTestOperatorAuthService, testAppOrigin } from './operator.js';

export const settlementContractAddress = '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7';

/** Every route class is unbounded unless a test is specifically exercising a limit. */
export const unlimitedRateLimits = Object.freeze({
  global: 10_000,
  authChallenge: 10_000,
  authVerify: 10_000,
  settlementWrite: 10_000,
  settlementExecute: 10_000,
  appKitEstimate: 10_000,
});

export function baseTestConfig(overrides = {}) {
  return {
    nodeEnv: 'test',
    appOrigin: testAppOrigin,
    arcChainId: 5042002,
    quoteTtlSeconds: 300,
    maxSpendUsdc: '25.00',
    minViralityScore: 78,
    creatorShareBps: 6000,
    agentDailySpendUsdc: '30.00',
    agentMaxFraudRisk: 20,
    agentMinConfidence: 80,
    agentSignalMaxAgeSeconds: 300,
    operatorSessionTtlSeconds: 1200,
    executionClaimLeaseSeconds: 120,
    trustedProxyHopCount: 0,
    secureCookies: false,
    rateLimits: unlimitedRateLimits,
    ...overrides,
  };
}

/** A live-looking Circle treasury that records calls instead of contacting Circle. */
export function stubCircleGateway({ transaction, onExecute } = {}) {
  const calls = [];
  return {
    calls,
    configuration() {
      return { configured: true, missing: [] };
    },
    createExecutionPlan(record) {
      return createArcSettlementExecutionPlan(record, settlementContractAddress);
    },
    async readiness() {
      return {
        configured: true,
        provider: 'CIRCLE_DEVELOPER_CONTROLLED_WALLET',
        wallet: { id: 'wallet-1', address: '0x1234567890123456789012345678901234567890', blockchain: 'ARC-TESTNET', state: 'LIVE', accountType: 'EOA' },
        usdcBalance: '100',
      };
    },
    async treasuryAvailableUnits() {
      return 100_000_000n;
    },
    async executeSettlement(record) {
      calls.push(['execute', record.id]);
      const override = await onExecute?.(record, calls.length);
      return override ?? transaction
        ?? { id: `circle-${record.id}`, state: 'INITIATED', walletId: 'wallet-1' };
    },
    async getTransaction(id) {
      calls.push(['reconcile', id]);
      return transaction ?? { id, state: 'SENT', blockchain: 'ARC-TESTNET' };
    },
  };
}

export const verifiedArcRpc = {
  async health() {
    return { status: 'verified', chainId: 5042002, blockNumber: 1234, checkedAt: new Date().toISOString() };
  },
};

export async function startTestApp({
  circleGateway = stubCircleGateway(),
  arcIndexer,
  operatorAuthService = createTestOperatorAuthService(),
  configOverrides = {},
  store = new MemorySettlementStore(),
  autonomousAgentService,
  autonomyStore,
} = {}) {
  const config = baseTestConfig(configOverrides);
  const settlementService = new SettlementService({
    store,
    policy: createSettlementPolicy(config),
    chainId: config.arcChainId,
    quoteTtlSeconds: config.quoteTtlSeconds,
    circleGateway,
    arcIndexer,
    executionClaimLeaseSeconds: config.executionClaimLeaseSeconds,
  });
  const agentDecisionService = new AgentDecisionService({
    settlementService,
    arcRpc: verifiedArcRpc,
    circleGateway,
    policy: createAgentPolicy(config),
  });
  const app = createApp({
    config,
    settlementService,
    arcRpc: verifiedArcRpc,
    circleGateway,
    arcIndexer,
    store,
    agentDecisionService,
    autonomousAgentService,
    autonomyStore,
    operatorAuthService,
    logger: { info() {}, error() {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    server,
    store,
    settlementService,
    agentDecisionService,
    autonomousAgentService,
    autonomyStore,
    operatorAuthService,
    circleGateway,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function agentDecisionBody(overrides = {}) {
  return {
    recipient: '0x1111111111111111111111111111111111111111',
    requestedAmount: '1.00',
    reference: 'OPERATOR-PAYOUT-001',
    signals: {
      engagementVelocity: 94,
      holderRetention: 92,
      liquidityDepth: 90,
      fraudRisk: 8,
      confidence: 96,
      sourceReference: 'operator-console-entry',
    },
    ...overrides,
  };
}
