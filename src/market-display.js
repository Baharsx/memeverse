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
 * Markets that are hidden from public browsing.
 *
 * These two are the project's own earlier test markets, created while the factory, the trading
 * economics, and the autonomous agent were being proven. They are real, they still hold real USDC
 * reserves, and they remain registered in the factory — the historical autonomous payout, the
 * Proof Center references, the onchain audits, and the transaction hashes in the docs all still
 * point at them and all still resolve. Nothing about them is being deleted or changed.
 *
 * What they are not is something a visitor should have to scroll past to find the markets people
 * actually launched. So this is presentation only, applied at the two judge-facing surfaces and
 * nowhere else: the factory still enumerates them, the agent still discovers and scores them,
 * media authorization still resolves their creators, and every audit script still reads them
 * directly from chain. Hiding a market from a list is not the same as removing it, and this
 * codebase deliberately keeps those two ideas in different places.
 *
 * Identity is the address and only the address. Filtering on a name or a symbol would mean any
 * future market that happened to pick similar text would silently vanish from the product.
 */
export const LEGACY_HIDDEN_MARKETS = Object.freeze([
  // MEMEVERSE GENESIS 6A1 / MMV6A1 — the first market ever deployed by the factory.
  '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D',
  // MEMEVERSE AGENT SIGNAL / MVAGENT — created to give the autonomous agent trade evidence to
  // score. The historical agent payout proof references this market.
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
