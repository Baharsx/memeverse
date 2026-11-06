/**
 * Read-only Arc mainnet plan by default. --broadcast deploys only the new fractional factory.
 * Existing markets, balances, reserves, and the live application configuration are not changed.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, formatUnits, getAddress, http, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc } from 'viem/chains';
import { assertMainnetChainId, bufferedGasCost, deployBudgetDecision, parseDeployerPrivateKey } from './mainnet-deploy-plan.js';

export function fractionalFactoryArgs({ usdc, treasury, creatorFeeBps, treasuryFeeBps }) {
  if (getAddress(usdc) !== getAddress('0x3600000000000000000000000000000000000000')) throw new Error('The factory must use Arc USDC.');
  if (BigInt(creatorFeeBps) + BigInt(treasuryFeeBps) > 500n) throw new Error('Total fees exceed 5%.');
  return [getAddress(usdc), getAddress(treasury), BigInt(creatorFeeBps), BigInt(treasuryFeeBps)];
}

async function environment() {
  let stored = {};
  try {
    const content = await readFile(process.env.MEMEVERSE_ENV || '/etc/memeverse/memeverse.env', 'utf8');
    stored = Object.fromEntries(content.split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')];
    }));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read deployment environment.'); }
  return { ...stored, ...process.env };
}

async function main() {
  const env = await environment();
  const broadcast = process.argv.includes('--broadcast');
  const client = createPublicClient({ chain: arc, transport: http('https://rpc.mainnet.arc.io') });
  assertMainnetChainId(await client.getChainId());
  const legacy = getAddress(env.VITE_MEMEVERSE_FACTORY_ADDRESS || env.MARKET_FACTORY_ADDRESS || '');
  const abi = parseAbi(['function usdc() view returns(address)', 'function treasury() view returns(address)', 'function creatorFeeBps() view returns(uint16)', 'function treasuryFeeBps() view returns(uint16)', 'function marketCount() view returns(uint256)', 'function tradingVersion() view returns(uint256)']);
  const [usdc, treasury, creatorFeeBps, treasuryFeeBps, legacyMarketCount] = await Promise.all(['usdc', 'treasury', 'creatorFeeBps', 'treasuryFeeBps', 'marketCount'].map(functionName => client.readContract({ address: legacy, abi, functionName })));
  const args = fractionalFactoryArgs({ usdc, treasury, creatorFeeBps, treasuryFeeBps });
  const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFractionalFactory.json', 'utf8'));
  if (artifact.contractName !== 'MemeVerseFractionalFactory') throw new Error('Unexpected artifact.');
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  // The treasury address is public and suffices for a read-only gas estimate. No key is read.
  const account = broadcast ? privateKeyToAccount(parseDeployerPrivateKey(env.DEPLOYER_PRIVATE_KEY)) : getAddress(env.FRACTIONAL_DEPLOYER_ADDRESS || treasury);
  const address = typeof account === 'string' ? account : account.address;
  const [gas, gasPrice, balance] = await Promise.all([
    client.estimateGas({ account: address, data }), client.getGasPrice(), client.getBalance({ address }),
  ]);
  const cost = bufferedGasCost(gas, gasPrice);
  const budget = deployBudgetDecision({ balanceWei: balance, estimatedCostWei: cost });
  const plan = { mode: broadcast ? 'broadcast' : 'read-only', chainId: 5042, legacyFactory: legacy, legacyMarketCount: legacyMarketCount.toString(), deployer: address, treasury, creatorFeeBps: Number(creatorFeeBps), treasuryFeeBps: Number(treasuryFeeBps), bytecodeHash: keccak256(data), estimatedGas: gas.toString(), bufferedCostUsdc: formatUnits(cost, 18), balanceUsdc: formatUnits(balance, 18), budgetAction: budget.action, changesExistingMarkets: false, changesApplicationConfig: false };
  console.log(JSON.stringify(plan, null, 2));
  if (!broadcast) return;
  if (budget.action !== 'deploy') throw new Error('Insufficient deployment budget; no transaction was broadcast.');
  if (!env.FRACTIONAL_DEPLOY_STATE) throw new Error('FRACTIONAL_DEPLOY_STATE is required before broadcasting.');
  try { await readFile(env.FRACTIONAL_DEPLOY_STATE); throw new Error('Deployment state already exists; inspect it before broadcasting again.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(env.FRACTIONAL_DEPLOY_STATE), { recursive: true });
  await writeFile(env.FRACTIONAL_DEPLOY_STATE, JSON.stringify({ ...plan, status: 'prepared' }, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
  const signer = createWalletClient({ account, chain: arc, transport: http('https://rpc.mainnet.arc.io') });
  assertMainnetChainId(await client.getChainId());
  const hash = await signer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  // Record the hash before waiting; an interrupted receipt wait must never trigger a redeploy.
  await writeFile(env.FRACTIONAL_DEPLOY_STATE, JSON.stringify({ ...plan, transactionHash: hash }, null, 2) + '\n', { mode: 0o644 });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Fractional factory deployment did not succeed.');
  const factory = getAddress(receipt.contractAddress);
  const version = await client.readContract({ address: factory, abi, functionName: 'tradingVersion' });
  if (version !== 2n) throw new Error('The deployed factory is not version 2.');
  const result = { ...plan, transactionHash: hash, factory, blockNumber: receipt.blockNumber.toString() };
  await writeFile(env.FRACTIONAL_DEPLOY_STATE, JSON.stringify(result, null, 2) + '\n', { mode: 0o644 });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Provider failures can contain signed transaction details. Keep operator output generic.
    console.error(error.name === 'Error' ? error.message : 'Fractional deployment failed; inspect the saved transaction hash.');
    process.exitCode = 1;
  });
}
