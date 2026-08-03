import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOLD_OUT_LABEL,
  isMarketSoldOut,
  marketAvailability,
  marketSpotLabel,
  marketSpotPerTokenLabel,
} from '../../src/market-display.js';

const formatUsdc = (value) => (Number(value) / 1e6).toString();

function market(sold, total, spotPriceUsdc = 1000n) {
  return { soldTokenCount: sold, totalSupplyTokens: total, spotPriceUsdc };
}

test('a partially sold market prices normally and allows both sides', () => {
  const partial = market(7235n, 100_000n, 172_000n);

  assert.equal(isMarketSoldOut(partial), false);
  assert.deepEqual(marketAvailability(partial), { soldOut: false, canBuy: true, canSell: true });
  assert.equal(marketSpotLabel(partial, formatUsdc), '0.172 USDC');
  assert.equal(marketSpotPerTokenLabel(partial, formatUsdc), '0.172 USDC / TOKEN');
});

test('a fully sold market renders SOLD OUT instead of a zero price', () => {
  // The contract returns 0 from spotPriceUsdc() once no token remains to price.
  const soldOut = market(100_000n, 100_000n, 0n);

  assert.equal(isMarketSoldOut(soldOut), true);
  assert.deepEqual(marketAvailability(soldOut), { soldOut: true, canBuy: false, canSell: true });
  assert.equal(marketSpotLabel(soldOut, formatUsdc), SOLD_OUT_LABEL);
  assert.equal(marketSpotPerTokenLabel(soldOut, formatUsdc), SOLD_OUT_LABEL);
  assert.equal(marketSpotLabel(soldOut, formatUsdc).includes('0 USDC'), false);
});

test('sold-out detection tolerates missing state and never blocks selling', () => {
  assert.equal(isMarketSoldOut(undefined), false);
  assert.equal(isMarketSoldOut({}), false);
  assert.equal(marketAvailability(market(100_000n, 100_000n)).canSell, true);
  assert.equal(marketAvailability(undefined).canBuy, true);
});
