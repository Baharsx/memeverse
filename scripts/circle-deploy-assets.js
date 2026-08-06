import { readFile } from 'node:fs/promises';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { initiateSmartContractPlatformClient } from '@circle-fin/smart-contract-platform';
import { createPublicClient, getAddress, http } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

/**
 * Deploys the Stage 2 Arc contracts: the media NFT collection, its USDC marketplace, and the
 * USDC vault.
 *
 * Every deployment key is bound to the exact bytecode and constructor arguments, so a rerun with
 * identical inputs resolves to the same Circle operation instead of deploying a second copy,
 * while any change to either produces a new identity. Each address is read back from the chain
 * and checked before the next contract that depends on it is deployed.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const ARC_CHAIN_ID = 5042002;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!config.circleApiKey || !config.circleEntitySecret || !config.circleWalletId) {
  fail('CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_WALLET_ID are required.');
}

const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });
const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  fail(`Refusing to deploy: RPC reports chain ${chainId}, expected Arc Testnet ${ARC_CHAIN_ID}.`);
}

const clientConfig = {
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
};
const walletClient = initiateDeveloperControlledWalletsClient(clientConfig);
const contractClient = initiateSmartContractPlatformClient(clientConfig);

const walletResponse = await walletClient.getWallet({ id: config.circleWalletId });
const wallet = walletResponse.data?.wallet;
if (!wallet || wallet.blockchain !== 'ARC-TESTNET' || wallet.accountType !== 'EOA') {
  fail('Deployment wallet must be a live ARC-TESTNET EOA.');
}

// The factory the media collection will trust forever. It must already be a real contract.
const factoryAddress = getAddress(config.marketFactoryAddress);
if ((await rpc.getCode({ address: factoryAddress })) === undefined) {
  fail(`Configured MARKET_FACTORY_ADDRESS ${factoryAddress} has no bytecode on Arc.`);
}

async function awaitTransaction(transactionId, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await walletClient.getTransaction({ id: transactionId });
    const transaction = response.data?.transaction;
    if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) return transaction;
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
      throw new Error(`${label} ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function deploy(contractName, constructorParameters) {
  const artifact = JSON.parse(
    await readFile(`contracts/artifacts/${contractName}.json`, 'utf8'),
  );
  const fingerprint = circleIdempotencyKey(`${contractName}-artifact`, [
    artifact.bytecode,
    'ARC-TESTNET',
    ...constructorParameters,
  ]);
  const deployment = await contractClient.deployContract({
    idempotencyKey: circleIdempotencyKey(`${contractName}-deploy`, [fingerprint]),
    name: contractName,
    blockchain: 'ARC-TESTNET',
    walletId: config.circleWalletId,
    abiJson: JSON.stringify(artifact.abi),
    bytecode: artifact.bytecode,
    constructorParameters,
    fee: { type: 'level', config: { feeLevel: config.circleFeeLevel } },
  });
  const contractId = deployment.data?.contractId;
  const transactionId = deployment.data?.transactionId;
  if (!contractId || !transactionId) throw new Error(`Circle returned incomplete IDs for ${contractName}.`);

  const transaction = await awaitTransaction(transactionId, `${contractName} deployment`);
  const contractResponse = await contractClient.getContract({ id: contractId });
  const address = contractResponse.data?.contract?.contractAddress ?? transaction.contractAddress;
  if (!address || !transaction.txHash) {
    throw new Error(`Circle returned no address or hash for ${contractName}.`);
  }

  // Never trust the provider's word that a contract exists: read the code back from Arc.
  const deployedCode = await rpc.getCode({ address: getAddress(address) });
  if (!deployedCode || deployedCode === '0x') {
    throw new Error(`${contractName} reports ${address} but Arc has no bytecode there.`);
  }

  console.log(`\n${contractName} deployed.`);
  console.log(`  address:     ${getAddress(address)}`);
  console.log(`  txHash:      ${transaction.txHash}`);
  console.log(`  contractId:  ${contractId}`);
  console.log(`  fingerprint: ${fingerprint}`);
  return { address: getAddress(address), txHash: transaction.txHash, contractId, transactionId };
}

try {
  console.log(`Deploying Stage 2 assets to Arc Testnet (chain ${chainId}).`);
  console.log(`Deployer: ${wallet.address}`);
  console.log(`Trusted factory: ${factoryAddress}`);
  console.log(`Arc USDC: ${config.arcUsdcAddress}`);

  const nft = await deploy('MemeVerseMediaNFT', [factoryAddress]);
  const marketplace = await deploy('MemeVerseNFTMarketplace', [
    nft.address,
    config.arcUsdcAddress,
  ]);
  const vault = await deploy('MemeVerseVault', [config.arcUsdcAddress]);

  console.log('\nStage 2 asset deployment complete. Add to .env.local:\n');
  console.log(`MEDIA_NFT_ADDRESS=${nft.address}`);
  console.log(`NFT_MARKETPLACE_ADDRESS=${marketplace.address}`);
  console.log(`USDC_VAULT_ADDRESS=${vault.address}`);
  console.log(`CIRCLE_MEDIA_NFT_CONTRACT_ID=${nft.contractId}`);
  console.log(`CIRCLE_NFT_MARKETPLACE_CONTRACT_ID=${marketplace.contractId}`);
  console.log(`CIRCLE_USDC_VAULT_CONTRACT_ID=${vault.contractId}`);
  console.log('\nDeployment transactions:');
  console.log(`  MemeVerseMediaNFT:        ${nft.txHash}`);
  console.log(`  MemeVerseNFTMarketplace:  ${marketplace.txHash}`);
  console.log(`  MemeVerseVault:           ${vault.txHash}`);
} catch (error) {
  const provider = error?.response?.data;
  console.error(`\nStage 2 asset deployment failed: ${provider?.message ?? error.message}`);
  console.error(JSON.stringify({
    providerStatus: error?.response?.status,
    providerCode: provider?.code,
    errors: provider?.errors,
  }, null, 2));
  process.exitCode = 1;
}
