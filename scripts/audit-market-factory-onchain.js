import { readFile } from 'node:fs/promises';
import { createPublicClient, getAddress, http } from 'viem';
import { arcTestnet } from 'viem/chains';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';

loadLocalEnvironment();
const config = loadServerConfig();
if (!config.marketFactoryAddress) throw new Error('MARKET_FACTORY_ADDRESS is required.');

const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8'));
const marketArtifact = JSON.parse(await readFile('contracts/artifacts/MemeMarket.json', 'utf8'));
const client = createPublicClient({ chain: arcTestnet, transport: http(config.arcRpcUrl) });

async function withRpcRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!/request limit|rate limit|429/i.test(`${error?.message} ${error?.details}`)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

const readContract = (parameters) => withRpcRetry(() => client.readContract(parameters));

function maskImmutables(bytecode, immutableReferences) {
  const bytes = bytecode.slice(2).split('');
  for (const references of Object.values(immutableReferences)) {
    for (const { start, length } of references) {
      bytes.fill('0', start * 2, (start + length) * 2);
    }
  }
  return bytes.join('');
}

const code = await withRpcRetry(() => client.getCode({ address: config.marketFactoryAddress }));
if (!code || code === '0x') throw new Error('No deployed market factory bytecode was found.');
const expected = maskImmutables(artifact.deployedBytecode, artifact.immutableReferences);
const actual = maskImmutables(code, artifact.immutableReferences);
if (actual !== expected) throw new Error('Deployed factory bytecode does not match the local artifact.');

const [chainId, usdc, treasury, creatorFeeBps, treasuryFeeBps, marketCount, deployedAtBlock] = await Promise.all([
  withRpcRetry(() => client.getChainId()),
  readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'usdc' }),
  readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'treasury' }),
  readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'creatorFeeBps' }),
  readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'treasuryFeeBps' }),
  readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'marketCount' }),
  readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'deployedAtBlock' }),
]);
if (chainId !== 5042002) throw new Error(`Unexpected chain ID ${chainId}.`);
if (getAddress(usdc) !== getAddress(config.arcUsdcAddress)) throw new Error('Factory USDC mismatch.');
if (creatorFeeBps !== 100 || treasuryFeeBps !== 100) throw new Error('Factory fee configuration mismatch.');

const markets = [];
for (let index = 0n; index < marketCount; index += 1n) {
  const market = await readContract({
    address: config.marketFactoryAddress,
    abi: artifact.abi,
    functionName: 'markets',
    args: [index],
  });
  const marketCode = await withRpcRetry(() => client.getCode({ address: market }));
  if (!marketCode || marketCode === '0x') throw new Error(`Market ${market} has no runtime bytecode.`);
  if (maskImmutables(marketCode, marketArtifact.immutableReferences)
    !== maskImmutables(marketArtifact.deployedBytecode, marketArtifact.immutableReferences)) {
    throw new Error(`Market ${market} bytecode does not match the local artifact.`);
  }
  const [registered, marketUsdc, marketTreasury, marketCreatorFee, marketTreasuryFee,
    totalSupply, inventory, soldTokenCount, reserveUsdc, currencyBalance] = await Promise.all([
    readContract({ address: config.marketFactoryAddress, abi: artifact.abi, functionName: 'isMarket', args: [market] }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'usdc' }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'treasury' }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'creatorFeeBps' }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'treasuryFeeBps' }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'totalSupply' }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'balanceOf', args: [market] }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'soldTokenCount' }),
    readContract({ address: market, abi: marketArtifact.abi, functionName: 'reserveUsdc' }),
    readContract({
      address: config.arcUsdcAddress,
      abi: [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }],
      functionName: 'balanceOf',
      args: [market],
    }),
  ]);
  if (!registered || getAddress(marketUsdc) !== getAddress(usdc)
    || getAddress(marketTreasury) !== getAddress(treasury)
    || marketCreatorFee !== creatorFeeBps || marketTreasuryFee !== treasuryFeeBps) {
    throw new Error(`Market ${market} immutable configuration mismatch.`);
  }
  if (inventory + soldTokenCount * 10n ** 18n !== totalSupply) {
    throw new Error(`Market ${market} fixed-supply invariant failed.`);
  }
  if (currencyBalance < reserveUsdc) throw new Error(`Market ${market} is insolvent.`);
  markets.push({
    address: getAddress(market),
    bytecodeMatches: true,
    supplyInvariant: true,
    solvent: true,
    soldTokenCount,
    reserveUsdc,
    currencyBalance,
  });
}

console.log(JSON.stringify({
  chainId,
  factory: getAddress(config.marketFactoryAddress),
  deployedBytecodeBytes: (code.length - 2) / 2,
  bytecodeMatches: true,
  usdc: getAddress(usdc),
  treasury: getAddress(treasury),
  creatorFeeBps,
  treasuryFeeBps,
  marketCount: marketCount.toString(),
  deployedAtBlock: deployedAtBlock.toString(),
  markets,
}, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
