import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, formatUnits, getAddress, http, parseUnits } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

/**
 * Provisions the second real Arc identity the Stage 2 end-to-end flows need.
 *
 * A genuine NFT sale needs a buyer who is not the seller, and a meaningful autonomous creator
 * payout needs a creator who is not the treasury paying it — otherwise the "payout" is the
 * treasury moving USDC to itself and proves nothing. This wallet is a real Circle
 * developer-controlled Arc wallet, not a simulated counterparty.
 *
 * Idempotent: the wallet is identified by `refId`, so a rerun reuses the existing wallet rather
 * than creating another, and funding is skipped when the balance is already sufficient.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const COUNTERPARTY_REF = 'memeverse-arc-counterparty';
const TARGET_USDC = process.env.COUNTERPARTY_TARGET_USDC ?? '3.00';
const ARC_CHAIN_ID = 5042002;

if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletSetId) {
  console.error('CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_SET_ID are required.');
  process.exit(1);
}

const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });
const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  console.error(`Refusing to run: RPC reports chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
});

const existing = await client.listWallets({ blockchain: 'ARC-TESTNET', refId: COUNTERPARTY_REF });
let wallet = existing.data?.wallets?.[0];

if (!wallet) {
  const created = await client.createWallets({
    idempotencyKey: circleIdempotencyKey('counterparty-wallet', [
      config.circleWalletSetId, COUNTERPARTY_REF, 'ARC-TESTNET',
    ]),
    walletSetId: config.circleWalletSetId,
    blockchains: ['ARC-TESTNET'],
    accountType: 'EOA',
    count: 1,
    refId: COUNTERPARTY_REF,
  });
  wallet = created.data?.wallets?.[0];
  if (!wallet) throw new Error('Circle returned no counterparty wallet.');
  console.log('Created counterparty wallet.');
} else {
  console.log('Reusing existing counterparty wallet.');
}

const address = getAddress(wallet.address);
console.log(`  id:      ${wallet.id}`);
console.log(`  address: ${address}`);
console.log(`  state:   ${wallet.state}`);

const usdcAbi = [{
  name: 'balanceOf',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ type: 'address' }],
  outputs: [{ type: 'uint256' }],
}];
const balanceOf = (owner) => rpc.readContract({
  address: getAddress(config.arcUsdcAddress), abi: usdcAbi, functionName: 'balanceOf', args: [owner],
});

const targetUnits = parseUnits(TARGET_USDC, 6);
const current = await balanceOf(address);
console.log(`  balance: ${formatUnits(current, 6)} USDC (target ${TARGET_USDC})`);

if (current >= targetUnits) {
  console.log('\nCounterparty already funded; nothing to do.');
} else {
  const topUp = targetUnits - current;
  console.log(`\nTopping up ${formatUnits(topUp, 6)} USDC from the treasury.`);
  const transfer = await client.createTransaction({
    idempotencyKey: circleIdempotencyKey('counterparty-fund', [
      config.circleWalletId, address, topUp.toString(),
    ]),
    walletId: config.circleWalletId,
    tokenAddress: config.arcUsdcAddress,
    blockchain: 'ARC-TESTNET',
    destinationAddress: address,
    amounts: [formatUnits(topUp, 6)],
    fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
  });
  const transactionId = transfer.data?.id;
  if (!transactionId) throw new Error('Circle returned no funding transaction ID.');

  let final;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await client.getTransaction({ id: transactionId });
    final = response.data?.transaction;
    if (['COMPLETE', 'CONFIRMED'].includes(final?.state)) break;
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(final?.state)) {
      throw new Error(`Funding ended in ${final.state}: ${final.errorReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log(`  txHash:  ${final?.txHash}`);
  console.log(`  balance: ${formatUnits(await balanceOf(address), 6)} USDC`);
}

console.log('\nAdd to .env.local:');
console.log(`CIRCLE_COUNTERPARTY_WALLET_ID=${wallet.id}`);
console.log(`CIRCLE_COUNTERPARTY_ADDRESS=${address}`);
