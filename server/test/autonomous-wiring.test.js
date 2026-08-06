import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerConfig } from '../config.js';
import { createSettlementRuntime } from '../runtime.js';

/**
 * The Agent Wallet-only invariant.
 *
 * `AUTONOMOUS_POLICY` must mean exactly one thing: the Circle Agent Wallet paid, through the
 * autonomous settlement contract. The runtime previously fell back to the manual
 * Developer-Controlled Wallet settlement service when the Agent Wallet was unconfigured, which
 * would have let that same mode quietly mean "the manual treasury paid, with no human approval".
 * The worker gated it in practice, but the ambiguity had no business existing.
 */

function baseEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'test',
    APP_ORIGIN: 'http://127.0.0.1:5173',
    ARC_RPC_URL: 'https://rpc.testnet.arc.io',
    CIRCLE_SETTLEMENT_CONTRACT_ADDRESS: '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7',
    ...overrides,
  };
}

async function runtimeFor(environment) {
  const directory = await mkdtemp(join(tmpdir(), 'memeverse-wiring-'));
  const config = {
    ...loadServerConfig(baseEnvironment(environment)),
    pgliteDataDir: directory,
    runDatabaseMigrations: true,
  };
  const runtime = await createSettlementRuntime(config);
  return {
    runtime,
    config,
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('without an Agent Wallet the autonomous service does not exist at all', async () => {
  const context = await runtimeFor({});
  try {
    const { runtime } = context;

    // Not "constructed but disabled" — absent. Nothing can call what was never built.
    assert.equal(runtime.autonomousSettlementService, null);
    assert.equal(runtime.autonomousAgentService, null);
    assert.equal(runtime.agentWalletGateway.configuration().configured, false);

    // The manual path is untouched and still present.
    assert.ok(runtime.settlementService, 'manual settlement must still exist');
    assert.ok(runtime.circleGateway, 'the Developer-Controlled Wallet gateway must still exist');
  } finally {
    await context.close();
  }
});

test('the autonomous settlement service never shares the manual treasury gateway', async () => {
  const context = await runtimeFor({
    AGENT_WALLET_ADDRESS: '0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3',
    AGENT_SETTLEMENT_CONTRACT_ADDRESS: '0x2176107C2562Ed30ca1d490C43cD53C3369946e2',
  });
  try {
    const { runtime } = context;
    assert.ok(runtime.autonomousAgentService, 'autonomy exists once the Agent Wallet is configured');

    // The autonomous service must be wired to the Agent Wallet, and to nothing else.
    assert.notEqual(
      runtime.autonomousSettlementService,
      runtime.settlementService,
      'the autonomous route must not reuse the manual settlement service',
    );
    assert.equal(
      runtime.autonomousSettlementService.circleGateway,
      runtime.agentWalletGateway,
      'the autonomous route must execute through the Agent Wallet gateway',
    );
    assert.equal(
      runtime.autonomousAgentService.circleGateway,
      runtime.agentWalletGateway,
      'agent readiness must describe the Agent Wallet, not the manual treasury',
    );
    assert.equal(
      runtime.autonomousAgentService.settlementService,
      runtime.autonomousSettlementService,
    );

    // The manual route keeps the Developer-Controlled Wallet.
    assert.equal(runtime.settlementService.circleGateway, runtime.circleGateway);
    assert.notEqual(runtime.settlementService.circleGateway, runtime.agentWalletGateway);
  } finally {
    await context.close();
  }
});

test('reconciliation knows the configured Agent Wallet and both settlement contracts', async () => {
  const context = await runtimeFor({
    AGENT_WALLET_ADDRESS: '0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3',
    AGENT_SETTLEMENT_CONTRACT_ADDRESS: '0x2176107C2562Ed30ca1d490C43cD53C3369946e2',
  });
  try {
    const configuration = context.runtime.arcIndexer.configuration();
    assert.equal(configuration.agentWallet, '0x65da73c6d9300F3dAb1dF785219f76DeCA5e0FE3');
    assert.equal(configuration.agentSettlementContract, '0x2176107C2562Ed30ca1d490C43cD53C3369946e2');
    assert.equal(configuration.settlementContract, '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7');
    // The two routes must never be pointed at the same contract.
    assert.notEqual(configuration.agentSettlementContract, configuration.settlementContract);
  } finally {
    await context.close();
  }
});

test('the public agent route reports unavailable rather than falling back', async () => {
  const context = await runtimeFor({});
  try {
    const { createApp } = await import('../app.js');
    const app = createApp({
      config: context.config,
      settlementService: context.runtime.settlementService,
      arcRpc: context.runtime.arcRpc,
      circleGateway: context.runtime.circleGateway,
      arcIndexer: context.runtime.arcIndexer,
      store: context.runtime.store,
      autonomousAgentService: context.runtime.autonomousAgentService,
      autonomyStore: context.runtime.autonomyStore,
      operatorAuthService: context.runtime.operatorAuthService,
      logger: { info() {}, error() {} },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/v1/agent/autonomy`,
      );
      assert.equal(response.status, 503, 'an unconfigured agent is unavailable, not silently manual');
      const body = await response.json();
      assert.equal(body.error.code, 'AGENT_NOT_CONFIGURED');
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await context.close();
  }
});
