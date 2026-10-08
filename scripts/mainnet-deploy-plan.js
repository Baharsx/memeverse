/**
 * Pure decisions for the Arc mainnet EOA cutover.
 *
 * Deploy only MemeVerseFactory and one seed market. No Circle client, no private key material,
 * and no network calls live in this module so the budget rules can be unit tested.
 */

export const ARC_MAINNET_CHAIN_ID = 5042;
export const ARCHIE_CHAIN_ID = 1243;
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
export const CREATOR_FEE_BPS = 100;
export const TREASURY_FEE_BPS = 100;

/** 0.8 native USDC (18 decimals). Below this the deployer is unfunded and nothing is broadcast. */
export const MIN_BALANCE_WEI = 8n * 10n ** 17n;
/** 0.15 native USDC left after the estimated deploy, for one tiny buy and one sell. */
export const RESERVE_WEI = 15n * 10n ** 16n;
/** Extra gas for the factory's createMarket bookkeeping, on top of a direct MemeMarket deploy. */
export const BOOKKEEPING_GAS = 150_000n;

export const SEED_MARKET = Object.freeze({
  name: 'MEMEVERSE GENESIS',
  symbol: 'MMV',
  description: 'Phase 6A.1 exact-spend market. Creator and treasury fees settle inside the trade. Autonomous rewards are not live.',
  totalSupplyTokens: 100_000n,
  basePriceUsdc: 100n,
  slopePriceUsdc: 1_000n,
});

export function assertMainnetChainId(chainId) {
  const id = typeof chainId === 'bigint' ? Number(chainId) : Number(chainId);
  if (id === ARCHIE_CHAIN_ID) {
    throw new Error('Chain ID 1243 is Archie Chain, not Arc. Refusing to deploy.');
  }
  if (id !== ARC_MAINNET_CHAIN_ID) {
    throw new Error(`Refusing to deploy: eth_chainId is ${id}, expected 5042.`);
  }
  return ARC_MAINNET_CHAIN_ID;
}

/**
 * Accept a 32-byte hex key. The error text never includes the supplied value.
 */
export function parseDeployerPrivateKey(value) {
  if (typeof value !== 'string') {
    throw new Error('DEPLOYER_PRIVATE_KEY is missing. The value was not printed.');
  }
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('DEPLOYER_PRIVATE_KEY must be a 32-byte hex string. The value was not printed.');
  }
  return trimmed;
}

export function bufferedGasCost(gas, maxFeePerGas) {
  return (gas * 5n / 4n) * maxFeePerGas;
}

/**
 * @param {'start' | 'next'} phase `start` also requires 0.8 USDC. `next` only protects the reserve.
 */
export function deployBudgetDecision({ balanceWei, estimatedCostWei, phase = 'start' }) {
  if (phase === 'start' && balanceWei < MIN_BALANCE_WEI) {
    return { action: 'unfunded', balanceWei, estimatedCostWei, reserveWei: RESERVE_WEI };
  }
  if (balanceWei < estimatedCostWei || balanceWei - estimatedCostWei < RESERVE_WEI) {
    return { action: 'abort', balanceWei, estimatedCostWei, reserveWei: RESERVE_WEI };
  }
  return { action: 'deploy', balanceWei, estimatedCostWei, reserveWei: RESERVE_WEI };
}

export function factoryConstructorArgs(usdc, treasury) {
  return [usdc, treasury, CREATOR_FEE_BPS, TREASURY_FEE_BPS];
}

export function seedMarketArgs() {
  return [
    SEED_MARKET.name,
    SEED_MARKET.symbol,
    SEED_MARKET.description,
    SEED_MARKET.totalSupplyTokens,
    SEED_MARKET.basePriceUsdc,
    SEED_MARKET.slopePriceUsdc,
  ];
}

export function marketConstructorArgs(creator, treasury, usdc) {
  return [
    creator,
    treasury,
    usdc,
    SEED_MARKET.name,
    SEED_MARKET.symbol,
    SEED_MARKET.description,
    SEED_MARKET.totalSupplyTokens,
    SEED_MARKET.basePriceUsdc,
    SEED_MARKET.slopePriceUsdc,
    CREATOR_FEE_BPS,
    TREASURY_FEE_BPS,
  ];
}
