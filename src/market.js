import {
  createPublicClient,
  fallback,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from 'viem';
import { ARC_FALLBACK_RPC_URL, ARC_RPC_URL, arc, arcContracts } from './arc';

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
  transport: fallback([http(ARC_RPC_URL), http(ARC_FALLBACK_RPC_URL)]),
});

export function parseUsdc(value) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value.trim())) throw new Error('Enter a USDC amount with at most 6 decimals.');
  return parseUnits(value, USDC_DECIMALS);
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
  return Promise.all(addresses.map((address) => loadMarket(address, userAddress)));
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
