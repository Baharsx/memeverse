import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  importedMarketsStorageKey,
  filterTradeableMarkets,
  marketSoldPercent,
  mergeTradeableMarkets,
  parseMarketAddress,
  persistImportedMarketAddress,
  readImportedMarketAddresses,
  sortTradeableMarkets,
} from '../../src/imported-markets.js';

function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    data,
  };
}

const FACTORY = {
  address: '0x1D6C0556aba63560daD71e96AE967eded94cDc40',
  symbol: 'PXPS',
  name: 'Pixel Possum',
  reserveUsdc: 1_000_000n,
  soldTokenCount: 100n,
  totalSupplyTokens: 1_000n,
  createdBlock: 50n,
  userBalance: 0n,
};
const IMPORTED = {
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  symbol: 'AXO',
  name: 'Agent Axolotl',
  reserveUsdc: 5_000_000n,
  soldTokenCount: 800n,
  totalSupplyTokens: 1_000n,
  createdBlock: 90n,
  userBalance: 12n,
};

test('parseMarketAddress accepts only a 20-byte hex address', () => {
  assert.equal(
    parseMarketAddress('  0x1D6C0556aba63560daD71e96AE967eded94cDc40  '),
    '0x1d6c0556aba63560dad71e96ae967eded94cdc40',
  );
  for (const value of [undefined, null, '', 42, {}, '0x', 'not-an-address', '0x1D6C0556aba63560daD71e96AE967eded94cDc4']) {
    assert.equal(parseMarketAddress(value), null);
  }
});

test('imported addresses persist, de-duplicate, and survive hostile storage', () => {
  const store = memoryStore();
  assert.deepEqual(readImportedMarketAddresses(store), []);
  const first = persistImportedMarketAddress('0x1D6C0556aba63560daD71e96AE967eded94cDc40', store);
  const again = persistImportedMarketAddress('0x1d6c0556aba63560dad71e96ae967eded94cdc40', store);
  assert.deepEqual(first, again);
  assert.equal(first.length, 1);
  persistImportedMarketAddress('not-an-address', store);
  assert.equal(readImportedMarketAddresses(store).length, 1);
  assert.equal(store.data[importedMarketsStorageKey(5042002)].includes('1d6c0556'), true);

  const broken = memoryStore({ [importedMarketsStorageKey(5042002)]: 'not-json' });
  assert.deepEqual(readImportedMarketAddresses(broken), []);
});

test('imported markets are keyed by chain id and do not leak across networks', () => {
  const store = memoryStore();
  persistImportedMarketAddress('0x1D6C0556aba63560daD71e96AE967eded94cDc40', store, 5042002);
  persistImportedMarketAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', store, 5042);
  assert.deepEqual(readImportedMarketAddresses(store, 5042002), [
    '0x1d6c0556aba63560dad71e96ae967eded94cdc40',
  ]);
  assert.deepEqual(readImportedMarketAddresses(store, 5042), [
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);
  persistImportedMarketAddress('0x765E2Eaaba8eaEF4437B15CF42C1F268D3c8c08F', store, 5042);
  assert.equal(readImportedMarketAddresses(store, 5042).length, 1, 'banned legacy factory is not persisted');
});

test('merge keeps factory order, appends new imports, and never mutates inputs', () => {
  const factory = [FACTORY];
  const imported = [FACTORY, IMPORTED];
  const merged = mergeTradeableMarkets(factory, imported);
  assert.deepEqual(merged.map((row) => row.symbol), ['PXPS', 'AXO']);
  assert.equal(merged[0].origin, 'FACTORY');
  assert.equal(merged[1].origin, 'IMPORTED');
  assert.equal(factory.length, 1);
  assert.equal(imported.length, 2);
  assert.deepEqual(mergeTradeableMarkets(undefined, null), []);
});

test('filter matches symbol, name, or address and can keep only held positions', () => {
  const rows = mergeTradeableMarkets([FACTORY], [IMPORTED]);
  assert.equal(filterTradeableMarkets(rows, { query: 'possum' }).length, 1);
  assert.equal(filterTradeableMarkets(rows, { query: '0xaaaa' })[0].symbol, 'AXO');
  assert.deepEqual(filterTradeableMarkets(rows, { onlyHeld: true }).map((row) => row.symbol), ['AXO']);
  assert.deepEqual(filterTradeableMarkets(undefined), []);
});

test('sorts by newest block, reserve, and sold ratio', () => {
  const rows = [FACTORY, IMPORTED];
  assert.equal(sortTradeableMarkets(rows, 'newest')[0].symbol, 'AXO');
  assert.equal(sortTradeableMarkets(rows, 'reserve')[0].symbol, 'AXO');
  assert.equal(sortTradeableMarkets(rows, 'sold')[0].symbol, 'AXO');
  assert.equal(marketSoldPercent(FACTORY), 10);
  assert.equal(marketSoldPercent(IMPORTED), 80);
  assert.equal(marketSoldPercent({}), 0);
});

test('import helpers stay in the presentation layer', async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/main.jsx', import.meta.url)), 'utf8');
  const marketsPage = source.slice(source.indexOf('function Markets()'));
  assert.ok(marketsPage.includes('mergeTradeableMarkets('), 'the board merges factory + imported');
  assert.ok(marketsPage.includes('probeMemeMarket('), 'import probes the contract on Arc');
  assert.ok(marketsPage.includes('parseMarketAddress('), 'paste is validated before any RPC');
});
