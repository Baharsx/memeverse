import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  LEGACY_HIDDEN_MARKETS,
  SOLD_OUT_LABEL,
  isLegacyHiddenMarket,
  isMarketSoldOut,
  marketAvailability,
  marketSpotLabel,
  marketSpotPerTokenLabel,
  publicMarkets,
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

test('every surface prices a market through the shared sold-out helper', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/main.jsx', import.meta.url)),
    'utf8',
  );
  const marquee = source.slice(source.indexOf('function Marquee'), source.indexOf('function Wallet'));

  // The global ticker formatted spotPriceUsdc directly, so a sold-out market read as "0 USDC"
  // there while the Markets page correctly read SOLD OUT.
  assert.ok(marquee.includes('marketSpotLabel(market, formatUsdc)'), 'the ticker uses the helper');
  assert.equal(
    /formatUsdc\(\s*market\.spotPriceUsdc\s*\)/.test(source),
    false,
    'no surface may format a raw spot price, which is 0 for a sold-out market',
  );

  const soldOut = market(100_000n, 100_000n, 0n);
  assert.equal(marketSpotLabel(soldOut, formatUsdc), SOLD_OUT_LABEL);
  assert.equal(marketSpotPerTokenLabel(soldOut, formatUsdc), SOLD_OUT_LABEL);
  // Selling is still backed by the curve reserve, on every surface.
  assert.equal(marketAvailability(soldOut).canSell, true);
});

/**
 * Legacy market hiding.
 *
 * The rule these tests defend is narrow and easy to break in the wrong direction: two specific
 * markets are absent from public browsing, and *nothing else changes anywhere*. They stay in the
 * factory, the agent keeps scoring them, the audits keep reading them, and the docs keep citing
 * their transactions. A filter that leaked out of the presentation layer would quietly rewrite
 * history; a filter that matched on text would quietly delete somebody's market.
 */

const GENESIS = '0xBe6E56a8B5ec8861aE1284dF3f60E27953f2d39D';
const AGENT_SIGNAL = '0xE8ec1307fd500dF01CE0265167C05d8FfE4394DE';
const NCIE_CAT = '0x56Faae610A08b379d4D503fE0Aa7419460BF7377';

function listedMarket(address, symbol, name) {
  return { address, symbol, name, soldTokenCount: 10n, totalSupplyTokens: 1000n, spotPriceUsdc: 1n };
}

test('both legacy demo markets are excluded from public browsing', () => {
  assert.equal(isLegacyHiddenMarket(GENESIS), true);
  assert.equal(isLegacyHiddenMarket(AGENT_SIGNAL), true);
  assert.deepEqual([...LEGACY_HIDDEN_MARKETS].sort(), [GENESIS, AGENT_SIGNAL].sort());

  const all = [
    listedMarket(GENESIS, 'MMV6A1', 'MEMEVERSE GENESIS 6A1'),
    listedMarket(AGENT_SIGNAL, 'MVAGENT', 'MEMEVERSE AGENT SIGNAL'),
    listedMarket(NCIE_CAT, 'NCAT', 'NCIE CAT'),
  ];
  assert.deepEqual(publicMarkets(all).map((m) => m.symbol), ['NCAT']);
});

test('a creator market is never hidden, and the full set is left intact', () => {
  assert.equal(isLegacyHiddenMarket(NCIE_CAT), false);

  const all = [
    listedMarket(GENESIS, 'MMV6A1', 'MEMEVERSE GENESIS 6A1'),
    listedMarket(NCIE_CAT, 'NCAT', 'NCIE CAT'),
    listedMarket('0x1111111111111111111111111111111111111111', 'AAA', 'ANY OTHER MARKET'),
    listedMarket('0x2222222222222222222222222222222222222222', 'BBB', 'ANOTHER ONE'),
  ];
  const visible = publicMarkets(all);
  assert.deepEqual(visible.map((m) => m.symbol), ['NCAT', 'AAA', 'BBB']);
  // Presentation must not mutate the caller's data: the full factory set is still needed by
  // anything that reasons about onchain truth.
  assert.equal(all.length, 4);
  assert.equal(all[0].address, GENESIS);
});

test('the exclusion is by address, never by name or symbol', () => {
  // A future market that happens to carry the same text must still be browsable — otherwise the
  // filter would silently swallow somebody else's launch.
  const impostor = listedMarket(
    '0x3333333333333333333333333333333333333333', 'MMV6A1', 'MEMEVERSE GENESIS 6A1',
  );
  assert.equal(isLegacyHiddenMarket(impostor.address), false);
  assert.deepEqual(publicMarkets([impostor]).map((m) => m.address), [impostor.address]);

  // And a hidden market stays hidden no matter what text it carries.
  const renamed = listedMarket(GENESIS, 'ANYTHING', 'A COMPLETELY DIFFERENT NAME');
  assert.deepEqual(publicMarkets([renamed]), []);
});

test('case and checksum spelling cannot bypass the exclusion', () => {
  for (const spelling of [
    GENESIS.toLowerCase(),
    GENESIS.toUpperCase().replace('0X', '0x'),
    `  ${GENESIS}  `,
    AGENT_SIGNAL.toLowerCase(),
    AGENT_SIGNAL.toUpperCase().replace('0X', '0x'),
  ]) {
    assert.equal(isLegacyHiddenMarket(spelling), true, spelling);
    assert.deepEqual(publicMarkets([listedMarket(spelling, 'X', 'X')]), [], spelling);
  }
});

test('hostile or absent input is refused rather than throwing into the list', () => {
  for (const value of [undefined, null, '', 42, {}, [], '0x', 'not-an-address']) {
    assert.equal(isLegacyHiddenMarket(value), false);
  }
  assert.deepEqual(publicMarkets(undefined), []);
  assert.deepEqual(publicMarkets(null), []);
  assert.deepEqual(publicMarkets([]), []);
  // A row with no address is a data problem, not a hidden market, so it still renders.
  assert.equal(publicMarkets([{ symbol: 'X' }]).length, 1);
});

test('the filter exists only in the presentation layer', async () => {
  // Backend, agent, and audit code must never learn about this list. If any of them did, the
  // factory enumeration, the autonomous discovery sweep, the media creator check, or an onchain
  // audit would start disagreeing with the chain.
  const roots = ['../../server', '../../scripts', '../../contracts'];
  const { readdir } = await import('node:fs/promises');

  async function walk(directory) {
    const found = [];
    let entries;
    try {
      entries = await readdir(fileURLToPath(new URL(directory, import.meta.url)), { withFileTypes: true });
    } catch { return found; }
    for (const entry of entries) {
      const next = `${directory}/${entry.name}`;
      if (entry.isDirectory()) found.push(...await walk(next));
      else if (entry.name.endsWith('.js')) found.push(next);
    }
    return found;
  }

  const files = (await Promise.all(roots.map(walk))).flat()
    // The backend test suite legitimately uses these addresses as fixtures for agent logic.
    .filter((path) => !path.includes('/test/'));

  assert.ok(files.length > 20, 'the walk should have found the server sources');
  for (const path of files) {
    const source = await readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    for (const forbidden of ['LEGACY_HIDDEN_MARKETS', 'isLegacyHiddenMarket', 'publicMarkets']) {
      assert.equal(source.includes(forbidden), false, `${path} must not filter markets: ${forbidden}`);
    }
  }
});

test('both judge-facing surfaces filter through the one shared helper', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/main.jsx', import.meta.url)),
    'utf8',
  );
  // The ticker and the Markets selector must not be able to disagree about what is shown.
  const marquee = source.slice(source.indexOf('function Marquee'), source.indexOf('function Wallet'));
  assert.ok(marquee.includes('publicMarkets(markets.data)'), 'the ticker filters through the helper');

  const marketsPage = source.slice(source.indexOf('function Markets()'));
  assert.ok(marketsPage.includes('publicMarkets(markets.data)'), 'the Markets page filters through the helper');
  // Selection, the rendered list, the empty state, and the artwork lookup all read the filtered
  // set, so a hidden market can never be selected or quoted.
  assert.ok(marketsPage.includes('visibleMarkets.find('), 'selection reads the filtered set');
  assert.ok(marketsPage.includes('visibleMarkets.map('), 'the list renders the filtered set');
  assert.ok(marketsPage.includes('!visibleMarkets.length'), 'the empty state reads the filtered set');
  assert.equal(
    /markets\.data\??\.(map|length|\[0\])/.test(marketsPage),
    false,
    'no surface may render straight from the unfiltered factory result',
  );
});
