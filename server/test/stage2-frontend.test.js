import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  configuredAddress,
  decodeMetadata,
  formatUsdcAmount,
  mediaNftAbi,
  nftMarketplaceAbi,
  parseUsdcAmount,
  stage2Contracts,
  vaultAbi,
} from '../../src/assets.js';

/**
 * Browser-side Stage 2 helpers.
 *
 * These guard the properties that decide whether the UI can mislead someone: that an
 * unconfigured contract yields nothing rather than a fallback, that money is formatted from
 * exact integer units, that metadata parsing cannot throw on hostile input, and that the ABIs
 * the browser sends match the deployed artifacts.
 */

test('an unconfigured or malformed contract address yields null, never a fallback', async () => {
  for (const value of [
    undefined, null, '', '   ',
    '0x0000000000000000000000000000000000000000',
    '0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CF', // too short
    '0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFDD', // too long
    'not-an-address',
    '56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD', // missing 0x
  ]) {
    assert.equal(configuredAddress(value), null, `${value} must not resolve to an address`);
  }

  // A valid address is normalised to its checksummed form.
  assert.equal(
    configuredAddress(' 0x56a6f87e4d026e6d9d3e3c791a3a30e023bf1cfd '),
    '0x56A6f87e4d026E6D9d3E3c791A3A30e023bf1CFD',
  );
});

test('the module exposes no address when the environment configures none', async () => {
  // Imported outside Vite, so no VITE_* variables exist. Every surface must therefore render
  // its explicit "not configured" state rather than inventing a collection or a vault.
  for (const [name, value] of Object.entries(stage2Contracts)) {
    assert.equal(value, null, `${name} must be null without configuration`);
  }
});

test('USDC amounts format from exact integer units', async () => {
  assert.equal(formatUsdcAmount(0n), '0');
  assert.equal(formatUsdcAmount(1n), '0.000001', 'one atomic unit is not rounded away');
  assert.equal(formatUsdcAmount(60_000n), '0.06', 'the live autonomous creator payout');
  assert.equal(formatUsdcAmount(100_000n), '0.1', 'the gross request it was derived from');
  assert.equal(formatUsdcAmount(250_000n), '0.25', 'the live NFT sale price');
  assert.equal(formatUsdcAmount(1_000_000n), '1');
  assert.equal(formatUsdcAmount(undefined), '—', 'absent data is shown as absent');
  assert.equal(formatUsdcAmount(null), '—');
});

test('USDC input parses to exact atomic units', async () => {
  assert.equal(parseUsdcAmount('0.25'), 250_000n);
  assert.equal(parseUsdcAmount('0.06'), 60_000n);
  assert.equal(parseUsdcAmount('1'), 1_000_000n);
  assert.equal(parseUsdcAmount('0.000001'), 1n);
  // A round trip through the display helper never loses a unit.
  for (const units of [1n, 60_000n, 100_000n, 250_000n, 1_000_000n]) {
    assert.equal(parseUsdcAmount(formatUsdcAmount(units)), units);
  }
});

test('metadata decoding survives hostile and absent input', async () => {
  const metadata = { name: 'MemeVerse Media', image: 'https://example/x.png' };
  const encoded = `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;
  assert.deepEqual(decodeMetadata(encoded), metadata);

  for (const value of [
    undefined, null, 42, {},
    'https://example/not-a-data-uri.json',
    'data:application/json;base64,!!!not-base64!!!',
    'data:application/json;base64,' + Buffer.from('{ not json').toString('base64'),
    '',
  ]) {
    assert.equal(decodeMetadata(value), null, 'malformed metadata must degrade to null, not throw');
  }
});

test('the browser ABIs match the compiled contract artifacts', async () => {
  // A drift between the bundled ABI and the deployed artifact would make the UI encode calls the
  // contract cannot answer, so the function surfaces are compared directly.
  const cases = [
    ['MemeVerseMediaNFT', mediaNftAbi],
    ['MemeVerseNFTMarketplace', nftMarketplaceAbi],
    ['MemeVerseVault', vaultAbi],
  ];
  for (const [contractName, browserAbi] of cases) {
    const artifact = JSON.parse(
      await readFile(`contracts/artifacts/${contractName}.json`, 'utf8'),
    );
    const artifactFunctions = new Map(
      artifact.abi
        .filter((entry) => entry.type === 'function')
        .map((entry) => [
          `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`,
          entry,
        ]),
    );

    for (const entry of browserAbi.filter((item) => item.type === 'function')) {
      const signature = `${entry.name}(${entry.inputs.map((input) => input.type).join(',')})`;
      const artifactEntry = artifactFunctions.get(signature);
      assert.ok(artifactEntry, `${contractName}.${signature} must exist in the deployed artifact`);
      assert.equal(
        entry.stateMutability,
        artifactEntry.stateMutability,
        `${contractName}.${signature} mutability must match the artifact`,
      );
      assert.equal(
        entry.outputs.length,
        artifactEntry.outputs.length,
        `${contractName}.${signature} output arity must match the artifact`,
      );
    }
  }
});

test('the browser never carries a write it is not entitled to send', async () => {
  // The marketplace and vault ABIs must expose no administrative surface at all, so a compromised
  // frontend has nothing privileged to call.
  const names = [...nftMarketplaceAbi, ...vaultAbi]
    .filter((entry) => entry.type === 'function')
    .map((entry) => entry.name);
  for (const forbidden of [
    'owner', 'transferOwnership', 'pause', 'unpause', 'rescue', 'sweep', 'setFee', 'upgradeTo',
  ]) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be callable`);
  }
});

test('no simulated NFT or vault data remains in the browser bundle sources', async () => {
  const main = await readFile('src/main.jsx', 'utf8');
  const stage2 = await readFile('src/stage2-views.jsx', 'utf8');

  // The Stage 1 demo datasets and their components are gone, not merely unrouted.
  for (const removed of ['demoCoins', 'const nfts', 'function NFTCard', 'function Vault()']) {
    assert.equal(main.includes(removed), false, `${removed} must be removed from main.jsx`);
  }

  // And the surfaces that replaced them make no simulation claim.
  for (const banned of ['SIMULATION READY', 'SIMULATED ASSETS', 'DEMO ARCHIVE', 'CURRENT DATA IS SIMULATED']) {
    assert.equal(main.includes(banned), false, `main.jsx must not claim "${banned}"`);
    assert.equal(stage2.includes(banned), false, `stage2-views.jsx must not claim "${banned}"`);
  }

  // The real views are routed.
  assert.ok(main.includes('MediaAssets'), '/nft must render the real media view');
  assert.ok(main.includes('UsdcVault'), '/vault must render the real vault view');
  assert.ok(
    main.includes('AgentCommandCenter'),
    '/agent must render the Stage 3 command center over real backend state',
  );
});

test('the agent surface exposes no account identity', async () => {
  // The Circle account email is a personal identifier and must never be rendered. The operator's
  // actual address is deliberately not written here either — asserting on the generic shapes is
  // enough, and embedding it would put a personal identifier in the repository.
  for (const file of ['src/stage2-views.jsx', 'src/stage3-views.jsx']) {
    const source = await readFile(file, 'utf8');
    for (const banned of ['@gmail', '@googlemail', 'mailto:', 'email', 'apiKey', 'entitySecret']) {
      assert.equal(
        source.toLowerCase().includes(banned.toLowerCase()),
        false,
        `${file} must not reference ${banned}`,
      );
    }
  }
});
