import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { arcTestnet } from 'viem/chains';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

loadLocalEnvironment();
const config = loadServerConfig();
if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletId) {
  throw new Error('Circle deployment credentials are required for the explicit Testnet E2E script.');
}

const factoryArtifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8'));
const marketArtifact = JSON.parse(await readFile('contracts/artifacts/MemeMarket.json', 'utf8'));
const client = initiateDeveloperControlledWalletsClient({
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
  userAgent: 'MemeVerse-Market-E2E/1.3',
});
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(config.arcRpcUrl) });
const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
]);

async function withRpcRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!/request limit|rate limit|429/i.test(`${error?.message} ${error?.details}`)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

const readContract = (parameters) => withRpcRetry(() => publicClient.readContract(parameters));

const wallet = (await client.getWallet({ id: config.circleWalletId })).data?.wallet;
if (!wallet || wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') {
  throw new Error('E2E wallet must be a directly signing ARC-TESTNET EOA.');
}
if (await publicClient.getChainId() !== 5042002) throw new Error('Arc RPC chain mismatch.');
const e2eIdentity = [
  config.marketFactoryAddress,
  factoryArtifact.bytecode,
  getAddress(wallet.address),
  'MEMEVERSE GENESIS 6A1',
  'MMV6A1',
];

async function waitForCircleTransaction(transactionId) {
  let transaction;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    transaction = (await client.getTransaction({ id: transactionId })).data?.transaction;
    if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
      throw new Error(`Circle transaction ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown error'}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1500));
  }
  if (!['COMPLETE', 'CONFIRMED'].includes(transaction?.state) || !transaction.txHash) {
    throw new Error('Timed out waiting for a final Arc Testnet transaction.');
  }
  const receipt = await withRpcRetry(() => publicClient.waitForTransactionReceipt({ hash: transaction.txHash, confirmations: 1 }));
  if (receipt.status !== 'success') throw new Error(`Arc transaction ${transaction.txHash} reverted.`);
  return { transaction, receipt };
}

async function execute({ idempotencyKey, contractAddress, signature, parameters, reference }) {
  const response = await client.createContractExecutionTransaction({
    idempotencyKey,
    walletId: config.circleWalletId,
    contractAddress,
    abiFunctionSignature: signature,
    abiParameters: parameters,
    refId: reference,
    fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
  });
  const transactionId = response.data?.id;
  if (!transactionId) throw new Error(`Circle returned no transaction ID for ${reference}.`);
  return waitForCircleTransaction(transactionId);
}

const initialUsdc = await readContract({
  address: config.arcUsdcAddress,
  abi: usdcAbi,
  functionName: 'balanceOf',
  args: [wallet.address],
});
if (initialUsdc < 100_000n) throw new Error('At least 0.10 Testnet USDC is required for E2E plus gas.');

const launch = await execute({
  idempotencyKey: circleIdempotencyKey('market-e2e-launch', e2eIdentity),
  contractAddress: config.marketFactoryAddress,
  signature: 'createMarket(string,string,string,uint256,uint256,uint256)',
  parameters: ['MEMEVERSE GENESIS 6A1', 'MMV6A1', 'Phase 6A.1 exact-spend Arc Public Testnet market.', '100000', '100', '1000'],
  reference: 'mmv6a1-launch',
});
const marketCreated = launch.receipt.logs.map((log) => {
  try {
    return decodeEventLog({ abi: factoryArtifact.abi, eventName: 'MarketCreated', data: log.data, topics: log.topics });
  } catch { return null; }
}).find((event) => event?.eventName === 'MarketCreated');
if (!marketCreated?.args?.market) throw new Error('MarketCreated event was not found in launch receipt.');
const marketAddress = getAddress(marketCreated.args.market);
const seedSupply = 100_000n;
const seedBasePrice = 100n;
const seedSlopePrice = 1_000n;
const seedCreatorFeeBps = 100n;
const seedTreasuryFeeBps = 100n;

function seedCumulativeCost(tokenCount) {
  return seedBasePrice * tokenCount
    + (seedSlopePrice * tokenCount * (tokenCount === 0n ? 0n : tokenCount - 1n))
      / (2n * (seedSupply - 1n));
}

function seedBuyQuote(maximumUsdcIn, soldTokenCount = 0n) {
  let low = 0n;
  let high = seedSupply - soldTokenCount;
  const startCost = seedCumulativeCost(soldTokenCount);
  while (low < high) {
    const middle = low + (high - low + 1n) / 2n;
    const curveCost = seedCumulativeCost(soldTokenCount + middle) - startCost;
    const spend = curveCost
      + (curveCost * seedCreatorFeeBps) / 10_000n
      + (curveCost * seedTreasuryFeeBps) / 10_000n;
    if (spend <= maximumUsdcIn) low = middle;
    else high = middle - 1n;
  }
  const curveCost = seedCumulativeCost(soldTokenCount + low) - startCost;
  const creatorFee = (curveCost * seedCreatorFeeBps) / 10_000n;
  const treasuryFee = (curveCost * seedTreasuryFeeBps) / 10_000n;
  return [low * 10n ** 18n, curveCost, creatorFee, treasuryFee, curveCost + creatorFee + treasuryFee];
}

function seedSellQuote(tokenIn, soldTokenCount) {
  const tokenCount = tokenIn / 10n ** 18n;
  const grossReturn = seedCumulativeCost(soldTokenCount) - seedCumulativeCost(soldTokenCount - tokenCount);
  const creatorFee = (grossReturn * seedCreatorFeeBps) / 10_000n;
  const treasuryFee = (grossReturn * seedTreasuryFeeBps) / 10_000n;
  return [grossReturn - creatorFee - treasuryFee, grossReturn, creatorFee, treasuryFee];
}

const buyAmount = 10_000n; // 0.01 USDC
const approval = await execute({
  idempotencyKey: circleIdempotencyKey('market-e2e-approve', [...e2eIdentity, marketAddress, buyAmount.toString()]),
  contractAddress: config.arcUsdcAddress,
  signature: 'approve(address,uint256)',
  parameters: [marketAddress, buyAmount.toString()],
  reference: 'mmv6a1-approve',
});
const allowance = await readContract({
  address: config.arcUsdcAddress,
  abi: usdcAbi,
  functionName: 'allowance',
  args: [wallet.address, marketAddress],
});
const balanceBeforeBuyStep = await readContract({
  address: marketAddress,
  abi: marketArtifact.abi,
  functionName: 'balanceOf',
  args: [wallet.address],
});
if (allowance < buyAmount && balanceBeforeBuyStep === 0n) {
  throw new Error('Confirmed approval did not create the expected allowance.');
}

const buyQuote = seedBuyQuote(buyAmount);
if (balanceBeforeBuyStep === 0n) {
  const liveBuyQuote = await readContract({
    address: marketAddress,
    abi: marketArtifact.abi,
    functionName: 'quoteBuy',
    args: [buyAmount],
  });
  if (liveBuyQuote.some((value, index) => value !== buyQuote[index])) {
    throw new Error('Fresh market buy quote differs from the independently calculated seed quote.');
  }
}
if (buyQuote[0] === 0n) throw new Error('Buy quote returned zero tokens.');
const buy = await execute({
  idempotencyKey: circleIdempotencyKey('market-e2e-buy', [...e2eIdentity, marketAddress, buyAmount.toString()]),
  contractAddress: marketAddress,
  signature: 'buy(uint256,uint256)',
  parameters: [buyAmount.toString(), buyQuote[0].toString()],
  reference: 'mmv6a1-buy',
});
const boughtEvent = buy.receipt.logs.map((log) => {
  try {
    return decodeEventLog({ abi: marketArtifact.abi, eventName: 'Bought', data: log.data, topics: log.topics });
  } catch { return null; }
}).find((event) => event?.eventName === 'Bought');
if (!boughtEvent?.args?.tokenOut) throw new Error('Bought event was not found in the confirmed receipt.');
const boughtTokenOut = boughtEvent.args.tokenOut;
if (boughtEvent.args.maximumUsdcIn !== buyAmount
  || boughtEvent.args.actualUsdcSpent !== buyQuote[4]
  || boughtEvent.args.curveCostUsdc !== buyQuote[1]
  || boughtEvent.args.creatorFeeUsdc !== buyQuote[2]
  || boughtEvent.args.treasuryFeeUsdc !== buyQuote[3]) {
  throw new Error('Confirmed buy event does not match the exact-spend quote.');
}
if (buyQuote[4] >= buyAmount) throw new Error('E2E maximum input did not leave an unused budget remainder.');
const tokenBalance = await readContract({
  address: marketAddress,
  abi: marketArtifact.abi,
  functionName: 'balanceOf',
  args: [wallet.address],
});
if (tokenBalance === 0n || tokenBalance > boughtTokenOut) throw new Error('Confirmed buy did not create a valid token balance.');
const [allowanceAfterBuy, marketBalanceAfterBuy] = await Promise.all([
  readContract({
    address: config.arcUsdcAddress,
    abi: usdcAbi,
    functionName: 'allowance',
    args: [wallet.address, marketAddress],
  }),
  readContract({
    address: config.arcUsdcAddress,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [marketAddress],
  }),
]);
if (allowanceAfterBuy !== buyAmount - buyQuote[4]) {
  throw new Error('Buy consumed more or less allowance than actualUsdcSpent.');
}
if (balanceBeforeBuyStep === 0n && marketBalanceAfterBuy !== buyQuote[1]) {
  throw new Error('Market retained USDC beyond the executed curve cost.');
}

const sellAmount = (boughtTokenOut / 10n ** 18n / 2n) * 10n ** 18n;
const sellQuote = seedSellQuote(sellAmount, boughtTokenOut / 10n ** 18n);
if (balanceBeforeBuyStep === 0n) {
  const liveSellQuote = await readContract({
    address: marketAddress,
    abi: marketArtifact.abi,
    functionName: 'quoteSell',
    args: [sellAmount],
  });
  if (liveSellQuote.some((value, index) => value !== sellQuote[index])) {
    throw new Error('Post-buy sell quote differs from the independently calculated seed quote.');
  }
}
if (sellQuote[0] === 0n) throw new Error('Sell quote returned zero USDC.');
const sell = await execute({
  idempotencyKey: circleIdempotencyKey('market-e2e-sell', [...e2eIdentity, marketAddress, sellAmount.toString()]),
  contractAddress: marketAddress,
  signature: 'sell(uint256,uint256)',
  parameters: [sellAmount.toString(), sellQuote[0].toString()],
  reference: 'mmv6a1-sell',
});
const soldEvent = sell.receipt.logs.map((log) => {
  try {
    return decodeEventLog({ abi: marketArtifact.abi, eventName: 'Sold', data: log.data, topics: log.topics });
  } catch { return null; }
}).find((event) => event?.eventName === 'Sold');
if (!soldEvent?.args?.tokenIn) throw new Error('Sold event was not found in the confirmed receipt.');

const [finalTokenBalance, finalUsdc, reserveUsdc, creatorFees, treasuryFees, soldTokenCount, marketUsdcBalance] = await Promise.all([
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'balanceOf', args: [wallet.address] }),
  readContract({ address: config.arcUsdcAddress, abi: usdcAbi, functionName: 'balanceOf', args: [wallet.address] }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'reserveUsdc' }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'creatorFeesPaidUsdc' }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'treasuryFeesPaidUsdc' }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'soldTokenCount' }),
  readContract({ address: config.arcUsdcAddress, abi: usdcAbi, functionName: 'balanceOf', args: [marketAddress] }),
]);
if (finalTokenBalance !== boughtTokenOut - soldEvent.args.tokenIn) throw new Error('Sell did not return the expected token amount.');
if (creatorFees === 0n || treasuryFees === 0n) throw new Error('Trade fee allocation counters were not updated.');
if (soldTokenCount !== finalTokenBalance / 10n ** 18n) throw new Error('Market sold-supply accounting mismatch.');
if (marketUsdcBalance !== reserveUsdc) throw new Error('Final market balance contains unused input or is insolvent.');

const txUrl = (hash) => `https://testnet.arcscan.app/tx/${hash}`;
console.log(JSON.stringify({
  chainId: 5042002,
  wallet: getAddress(wallet.address),
  walletUsdcBefore: formatUnits(initialUsdc, 6),
  walletUsdcAfter: formatUnits(finalUsdc, 6),
  market: marketAddress,
  token: marketAddress,
  launch: { hash: launch.transaction.txHash, arcScan: txUrl(launch.transaction.txHash) },
  approval: { hash: approval.transaction.txHash, arcScan: txUrl(approval.transaction.txHash) },
  buy: {
    hash: buy.transaction.txHash,
    arcScan: txUrl(buy.transaction.txHash),
    maximumUsdcIn: formatUnits(buyAmount, 6),
    actualUsdcSpent: formatUnits(buyQuote[4], 6),
    unusedMaximumBudget: formatUnits(buyAmount - buyQuote[4], 6),
    curveCostUsdc: formatUnits(buyQuote[1], 6),
    creatorFeeUsdc: formatUnits(buyQuote[2], 6),
    treasuryFeeUsdc: formatUnits(buyQuote[3], 6),
    tokenOut: formatUnits(boughtTokenOut, 18),
  },
  sell: {
    hash: sell.transaction.txHash,
    arcScan: txUrl(sell.transaction.txHash),
    tokenIn: formatUnits(soldEvent.args.tokenIn, 18),
    usdcOut: formatUnits(soldEvent.args.usdcOut, 6),
  },
  finalTokenBalance: formatUnits(finalTokenBalance, 18),
  reserveUsdc: formatUnits(reserveUsdc, 6),
  marketUsdcBalance: formatUnits(marketUsdcBalance, 6),
  creatorFeesPaidUsdc: formatUnits(creatorFees, 6),
  treasuryFeesPaidUsdc: formatUnits(treasuryFees, 6),
}, null, 2));
