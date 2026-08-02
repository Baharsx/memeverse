import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import solc from 'solc';

const sourcePath = resolve('contracts/MemeVerseSettlement.sol');
const artifactPath = resolve('contracts/artifacts/MemeVerseSettlement.json');
const source = await readFile(sourcePath, 'utf8');

const input = {
  language: 'Solidity',
  sources: {
    'MemeVerseSettlement.sol': { content: source },
  },
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 200 },
    metadata: { bytecodeHash: 'ipfs' },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
if (errors.length) {
  throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
}

const contract = output.contracts?.['MemeVerseSettlement.sol']?.MemeVerseSettlement;
if (!contract?.evm?.bytecode?.object) throw new Error('Solidity compiler returned no bytecode.');

const artifact = {
  contractName: 'MemeVerseSettlement',
  sourceName: 'MemeVerseSettlement.sol',
  compiler: solc.version(),
  evmVersion: 'cancun',
  optimizer: { enabled: true, runs: 200 },
  standardJsonInput: input,
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  metadata: JSON.parse(contract.metadata),
};

await mkdir(dirname(artifactPath), { recursive: true });
await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`Compiled ${artifact.contractName} with ${artifact.compiler}.`);
console.log(`Artifact: ${artifactPath}`);
