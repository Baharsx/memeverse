import { readFile } from 'node:fs/promises';
import { createPublicClient, getAddress, http } from 'viem';
import { loadServerConfig } from '../server/config.js';
import { loadLocalEnvironment } from '../server/load-env.js';

/**
 * Independently audits the deployed Stage 2 Arc contracts against the compiled artifacts.
 *
 * Nothing here trusts the deployment script or the provider: every fact is read back from Arc
 * over JSON-RPC. Immutable constructor arguments are re-read through the contracts' own getters,
 * and runtime bytecode is compared to the locally compiled artifact with the immutable byte
 * ranges masked out, since those differ by construction.
 */

loadLocalEnvironment();
const config = loadServerConfig();

const ARC_CHAIN_ID = 5042002;
const rpc = createPublicClient({ transport: http(config.arcRpcUrl) });

const targets = {
  MemeVerseMediaNFT: process.env.MEDIA_NFT_ADDRESS,
  MemeVerseNFTMarketplace: process.env.NFT_MARKETPLACE_ADDRESS,
  MemeVerseVault: process.env.USDC_VAULT_ADDRESS,
};

const failures = [];
const checks = [];

function check(name, actual, expected) {
  const ok = String(actual).toLowerCase() === String(expected).toLowerCase();
  checks.push({ name, actual: String(actual), expected: String(expected), ok });
  if (!ok) failures.push(`${name}: expected ${expected}, read ${actual}`);
  return ok;
}

/** Blanks the immutable byte ranges so the rest of the runtime code can be compared exactly. */
function maskImmutables(code, immutableReferences) {
  const bytes = Buffer.from(code.replace(/^0x/, ''), 'hex');
  for (const references of Object.values(immutableReferences ?? {})) {
    for (const { start, length } of references) bytes.fill(0, start, start + length);
  }
  return bytes.toString('hex');
}

const chainId = await rpc.getChainId();
check('chainId', chainId, ARC_CHAIN_ID);

for (const [contractName, address] of Object.entries(targets)) {
  if (!address) {
    failures.push(`${contractName}: no address configured`);
    continue;
  }
  const artifact = JSON.parse(await readFile(`contracts/artifacts/${contractName}.json`, 'utf8'));
  const target = getAddress(address);
  const code = await rpc.getCode({ address: target });

  if (!code || code === '0x') {
    failures.push(`${contractName}: no bytecode at ${target}`);
    continue;
  }
  check(
    `${contractName}.runtimeBytecode`,
    maskImmutables(code, artifact.immutableReferences),
    maskImmutables(artifact.deployedBytecode, artifact.immutableReferences),
  );

  const read = (functionName, args = []) => rpc.readContract({
    address: target, abi: artifact.abi, functionName, args,
  });

  if (contractName === 'MemeVerseMediaNFT') {
    check('MediaNFT.factory', await read('factory'), config.marketFactoryAddress);
    check('MediaNFT.name', await read('name'), 'MemeVerse Media');
    check('MediaNFT.symbol', await read('symbol'), 'MVMEDIA');
    // ERC-721 and ERC-721 Metadata interface IDs.
    check('MediaNFT.supportsERC721', await read('supportsInterface', ['0x80ac58cd']), true);
    check('MediaNFT.supportsERC721Metadata', await read('supportsInterface', ['0x5b5e139f']), true);
  }

  if (contractName === 'MemeVerseNFTMarketplace') {
    check('Marketplace.nft', await read('nft'), targets.MemeVerseMediaNFT);
    check('Marketplace.usdc', await read('usdc'), config.arcUsdcAddress);
  }

  if (contractName === 'MemeVerseVault') {
    check('Vault.asset', await read('asset'), config.arcUsdcAddress);
    check('Vault.decimals', await read('decimals'), 12);
    check('Vault.symbol', await read('symbol'), 'mvUSDC');
    check('Vault.yield', await read('annualPercentageYieldBps'), 0);
  }

  // No contract in this set may expose an administrative or drain surface.
  const forbidden = artifact.abi
    .filter((entry) => entry.type === 'function')
    .map((entry) => entry.name)
    .filter((name) => ['owner', 'transferOwnership', 'pause', 'upgradeTo', 'rescue', 'sweep']
      .includes(name));
  if (forbidden.length) failures.push(`${contractName}: unexpected privileged functions ${forbidden}`);
  checks.push({
    name: `${contractName}.noPrivilegedSurface`,
    actual: 'none',
    expected: 'none',
    ok: forbidden.length === 0,
  });
}

for (const entry of checks) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.ok ? '' : ` (expected ${entry.expected}, read ${entry.actual})`}`);
}

if (failures.length) {
  console.error(`\n${failures.length} onchain audit failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${checks.length} onchain assertions passed against Arc chain ${chainId}.`);
}
