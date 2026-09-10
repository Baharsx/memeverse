import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { filterMediaAssets, sortMediaAssets } from '../../src/media-marketplace.js';

const WALLET = '0x76B74337D93dBcB811FcF2DAb4a57Db2b7058389';

function asset(tokenId, extra = {}) {
  return {
    tokenId,
    owner: extra.owner ?? '0x1111111111111111111111111111111111111111',
    creator: extra.creator ?? WALLET,
    market: extra.market ?? '0x1D6C0556aba63560daD71e96AE967eded94cDc40',
    metadata: { name: extra.name ?? `Token ${tokenId}` },
    listing: extra.listing ?? null,
  };
}

test('media marketplace tabs isolate listed and owned assets', () => {
  const rows = [
    asset(3, { listing: { fillable: true, priceUnits: 250_000n } }),
    asset(2, { owner: WALLET, name: 'Pixel Possum art' }),
    asset(1, { listing: { fillable: false, priceUnits: 1n } }),
  ];
  assert.equal(filterMediaAssets(rows, { tab: 'listed' }).length, 1);
  assert.equal(filterMediaAssets(rows, { tab: 'mine', wallet: WALLET }).length, 1);
  assert.equal(filterMediaAssets(rows, { query: 'possum' })[0].tokenId, 2);
  assert.deepEqual(filterMediaAssets(undefined), []);
  assert.equal(filterMediaAssets(rows, { tab: 'mine' }).length, 0);
});

test('media marketplace sorts listed price ascending and newest first otherwise', () => {
  const rows = [
    asset(5, { listing: { fillable: true, priceUnits: 400_000n } }),
    asset(9, { listing: { fillable: true, priceUnits: 100_000n } }),
    asset(7),
  ];
  assert.deepEqual(sortMediaAssets(rows, 'newest').map((row) => row.tokenId), [9, 7, 5]);
  assert.deepEqual(sortMediaAssets(rows, 'price').map((row) => row.tokenId), [9, 5, 7]);
});

test('the gallery board is wired through the shared helpers', async () => {
  const views = await readFile(fileURLToPath(new URL('../../src/stage2-views.jsx', import.meta.url)), 'utf8');
  assert.ok(views.includes('filterMediaAssets('));
  assert.ok(views.includes('sortMediaAssets('));
  assert.ok(views.includes('marketplace-board'));
  assert.ok(views.includes('FOR SALE'));
});
