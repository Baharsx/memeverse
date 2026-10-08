/**
 * Deploy MemeVerseFactory and one seed market with an EOA on Arc mainnet (chain 5042).
 *
 * Reads DEPLOYER_PRIVATE_KEY from the environment or from MEMEVERSE_ENV
 * (default /etc/memeverse/memeverse.env). Never prints the key and never writes it to git
 * or to the deploy state file. Aborts before any broadcast when the wallet is under 0.8 USDC
 * or when the estimated cost would leave less than 0.15 USDC.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeDeployData,
  formatUnits,
  getAddress,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc } from 'viem/chains';
import {
  isBannedContract,
  isTestnetProductContract,
} from '../src/arc-networks.js';
import {
  BOOKKEEPING_GAS,
  USDC_ADDRESS,
  assertMainnetChainId,
  bufferedGasCost,
  deployBudgetDecision,
  factoryConstructorArgs,
  marketConstructorArgs,
  parseDeployerPrivateKey,
  seedMarketArgs,
} from './mainnet-deploy-plan.js';

const READ_RPC = 'https://rpc.mainnet.arc.io';
const EXPLORER = 'https://explorer.arc.io';
const STATE_PATH = process.env.ARC_MAINNET_DEPLOY_STATE || '/var/lib/memeverse/arc-mainnet-deploy.json';

function safeMessage(error, privateKey) {
  const message = error instanceof Error ? error.message : String(error);
  return privateKey ? message.split(privateKey).join('[redacted]') : message;
}

function readDeployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) {
    return parseDeployerPrivateKey(process.env.DEPLOYER_PRIVATE_KEY);
  }
  const path = process.env.MEMEVERSE_ENV || '/etc/memeverse/memeverse.env';
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error('DEPLOYER_PRIVATE_KEY is missing. The value was not printed.');
  }
  const line = text.split('\n').find((row) => row.startsWith('DEPLOYER_PRIVATE_KEY='));
  if (!line) throw new Error('DEPLOYER_PRIVATE_KEY is missing. The value was not printed.');
  return parseDeployerPrivateKey(line.slice('DEPLOYER_PRIVATE_KEY='.length));
}

function readState() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(state, privateKey) {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  if (privateKey && body.includes(privateKey)) {
    throw new Error('Refusing to write deploy state because it contains the deployer key.');
  }
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, body, { mode: 0o644 });
  } catch (error) {
    console.error(`Could not write deploy state: ${error.message}`);
  }
  console.log(body);
}

async function hasCode(publicClient, address) {
  if (!address) return false;
  const code = await publicClient.getBytecode({ address });
  return Boolean(code && code !== '0x');
}

async function verifySource(address, artifact) {
  const lookup = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (lookup.ok && (await lookup.json()).is_verified === true) {
    console.log(`${artifact.contractName} already verified at ${address}.`);
    return;
  }
  const compilerVersion = `v${String(artifact.compiler).split('.Emscripten')[0]}`;
  const form = new FormData();
  form.set('compiler_version', compilerVersion);
  form.set('contract_name', artifact.contractName);
  form.set('autodetect_constructor_args', 'true');
  form.set('license_type', 'mit');
  form.set(
    'files[0]',
    new Blob([JSON.stringify(artifact.standardJsonInput)], { type: 'application/json' }),
    'standard-input.json',
  );
  const response = await fetch(
    `${EXPLORER}/api/v2/smart-contracts/${address}/verification/via/standard-input`,
    { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) },
  );
  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`Explorer verification failed for ${address} with HTTP ${response.status}: ${payload.slice(0, 300)}`);
  }
  console.log(`Explorer accepted ${artifact.contractName} verification for ${address}.`);
}

function assertFreshAddress(address, label) {
  if (isBannedContract(address) || isTestnetProductContract(address)) {
    throw new Error(`${label} ${address} collides with a banned or testnet contract.`);
  }
}

async function main() {
  const privateKey = readDeployerKey();
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: arc, transport: http(READ_RPC) });
  const walletClient = createWalletClient({ account, chain: arc, transport: http(READ_RPC) });
  const usdc = getAddress(USDC_ADDRESS);

  if (arc.id !== 5042) throw new Error(`viem arc chain id is ${arc.id}, expected 5042.`);
  const chainId = await publicClient.getChainId();
  assertMainnetChainId(chainId);

  const factoryArtifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8'));
  const marketArtifact = JSON.parse(await readFile('contracts/artifacts/MemeMarket.json', 'utf8'));
  const prior = readState();
  let factoryAddress = prior?.chainId === 5042 ? prior.factory : undefined;
  let factoryTx = prior?.factoryTx;
  let seedAddress = prior?.seedMarket;
  let seedTx = prior?.seedTx;

  if (!(await hasCode(publicClient, factoryAddress))) {
    factoryAddress = undefined;
    factoryTx = undefined;
    seedAddress = undefined;
    seedTx = undefined;
  } else if (await hasCode(publicClient, seedAddress)) {
    console.log(`Factory ${factoryAddress} and seed ${seedAddress} are already on chain 5042. Not redeploying.`);
    try {
      await verifySource(factoryAddress, factoryArtifact);
      await verifySource(seedAddress, marketArtifact);
    } catch (error) {
      console.error(safeMessage(error, privateKey));
      process.exitCode = 4;
    }
    return;
  }

  const phase = factoryAddress ? 'next' : 'start';
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`deployer_address: ${account.address}`);
  console.log(`native_usdc: ${formatUnits(balance, 18)}`);
  if (deployBudgetDecision({ balanceWei: balance, estimatedCostWei: 0n, phase }).action === 'unfunded') {
    console.error('Deployer balance is under 0.8 USDC. Nothing was broadcast.');
    process.exitCode = 2;
    return;
  }

  const fees = await publicClient.estimateFeesPerGas().catch(async () => ({
    maxFeePerGas: await publicClient.getGasPrice(),
  }));
  const maxFeePerGas = fees.maxFeePerGas;
  const factoryGas = factoryAddress ? 0n : await publicClient.estimateGas({
    account: account.address,
    data: encodeDeployData({
      abi: factoryArtifact.abi,
      bytecode: factoryArtifact.bytecode,
      args: factoryConstructorArgs(usdc, account.address),
    }),
  });
  const marketGas = await publicClient.estimateGas({
    account: account.address,
    data: encodeDeployData({
      abi: marketArtifact.abi,
      bytecode: marketArtifact.bytecode,
      args: marketConstructorArgs(account.address, account.address, usdc),
    }),
  });
  const estimated = bufferedGasCost(factoryGas + marketGas + BOOKKEEPING_GAS, maxFeePerGas);
  console.log(`estimated_deploy_usdc: ${formatUnits(estimated, 18)}`);
  const decision = deployBudgetDecision({
    balanceWei: balance,
    estimatedCostWei: estimated,
    phase,
  });
  if (decision.action !== 'deploy') {
    console.error('Estimated deploy gas would leave less than 0.15 USDC. Nothing was broadcast.');
    process.exitCode = 3;
    return;
  }

  if (!factoryAddress) {
    assertMainnetChainId(await publicClient.getChainId());
    factoryTx = await walletClient.deployContract({
      abi: factoryArtifact.abi,
      bytecode: factoryArtifact.bytecode,
      args: factoryConstructorArgs(usdc, account.address),
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: factoryTx });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new Error(`Factory deploy failed: ${factoryTx}`);
    }
    factoryAddress = getAddress(receipt.contractAddress);
    assertFreshAddress(factoryAddress, 'Factory');
    console.log(`factory_tx: ${EXPLORER}/tx/${factoryTx}`);
    console.log(`factory_address: ${factoryAddress}`);
  }

  const afterFactory = await publicClient.getBalance({ address: account.address });
  const seedEstimate = bufferedGasCost(marketGas + BOOKKEEPING_GAS, maxFeePerGas);
  const seedDecision = deployBudgetDecision({
    balanceWei: afterFactory,
    estimatedCostWei: seedEstimate,
    phase: 'next',
  });
  if (seedDecision.action !== 'deploy') {
    writeState({
      chainId: 5042,
      factory: factoryAddress,
      factoryTx,
      seedMarket: null,
      seedTx: null,
      deployer: account.address,
      usdc,
    }, privateKey);
    console.error(`Seed market was not broadcast. Factory remains at ${factoryAddress}.`);
    process.exitCode = 3;
    return;
  }

  assertMainnetChainId(await publicClient.getChainId());
  seedTx = await walletClient.writeContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'createMarket',
    args: seedMarketArgs(),
  });
  const seedReceipt = await publicClient.waitForTransactionReceipt({ hash: seedTx });
  if (seedReceipt.status !== 'success') {
    throw new Error(`Seed market transaction failed: ${seedTx}`);
  }
  const marketCount = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'marketCount',
  });
  seedAddress = getAddress(await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'markets',
    args: [marketCount - 1n],
  }));
  assertFreshAddress(seedAddress, 'Seed market');
  const registered = await publicClient.readContract({
    address: factoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'isMarket',
    args: [seedAddress],
  });
  if (!registered) throw new Error(`Seed ${seedAddress} is not registered on the factory.`);

  const state = {
    chainId: 5042,
    factory: factoryAddress,
    factoryTx,
    seedMarket: seedAddress,
    seedTx,
    deployer: account.address,
    usdc,
    seed: {
      name: 'MEMEVERSE GENESIS',
      symbol: 'MMV',
      creatorFeeBps: 100,
      treasuryFeeBps: 100,
    },
  };
  writeState(state, privateKey);
  console.log(`seed_tx: ${EXPLORER}/tx/${seedTx}`);
  console.log(`seed_address: ${seedAddress}`);

  try {
    await verifySource(factoryAddress, factoryArtifact);
    await verifySource(seedAddress, marketArtifact);
  } catch (error) {
    console.error(safeMessage(error, privateKey));
    process.exitCode = 4;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(safeMessage(error));
    if (!process.exitCode) process.exitCode = 1;
  });
}
