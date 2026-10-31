/**
 * Presentation rules for onchain market state. Dependency-free so both the browser bundle and
 * the Node test suite can use it.
 *
 * `spotPriceUsdc()` returns 0 once the whole fixed supply is sold because there is no next
 * token to price. Rendering that as "0 USDC / TOKEN" would read as a free token, so a fully
 * sold market is presented as SOLD OUT and its buy path is disabled. Selling stays available:
 * the curve reserve still backs every circulating token.
 */
export const SOLD_OUT_LABEL = 'SOLD OUT';

/**
 * Retired demonstration markets are hidden from browsing by address only.
 * The contracts and any funds remain onchain; this filter does not modify them.
 */
export const LEGACY_HIDDEN_MARKETS = Object.freeze([
  // Retired test market A.
  '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D',
  // Retired test market B.
  '0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE',
]);

// Compared lowercased. An EVM address is case-insensitive and its EIP-55 checksum is only a typo
// guard, so a caller passing the all-lowercase, all-uppercase, or checksummed spelling of one of
// these must get the same answer — otherwise the exclusion would be trivial to sidestep by
// accident, simply by rendering from a source that happened to normalize differently.
const HIDDEN = new Set(LEGACY_HIDDEN_MARKETS.map((address) => address.toLowerCase()));

export function isLegacyHiddenMarket(address) {
  return typeof address === 'string' && HIDDEN.has(address.trim().toLowerCase());
}

/**
 * The markets a visitor should browse: every registered market except the legacy set.
 *
 * Callers pass the full factory result and render the return value. The input is never mutated,
 * so the complete set stays available to anything that needs onchain truth.
 */
export function publicMarkets(markets) {
  // Callers pass factory enumeration that already dropped addresses where factory.isMarket is
  // false. This filter only hides retired demonstration markets by address. It stays synchronous.
  if (!Array.isArray(markets)) return [];
  return markets.filter((market) => !isLegacyHiddenMarket(market?.address));
}

export function isMarketSoldOut(market) {
  if (!market) return false;
  const { soldTokenCount, totalSupplyTokens } = market;
  if (soldTokenCount === undefined || totalSupplyTokens === undefined) return false;
  return BigInt(soldTokenCount) >= BigInt(totalSupplyTokens);
}

export function marketAvailability(market) {
  const soldOut = isMarketSoldOut(market);
  return { soldOut, canBuy: !soldOut, canSell: true };
}

export function marketSpotLabel(market, formatUsdc) {
  if (isMarketSoldOut(market)) return SOLD_OUT_LABEL;
  return `${formatUsdc(market.spotPriceUsdc)} USDC`;
}

export function marketSpotPerTokenLabel(market, formatUsdc) {
  if (isMarketSoldOut(market)) return SOLD_OUT_LABEL;
  return `${formatUsdc(market.spotPriceUsdc)} USDC / TOKEN`;
}

/**
 * The mainnet seed market has an old, immutable contract description.
 * Present the current factual product scope instead of obsolete phase notes.
 * Creator-written descriptions for every other market are shown unchanged.
 */
export function marketDescriptionForDisplay(market) {
  if (!market || typeof market.description !== 'string') return '';
  if (typeof market.address === 'string'
    && market.address.toLowerCase() === '0xdca07bd83bc7a4220c79afb60f8c2bb7dc746932') {
    return 'Fixed-supply meme market. Creator and treasury fees settle within each trade.';
  }
  return market.description.trim();
}
