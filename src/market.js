import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseUnits,
} from 'viem';
import { ARC_READ_FALLBACK_RPC_URL, ARC_READ_RPC_URL, arc, arcContracts } from './arc.js';
import { isBannedContract } from './arc-networks.js';
import { parseMarketAddress } from './imported-markets.js';

export const USDC_DECIMALS = 6;
export const TOKEN_DECIMALS = 18;
export const BPS_DENOMINATOR = 10_000n;

export const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

export const factoryAbi = parseAbi([
  'function usdc() view returns (address)',
  'function treasury() view returns (address)',
  'function creatorFeeBps() view returns (uint16)',
  'function treasuryFeeBps() view returns (uint16)',
  'function deployedAtBlock() view returns (uint256)',
  'function marketCount() view returns (uint256)',
  'function markets(uint256 index) view returns (address)',
  'function isMarket(address market) view returns (bool)',
  'function createMarket(string name,string symbol,string description,uint256 totalSupplyTokens,uint256 basePriceUsdc,uint256 slopePriceUsdc) returns (address market)',
  'event MarketCreated(address indexed market,address indexed token,address indexed creator,string name,string symbol,uint256 totalSupplyTokens,uint256 basePriceUsdc,uint256 slopePriceUsdc,uint256 createdAt,uint256 createdBlock)',
]);

export const marketAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function description() view returns (string)',
  'function creator() view returns (address)',
  'function treasury() view returns (address)',
  'function usdc() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function totalSupplyTokens() view returns (uint256)',
  'function soldTokenCount() view returns (uint256)',
  'function reserveUsdc() view returns (uint256)',
  'function creatorFeesPaidUsdc() view returns (uint256)',
  'function treasuryFeesPaidUsdc() view returns (uint256)',
  'function creatorFeeBps() view returns (uint16)',
  'function treasuryFeeBps() view returns (uint16)',
  'function basePriceUsdc() view returns (uint256)',
  'function slopePriceUsdc() view returns (uint256)',
  'function createdAt() view returns (uint256)',
  'function createdBlock() view returns (uint256)',
  'function active() view returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function spotPriceUsdc() view returns (uint256)',
  'function quoteBuy(uint256 maximumUsdcIn) view returns (uint256 tokenOut,uint256 curveCostUsdc,uint256 creatorFeeUsdc,uint256 treasuryFeeUsdc,uint256 actualUsdcSpent)',
  'function quoteSell(uint256 tokenIn) view returns (uint256 usdcOut,uint256 grossCurveReturnUsdc,uint256 creatorFeeUsdc,uint256 treasuryFeeUsdc)',
  'function buy(uint256 maximumUsdcIn,uint256 minimumTokenOut) returns (uint256 tokenOut,uint256 actualUsdcSpent)',
  'function sell(uint256 tokenIn,uint256 minimumUsdcOut) returns (uint256 usdcOut)',
  'event Bought(address indexed buyer,uint256 maximumUsdcIn,uint256 actualUsdcSpent,uint256 tokenOut,uint256 curveCostUsdc,uint256 creatorFeeUsdc,uint256 treasuryFeeUsdc,uint256 soldTokenCount)',
  'event Sold(address indexed seller,uint256 tokenIn,uint256 usdcOut,uint256 grossCurveReturnUsdc,uint256 creatorFeeUsdc,uint256 treasuryFeeUsdc,uint256 soldTokenCount)',
]);

export const marketPublicClient = createPublicClient({
  chain: arc,
  transport: fallback([http(ARC_READ_RPC_URL), http(ARC_READ_FALLBACK_RPC_URL)]),
});

export function parseUsdc(value) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) throw new Error('Enter a USDC amount with at most 6 decimals.');
  return parseUnits(value, USDC_DECIMALS);
}

/**
 * Launch-form validation, using the same parsers the transaction itself uses.
 *
 * A `type="number"` field will happily hand back `1e3`, and `BigInt('1e3')` throws — so the value
 * that passed the browser's own validation blew up inside the contract call, where a broad catch
 * swallowed it and the user saw a button that did nothing. These answer the question the call will
 * ask, and return null rather than throwing, so the form can refuse before anything reaches a
 * wallet. Every input is coerced to a string first: nothing here throws for any input.
 */

/** Whole-token supply, in the bounds the launch form advertises. */
export function tokenSupplyValue(value) {
  const text = String(value ?? '').trim();
  // Plain digits only. No exponent, no decimal point, no sign.
  if (!/^\d{1,12}$/.test(text)) return null;
  const units = BigInt(text);
  if (units < 100n || units > 1_000_000_000n) return null;
  return units;
}

const LAUNCH_PRICE_MAX_UNITS = 1_000_000_000n; // 1000 USDC at six decimals.

/**
 * A launch price in atomic USDC units.
 *
 * `allowZero` exists because the two price fields genuinely differ: the initial price must be at
 * least one atomic unit, while a flat curve — a slope of exactly 0 — is a legitimate market.
 */
export function launchPriceUnits(value, { allowZero = false } = {}) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  let units;
  try {
    units = parseUnits(text, USDC_DECIMALS);
  } catch {
    return null;
  }
  if (units > LAUNCH_PRICE_MAX_UNITS) return null;
  if (units === 0n) return allowZero ? 0n : null;
  return units;
}

export function parseWholeTokens(value) {
  if (!/^\d+$/.test(value.trim()) || BigInt(value) === 0n) {
    throw new Error('Enter a positive whole-token amount.');
  }
  return parseUnits(value, TOKEN_DECIMALS);
}

export function formatUsdc(value, maximumFractionDigits = 6) {
  return formatExactUnits(value, USDC_DECIMALS, maximumFractionDigits);
}

export function formatTokenAmount(value, maximumFractionDigits = 2) {
  return formatExactUnits(value, TOKEN_DECIMALS, maximumFractionDigits);
}

function formatExactUnits(value, decimals, maximumFractionDigits) {
  const [whole, rawFraction = ''] = formatUnits(value ?? 0n, decimals).split('.');
  const groupedWhole = BigInt(whole).toLocaleString();
  const fraction = rawFraction.slice(0, maximumFractionDigits).replace(/0+$/, '');
  return fraction ? `${groupedWhole}.${fraction}` : groupedWhole;
}

export function minimumAfterSlippage(value, slippageBps) {
  return (value * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
}

export async function loadFactoryConfig() {
  const address = arcContracts.memeVerseFactory;
  if (!address) {
    return {
      address: null, usdc: null, treasury: null, creatorFeeBps: 0n, treasuryFeeBps: 0n,
      deployedAtBlock: 0n, marketCount: 0n,
    };
  }
  const functions = ['usdc', 'treasury', 'creatorFeeBps', 'treasuryFeeBps', 'deployedAtBlock', 'marketCount'];
  const [usdc, treasury, creatorFeeBps, treasuryFeeBps, deployedAtBlock, marketCount] = await marketPublicClient.multicall({
    contracts: functions.map((functionName) => ({ address, abi: factoryAbi, functionName })),
    allowFailure: false,
  });
  return { address, usdc, treasury, creatorFeeBps, treasuryFeeBps, deployedAtBlock, marketCount };
}

export async function loadUsdcBalance(address) {
  if (!address) return 0n;
  return marketPublicClient.readContract({
    address: arcContracts.usdc,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [address],
  });
}

export async function loadMarket(address, userAddress) {
  const reads = [
    ['name'], ['symbol'], ['description'], ['creator'], ['treasury'], ['totalSupplyTokens'],
    ['soldTokenCount'], ['reserveUsdc'], ['creatorFeesPaidUsdc'], ['treasuryFeesPaidUsdc'],
    ['creatorFeeBps'], ['treasuryFeeBps'], ['basePriceUsdc'], ['slopePriceUsdc'],
    ['createdAt'], ['createdBlock'], ['active'], ['spotPriceUsdc'],
  ];
  const contracts = reads.map(([functionName]) => ({ address, abi: marketAbi, functionName }));
  if (userAddress) {
    contracts.push(
      { address, abi: marketAbi, functionName: 'balanceOf', args: [userAddress] },
      { address: arcContracts.usdc, abi: usdcAbi, functionName: 'allowance', args: [userAddress, address] },
    );
  }
  const values = await marketPublicClient.multicall({ contracts, allowFailure: false });
  const [
    name, symbol, description, creator, treasury, totalSupplyTokens, soldTokenCount,
    reserveUsdc, creatorFeesPaidUsdc, treasuryFeesPaidUsdc, creatorFeeBps,
    treasuryFeeBps, basePriceUsdc, slopePriceUsdc, createdAt, createdBlock, active,
    spotPriceUsdc,
  ] = values;
  const userBalance = userAddress ? values[18] : 0n;
  const usdcAllowance = userAddress ? values[19] : 0n;
  return {
    address, name, symbol, description, creator, treasury, totalSupplyTokens, soldTokenCount,
    reserveUsdc, creatorFeesPaidUsdc, treasuryFeesPaidUsdc, creatorFeeBps,
    treasuryFeeBps, basePriceUsdc, slopePriceUsdc, createdAt, createdBlock, active,
    spotPriceUsdc, userBalance, usdcAllowance,
  };
}

export async function loadMarkets(userAddress) {
  if (!arcContracts.memeVerseFactory) return [];
  const marketCount = await marketPublicClient.readContract({
    address: arcContracts.memeVerseFactory,
    abi: factoryAbi,
    functionName: 'marketCount',
  });
  const addresses = marketCount === 0n ? [] : await marketPublicClient.multicall({
    contracts: Array.from({ length: Number(marketCount) }, (_, index) => ({
      address: arcContracts.memeVerseFactory,
      abi: factoryAbi,
      functionName: 'markets',
      args: [BigInt(index)],
    })),
    allowFailure: false,
  });
  if (addresses.length === 0) return [];
  const registered = await marketPublicClient.multicall({
    contracts: addresses.map((address) => ({
      address: arcContracts.memeVerseFactory,
      abi: factoryAbi,
      functionName: 'isMarket',
      args: [address],
    })),
    allowFailure: false,
  });
  const live = addresses.filter((_, index) => registered[index]);
  return Promise.all(live.map((address) => loadMarket(address, userAddress)));
}

export async function quoteBuy(marketAddress, usdcIn) {
  return marketPublicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'quoteBuy',
    args: [usdcIn],
  });
}

export async function quoteSell(marketAddress, tokenIn) {
  return marketPublicClient.readContract({
    address: marketAddress,
    abi: marketAbi,
    functionName: 'quoteSell',
    args: [tokenIn],
  });
}

/**
 * Whether this address is registered in the trusted MemeVerse factory.
 * A false result is not "not a market" — an independent MemeMarket on Arc can still be traded.
 */
export async function isRegisteredFactoryMarket(address) {
  const parsed = parseMarketAddress(address);
  if (!parsed || !arcContracts.memeVerseFactory) return false;
  try {
    return await marketPublicClient.readContract({
      address: arcContracts.memeVerseFactory,
      abi: factoryAbi,
      functionName: 'isMarket',
      args: [getAddress(parsed)],
    });
  } catch {
    return false;
  }
}

/**
 * Load a contract as a MemeVerse USDC market if it actually is one.
 *
 * Used when a visitor pastes an address that is on Arc but was not launched from this site.
 * Fail-closed: an ERC-20 that does not expose the MemeMarket ABI, or that does not settle in
 * Arc USDC, is not offered as buyable.
 */
export async function probeMemeMarket(address, userAddress) {
  const parsed = parseMarketAddress(address);
  if (!parsed) return { ok: false, code: 'INVALID_ADDRESS', market: null };
  if (isBannedContract(parsed)) return { ok: false, code: 'BANNED_CONTRACT', market: null };
  const checksummed = getAddress(parsed);
  let market;
  try {
    market = await loadMarket(checksummed, userAddress);
  } catch {
    return { ok: false, code: 'NOT_MEME_MARKET', market: null };
  }
  let usdc;
  try {
    usdc = await marketPublicClient.readContract({
      address: checksummed,
      abi: marketAbi,
      functionName: 'usdc',
    });
  } catch {
    return { ok: false, code: 'NOT_MEME_MARKET', market: null };
  }
  try {
    if (getAddress(usdc) !== getAddress(arcContracts.usdc)) {
      return { ok: false, code: 'NOT_USDC_MARKET', market: null };
    }
  } catch {
    return { ok: false, code: 'NOT_USDC_MARKET', market: null };
  }
  const registered = await isRegisteredFactoryMarket(checksummed);
  return {
    ok: true,
    code: registered ? 'FACTORY' : 'ONCHAIN',
    market: { ...market, origin: registered ? 'FACTORY' : 'IMPORTED' },
  };
}
