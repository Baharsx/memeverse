import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('compiled factory artifact is the Cancun market build', async () => {
  const artifact = JSON.parse(await readFile('contracts/artifacts/MemeVerseFactory.json', 'utf8'));
  assert.match(artifact.compiler, /^0\.8\.30\+/);
  assert.equal(artifact.evmVersion, 'cancun');
  assert.ok(artifact.bytecode.startsWith('0x'));
  const createMarket = artifact.abi.find((entry) => entry.type === 'function' && entry.name === 'createMarket');
  assert.ok(createMarket, 'the factory must expose createMarket');
  assert.equal(artifact.contractName, 'MemeVerseFactory');
});
