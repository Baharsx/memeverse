import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { createPublicClient, formatUnits, http, parseUnits } from 'viem';
import { arcTestnet } from 'viem/chains';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { usdcAbi } from '../server/infrastructure/arc-contracts.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

loadLocalEnvironment();
const config = loadServerConfig();
if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletId
  || !config.circleSettlementContractAddress) {
  console.error('Circle credentials, wallet ID, and settlement contract address are required.');
  process.exitCode = 1;
} else {
  const client = initiateDeveloperControlledWalletsClient({
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    baseUrl: config.circleApiBaseUrl,
  });
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(config.arcRpcUrl) });
  try {
    const walletResponse = await client.getWallet({ id: config.circleWalletId });
    const wallet = walletResponse.data?.wallet;
    if (!wallet || wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') {
      throw new Error('Approval wallet must be an ARC-TESTNET EOA.');
    }
    const amount = parseUnits(config.circleSettlementAllowanceUsdc, 6);
    const currentAllowance = await publicClient.readContract({
      address: config.arcUsdcAddress,
      abi: usdcAbi,
      functionName: 'allowance',
      args: [wallet.address, config.circleSettlementContractAddress],
    });
    if (currentAllowance >= amount) {
      console.log(`Settlement allowance already covers ${formatUnits(currentAllowance, 6)} USDC.`);
      process.exit(0);
    }

    const response = await client.createContractExecutionTransaction({
      // Bound to the exact allowance operation. Raising CIRCLE_SETTLEMENT_ALLOWANCE_USDC or
      // repointing the settlement contract is a different approval, not a retry of this one.
      idempotencyKey: circleIdempotencyKey('settlement-allowance-approve', [
        'ARC-TESTNET',
        config.circleWalletId,
        config.arcUsdcAddress,
        config.circleSettlementContractAddress,
        amount.toString(),
      ]),
      walletId: config.circleWalletId,
      contractAddress: config.arcUsdcAddress,
      abiFunctionSignature: 'approve(address,uint256)',
      abiParameters: [config.circleSettlementContractAddress, amount.toString()],
      refId: 'memeverse-phase-3-settlement-allowance',
      fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
    });
    const transactionId = response.data?.id;
    if (!transactionId) throw new Error('Circle returned no approval transaction ID.');

    let transaction;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = await client.getTransaction({ id: transactionId });
      transaction = status.data?.transaction;
      if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
        throw new Error(`Approval ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown error'}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
    if (!['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) {
      throw new Error('Timed out while waiting for settlement approval.');
    }
    const allowance = await publicClient.readContract({
      address: config.arcUsdcAddress,
      abi: usdcAbi,
      functionName: 'allowance',
      args: [wallet.address, config.circleSettlementContractAddress],
    });
    console.log(`Settlement allowance confirmed: ${formatUnits(allowance, 6)} USDC.`);
    console.log(`CIRCLE_SETTLEMENT_APPROVAL_TX_ID=${transactionId}`);
    console.log(`Approval transaction: ${transaction.txHash}`);
  } catch (error) {
    console.error(`Settlement approval failed: ${error?.response?.data?.message ?? error.message}`);
    process.exitCode = 1;
  }
}
