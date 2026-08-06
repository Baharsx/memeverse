import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  createPublicClient, encodeFunctionData, formatUnits, getAddress, http, parseAbi, parseUnits,
} from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

/**
 * Prepares a registered MemeVerse market that genuinely satisfies the autonomous agent's
 * evidence thresholds, by generating real Arc trading activity.
 *
 * This exists so the live autonomous payout can be demonstrated against a market the policy
 * honestly approves, rather than by lowering the thresholds until a quiet market passes. Every
 * trade here is a real onchain buy paid for in real testnet USDC by a real wallet.
 *
 * The market is created by the counterparty wallet, so its `creator()` is *not* the treasury
 * that pays. That makes the eventual payout a genuine transfer with a measurable balance delta
 * rather than the treasury moving USDC to itself.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const ARC_CHAIN_ID = 5042002;
const SYMBOL = process.env.AGENT_ACTIVITY_SYMBOL ?? 'MVAGENT';
const BUY_USDC = process.env.AGENT_ACTIVITY_BUY_USDC ?? '0.70';
const ROUNDS = Number(process.env.AGENT_ACTIVITY_ROUNDS ?? 4);
// Circle idempotency is payload-bound, so a transaction that failed for an external reason
// (an under-funded wallet, say) replays its cached failure until the payload identity changes.
// This nonce lets an operator deliberately retry after fixing the cause.
const NONCE = process.env.AGENT_ACTIVITY_NONCE ?? '1';

const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });
const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  console.error(`Refusing to run: chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
  process.exit(1);
}
if (!process.env.CIRCLE_COUNTERPARTY_WALLET_ID) {
  console.error('CIRCLE_COUNTERPARTY_WALLET_ID is required.');
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
});

const factoryAbi = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8')).abi;
const marketAbi = JSON.parse(await readFile('contracts/artifacts/MemeMarket.json', 'utf8')).abi;
const usdcAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

const factoryAddress = getAddress(config.marketFactoryAddress);
const usdcAddress = getAddress(config.arcUsdcAddress);
const balanceOf = (owner) => rpc.readContract({
  address: usdcAddress, abi: usdcAbi, functionName: 'balanceOf', args: [getAddress(owner)],
});

const treasuryWallet = (await client.getWallet({ id: config.circleWalletId })).data.wallet;
const counterpartyWallet = (await client.getWallet({
  id: process.env.CIRCLE_COUNTERPARTY_WALLET_ID,
})).data.wallet;
const treasuryAddress = getAddress(treasuryWallet.address);
const counterpartyAddress = getAddress(counterpartyWallet.address);

async function execute({ walletId, to, data, label, scope }) {
  const response = await client.createContractExecutionTransaction({
    idempotencyKey: circleIdempotencyKey(scope, [walletId, to, data, NONCE]),
    walletId,
    contractAddress: to,
    callData: data,
    fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
  });
  const id = response.data?.id;
  if (!id) throw new Error(`Circle returned no transaction ID for ${label}.`);
  let transaction;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = await client.getTransaction({ id });
    transaction = status.data?.transaction;
    if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
      throw new Error(`${label} ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!transaction?.txHash) throw new Error(`${label} produced no Arc transaction hash.`);
  const receipt = await rpc.waitForTransactionReceipt({ hash: transaction.txHash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${transaction.txHash}).`);
  console.log(`    ${label}: ${transaction.txHash} (block ${receipt.blockNumber})`);
  return receipt;
}

console.log('Preparing real market activity for the autonomous agent');
console.log(`  treasury:     ${treasuryAddress} (${formatUnits(await balanceOf(treasuryAddress), 6)} USDC)`);
console.log(`  counterparty: ${counterpartyAddress} (${formatUnits(await balanceOf(counterpartyAddress), 6)} USDC)`);

// ── Find or create the counterparty's market ──
const key = await rpc.readContract({
  address: factoryAddress,
  abi: factoryAbi,
  functionName: 'marketFor',
  args: [
    // keccak256(abi.encode(creator, keccak256(bytes(symbol))))
    await (async () => {
      const { encodeAbiParameters, keccak256, toHex } = await import('viem');
      return keccak256(encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes32' }],
        [counterpartyAddress, keccak256(toHex(SYMBOL))],
      ));
    })(),
  ],
});

let marketAddress = getAddress(key);
if (marketAddress === '0x0000000000000000000000000000000000000000') {
  console.log(`\n[1/3] Counterparty creates market ${SYMBOL}`);
  await execute({
    walletId: process.env.CIRCLE_COUNTERPARTY_WALLET_ID,
    to: factoryAddress,
    data: encodeFunctionData({
      abi: factoryAbi,
      functionName: 'createMarket',
      args: [
        'MEMEVERSE AGENT SIGNAL',
        SYMBOL,
        'Market used to produce real Arc signal evidence for the autonomous agent.',
        100_000n,
        100n,
        1_000n,
      ],
    }),
    label: 'createMarket',
    scope: 'agent-activity-create-market',
  });
  const count = await rpc.readContract({
    address: factoryAddress, abi: factoryAbi, functionName: 'marketCount',
  });
  marketAddress = getAddress(await rpc.readContract({
    address: factoryAddress, abi: factoryAbi, functionName: 'markets', args: [count - 1n],
  }));
} else {
  console.log(`\n[1/3] Reusing existing market ${SYMBOL}`);
}

const creator = getAddress(await rpc.readContract({
  address: marketAddress, abi: marketAbi, functionName: 'creator',
}));
console.log(`  market:  ${marketAddress}`);
console.log(`  creator: ${creator}`);
if (creator !== counterpartyAddress) {
  throw new Error('The market creator is not the counterparty; a payout would have no delta.');
}

// ── Real buys from two distinct traders ──
console.log(`\n[2/3] Generating ${ROUNDS * 2} real buys of ${BUY_USDC} USDC from two traders`);
const buyUnits = parseUnits(BUY_USDC, 6);
const traders = [
  { name: 'treasury', walletId: config.circleWalletId, address: treasuryAddress },
  { name: 'counterparty', walletId: process.env.CIRCLE_COUNTERPARTY_WALLET_ID, address: counterpartyAddress },
];

for (const trader of traders) {
  await execute({
    walletId: trader.walletId,
    to: usdcAddress,
    data: encodeFunctionData({
      abi: usdcAbi, functionName: 'approve', args: [marketAddress, buyUnits * BigInt(ROUNDS)],
    }),
    label: `${trader.name} approves market`,
    scope: `agent-activity-approve-${trader.name}-${ROUNDS}`,
  });
}

for (let round = 0; round < ROUNDS; round += 1) {
  for (const trader of traders) {
    await execute({
      walletId: trader.walletId,
      to: marketAddress,
      data: encodeFunctionData({
        abi: marketAbi, functionName: 'buy', args: [buyUnits, 0n],
      }),
      label: `${trader.name} buy #${round + 1}`,
      scope: `agent-activity-buy-${trader.name}-${round}`,
    });
  }
}

// ── Report the resulting confirmed state ──
console.log('\n[3/3] Resulting market state');
const [reserve, sold, createdBlock] = await Promise.all([
  rpc.readContract({ address: marketAddress, abi: marketAbi, functionName: 'reserveUsdc' }),
  rpc.readContract({ address: marketAddress, abi: marketAbi, functionName: 'soldTokenCount' }),
  rpc.readContract({ address: marketAddress, abi: marketAbi, functionName: 'createdBlock' }),
]);
const head = await rpc.getBlockNumber();
console.log(`  reserveUsdc:   ${formatUnits(reserve, 6)} USDC`);
console.log(`  soldTokens:    ${sold}`);
console.log(`  createdBlock:  ${createdBlock}`);
console.log(`  head:          ${head} (age ${head - createdBlock} blocks)`);
console.log(`  treasury:      ${formatUnits(await balanceOf(treasuryAddress), 6)} USDC`);
console.log(`  counterparty:  ${formatUnits(await balanceOf(counterpartyAddress), 6)} USDC`);
console.log(`\nAGENT_E2E_MARKET=${marketAddress}`);
console.log('The market must reach 500 blocks of age before the risk heuristic clears.');
