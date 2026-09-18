/**
 * Browser-side rules for trading markets that exist on Arc even if they were not launched
 * from this site.
 *
 * Factory enumeration is still the primary catalogue. This module only:
 *   1. remembers addresses a visitor explicitly pasted
 *   2. merges those loaded markets onto the public factory set
 *   3. filters / sorts the combined board
 *
 * It never hides a factory market, never mutates the factory result, and never invents a
 * market that was not actually loaded from chain. Persistence is localStorage in the browser;
 * Node tests pass an in-memory store. Backend, agent, and audit code must not import this.
 */

import { ARC_CHAIN_ID } from './arc.js';
import { isBannedContract } from './arc-networks.js';

export const IMPORTED_MARKETS_STORAGE_PREFIX = 'memeverse.imported-markets.v1';
/** @deprecated Unkeyed prefix. Persistence is always `v1.<chainId>`. */
export const IMPORTED_MARKETS_STORAGE_KEY = IMPORTED_MARKETS_STORAGE_PREFIX;

export function importedMarketsStorageKey(chainId = ARC_CHAIN_ID) {
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('imported-markets storage key requires a positive chain id');
  }
  return `${IMPORTED_MARKETS_STORAGE_PREFIX}.${id}`;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function parseMarketAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ADDRESS.test(trimmed)) return null;
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

function storageOf(storage) {
  if (storage && typeof storage.getItem === 'function') return storage;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  } catch {
    return null;
  }
  return null;
}

export function readImportedMarketAddresses(storage, chainId = ARC_CHAIN_ID) {
  const store = storageOf(storage);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(importedMarketsStorageKey(chainId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const unique = [];
    const seen = new Set();
    for (const entry of parsed) {
      const address = parseMarketAddress(entry);
      if (!address || seen.has(address)) continue;
      seen.add(address);
      unique.push(address);
    }
    return unique;
  } catch {
    return [];
  }
}

export function persistImportedMarketAddress(address, storage, chainId = ARC_CHAIN_ID) {
  const parsed = parseMarketAddress(address);
  if (!parsed || isBannedContract(parsed)) return readImportedMarketAddresses(storage, chainId);
  const current = readImportedMarketAddresses(storage, chainId);
  if (current.includes(parsed)) return current;
  const next = [...current, parsed];
  const store = storageOf(storage);
  if (store) {
    try {
      store.setItem(importedMarketsStorageKey(chainId), JSON.stringify(next));
    } catch {
      return current;
    }
  }
  return next;
}

function addressKey(market) {
  return typeof market?.address === 'string' ? market.address.trim().toLowerCase() : '';
}

/**
 * Factory-visible markets first, then imported ones that are not already in that set.
 * The factory array is never mutated.
 */
export function mergeTradeableMarkets(factoryVisible, importedLoaded) {
  const merged = [];
  const seen = new Set();
  for (const market of Array.isArray(factoryVisible) ? factoryVisible : []) {
    const key = addressKey(market);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...market, origin: market.origin ?? 'FACTORY' });
  }
  for (const market of Array.isArray(importedLoaded) ? importedLoaded : []) {
    const key = addressKey(market);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...market, origin: market.origin ?? 'IMPORTED' });
  }
  return merged;
}

export function filterTradeableMarkets(markets, { query = '', onlyHeld = false } = {}) {
  if (!Array.isArray(markets)) return [];
  const needle = String(query ?? '').trim().toLowerCase();
  return markets.filter((market) => {
    if (onlyHeld && !(market.userBalance > 0n)) return false;
    if (!needle) return true;
    const haystack = [
      market.symbol,
      market.name,
      market.address,
      market.creator,
      market.origin,
    ].map((value) => String(value ?? '').toLowerCase());
    return haystack.some((value) => value.includes(needle));
  });
}

function soldRatio(market) {
  const sold = BigInt(market?.soldTokenCount ?? 0n);
  const total = BigInt(market?.totalSupplyTokens ?? 0n);
  if (total === 0n) return 0;
  return Number((sold * 10_000n) / total) / 10_000;
}

export function sortTradeableMarkets(markets, sort = 'newest') {
  const copy = Array.isArray(markets) ? [...markets] : [];
  copy.sort((left, right) => {
    if (sort === 'reserve') {
      const delta = BigInt(right.reserveUsdc ?? 0n) - BigInt(left.reserveUsdc ?? 0n);
      if (delta === 0n) return 0;
      return delta > 0n ? 1 : -1;
    }
    if (sort === 'sold') {
      return soldRatio(right) - soldRatio(left);
    }
    const rightBlock = Number(right.createdBlock ?? 0);
    const leftBlock = Number(left.createdBlock ?? 0);
    if (rightBlock !== leftBlock) return rightBlock - leftBlock;
    return addressKey(right).localeCompare(addressKey(left));
  });
  return copy;
}

export function marketSoldPercent(market) {
  return Math.min(100, Math.max(0, Math.round(soldRatio(market) * 100)));
}
