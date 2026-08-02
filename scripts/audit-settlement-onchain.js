import { createPublicClient, getAddress, http } from 'viem';
import { arcTestnet } from 'viem/chains';
import { loadServerConfig } from '../server/config.js';
import { settlementAbi } from '../server/infrastructure/arc-contracts.js';
import { loadLocalEnvironment } from '../server/load-env.js';

loadLocalEnvironment();
const config = loadServerConfig();
if (!config.circleSettlementContractAddress || !config.circleWalletId) {
  throw new Error('The deployed settlement contract and Circle wallet must be configured.');
}

const client = createPublicClient({ chain: arcTestnet, transport: http(config.arcRpcUrl) });
const phase3SettlementId = '0xa5e1fdc48886c96d77cc7ccfe2d06e2195cfa663372c0df3722c4e4ace26c737';
async function withRpcRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!/request limit|rate limit|429/i.test(`${error?.message} ${error?.details}`)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}

const code = await withRpcRetry(() => client.getCode({
  address: config.circleSettlementContractAddress,
}));
const operator = await withRpcRetry(() => client.readContract({
    address: config.circleSettlementContractAddress,
    abi: settlementAbi,
    functionName: 'operator',
  }));
const usdc = await withRpcRetry(() => client.readContract({
    address: config.circleSettlementContractAddress,
    abi: settlementAbi,
    functionName: 'usdc',
  }));
const duplicateSettled = await withRpcRetry(() => client.readContract({
    address: config.circleSettlementContractAddress,
    abi: settlementAbi,
    functionName: 'settled',
    args: [phase3SettlementId],
  }));
if (!code || code === '0x') throw new Error('No deployed bytecode was found.');
if (getAddress(usdc) !== getAddress(config.arcUsdcAddress)) throw new Error('USDC immutable mismatch.');
if (!duplicateSettled) throw new Error('The known Phase 3 settlement is not marked complete.');

async function mustRevert(label, parameters) {
  return withRpcRetry(async () => {
    try {
      await client.simulateContract(parameters);
    } catch (error) {
      if (/request limit|rate limit|429/i.test(`${error?.message} ${error?.details}`)) throw error;
      if (/revert|execution/i.test(`${error?.message} ${error?.details}`)) {
        return { label, reverted: true };
      }
      throw error;
    }
    throw new Error(`${label} unexpectedly succeeded.`);
  });
}

const checks = [];
checks.push(await mustRevert('unauthorized caller', {
    address: config.circleSettlementContractAddress,
    abi: settlementAbi,
    functionName: 'settle',
    account: '0x000000000000000000000000000000000000dEaD',
    args: [`0x${'11'.repeat(32)}`, operator, 1n],
  }));
checks.push(await mustRevert('zero settlement id', {
    address: config.circleSettlementContractAddress,
    abi: settlementAbi,
    functionName: 'settle',
    account: operator,
    args: [`0x${'00'.repeat(32)}`, operator, 1n],
  }));
checks.push(await mustRevert('duplicate settlement id', {
    address: config.circleSettlementContractAddress,
    abi: settlementAbi,
    functionName: 'settle',
    account: operator,
    args: [phase3SettlementId, operator, 1n],
  }));

console.log(JSON.stringify({
  contract: config.circleSettlementContractAddress,
  deployedBytecodeBytes: (code.length - 2) / 2,
  operator,
  usdc,
  duplicateSettled,
  checks,
}, null, 2));
