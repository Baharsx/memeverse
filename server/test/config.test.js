import assert from 'node:assert/strict';
import test from 'node:test';
import { loadServerConfig } from '../config.js';

test('production API uses only network, media, and wallet-safe settings', () => {
  const config = loadServerConfig({ NODE_ENV: 'production' });
  assert.equal(config.secureCookies, true);
  assert.equal(config.arcNetwork, 'testnet');
  assert.equal(config.arcChainId, 5042002);
  assert.equal(config.arcRpcUrl, 'https://rpc.testnet.arc.io');
  assert.equal(config.marketFactoryAddress, '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C');
  assert.ok(config.mediaStorageDir.endsWith('.data/media'));
});

test('mainnet has official RPC and uses no testnet factory', () => {
  const config = loadServerConfig({ ARC_NETWORK: 'mainnet' });
  assert.equal(config.arcChainId, 5042);
  assert.equal(config.arcRpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(config.arcFallbackRpcUrl, 'https://rpc.drpc.mainnet.arc.io');
  assert.equal(config.arcExplorerUrl, 'https://explorer.arc.io');
  assert.equal(config.marketFactoryAddress, null);
  assert.equal(config.arcUsdcAddress, '0x3600000000000000000000000000000000000000');
});

test('testnet addresses are refused as new mainnet factory values', () => {
  const config = loadServerConfig({
    ARC_NETWORK: 'mainnet',
    MARKET_FACTORY_ADDRESS: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
    VITE_MEMEVERSE_FACTORY_ADDRESS: '0x2222222222222222222222222222222222222222',
  });
  assert.equal(config.marketFactoryAddress, '0x2222222222222222222222222222222222222222');
  assert.throws(() => loadServerConfig({
    ARC_NETWORK: 'mainnet', VITE_MARKET_FACTORY_ADDRESS: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
  }), /testnet \(5042002\)/);
});

test('chain id mismatch and banned factory addresses fail closed', () => {
  assert.throws(() => loadServerConfig({ ARC_CHAIN_ID: '1243' }), /Archie Chain/);
  assert.throws(() => loadServerConfig({ ARC_NETWORK: 'mainnet', ARC_CHAIN_ID: '1243' }), /Archie Chain/);
  assert.throws(() => loadServerConfig({ ARC_NETWORK: 'testnet', VITE_ARC_NETWORK: 'mainnet' }), /disagree/);
  assert.throws(() => loadServerConfig({
    MARKET_FACTORY_ADDRESS: '0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F',
  }), /banned legacy/);
});
