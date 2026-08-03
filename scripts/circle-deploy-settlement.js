import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { initiateSmartContractPlatformClient } from '@circle-fin/smart-contract-platform';
import { getAddress } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

loadLocalEnvironment();
const config = loadServerConfig();

if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletId) {
  console.error('CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_ID are required.');
  process.exitCode = 1;
} else {
  const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseSettlement.json', 'utf8'));
  const clientConfig = {
    apiKey: config.circleApiKey,
    entitySecret: config.circleEntitySecret,
    baseUrl: config.circleApiBaseUrl,
  };
  const walletClient = initiateDeveloperControlledWalletsClient(clientConfig);
  const contractClient = initiateSmartContractPlatformClient(clientConfig);

  try {
    const walletResponse = await walletClient.getWallet({ id: config.circleWalletId });
    const wallet = walletResponse.data?.wallet;
    if (!wallet || wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') {
      throw new Error('Deployment wallet must be an ARC-TESTNET EOA.');
    }

    const constructorParameters = [wallet.address, config.arcUsdcAddress];
    // Bound to the artifact and constructor arguments: retrying the identical deployment reuses
    // the Circle request, while a recompiled bytecode or changed operator produces a new key.
    const artifactFingerprint = circleIdempotencyKey('settlement-artifact', [
      artifact.bytecode,
      'ARC-TESTNET',
      config.circleWalletId,
      ...constructorParameters,
    ]);

    const deployment = await contractClient.deployContract({
      idempotencyKey: circleIdempotencyKey('settlement-deploy', [artifactFingerprint]),
      name: 'MemeVerseSettlement',
      description: 'Idempotent creator USDC settlement contract built on Arc',
      blockchain: 'ARC-TESTNET',
      walletId: config.circleWalletId,
      abiJson: JSON.stringify(artifact.abi),
      bytecode: artifact.bytecode,
      constructorParameters,
      refId: 'memeverse-phase-3-settlement-v1',
      fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
    });
    const contractId = deployment.data?.contractId;
    const transactionId = deployment.data?.transactionId;
    if (!contractId || !transactionId) throw new Error('Circle returned incomplete deployment IDs.');

    let transaction;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await walletClient.getTransaction({ id: transactionId });
      transaction = response.data?.transaction;
      if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
        throw new Error(`Deployment ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown error'}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
    if (!['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) {
      throw new Error('Timed out while waiting for the Circle deployment transaction.');
    }

    const contractResponse = await contractClient.getContract({ id: contractId });
    const contract = contractResponse.data?.contract;
    const contractAddress = contract?.contractAddress ?? transaction.contractAddress;
    if (!contractAddress) throw new Error('Circle did not return the deployed contract address.');

    console.log('MemeVerse settlement contract is live on Arc Testnet.');
    console.log(`CIRCLE_SETTLEMENT_CONTRACT_ID=${contractId}`);
    console.log(`CIRCLE_SETTLEMENT_DEPLOYMENT_TX_ID=${transactionId}`);
    console.log(`CIRCLE_SETTLEMENT_CONTRACT_ADDRESS=${getAddress(contractAddress)}`);
    console.log(`Artifact fingerprint: ${artifactFingerprint}`);
    console.log(`Deployment transaction: ${transaction.txHash}`);
  } catch (error) {
    console.error(`Settlement deployment failed: ${error?.response?.data?.message ?? error.message}`);
    process.exitCode = 1;
  }
}
