import { readFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { arcTestnet } from 'viem/chains';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';

loadLocalEnvironment();
const config = loadServerConfig();
const factoryArtifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8'));
const marketArtifact = JSON.parse(await readFile('contracts/artifacts/MemeMarket.json', 'utf8'));
const client = createPublicClient({ chain: arcTestnet, transport: http(config.arcRpcUrl) });

async function withRpcRetry(operation) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await operation(); } catch (error) {
      lastError = error;
      if (!/request limit|rate limit|429/i.test(`${error?.message} ${error?.details}`)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 750 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function isVerified(address) {
  const response = await fetch(`https://testnet.arcscan.app/api/v2/smart-contracts/${address}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return false;
  return (await response.json()).is_verified === true;
}

async function verify(address, artifact) {
  if (await isVerified(address)) {
    console.log(`${artifact.contractName} is already verified at ${address}.`);
    return;
  }
  const compilerVersion = `v${artifact.compiler.split('.Emscripten')[0]}`;
  const endpoint = `https://testnet.arcscan.app/api/v2/smart-contracts/${address}/verification/via/standard-input`;
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
  const response = await fetch(endpoint, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`ArcScan verification failed with HTTP ${response.status}: ${payload}`);
  console.log(`ArcScan accepted ${artifact.contractName} verification for ${address}: ${payload}`);
}

await verify(config.marketFactoryAddress, factoryArtifact);
const count = await withRpcRetry(() => client.readContract({
  address: config.marketFactoryAddress,
  abi: factoryArtifact.abi,
  functionName: 'marketCount',
}));
for (let index = 0n; index < count; index += 1n) {
  const market = await withRpcRetry(() => client.readContract({
    address: config.marketFactoryAddress,
    abi: factoryArtifact.abi,
    functionName: 'markets',
    args: [index],
  }));
  await verify(market, marketArtifact);
}
