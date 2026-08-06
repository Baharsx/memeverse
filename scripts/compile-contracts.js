import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import solc from 'solc';

const require = createRequire(import.meta.url);

const builds = [
  {
    sourceName: 'MemeVerseSettlement.sol',
    contractNames: ['MemeVerseSettlement'],
    viaIR: false,
  },
  {
    sourceName: 'MemeVerseMarket.sol',
    contractNames: ['MemeMarket', 'MemeVerseFactory'],
    viaIR: true,
  },
  {
    sourceName: 'MemeVerseMedia.sol',
    contractNames: ['MemeVerseMediaNFT', 'MemeVerseNFTMarketplace'],
    viaIR: true,
  },
  {
    sourceName: 'MemeVerseVault.sol',
    contractNames: ['MemeVerseVault'],
    viaIR: true,
  },
];

/**
 * Resolves `@openzeppelin/...` imports from the installed, version-pinned package rather than
 * vendoring upstream sources into the repository.
 *
 * Every resolved file is recorded in the standard JSON input, so the emitted artifact still
 * carries the complete, byte-exact source set the bytecode was produced from — which is what
 * source verification and the onchain audit scripts compare against.
 */
function importResolver(sources) {
  return (importPath) => {
    try {
      const filePath = importPath.startsWith('@')
        ? require.resolve(importPath)
        : resolve('contracts', importPath);
      const contents = readFileSync(filePath, 'utf8');
      sources[importPath] = { content: contents };
      return { contents };
    } catch (error) {
      return { error: `Could not resolve import "${importPath}": ${error.message}` };
    }
  };
}

for (const build of builds) {
  const sourcePath = resolve('contracts', build.sourceName);
  const source = await readFile(sourcePath, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [build.sourceName]: { content: source } },
    settings: {
      evmVersion: 'cancun',
      viaIR: build.viaIR,
      optimizer: { enabled: true, runs: 200 },
      metadata: { bytecodeHash: 'ipfs' },
      outputSelection: {
        '*': {
          '*': [
            'abi',
            'evm.bytecode.object',
            'evm.deployedBytecode.object',
            'evm.deployedBytecode.immutableReferences',
            'metadata',
          ],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), {
    import: importResolver(input.sources),
  }));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));

  for (const contractName of build.contractNames) {
    const contract = output.contracts?.[build.sourceName]?.[contractName];
    if (!contract?.evm?.bytecode?.object) {
      throw new Error(`Solidity compiler returned no bytecode for ${contractName}.`);
    }
    const artifact = {
      contractName,
      sourceName: build.sourceName,
      compiler: solc.version(),
      evmVersion: 'cancun',
      viaIR: build.viaIR,
      optimizer: { enabled: true, runs: 200 },
      standardJsonInput: input,
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
      immutableReferences: contract.evm.deployedBytecode.immutableReferences ?? {},
      metadata: JSON.parse(contract.metadata),
    };
    const artifactPath = resolve('contracts/artifacts', `${contractName}.json`);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`Compiled ${contractName} with ${artifact.compiler}.`);
    console.log(`Artifact: ${artifactPath}`);
  }
}
