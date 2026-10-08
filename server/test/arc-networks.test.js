import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARC_CHAIN_ID,
  ARC_CHAIN_ID_HEX,
  ARC_IS_MAINNET,
  ARC_READ_FALLBACK_RPC_URL,
  ARC_READ_RPC_URL,
  ARC_WALLET_RPC_URL,
  arc,
  arcMainnet,
  arcTestnet,
} from '../../src/arc.js';
import {
  ARCHIE_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID,
  ARC_MAINNET_CHAIN_ID_HEX,
  ARC_NETWORKS,
  BANNED_CONTRACTS,
  TESTNET_PRODUCT_CONTRACTS,
  assertAllowedProductContract,
  resolveArcNetwork,
} from '../../src/arc-networks.js';
import { reownCustomRpcUrls, reownSessionNetworks } from '../../src/wallet-connection.js';

test('the committed default remains Arc testnet until an env flip', () => {
  assert.equal(ARC_IS_MAINNET, false);
  assert.equal(ARC_CHAIN_ID, 5042002);
  assert.equal(ARC_CHAIN_ID_HEX, '0x4cef52');
  assert.equal(arc.id, 5042002);
  assert.equal(ARC_READ_RPC_URL, 'https://rpc.testnet.arc.io');
  assert.equal(ARC_READ_FALLBACK_RPC_URL, 'https://rpc.drpc.testnet.arc.io');
  assert.equal(ARC_WALLET_RPC_URL, 'https://rpc.testnet.arc.network');
  assert.notEqual(ARC_WALLET_RPC_URL, ARC_READ_RPC_URL);
});

test('Arc mainnet catalog is official 5042 / 0x13b2 and never Archie 1243', () => {
  assert.equal(ARC_NETWORKS.mainnet.chainId, ARC_MAINNET_CHAIN_ID);
  assert.equal(ARC_NETWORKS.mainnet.chainId, 5042);
  assert.equal(ARC_NETWORKS.mainnet.chainIdHex, ARC_MAINNET_CHAIN_ID_HEX);
  assert.equal(ARC_NETWORKS.mainnet.chainIdHex, '0x13b2');
  assert.equal(Number.parseInt(ARC_NETWORKS.mainnet.chainIdHex, 16), 5042);
  assert.equal(ARC_NETWORKS.mainnet.circleChainCode, null);
  assert.equal(ARC_NETWORKS.mainnet.readRpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(ARC_NETWORKS.mainnet.readFallbackRpcUrl, 'https://rpc.drpc.mainnet.arc.io');
  assert.equal(ARC_NETWORKS.mainnet.walletRpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(ARC_NETWORKS.mainnet.explorerUrl, 'https://explorer.arc.io');
  assert.equal(ARC_NETWORKS.mainnet.factory, null);
  assert.notEqual(ARCHIE_CHAIN_ID, 5042);
  assert.notEqual(ARCHIE_CHAIN_ID, 5042002);
  assert.equal(arcMainnet.id, 5042);
  assert.equal(arcTestnet.id, 5042002);
});

test('wagmi/Reown always know both Arc networks', () => {
  assert.deepEqual(reownSessionNetworks.map((network) => network.id), [5042002, 5042, 1]);
  assert.deepEqual(
    reownCustomRpcUrls['eip155:5042'].map((entry) => entry.url),
    ['https://rpc.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io'],
  );
});

test('resolveArcNetwork ignores stale testnet product addresses and refuses a new one', () => {
  const stale = resolveArcNetwork({
    ARC_NETWORK: 'mainnet',
    MARKET_FACTORY_ADDRESS: TESTNET_PRODUCT_CONTRACTS.factory,
    ARC_RPC_URL: 'https://rpc.testnet.arc.io',
  });
  assert.equal(stale.factory, null);
  assert.equal(stale.readRpcUrl, 'https://rpc.mainnet.arc.io');
  assert.equal(stale.circleChainCode, null);
  const chosen = resolveArcNetwork({
    ARC_NETWORK: 'mainnet',
    VITE_MEMEVERSE_FACTORY_ADDRESS: '0x1111111111111111111111111111111111111111',
    MARKET_FACTORY_ADDRESS: TESTNET_PRODUCT_CONTRACTS.factory,
  });
  assert.equal(chosen.factory, '0x1111111111111111111111111111111111111111');
  assert.throws(
    () => resolveArcNetwork({
      ARC_NETWORK: 'mainnet',
      VITE_MARKET_FACTORY_ADDRESS: TESTNET_PRODUCT_CONTRACTS.factory,
    }),
    /must not be configured on Arc mainnet/,
  );
  assert.throws(
    () => assertAllowedProductContract('mainnet', BANNED_CONTRACTS[0], 'FACTORY'),
    /banned legacy/,
  );
  const mainnet = resolveArcNetwork({ ARC_NETWORK: 'mainnet' });
  assert.equal(mainnet.chainId, 5042);
  assert.equal(mainnet.factory, null);
});
