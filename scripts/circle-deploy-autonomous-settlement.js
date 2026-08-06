import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { initiateSmartContractPlatformClient } from '@circle-fin/smart-contract-platform';
import { createPublicClient, getAddress, http } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';
import { circleIdempotencyKey } from './circle-idempotency.js';

/**
 * Deploys the autonomous settlement contract whose immutable operator is the Circle Agent Wallet.
 *
 * Why a second contract exists at all: `MemeVerseSettlement.operator` is immutable, and the
 * existing deployment is bound to the Developer-Controlled Wallet that serves the manual operator
 * path. Rather than loosen that contract's authorization to an arbitrary caller — which would
 * destroy the guarantee the whole Stage 1 design rests on — the autonomous executor gets its own
 * correctly configured instance. The two payout paths stay physically isolated onchain.
 *
 * The deployer is the Developer-Controlled Wallet (it holds the Smart Contract Platform
 * credentials); the *operator* is the Agent Wallet. Deployer and operator are deliberately
 * different, and the constructor argument is what grants authority.
 */

loadLocalEnvironment();
const config = loadServerConfig();
const run = promisify(execFile);

const ARC_CHAIN_ID = 5042002;

const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });
const chainId = await rpc.getChainId();
if (chainId !== ARC_CHAIN_ID) {
  console.error(`Refusing to deploy: chain ${chainId}, expected ${ARC_CHAIN_ID}.`);
  process.exit(1);
}

// Resolve the Agent Wallet from the authenticated Circle CLI session rather than from
// configuration, so the operator can never be a stale or mistyped address.
const listed = await run('circle', [
  'wallet', 'list', '--chain', 'ARC-TESTNET', '--type', 'agent', '--output', 'json',
]);
const agentWallets = JSON.parse(listed.stdout)?.data?.wallets ?? [];
if (agentWallets.length === 0) {
  console.error('No Circle Agent Wallet exists on ARC-TESTNET. Run `circle wallet create` first.');
  process.exit(1);
}
const agentWalletAddress = getAddress(agentWallets[0].address);

const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseSettlement.json', 'utf8'));
const clientConfig = {
  apiKey: config.circleApiKey,
  entitySecret: config.circleEntitySecret,
  baseUrl: config.circleApiBaseUrl,
};
const walletClient = initiateDeveloperControlledWalletsClient(clientConfig);
const contractClient = initiateSmartContractPlatformClient(clientConfig);

try {
  const constructorParameters = [agentWalletAddress, config.arcUsdcAddress];
  const fingerprint = circleIdempotencyKey('autonomous-settlement-artifact', [
    artifact.bytecode, 'ARC-TESTNET', ...constructorParameters,
  ]);

  console.log('Deploying the autonomous settlement contract to Arc Testnet.');
  console.log(`  chain:            ${chainId}`);
  console.log(`  immutable operator: ${agentWalletAddress}  (Circle Agent Wallet)`);
  console.log(`  usdc:             ${config.arcUsdcAddress}`);
  console.log(`  manual settlement remains: ${config.circleSettlementContractAddress}`);

  const deployment = await contractClient.deployContract({
    idempotencyKey: circleIdempotencyKey('autonomous-settlement-deploy', [fingerprint]),
    name: 'MemeVerseSettlementAutonomous',
    blockchain: 'ARC-TESTNET',
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await walletClient.getTransaction({ id: transactionId });
    transaction = response.data?.transaction;
    if (['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) break;
    if (['FAILED', 'DENIED', 'CANCELLED'].includes(transaction?.state)) {
      throw new Error(`Deployment ended in ${transaction.state}: ${transaction.errorReason ?? 'unknown'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!['COMPLETE', 'CONFIRMED'].includes(transaction?.state)) {
    throw new Error('Timed out waiting for the autonomous settlement deployment.');
  }

  const contractResponse = await contractClient.getContract({ id: contractId });
  const address = getAddress(
    contractResponse.data?.contract?.contractAddress ?? transaction.contractAddress,
  );

  // Read the operator back from the chain. A contract whose operator is not the Agent Wallet is
  // useless for the autonomous path and must never be recorded as if it were.
  const onchainOperator = getAddress(await rpc.readContract({
    address,
    abi: artifact.abi,
    functionName: 'operator',
  }));
  const onchainUsdc = getAddress(await rpc.readContract({
    address, abi: artifact.abi, functionName: 'usdc',
  }));
  if (onchainOperator !== agentWalletAddress) {
    throw new Error(`Deployed operator ${onchainOperator} is not the Agent Wallet ${agentWalletAddress}.`);
  }
  if (onchainUsdc !== getAddress(config.arcUsdcAddress)) {
    throw new Error(`Deployed USDC ${onchainUsdc} is not Arc USDC.`);
  }

  console.log('\nAutonomous settlement contract is live.');
  console.log(`  address:  ${address}`);
  console.log(`  txHash:   ${transaction.txHash}`);
  console.log(`  operator: ${onchainOperator} (verified onchain)`);
  console.log(`  usdc:     ${onchainUsdc} (verified onchain)`);
  console.log('\nAdd to .env.local:');
  console.log(`AGENT_SETTLEMENT_CONTRACT_ADDRESS=${address}`);
  console.log(`CIRCLE_AGENT_SETTLEMENT_CONTRACT_ID=${contractId}`);
  console.log(`AGENT_WALLET_ADDRESS=${agentWalletAddress}`);
} catch (error) {
  const provider = error?.response?.data;
  console.error(`\nAutonomous settlement deployment failed: ${provider?.message ?? error.message}`);
  process.exitCode = 1;
}
