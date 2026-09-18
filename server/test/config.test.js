import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../config.js';

const productionDatabase = 'postgresql://memeverse:secret@db.example.test:5432/memeverse';
const circleExecutionEnvironment = {
  CIRCLE_API_KEY: 'TEST_API_KEY',
  CIRCLE_ENTITY_SECRET: 'a'.repeat(64),
  CIRCLE_WALLET_ID: '11111111-2222-4333-8444-555555555555',
  CIRCLE_SETTLEMENT_CONTRACT_ADDRESS: '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7',
};

test('production requires managed PostgreSQL and one-shot migrations', () => {
  assert.throws(
    () => loadServerConfig({ NODE_ENV: 'production' }),
    /DATABASE_URL is required/,
  );
  const config = loadServerConfig({
    NODE_ENV: 'production',
    DATABASE_URL: productionDatabase,
  });
  assert.equal(config.runDatabaseMigrations, false);
  assert.equal(config.databaseUrl.startsWith('postgresql://'), true);
  assert.equal(config.secureCookies, true);
  assert.equal(config.settlementOperatorAddress, undefined);
});

test('production fails closed when settlement execution has no authorized operator', () => {
  assert.throws(
    () => loadServerConfig({
      NODE_ENV: 'production',
      DATABASE_URL: productionDatabase,
      ...circleExecutionEnvironment,
    }),
    /SETTLEMENT_OPERATOR_ADDRESS is required/,
  );
  const config = loadServerConfig({
    NODE_ENV: 'production',
    DATABASE_URL: productionDatabase,
    ...circleExecutionEnvironment,
    SETTLEMENT_OPERATOR_ADDRESS: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  });
  assert.equal(config.settlementExecutionConfigured, true);
  assert.equal(config.settlementOperatorAddress, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
});

test('a claim heartbeat too slow to protect its own lease refuses to boot', () => {
  const defaults = loadServerConfig({});
  assert.equal(defaults.executionClaimLeaseSeconds, 120);
  assert.equal(defaults.executionClaimHeartbeatSeconds, 30);

  for (const [heartbeat, lease] of [['60', '120'], ['61', '120'], ['30', '30'], ['200', '300']]) {
    assert.throws(
      () => loadServerConfig({
        EXECUTION_CLAIM_HEARTBEAT_SECONDS: heartbeat,
        EXECUTION_CLAIM_LEASE_SECONDS: lease,
      }),
      /EXECUTION_CLAIM_HEARTBEAT_SECONDS \(\d+\) must be less than half/,
      `heartbeat ${heartbeat} against lease ${lease} must be rejected`,
    );
  }

  const safe = loadServerConfig({
    EXECUTION_CLAIM_HEARTBEAT_SECONDS: '10',
    EXECUTION_CLAIM_LEASE_SECONDS: '60',
  });
  assert.equal(safe.executionClaimHeartbeatSeconds, 10);
  assert.equal(safe.executionClaimLeaseSeconds, 60);
  // A heartbeat below the floor, or above the ceiling, never reaches the ratio check.
  assert.throws(() => loadServerConfig({ EXECUTION_CLAIM_HEARTBEAT_SECONDS: '4' }));
  assert.throws(() => loadServerConfig({ EXECUTION_CLAIM_HEARTBEAT_SECONDS: '301' }));
});

test('default network is Arc testnet so production cannot silently flip to mainnet', () => {
  const config = loadServerConfig({});
  assert.equal(config.arcNetwork, 'testnet');
  assert.equal(config.arcChainId, 5042002);
  assert.equal(config.circleChainCode, 'ARC-TESTNET');
  assert.equal(config.arcRpcUrl, 'https://rpc.testnet.arc.io');
  assert.equal(config.marketFactoryAddress, '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C');
});

test('ARC_NETWORK=mainnet selects chain 5042 and Circle code ARC without the testnet factory', () => {
  const config = loadServerConfig({ ARC_NETWORK: 'mainnet' });
  assert.equal(config.arcNetwork, 'mainnet');
  assert.equal(config.arcChainId, 5042);
  assert.equal(config.circleChainCode, 'ARC');
  assert.equal(config.arcRpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(config.arcFallbackRpcUrl, 'https://rpc.drpc.mainnet.arc.io');
  assert.equal(config.arcExplorerUrl, 'https://explorer.arc.io');
  assert.equal(config.marketFactoryAddress, null);
  assert.equal(config.arcUsdcAddress, '0x3600000000000000000000000000000000000000');
});

test('mainnet refuses the testnet factory and a TEST_API_KEY', () => {
  assert.throws(
    () => loadServerConfig({
      ARC_NETWORK: 'mainnet',
      MARKET_FACTORY_ADDRESS: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
    }),
    /testnet \(5042002\)/,
  );
  assert.throws(
    () => loadServerConfig({
      ARC_NETWORK: 'mainnet',
      CIRCLE_API_KEY: 'TEST_API_KEY:not-for-mainnet',
    }),
    /LIVE_API_KEY/,
  );
  assert.throws(
    () => loadServerConfig({
      CIRCLE_API_KEY: 'LIVE_API_KEY:not-for-testnet',
    }),
    /TEST_API_KEY/,
  );
});

test('chain id 1243 is rejected as Archie Chain, not Arc', () => {
  assert.throws(
    () => loadServerConfig({ ARC_CHAIN_ID: '1243' }),
    /Archie Chain/,
  );
  assert.throws(
    () => loadServerConfig({ ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '1243' }),
    /Archie Chain/,
  );
  assert.throws(
    () => loadServerConfig({ ARC_NETWORK: 'testnet', VITE_ARC_NETWORK: 'mainnet' }),
    /disagree/,
  );
});

test('banned Phase 6A addresses cannot be configured on any network', () => {
  assert.throws(
    () => loadServerConfig({
      MARKET_FACTORY_ADDRESS: '0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F',
    }),
    /banned legacy/,
  );
});

test('the operator address must be a checksummed EVM address', () => {
  assert.throws(
    () => loadServerConfig({
      SETTLEMENT_OPERATOR_ADDRESS: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
    }),
    /checksummed/,
  );
  assert.throws(
    () => loadServerConfig({ SETTLEMENT_OPERATOR_ADDRESS: 'not-an-address' }),
    /checksummed/,
  );
});
