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
