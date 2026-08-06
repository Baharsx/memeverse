import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  createPublicClient, encodeFunctionData, formatUnits, getAddress, http, parseUnits,
} from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

/**
 * Live Arc Testnet end-to-end proof for the Stage 2 USDC vault:
 * approve -> deposit real USDC -> read a real share position -> redeem it back.
 *
 * The solvency invariant (vault USDC balance covers what the accounting owes) is asserted from
 * chain reads at every step, and the round-trip is checked to return the deposit intact.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const ARC_CHAIN_ID = 5042002;
const DEPOSIT_USDC = process.env.VAULT_E2E_DEPOSIT_USDC ?? '1.00';

if (!process.env.USDC_VAULT_ADDRESS) {
  console.error('USDC_VAULT_ADDRESS is required. Run circle:deploy:assets first.');
  process.exit(1);
}

const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });
const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  console.error(`Refusing to run: chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
  process.exit(1);
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
});

const vaultAbi = JSON.parse(await readFile('contracts/artifacts/MemeVerseVault.json', 'utf8')).abi;
const vaultAddress = getAddress(process.env.USDC_VAULT_ADDRESS);
const usdcAddress = getAddress(config.arcUsdcAddress);

const usdcAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const balanceOf = (owner) => rpc.readContract({
  address: usdcAddress, abi: usdcAbi, functionName: 'balanceOf', args: [getAddress(owner)],
});
const vaultRead = (functionName, args = []) => rpc.readContract({
  address: vaultAddress, abi: vaultAbi, functionName, args,
});

const writes = [];

async function execute({ to, data, label, scope }) {
  const response = await client.createContractExecutionTransaction({
    idempotencyKey: circleIdempotencyKey(scope, [config.circleWalletId, to, data]),
    walletId: config.circleWalletId,
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
  if (receipt.status !== 'success') throw new Error(`${label} reverted on Arc (${transaction.txHash}).`);
  writes.push({ label, txHash: transaction.txHash, blockNumber: receipt.blockNumber.toString() });
  console.log(`  ${label}`);
  console.log(`    tx:    ${transaction.txHash}`);
  console.log(`    block: ${receipt.blockNumber}`);
  return transaction;
}

/** Real USDC held by the vault must always cover what the share accounting owes. */
async function assertSolvent(note) {
  const held = await balanceOf(vaultAddress);
  const totalAssets = await vaultRead('totalAssets');
  const supply = await vaultRead('totalSupply');
  const owed = supply === 0n ? 0n : await vaultRead('previewRedeem', [supply]);
  if (totalAssets !== held) throw new Error(`totalAssets ${totalAssets} != held ${held} (${note})`);
  if (owed > held) throw new Error(`vault owes ${owed} but holds ${held} (${note})`);
  console.log(`    solvency ${note}: holds ${formatUnits(held, 6)} USDC, owes ${formatUnits(owed, 6)} USDC`);
}

try {
  const wallet = (await client.getWallet({ id: config.circleWalletId })).data.wallet;
  const owner = getAddress(wallet.address);

  console.log('MemeVerse vault end-to-end on Arc Testnet');
  console.log(`  chain:  ${chainId}`);
  console.log(`  vault:  ${vaultAddress}`);
  console.log(`  asset:  ${getAddress(await vaultRead('asset'))}`);
  console.log(`  wallet: ${owner}`);

  if (getAddress(await vaultRead('asset')) !== usdcAddress) {
    throw new Error('Vault asset is not Arc USDC.');
  }

  const depositUnits = parseUnits(DEPOSIT_USDC, 6);
  const walletBefore = await balanceOf(owner);
  console.log(`\n  wallet USDC before: ${formatUnits(walletBefore, 6)}`);
  if (walletBefore < depositUnits) throw new Error('Wallet has insufficient USDC for the deposit.');
  await assertSolvent('before deposit');

  console.log('\n[1/3] Approve and deposit');
  await execute({
    to: usdcAddress,
    data: encodeFunctionData({ abi: usdcAbi, functionName: 'approve', args: [vaultAddress, depositUnits] }),
    label: `approve vault for ${DEPOSIT_USDC} USDC`,
    scope: 'vault-e2e-approve',
  });

  const previewShares = await vaultRead('previewDeposit', [depositUnits]);
  await execute({
    to: vaultAddress,
    data: encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [depositUnits, owner] }),
    label: `deposit ${DEPOSIT_USDC} USDC`,
    scope: 'vault-e2e-deposit',
  });

  console.log('\n[2/3] Read the real vault position');
  const shares = await vaultRead('balanceOf', [owner]);
  const redeemable = await vaultRead('maxWithdraw', [owner]);
  const totalAssets = await vaultRead('totalAssets');
  console.log(`    shares:      ${shares} (preview was ${previewShares})`);
  console.log(`    redeemable:  ${formatUnits(redeemable, 6)} USDC`);
  console.log(`    totalAssets: ${formatUnits(totalAssets, 6)} USDC`);
  console.log(`    yield:       ${await vaultRead('annualPercentageYieldBps')} bps (no strategy, no APY)`);
  if (shares !== previewShares) throw new Error('Minted shares do not match the preview.');
  if (shares === 0n) throw new Error('Deposit minted no shares.');
  if (redeemable !== depositUnits) {
    throw new Error(`Redeemable ${redeemable} does not match deposit ${depositUnits}.`);
  }
  await assertSolvent('after deposit');

  console.log('\n[3/3] Redeem the whole position');
  await execute({
    to: vaultAddress,
    data: encodeFunctionData({ abi: vaultAbi, functionName: 'redeem', args: [shares, owner, owner] }),
    label: 'redeem all shares',
    scope: 'vault-e2e-redeem',
  });

  const sharesAfter = await vaultRead('balanceOf', [owner]);
  const assetsAfter = await vaultRead('totalAssets');
  console.log(`    shares after:      ${sharesAfter}`);
  console.log(`    totalAssets after: ${formatUnits(assetsAfter, 6)} USDC`);
  if (sharesAfter !== 0n) throw new Error('Redeem left a residual share balance.');
  await assertSolvent('after redeem');

  console.log('\nVault end-to-end verified on Arc Testnet.');
  console.log(`  deposited: ${DEPOSIT_USDC} USDC`);
  console.log(`  shares:    ${shares}`);
  console.log(`  redeemed:  ${formatUnits(redeemable, 6)} USDC (full principal returned)`);
  console.log('\nArc writes performed:');
  for (const write of writes) console.log(`  ${write.label}: ${write.txHash} (block ${write.blockNumber})`);
} catch (error) {
  console.error(`\nVault end-to-end failed: ${error?.response?.data?.message ?? error.message}`);
  if (writes.length) {
    console.error('Arc writes completed before the failure:');
    for (const write of writes) console.error(`  ${write.label}: ${write.txHash}`);
  }
  process.exitCode = 1;
}
