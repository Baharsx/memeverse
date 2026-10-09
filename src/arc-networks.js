/**
 * Official Arc network catalog.
 *
 * One module, no Vite env, so the browser bundle, the API, and the Circle deploy scripts all
 * name the same chain ids, RPCs, and Circle wallet codes. Selection happens in `resolveArcNetwork`.
 *
 * Facts re-verified 2026-10-08 against docs.arc.io and eth_chainId on
 * https://rpc.mainnet.arc.io (0x13b2 = 5042). Circle is not a mainnet deploy path.
 *   https://docs.arc.io/arc/references/rpc-endpoints
 *   https://docs.arc.io/integrate/connect-to-arc
 *   https://docs.arc.io/arc/references/contract-addresses
 *   https://docs.arc.io/arc/concepts/stablecoin-native-model
 *   https://developers.circle.com/stablecoins/usdc-contract-addresses
 *   https://developers.circle.com/wallets/supported-blockchains
 *
 * NEVER 1243 — that is Archie Chain, not Arc.
 */

const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/** Archie Chain. Not Arc. A wrong nibble here sends real USDC to the wrong network. */
export const ARCHIE_CHAIN_ID = 1243;

export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARC_MAINNET_CHAIN_ID_HEX = '0x13b2';
export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_CHAIN_ID_HEX = '0x4cef52';

export const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
export const ARC_MEMO_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
/** Canonical Multicall3. Read batching. Not Multicall3From, which preserves msg.sender for writes. */
export const ARC_MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const ARC_MULTICALL3_FROM_ADDRESS = '0x522fAf9A91c41c443c66765030741e4AaCe147D0';

/**
 * Legacy Phase 6A contracts. Their buy path could retain unused USDC. Banned on every chain:
 * never a factory, never a market, never an import.
 */
export const BANNED_CONTRACTS = Object.freeze([
  '0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F',
  '0x5CcB34ec32e5ea12CdD7119157De9b8207b8880D',
]);

/**
 * Testnet product deployments. Real contracts on 5042002. Reusing any of them as a mainnet
 * address would point 5042 at the wrong chain's bytecode (or at nothing).
 */
export const TESTNET_PRODUCT_CONTRACTS = Object.freeze({
  factory: '0x363124490E953EEbB414eB4c3e2f03a40eef8F2C',
  settlement: '0x8E09979fdb97A3F2d2c797F3274Eff6B67c5c9e7',
  seedMarket: '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D',
  mediaNft: '0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD',
  nftMarketplace: '0xfc3e869bA4Dd808A0942bc9C034f6f8427a08666',
  vault: '0xe26EeA49973226b406fd92Bd178484a29D7F7C05',
  agentSettlement: '0x2176107C2562Ed30ca1d490C43cD53C3369946e2',
});

function lower(address) {
  return typeof address === 'string' ? address.trim().toLowerCase() : '';
}

const BANNED_SET = new Set(BANNED_CONTRACTS.map(lower));
const TESTNET_PRODUCT_SET = new Set(Object.values(TESTNET_PRODUCT_CONTRACTS).map(lower));

export function isBannedContract(address) {
  return BANNED_SET.has(lower(address));
}

export function isTestnetProductContract(address) {
  return TESTNET_PRODUCT_SET.has(lower(address));
}

export function parseContractAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ADDRESS.test(trimmed) || trimmed === ZERO) return null;
  return trimmed;
}

/**
 * Catalog defaults. RPC/explorer/factory may be overridden by env; chain id and Circle chain
 * code may not — those are identity, not configuration.
 *
 * Testnet keeps the endpoints that already survive a Markets-page burst, and the explorer the
 * product has been linking to. Mainnet uses the published docs.arc.io endpoints. The read
 * transport and the EIP-3085 wallet RPC stay separate fields even when a network happens to
 * use the same host for both.
 */
export const ARC_NETWORKS = Object.freeze({
  testnet: Object.freeze({
    name: 'testnet',
    label: 'Arc Testnet',
    chainId: ARC_TESTNET_CHAIN_ID,
    chainIdHex: ARC_TESTNET_CHAIN_ID_HEX,
    circleChainCode: 'ARC-TESTNET',
    circleApiKeyPrefix: 'TEST_API_KEY',
    kitChainName: 'Arc_Testnet',
    readRpcUrl: 'https://rpc.testnet.arc.io',
    readFallbackRpcUrl: 'https://rpc.drpc.testnet.arc.io',
    walletRpcUrl: 'https://rpc.testnet.arc.network',
    websocketUrl: 'wss://rpc.testnet.arc.io',
    fallbackWebsocketUrl: 'wss://rpc.drpc.testnet.arc.io',
    explorerName: 'ArcScan',
    explorerUrl: 'https://testnet.arcscan.app',
    explorerApiUrl: 'https://testnet.arcscan.app/api',
    officialExplorerUrl: 'https://explorer.testnet.arc.io',
    usdc: ARC_USDC_ADDRESS,
    memo: ARC_MEMO_ADDRESS,
    multicall3From: ARC_MULTICALL3_FROM_ADDRESS,
    factory: TESTNET_PRODUCT_CONTRACTS.factory,
    settlement: TESTNET_PRODUCT_CONTRACTS.settlement,
    seedMarket: TESTNET_PRODUCT_CONTRACTS.seedMarket,
    mediaNft: TESTNET_PRODUCT_CONTRACTS.mediaNft,
    nftMarketplace: TESTNET_PRODUCT_CONTRACTS.nftMarketplace,
    vault: TESTNET_PRODUCT_CONTRACTS.vault,
    isTestnet: true,
  }),
  mainnet: Object.freeze({
    name: 'mainnet',
    label: 'Arc',
    chainId: ARC_MAINNET_CHAIN_ID,
    chainIdHex: ARC_MAINNET_CHAIN_ID_HEX,
    // Circle is not used on mainnet. A null chain code cannot be sent as blockchain "ARC".
    circleChainCode: null,
    circleApiKeyPrefix: null,
    kitChainName: null,
    readRpcUrl: 'https://rpc.mainnet.arc.io',
    readFallbackRpcUrl: 'https://rpc.drpc.mainnet.arc.io',
    walletRpcUrl: 'https://rpc.mainnet.arc.io',
    websocketUrl: 'wss://rpc.mainnet.arc.io',
    fallbackWebsocketUrl: 'wss://rpc.drpc.mainnet.arc.io',
    explorerName: 'Arc Explorer',
    explorerUrl: 'https://explorer.arc.io',
    explorerApiUrl: 'https://explorer.arc.io/api',
    officialExplorerUrl: 'https://explorer.arc.io',
    usdc: ARC_USDC_ADDRESS,
    memo: ARC_MEMO_ADDRESS,
    multicall3From: ARC_MULTICALL3_FROM_ADDRESS,
    factory: null,
    settlement: null,
    seedMarket: null,
    mediaNft: null,
    nftMarketplace: null,
    vault: null,
    isTestnet: false,
  }),
});

function firstNonEmpty(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function parseNetworkName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (name === 'mainnet' || name === 'testnet') return name;
  throw new Error(`ARC_NETWORK must be "mainnet" or "testnet", received "${value}".`);
}

function parseChainId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const chainId = typeof value === 'number' ? value : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`ARC_CHAIN_ID must be a positive integer, received "${value}".`);
  }
  if (chainId === ARCHIE_CHAIN_ID) {
    throw new Error('Chain ID 1243 is Archie Chain, not Arc. Arc mainnet is 5042; Arc testnet is 5042002.');
  }
  return chainId;
}

function optionalUrl(value, label) {
  if (!value) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL, received "${value}".`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${label} must be https, received "${url.protocol}".`);
  }
  return url.href.replace(/\/$/, '');
}

function optionalAddress(value, label) {
  if (!value) return undefined;
  const parsed = parseContractAddress(value);
  if (!parsed) throw new Error(`${label} must be a 20-byte EVM address, received "${value}".`);
  return parsed;
}

export function assertAllowedProductContract(networkName, address, label) {
  const parsed = parseContractAddress(address);
  if (!parsed) throw new Error(`${label} must be a 20-byte EVM address, received "${address}".`);
  if (isBannedContract(parsed)) {
    throw new Error(`${label} ${parsed} is a banned legacy Phase 6A contract and must not be used on any chain.`);
  }
  if (networkName === 'mainnet' && isTestnetProductContract(parsed)) {
    throw new Error(
      `${label} ${parsed} is a testnet (5042002) MemeVerse contract and must not be configured on Arc mainnet (5042).`,
    );
  }
  return parsed;
}

const STALE_TESTNET_HOSTS = new Set([
  'rpc.testnet.arc.io',
  'rpc.drpc.testnet.arc.io',
  'rpc.testnet.arc.network',
  'rpc.quicknode.testnet.arc.network',
  'rpc.blockdaemon.testnet.arc.network',
  'testnet.arcscan.app',
  'explorer.testnet.arc.io',
]);

export function isStaleTestnetEndpoint(value) {
  try {
    return STALE_TESTNET_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function circleApiKeyMatchesNetwork(apiKey, networkName) {
  if (!apiKey) return true;
  if (networkName === 'mainnet') return false;
  const prefix = ARC_NETWORKS[networkName].circleApiKeyPrefix;
  return Boolean(prefix) && apiKey.startsWith(prefix);
}

export function assertCircleApiKeyPrefix(apiKey, networkName) {
  if (!apiKey) return;
  if (networkName === 'mainnet') {
    throw new Error(
      'Circle is not used on Arc mainnet. Do not call circle:setup, circle:fund, or circle:deploy against chain 5042.',
    );
  }
  if (circleApiKeyMatchesNetwork(apiKey, networkName)) return;
  const expected = ARC_NETWORKS[networkName].circleApiKeyPrefix;
  throw new Error(
    `CIRCLE_API_KEY for Arc ${networkName} must start with ${expected}. `
    + 'A LIVE_API_KEY cannot sign this network.',
  );
}

function pickEndpoint(networkName, label, catalogUrl, candidates) {
  for (const value of candidates) {
    if (!value) continue;
    const url = optionalUrl(value, label);
    if (networkName === 'mainnet' && isStaleTestnetEndpoint(url)) continue;
    return url;
  }
  return catalogUrl;
}

/**
 * On mainnet, leftover testnet product addresses in the server env are skipped so a cutover
 * can keep the old lines and still not point chain 5042 at them. A new VITE factory value that
 * is itself a testnet contract is rejected.
 */
function pickProductAddress(networkName, label, candidates) {
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const parsed = optionalAddress(candidate.value, label);
    if (isBannedContract(parsed)) {
      throw new Error(
        `${label} ${parsed} is a banned legacy Phase 6A contract and must not be used on any chain.`,
      );
    }
    if (networkName === 'mainnet' && isTestnetProductContract(parsed)) {
      if (candidate.stale) continue;
      throw new Error(
        `${label} ${parsed} is a testnet (5042002) MemeVerse contract and must not be configured on Arc mainnet (5042).`,
      );
    }
    return parsed;
  }
  return undefined;
}

/**
 * Resolve the active Arc network from an env-shaped object.
 *
 * Defaults to testnet so a missing production env cannot silently flip memeverse.biz onto
 * mainnet. After cutover the live env sets ARC_NETWORK=mainnet and VITE_ARC_NETWORK=mainnet.
 */
export function resolveArcNetwork(env = {}) {
  const fromServer = env.ARC_NETWORK?.trim().toLowerCase();
  const fromVite = env.VITE_ARC_NETWORK?.trim().toLowerCase();
  if (fromServer && fromVite && fromServer !== fromVite) {
    throw new Error(
      `ARC_NETWORK (${fromServer}) and VITE_ARC_NETWORK (${fromVite}) disagree. They must name the same network.`,
    );
  }
  const name = parseNetworkName(fromServer || fromVite || 'testnet');
  const catalog = ARC_NETWORKS[name];

  const configuredChainId = parseChainId(firstNonEmpty(env, ['ARC_CHAIN_ID', 'VITE_ARC_CHAIN_ID']));
  if (configuredChainId !== undefined && configuredChainId !== catalog.chainId) {
    throw new Error(
      `Configured chain id ${configuredChainId} does not match Arc ${name} (${catalog.chainId}).`,
    );
  }

  const endpointOrder = (viteKey, serverKey) => (
    name === 'mainnet'
      ? [firstNonEmpty(env, [viteKey]), firstNonEmpty(env, [serverKey])]
      : [firstNonEmpty(env, [serverKey]), firstNonEmpty(env, [viteKey])]
  );
  const factory = pickProductAddress(name, 'MARKET_FACTORY_ADDRESS', [
    { value: firstNonEmpty(env, ['VITE_MEMEVERSE_FACTORY_ADDRESS']), stale: false },
    { value: firstNonEmpty(env, ['VITE_MARKET_FACTORY_ADDRESS']), stale: false },
    { value: firstNonEmpty(env, ['MARKET_FACTORY_ADDRESS']), stale: true },
  ]);
  const settlement = pickProductAddress(name, 'SETTLEMENT_ADDRESS', [
    { value: firstNonEmpty(env, ['VITE_SETTLEMENT_ADDRESS']), stale: true },
    { value: firstNonEmpty(env, ['CIRCLE_SETTLEMENT_CONTRACT_ADDRESS']), stale: true },
  ]);
  const mediaNft = pickProductAddress(name, 'MEDIA_NFT_ADDRESS', [
    { value: firstNonEmpty(env, ['VITE_MEDIA_NFT_ADDRESS']), stale: true },
    { value: firstNonEmpty(env, ['MEDIA_NFT_ADDRESS']), stale: true },
  ]);
  const nftMarketplace = pickProductAddress(name, 'NFT_MARKETPLACE_ADDRESS', [
    { value: firstNonEmpty(env, ['VITE_NFT_MARKETPLACE_ADDRESS']), stale: true },
    { value: firstNonEmpty(env, ['NFT_MARKETPLACE_ADDRESS']), stale: true },
  ]);
  const vault = pickProductAddress(name, 'USDC_VAULT_ADDRESS', [
    { value: firstNonEmpty(env, ['VITE_USDC_VAULT_ADDRESS']), stale: true },
    { value: firstNonEmpty(env, ['USDC_VAULT_ADDRESS']), stale: true },
  ]);
  const usdc = optionalAddress(firstNonEmpty(env, ['VITE_USDC_ADDRESS', 'ARC_USDC_ADDRESS']), 'USDC_ADDRESS')
    ?? catalog.usdc;

  if (usdc && isBannedContract(usdc)) {
    throw new Error(`USDC_ADDRESS ${usdc} is banned.`);
  }
  if (usdc && usdc.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) {
    throw new Error(`USDC_ADDRESS must be ${ARC_USDC_ADDRESS} on Arc.`);
  }

  return Object.freeze({
    ...catalog,
    readRpcUrl: pickEndpoint(name, 'ARC_RPC_URL', catalog.readRpcUrl, endpointOrder('VITE_ARC_RPC_URL', 'ARC_RPC_URL')),
    readFallbackRpcUrl: pickEndpoint(
      name, 'ARC_FALLBACK_RPC_URL', catalog.readFallbackRpcUrl,
      endpointOrder('VITE_ARC_FALLBACK_RPC_URL', 'ARC_FALLBACK_RPC_URL'),
    ),
    walletRpcUrl: pickEndpoint(
      name, 'ARC_WALLET_RPC_URL', catalog.walletRpcUrl,
      endpointOrder('VITE_ARC_WALLET_RPC_URL', 'ARC_WALLET_RPC_URL'),
    ),
    explorerUrl: pickEndpoint(
      name, 'ARC_EXPLORER_URL', catalog.explorerUrl,
      endpointOrder('VITE_ARC_EXPLORER_URL', 'ARC_EXPLORER_URL'),
    ),
    usdc,
    factory: factory ?? catalog.factory,
    settlement: settlement ?? catalog.settlement,
    mediaNft: mediaNft ?? catalog.mediaNft,
    nftMarketplace: nftMarketplace ?? catalog.nftMarketplace,
    vault: vault ?? catalog.vault,
  });
}

export function explorerTxUrl(explorerUrl, hash) {
  return `${explorerUrl.replace(/\/$/, '')}/tx/${hash}`;
}

export function explorerAddressUrl(explorerUrl, address) {
  return `${explorerUrl.replace(/\/$/, '')}/address/${address}`;
}
