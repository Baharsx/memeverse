import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { initiateSmartContractPlatformClient } from '@circle-fin/smart-contract-platform';
import { getAddress } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';
import { assertCircleDeployWallet, circleChain } from './circle-chain.js';

loadLocalEnvironment();
const config = loadServerConfig();
const { blockchain, label } = circleChain(config);

if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletId) {
  console.error('CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_ID are required.');
  process.exitCode = 1;
} else {
  const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8'));
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
    assertCircleDeployWallet(wallet, blockchain);
    const constructorParameters = [config.arcUsdcAddress, wallet.address, '100', '100'];
    const artifactFingerprint = circleIdempotencyKey('market-factory-artifact', [
      artifact.bytecode,
      blockchain,
      ...constructorParameters,
    ]);

    const deployment = await contractClient.deployContract({
      idempotencyKey: circleIdempotencyKey('market-factory-deploy', [artifactFingerprint]),
      name: 'MemeVerseFactory',
      blockchain,
      walletId: config.circleWalletId,
      abiJson: JSON.stringify(artifact.abi),
      bytecode: artifact.bytecode,
      constructorParameters,
      fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
    });
    const contractId = deployment.data?.contractId;
    const transactionId = deployment.data?.transactionId;
    if (!contractId || !transactionId) throw new Error('Circle returned incomplete deployment IDs.');

    let transaction;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      const response = await walletClient.getTransaction({ id: transactionId });
      transaction = response.data?.transaction;
      if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
      if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
        throw new Error(`Deployment ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown error'}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    }
    if (!['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) {
      throw new Error('Timed out while waiting for the market factory deployment.');
    }

    const contractResponse = await contractClient.getContract({ id: contractId });
    const contract = contractResponse.data?.contract;
    const contractAddress = contract?.contractAddress ?? transaction.contractAddress;
    if (!contractAddress || !transaction.txHash) throw new Error('Circle returned no deployed address or hash.');

    console.log(`MemeVerse market factory is live on ${label}.`);
    console.log(`CIRCLE_MARKET_FACTORY_CONTRACT_ID=${contractId}`);
    console.log(`CIRCLE_MARKET_FACTORY_DEPLOYMENT_TX_ID=${transactionId}`);
    console.log(`MARKET_FACTORY_ADDRESS=${getAddress(contractAddress)}`);
    console.log(`Artifact fingerprint: ${artifactFingerprint}`);
    console.log(`Deployment transaction: ${transaction.txHash}`);
  } catch (error) {
    const provider = error?.response?.data;
    console.error(`Market factory deployment failed: ${provider?.message ?? error.message}`);
    console.error(JSON.stringify({
      providerStatus: error?.response?.status,
      status: error?.status,
      code: error?.code,
      method: error?.method,
      url: error?.url,
      providerCode: provider?.code,
      providerFields: provider ? Object.keys(provider) : [],
      errorFields: Object.keys(error ?? {}),
      responseFields: error?.response ? Object.keys(error.response) : [],
      errors: provider?.errors,
    }, null, 2));
    process.exitCode = 1;
  }
}
