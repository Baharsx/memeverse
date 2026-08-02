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
  idempotencyKey: 'd8b68851-0fc3-4c07-a3cf-46fb98365cb7',
  contractAddress: config.marketFactoryAddress,
  signature: 'createMarket(string,string,string,uint256,uint256,uint256)',
  parameters: ['MEMEVERSE GENESIS', 'MMV6A', 'Phase 6A verified Arc Public Testnet market.', '100000', '100', '1000'],
  reference: 'mmv6a-launch',
});
const marketCreated = launch.receipt.logs.map((log) => {
  try {
    return decodeEventLog({ abi: factoryArtifact.abi, eventName: 'MarketCreated', data: log.data, topics: log.topics });
  } catch { return null; }
}).find((event) => event?.eventName === 'MarketCreated');
if (!marketCreated?.args?.market) throw new Error('MarketCreated event was not found in launch receipt.');
const marketAddress = getAddress(marketCreated.args.market);

const buyAmount = 10_000n; // 0.01 USDC
const approval = await execute({
  idempotencyKey: 'ab2be08b-3a04-49c0-b085-d8a4c2ad3ce8',
  contractAddress: config.arcUsdcAddress,
  signature: 'approve(address,uint256)',
  parameters: [marketAddress, buyAmount.toString()],
  reference: 'mmv6a-approve',
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

const buyQuote = await readContract({
  address: marketAddress,
  abi: marketArtifact.abi,
  functionName: 'quoteBuy',
  args: [buyAmount],
});
if (buyQuote[0] === 0n) throw new Error('Buy quote returned zero tokens.');
const buy = await execute({
  idempotencyKey: '51d9eb03-a73b-44dc-9220-8354c57ad36a',
  contractAddress: marketAddress,
  signature: 'buy(uint256,uint256)',
  parameters: [buyAmount.toString(), buyQuote[0].toString()],
  reference: 'mmv6a-buy',
});
const boughtEvent = buy.receipt.logs.map((log) => {
  try {
    return decodeEventLog({ abi: marketArtifact.abi, eventName: 'Bought', data: log.data, topics: log.topics });
  } catch { return null; }
}).find((event) => event?.eventName === 'Bought');
if (!boughtEvent?.args?.tokenOut) throw new Error('Bought event was not found in the confirmed receipt.');
const boughtTokenOut = boughtEvent.args.tokenOut;
const tokenBalance = await readContract({
  address: marketAddress,
  abi: marketArtifact.abi,
  functionName: 'balanceOf',
  args: [wallet.address],
});
if (tokenBalance === 0n || tokenBalance > boughtTokenOut) throw new Error('Confirmed buy did not create a valid token balance.');

const sellAmount = (boughtTokenOut / 10n ** 18n / 2n) * 10n ** 18n;
const sellQuote = await readContract({
  address: marketAddress,
  abi: marketArtifact.abi,
  functionName: 'quoteSell',
  args: [sellAmount],
});
if (sellQuote[0] === 0n) throw new Error('Sell quote returned zero USDC.');
const sell = await execute({
  idempotencyKey: '2199e80b-a430-475a-92da-ab430ec1cab7',
  contractAddress: marketAddress,
  signature: 'sell(uint256,uint256)',
  parameters: [sellAmount.toString(), sellQuote[0].toString()],
  reference: 'mmv6a-sell',
});
const soldEvent = sell.receipt.logs.map((log) => {
  try {
    return decodeEventLog({ abi: marketArtifact.abi, eventName: 'Sold', data: log.data, topics: log.topics });
  } catch { return null; }
}).find((event) => event?.eventName === 'Sold');
if (!soldEvent?.args?.tokenIn) throw new Error('Sold event was not found in the confirmed receipt.');

const [finalTokenBalance, finalUsdc, reserveUsdc, creatorFees, treasuryFees, soldTokenCount] = await Promise.all([
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'balanceOf', args: [wallet.address] }),
  readContract({ address: config.arcUsdcAddress, abi: usdcAbi, functionName: 'balanceOf', args: [wallet.address] }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'reserveUsdc' }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'creatorFeesPaidUsdc' }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'treasuryFeesPaidUsdc' }),
  readContract({ address: marketAddress, abi: marketArtifact.abi, functionName: 'soldTokenCount' }),
]);
if (finalTokenBalance !== boughtTokenOut - soldEvent.args.tokenIn) throw new Error('Sell did not return the expected token amount.');
if (creatorFees === 0n || treasuryFees === 0n) throw new Error('Trade fee allocation counters were not updated.');
if (soldTokenCount !== finalTokenBalance / 10n ** 18n) throw new Error('Market sold-supply accounting mismatch.');

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
    usdcIn: formatUnits(buyAmount, 6),
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
  creatorFeesPaidUsdc: formatUnits(creatorFees, 6),
  treasuryFeesPaidUsdc: formatUnits(treasuryFees, 6),
}, null, 2));
